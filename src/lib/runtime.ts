import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL, summarizeTelegramPostWithCompletion } from '../../shared/summary';
import {
  fetchTelegramPreview,
  TelegramFetchError,
  validatePublicPage,
} from '../../shared/telegram';
import type { SummaryResult, TelegramPreview } from '../types';
import {
  clearNativeSettings,
  getNativeSettings,
  isAndroidRuntime,
  requestNativeChatJson,
  requestNativeHtml,
  saveNativeSettings,
} from './native';

export type RuntimeSettings = {
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
};

export type RuntimeApi = {
  preview(url: string, signal?: AbortSignal): Promise<TelegramPreview>;
  summary(preview: TelegramPreview, signal?: AbortSignal): Promise<SummaryResult>;
  getSettings(): Promise<RuntimeSettings>;
  saveSettings(input: { apiKey?: string; baseUrl: string; model: string }): Promise<void>;
  clearSettings(): Promise<void>;
};

async function requestJson<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || '请求失败。');
  return data;
}

function telegramHttpError(status: number): TelegramFetchError {
  if (status === 429) return new TelegramFetchError('Telegram 暂时限制了访问，请稍后重试。', status);
  if (status === 404) return new TelegramFetchError('帖子不存在，或该频道不是公开频道。', status);
  return new TelegramFetchError(`Telegram 返回了 HTTP ${status || '未知'}。`, status);
}

async function fetchNativePage(url: string, signal?: AbortSignal): Promise<string> {
  const response = await requestNativeHtml(url, signal);
  if (response.status < 200 || response.status >= 300) throw telegramHttpError(response.status);
  return validatePublicPage(response.body);
}

function makeAndroidApi(): RuntimeApi {
  return {
    preview: (url, signal) => fetchTelegramPreview(url, fetchNativePage, signal),
    async summary(preview, signal) {
      const settings = await getNativeSettings();
      if (!settings.hasApiKey) throw new Error('请先在设置中保存 OpenAI API Key。');
      return summarizeTelegramPostWithCompletion(
        preview.post,
        preview.comments,
        preview.warnings,
        async (request, requestSignal) => {
          const response = await requestNativeChatJson({
            baseUrl: settings.baseUrl,
            model: settings.model,
            messages: request.messages,
            responseFormat: request.response_format,
          }, requestSignal);
          return response.content;
        },
        settings.model,
        signal,
      );
    },
    getSettings: getNativeSettings,
    saveSettings: saveNativeSettings,
    clearSettings: clearNativeSettings,
  };
}

const androidApi = makeAndroidApi();

export const runtimeApi: RuntimeApi = isAndroidRuntime()
  ? androidApi
  : {
      preview: (url, signal) => requestJson<TelegramPreview>('/api/telegram/preview', { url }, signal),
      summary: (preview, signal) => requestJson<SummaryResult>('/api/summary', { preview }, signal),
      getSettings: async () => ({ hasApiKey: true, baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL }),
      saveSettings: async () => undefined,
      clearSettings: async () => undefined,
    };

export const isStandaloneAndroid = isAndroidRuntime();
