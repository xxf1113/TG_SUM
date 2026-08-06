import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { SummaryEvidence, SummaryItem, SummaryResult, TelegramComment, TelegramPost } from './types';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_TIMEOUT = 60_000;
const MAX_POST_CHARS = 20_000;
const MAX_COMMENT_CHARS = 2_000;
const MAX_COMMENT_INPUT_CHARS = 100_000;

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

export type OpenAISummaryErrorCode =
  | 'OPENAI_AUTH_FAILED'
  | 'OPENAI_PERMISSION_DENIED'
  | 'OPENAI_INSUFFICIENT_QUOTA'
  | 'OPENAI_RATE_LIMITED'
  | 'OPENAI_MODEL_NOT_FOUND'
  | 'OPENAI_STRUCTURED_OUTPUT_UNSUPPORTED'
  | 'OPENAI_TIMEOUT'
  | 'OPENAI_CANCELLED'
  | 'OPENAI_REQUEST_FAILED';

export class OpenAISummaryError extends Error {
  constructor(public readonly code: OpenAISummaryErrorCode, public readonly status?: number) {
    super(code);
    this.name = 'OpenAISummaryError';
  }
}

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

export function getOpenAIBaseUrl(): string {
  const configured = process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim();
  return (configured || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
}

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY_MISSING');
  const configuredTimeout = Number(process.env.OPENAI_TIMEOUT_MS);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout >= 5_000 && configuredTimeout <= 300_000
    ? configuredTimeout
    : DEFAULT_OPENAI_TIMEOUT;
  return new OpenAI({ apiKey, baseURL: getOpenAIBaseUrl(), timeout, maxRetries: 0 });
}

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

function errorDetails(error: APIError): string {
  let body = '';
  try {
    body = JSON.stringify(error.error ?? '');
  } catch {
    body = '';
  }
  return `${error.message} ${error.code || ''} ${error.type || ''} ${body}`.toLowerCase();
}

export function classifyOpenAIError(error: unknown): OpenAISummaryError {
  if (error instanceof OpenAISummaryError) return error;
  if (error instanceof APIConnectionTimeoutError) return new OpenAISummaryError('OPENAI_TIMEOUT');
  if (error instanceof APIUserAbortError) return new OpenAISummaryError('OPENAI_CANCELLED');
  if (error instanceof APIConnectionError) return new OpenAISummaryError('OPENAI_REQUEST_FAILED');
  if (error instanceof APIError) {
    const details = errorDetails(error);
    if (error.status === 401) return new OpenAISummaryError('OPENAI_AUTH_FAILED', error.status);
    if (error.status === 403) return new OpenAISummaryError('OPENAI_PERMISSION_DENIED', error.status);
    if (error.status === 429) {
      return new OpenAISummaryError(/insufficient[_ -]?quota|quota|billing|余额|配额/i.test(details) ? 'OPENAI_INSUFFICIENT_QUOTA' : 'OPENAI_RATE_LIMITED', error.status);
    }
    if (error.status === 404 || /model[_ -]?not[_ -]?found|model does not exist/i.test(details)) {
      return new OpenAISummaryError('OPENAI_MODEL_NOT_FOUND', error.status);
    }
    if (/response[_ -]?format|json[_ -]?schema|structured output|structured outputs|not supported/i.test(details)) {
      return new OpenAISummaryError('OPENAI_STRUCTURED_OUTPUT_UNSUPPORTED', error.status);
    }
  }
  return new OpenAISummaryError('OPENAI_REQUEST_FAILED');
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

export async function summarizeTelegramPost(
  post: TelegramPost,
  comments: TelegramComment[],
  warnings: string[],
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const client = getClient();
  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content: '你是一个严谨的中文信息整理助手。你只根据输入内容总结，不评价用户，也不重复寒暄和广告。',
        },
        { role: 'user', content: buildPrompt(post, comments, warnings) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'telegram_thread_summary', strict: true, schema: summarySchema },
      },
    }, { signal });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('OPENAI_EMPTY_RESPONSE');
    const result = normalizeSummaryResult(JSON.parse(content), comments);
    if (!result) throw new Error('OPENAI_INVALID_RESPONSE');
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'OPENAI_API_KEY_MISSING') throw error;
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'OPENAI_INVALID_RESPONSE')) {
      throw new Error('OPENAI_INVALID_RESPONSE');
    }
    throw classifyOpenAIError(error);
  }
}
