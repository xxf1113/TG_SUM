import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from '../../shared/summary';

const STORAGE_KEY = 'threadbrief.api.settings';

export type BrowserApiRequestSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

type StoredApiSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

function storage(): Storage {
  if (typeof localStorage === 'undefined') throw new Error('当前环境不支持本地 API 配置存储。');
  return localStorage;
}

function readStored(): StoredApiSettings | null {
  try {
    const value: unknown = JSON.parse(storage().getItem(STORAGE_KEY) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (typeof data.apiKey !== 'string' || typeof data.baseUrl !== 'string' || typeof data.model !== 'string') return null;
    return { apiKey: data.apiKey, baseUrl: data.baseUrl, model: data.model };
  } catch {
    return null;
  }
}

export function getBrowserApiSettings(): { hasApiKey: boolean; baseUrl: string; model: string } {
  const value = readStored();
  return {
    hasApiKey: Boolean(value?.apiKey),
    baseUrl: value?.baseUrl || DEFAULT_OPENAI_BASE_URL,
    model: value?.model || DEFAULT_OPENAI_MODEL,
  };
}

export function getBrowserApiRequestSettings(): BrowserApiRequestSettings | undefined {
  const value = readStored();
  if (!value?.apiKey) return undefined;
  return {
    apiKey: value.apiKey,
    baseUrl: value.baseUrl || DEFAULT_OPENAI_BASE_URL,
    model: value.model || DEFAULT_OPENAI_MODEL,
  };
}

export function saveBrowserApiSettings(input: { apiKey?: string; baseUrl: string; model: string }): void {
  const current = readStored();
  const apiKey = input.apiKey?.trim() || current?.apiKey || '';
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_OPENAI_BASE_URL;
  const model = input.model.trim() || DEFAULT_OPENAI_MODEL;
  if (!apiKey) throw new Error('请输入 API Key。');
  storage().setItem(STORAGE_KEY, JSON.stringify({ apiKey, baseUrl, model }));
}

export function clearBrowserApiSettings(): void {
  storage().removeItem(STORAGE_KEY);
}
