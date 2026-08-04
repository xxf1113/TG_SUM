import OpenAI from 'openai';
import type { SummaryResult, TelegramComment, TelegramPost } from './types';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    question: { type: 'string' },
    consensus: { type: 'array', items: { type: 'string' } },
    disagreements: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
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
  return new OpenAI({ apiKey, baseURL: getOpenAIBaseUrl() });
}

function buildPrompt(post: TelegramPost, comments: TelegramComment[], warnings: string[]): string {
  const commentText = comments.length
    ? comments.map((comment, index) => `[评论 ${index + 1}] ${comment.author}：${comment.text}`).join('\n')
    : '（没有抓取到公开评论）';
  return [
    '请总结一条 Telegram 公开频道帖子。输出简体中文，保持事实准确，不要编造帖子和评论中没有的信息。',
    '主贴是提问或讨论发起内容，评论是答复和观点。请区分主贴提出的问题、评论共同支持的内容和互相冲突的内容。',
    '每个数组项目写成一句到两句完整的话；没有内容时返回空数组。limitations 只写数据抓取限制或证据不足，不要泛泛而谈。',
    '',
    `主贴作者：${post.author}`,
    `主贴发布时间：${post.publishedAt || '未知'}`,
    `主贴正文：${post.text}`,
    '',
    `评论（共 ${comments.length} 条）：`,
    commentText,
    '',
    warnings.length ? `抓取提示：${warnings.join('；')}` : '抓取提示：无',
  ].join('\n');
}

export async function summarizeTelegramPost(
  post: TelegramPost,
  comments: TelegramComment[],
  warnings: string[],
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
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('OPENAI_EMPTY_RESPONSE');
    const result = JSON.parse(content) as SummaryResult;
    if (
      typeof result.question !== 'string' ||
      !Array.isArray(result.consensus) ||
      !Array.isArray(result.disagreements) ||
      !Array.isArray(result.recommendations) ||
      !Array.isArray(result.limitations)
    ) {
      throw new Error('OPENAI_INVALID_RESPONSE');
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'OPENAI_API_KEY_MISSING') throw error;
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'OPENAI_INVALID_RESPONSE')) {
      throw new Error('OPENAI_INVALID_RESPONSE');
    }
    throw new Error('OPENAI_REQUEST_FAILED');
  }
}
