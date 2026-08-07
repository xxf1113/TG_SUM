import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  normalizeSummaryResult,
  summarizeTelegramPostWithCompletion,
} from '../shared/summary';
import type { TelegramComment, TelegramPost } from './types';

export { DEFAULT_OPENAI_BASE_URL, normalizeSummaryResult } from '../shared/summary';

const DEFAULT_OPENAI_TIMEOUT = 60_000;

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

export async function summarizeTelegramPost(
  post: TelegramPost,
  comments: TelegramComment[],
  warnings: string[],
  signal?: AbortSignal,
) {
  const client = getClient();
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  try {
    return await summarizeTelegramPostWithCompletion(
      post,
      comments,
      warnings,
      async (request, requestSignal) => {
        const response = await client.chat.completions.create(
          request as ChatCompletionCreateParamsNonStreaming,
          { signal: requestSignal },
        );
        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error('OPENAI_EMPTY_RESPONSE');
        return content;
      },
      model,
      signal,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'OPENAI_API_KEY_MISSING') throw error;
    if (error instanceof Error && error.message === 'OPENAI_INVALID_RESPONSE') throw error;
    throw classifyOpenAIError(error);
  }
}
