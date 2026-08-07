import type { SummaryEvidence, SummaryItem, SummaryResult, TelegramComment, TelegramPost } from './types';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const MAX_POST_CHARS = 20_000;
const MAX_COMMENT_CHARS = 2_000;
const MAX_COMMENT_INPUT_CHARS = 100_000;

export interface SummaryMessage {
  role: 'system' | 'user';
  content: string;
}

export interface SummaryRequest {
  model: string;
  messages: SummaryMessage[];
  response_format: unknown;
}

export type SummaryCompletion = (request: SummaryRequest, signal?: AbortSignal) => Promise<string>;

const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commentId: { type: 'string' },
    quote: { type: 'string' },
  },
  required: ['commentId', 'quote'],
} as const;

const summaryItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    evidence: { type: 'array', items: evidenceSchema },
  },
  required: ['text', 'evidence'],
} as const;

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    question: { type: 'string' },
    consensus: { type: 'array', items: summaryItemSchema },
    disagreements: { type: 'array', items: summaryItemSchema },
    recommendations: { type: 'array', items: summaryItemSchema },
    limitations: { type: 'array', items: { type: 'string' } },
  },
  required: ['question', 'consensus', 'disagreements', 'recommendations', 'limitations'],
} as const;

export const SUMMARY_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'telegram_thread_summary', strict: true, schema: summarySchema },
} as const;

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  return value.length > maxChars ? { text: `${value.slice(0, maxChars)}…`, truncated: true } : { text: value, truncated: false };
}

function buildPrompt(post: TelegramPost, comments: TelegramComment[], warnings: string[]): string {
  const postText = truncateText(post.text, MAX_POST_CHARS);
  let commentChars = 0;
  let truncatedComments = 0;
  const commentLines: string[] = [];
  for (const [index, comment] of comments.entries()) {
    if (commentChars >= MAX_COMMENT_INPUT_CHARS) {
      truncatedComments += comments.length - index;
      break;
    }
    const clipped = truncateText(comment.text, MAX_COMMENT_CHARS);
    const line = `[评论 ${index + 1} id=${comment.id}] ${comment.author}：${clipped.text}`;
    const remaining = MAX_COMMENT_INPUT_CHARS - commentChars;
    commentLines.push(line.slice(0, remaining));
    commentChars += Math.min(line.length, remaining);
    truncatedComments += clipped.truncated ? 1 : 0;
    if (line.length > remaining) {
      truncatedComments += comments.length - index - 1;
      break;
    }
  }
  const commentText = commentLines.length ? commentLines.join('\n') : '（没有抓取到公开评论）';
  const promptWarnings = [...warnings];
  if (postText.truncated) promptWarnings.push(`主贴正文超过 ${MAX_POST_CHARS} 字，已截断后再总结。`);
  if (truncatedComments) promptWarnings.push(`部分评论超过单条 ${MAX_COMMENT_CHARS} 字或总量 ${MAX_COMMENT_INPUT_CHARS} 字限制，已截断或省略 ${truncatedComments} 条。`);
  return [
    '请总结一条 Telegram 公开频道帖子。输出简体中文，保持事实准确，不要编造帖子和评论中没有的信息。',
    '主贴是提问或讨论发起内容，评论是答复和观点。请区分主贴提出的问题、评论共同支持的内容和互相冲突的内容。',
    'consensus、disagreements、recommendations 必须返回对象数组，每项包含 text 和 evidence。evidence 只能引用输入评论中的 commentId，并用 quote 给出评论原文的连续片段；有评论依据时至少引用一条，没有可验证依据时返回空 evidence。limitations 仍然是字符串数组，只写数据抓取限制或证据不足。',
    '',
    `主贴作者：${post.author}`,
    `主贴发布时间：${post.publishedAt || '未知'}`,
    `主贴正文：${postText.text}`,
    '',
    `评论（共 ${comments.length} 条）：`,
    commentText,
    '',
    promptWarnings.length ? `抓取提示：${promptWarnings.join('；')}` : '抓取提示：无',
  ].join('\n');
}

export function buildSummaryRequest(
  post: TelegramPost,
  comments: TelegramComment[],
  warnings: string[],
  model = DEFAULT_OPENAI_MODEL,
): SummaryRequest {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: '你是一个严谨的中文信息整理助手。你只根据输入内容总结，不评价用户，也不重复寒暄和广告。',
      },
      { role: 'user', content: buildPrompt(post, comments, warnings) },
    ],
    response_format: SUMMARY_RESPONSE_FORMAT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEvidence(value: unknown, commentsById: Map<string, TelegramComment>): SummaryEvidence | null {
  if (!isRecord(value) || typeof value.commentId !== 'string' || typeof value.quote !== 'string') return null;
  const comment = commentsById.get(value.commentId);
  if (!comment) return null;
  const requestedQuote = value.quote.trim();
  const quote = requestedQuote && comment.text.includes(requestedQuote)
    ? requestedQuote
    : comment.text.length > 180 ? `${comment.text.slice(0, 180)}…` : comment.text;
  return { commentId: comment.id, author: comment.author, quote };
}

function normalizeSummaryItem(value: unknown, commentsById: Map<string, TelegramComment>): SummaryItem | null {
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.evidence)) return null;
  return {
    text: value.text.trim(),
    evidence: value.evidence
      .map((evidence) => normalizeEvidence(evidence, commentsById))
      .filter((evidence): evidence is SummaryEvidence => evidence !== null),
  };
}

export function normalizeSummaryResult(value: unknown, comments: TelegramComment[]): SummaryResult | null {
  if (!isRecord(value) || typeof value.question !== 'string') return null;
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  const normalizeSection = (key: string): SummaryItem[] | null => {
    const raw = value[key];
    if (!Array.isArray(raw)) return null;
    const items = raw.map((item) => normalizeSummaryItem(item, commentsById));
    return items.every((item): item is SummaryItem => item !== null) ? items : null;
  };
  const consensus = normalizeSection('consensus');
  const disagreements = normalizeSection('disagreements');
  const recommendations = normalizeSection('recommendations');
  const limitations = value.limitations;
  if (!consensus || !disagreements || !recommendations || !Array.isArray(limitations) || !limitations.every((item) => typeof item === 'string')) return null;
  return {
    question: value.question,
    consensus,
    disagreements,
    recommendations,
    limitations,
  };
}

export async function summarizeTelegramPostWithCompletion(
  post: TelegramPost,
  comments: TelegramComment[],
  warnings: string[],
  complete: SummaryCompletion,
  model = DEFAULT_OPENAI_MODEL,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  try {
    const content = await complete(buildSummaryRequest(post, comments, warnings, model), signal);
    if (!content) throw new Error('OPENAI_EMPTY_RESPONSE');
    const result = normalizeSummaryResult(JSON.parse(content), comments);
    if (!result) throw new Error('OPENAI_INVALID_RESPONSE');
    return result;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && (error.message === 'OPENAI_EMPTY_RESPONSE' || error.message === 'OPENAI_INVALID_RESPONSE'))) {
      throw new Error('OPENAI_INVALID_RESPONSE');
    }
    throw error;
  }
}
