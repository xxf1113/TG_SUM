import {
  DEFAULT_WEBDAV_PATH,
  WebDavError,
  normalizeWebDavPath,
  normalizeWebDavServerUrl,
  type WebDavSettings,
} from '../../shared/webdav';

const STORAGE_KEY = 'threadbrief.webdav.settings';

export interface BrowserWebDavCredentials {
  serverUrl: string;
  remotePath: string;
  username: string;
  password: string;
}

function storage(): Storage {
  if (typeof localStorage === 'undefined') throw new WebDavError('当前环境不支持本地 WebDAV 配置存储。', 'WEBDAV_INVALID_SETTINGS');
  return localStorage;
}

function readStored(): BrowserWebDavCredentials | null {
  try {
    const value: unknown = JSON.parse(storage().getItem(STORAGE_KEY) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (typeof data.serverUrl !== 'string' || typeof data.remotePath !== 'string' || typeof data.username !== 'string' || typeof data.password !== 'string') return null;
    return { serverUrl: data.serverUrl, remotePath: data.remotePath, username: data.username, password: data.password };
  } catch {
    return null;
  }
}

export function getBrowserWebDavSettings(): WebDavSettings {
  const value = readStored();
  return {
    serverUrl: value?.serverUrl || '',
    remotePath: value?.remotePath || DEFAULT_WEBDAV_PATH,
    username: value?.username || '',
    hasPassword: Boolean(value?.password),
  };
}

export function getBrowserWebDavCredentials(): BrowserWebDavCredentials {
  const value = readStored();
  if (!value?.serverUrl || !value.password) throw new WebDavError('请先配置 WebDAV 地址、用户名和密码。', 'WEBDAV_NOT_CONFIGURED');
  return value;
}

export function saveBrowserWebDavSettings(input: { serverUrl: string; remotePath: string; username: string; password?: string }): void {
  const current = readStored();
  const serverUrl = normalizeWebDavServerUrl(input.serverUrl);
  const remotePath = normalizeWebDavPath(input.remotePath);
  const username = input.username.trim();
  const password = input.password?.trim() || current?.password || '';
  if (!username || !password) throw new WebDavError('请输入 WebDAV 用户名和密码。', 'WEBDAV_INVALID_SETTINGS');
  storage().setItem(STORAGE_KEY, JSON.stringify({ serverUrl, remotePath, username, password }));
}

export function clearBrowserWebDavSettings(): void {
  storage().removeItem(STORAGE_KEY);
}
