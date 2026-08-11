import type {
  HistoryEntry,
  SummaryEvidence,
  SummarySectionItem,
  TelegramComment,
  TelegramPost,
} from './types';

export const MAX_HISTORY_ENTRIES = 100;
export const DEFAULT_WEBDAV_PATH = 'threadbrief/history.json';
export const MAX_WEBDAV_BYTES = 20_000_000;

export type WebDavMethod = 'GET' | 'PUT';

export interface WebDavSettings {
  serverUrl: string;
  remotePath: string;
  username: string;
  hasPassword: boolean;
}

export interface WebDavArchive {
  version: 1;
  updatedAt: string;
  entries: HistoryEntry[];
}

export type WebDavErrorCode =
  | 'WEBDAV_INVALID_SETTINGS'
  | 'WEBDAV_NOT_CONFIGURED'
  | 'WEBDAV_AUTH_FAILED'
  | 'WEBDAV_NOT_FOUND'
  | 'WEBDAV_REQUEST_FAILED'
  | 'WEBDAV_TIMEOUT'
  | 'WEBDAV_INVALID_ARCHIVE'
  | 'WEBDAV_RESPONSE_TOO_LARGE';

export class WebDavError extends Error {
  constructor(message: string, public readonly code: WebDavErrorCode, public readonly status?: number) {
    super(message);
    this.name = 'WebDavError';
  }
}

export function normalizeWebDavServerUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid');
    }
    return normalized;
  } catch {
    throw new WebDavError('WebDAV 地址必须是有效的 HTTP 或 HTTPS 地址。', 'WEBDAV_INVALID_SETTINGS');
  }
}

export function normalizeWebDavPath(value: string): string {
  const normalized = (value.trim() || DEFAULT_WEBDAV_PATH).replace(/^\/+/, '');
  if (!normalized || normalized.includes('?') || normalized.includes('#') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new WebDavError('WebDAV 远程路径无效。', 'WEBDAV_INVALID_SETTINGS');
  }
  return normalized;
}

export function buildWebDavFileUrl(serverUrl: string, remotePath: string): string {
  const base = normalizeWebDavServerUrl(serverUrl);
  const path = normalizeWebDavPath(remotePath);
  return new URL(`${base}/${path}`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizePost(value: unknown): TelegramPost | null {
  if (!isRecord(value) || typeof value.channel !== 'string' || typeof value.messageId !== 'number' || !Number.isFinite(value.messageId) || typeof value.url !== 'string' || typeof value.text !== 'string') return null;
  return {
    channel: value.channel,
    messageId: value.messageId,
    url: value.url,
    author: stringValue(value.author),
    publishedAt: stringValue(value.publishedAt),
    text: value.text,
    hasMedia: value.hasMedia === true,
    ...(typeof value.mediaLabel === 'string' ? { mediaLabel: value.mediaLabel } : {}),
    ...(typeof value.commentCount === 'number' && Number.isFinite(value.commentCount) ? { commentCount: value.commentCount } : {}),
  };
}

function normalizeComment(value: unknown): TelegramComment | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.text !== 'string') return null;
  return {
    id: value.id,
    author: stringValue(value.author),
    publishedAt: stringValue(value.publishedAt),
    text: value.text,
  };
}

function normalizeEvidence(value: unknown): SummaryEvidence | null {
  if (!isRecord(value) || typeof value.commentId !== 'string' || !value.commentId || typeof value.quote !== 'string') return null;
  return {
    commentId: value.commentId,
    author: stringValue(value.author),
    quote: value.quote,
  };
}

function normalizeSectionItem(value: unknown): SummarySectionItem | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(normalizeEvidence).filter((item): item is SummaryEvidence => item !== null) : [];
  return { text: value.text, evidence };
}

function normalizeHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.url !== 'string' || typeof value.channel !== 'string' || typeof value.createdAt !== 'string' || !value.createdAt) return null;
  const post = normalizePost(value.post);
  const summaryValue = isRecord(value.summary) ? value.summary : null;
  if (!post || !summaryValue || typeof summaryValue.question !== 'string') return null;
  const normalizeItems = (items: unknown): SummarySectionItem[] => Array.isArray(items) ? items.map(normalizeSectionItem).filter((item): item is SummarySectionItem => item !== null) : [];
  const comments = Array.isArray(value.comments) ? value.comments.map(normalizeComment).filter((item): item is TelegramComment => item !== null) : [];
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string') : [];
  return {
    id: value.id,
    url: value.url,
    channel: value.channel,
    createdAt: value.createdAt,
    post,
    comments,
    warnings,
    fetchedAt: stringValue(value.fetchedAt, value.createdAt),
    summary: {
      question: summaryValue.question,
      consensus: normalizeItems(summaryValue.consensus),
      disagreements: normalizeItems(summaryValue.disagreements),
      recommendations: normalizeItems(summaryValue.recommendations),
      limitations: Array.isArray(summaryValue.limitations) ? summaryValue.limitations.filter((item): item is string => typeof item === 'string') : [],
    },
  };
}

function normalizeEntries(entries: unknown[]): HistoryEntry[] {
  return entries.map(normalizeHistoryEntry).filter((entry): entry is HistoryEntry => entry !== null);
}

function compareCreatedAt(left: HistoryEntry, right: HistoryEntry): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return left.createdAt.localeCompare(right.createdAt);
}

export function mergeHistory(localEntries: HistoryEntry[], remoteEntries: HistoryEntry[]): HistoryEntry[] {
  const merged = new Map<string, HistoryEntry>();
  for (const entry of normalizeEntries(localEntries)) {
    const current = merged.get(entry.id);
    if (!current || compareCreatedAt(entry, current) > 0) merged.set(entry.id, entry);
  }
  for (const entry of normalizeEntries(remoteEntries)) {
    const current = merged.get(entry.id);
    if (!current || compareCreatedAt(entry, current) > 0) merged.set(entry.id, entry);
  }
  return [...merged.values()].sort((left, right) => compareCreatedAt(right, left)).slice(0, MAX_HISTORY_ENTRIES);
}

export function serializeHistory(entries: HistoryEntry[], updatedAt = new Date().toISOString()): string {
  const archive: WebDavArchive = {
    version: 1,
    updatedAt,
    entries: mergeHistory(entries, []),
  };
  const payload = JSON.stringify(archive, null, 2);
  if (new TextEncoder().encode(payload).byteLength > MAX_WEBDAV_BYTES) throw new WebDavError('WebDAV 历史文件过大，请减少评论内容后重试。', 'WEBDAV_RESPONSE_TOO_LARGE');
  return payload;
}

export function parseHistoryArchive(payload: string): { entries: HistoryEntry[]; invalidEntries: number } {
  if (new TextEncoder().encode(payload).byteLength > MAX_WEBDAV_BYTES) throw new WebDavError('WebDAV 历史文件过大。', 'WEBDAV_RESPONSE_TOO_LARGE');
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new WebDavError('WebDAV 历史文件不是有效 JSON。', 'WEBDAV_INVALID_ARCHIVE');
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new WebDavError('WebDAV 历史文件格式不受支持。', 'WEBDAV_INVALID_ARCHIVE');
  const entries = normalizeEntries(value.entries);
  return { entries: mergeHistory(entries, []), invalidEntries: value.entries.length - entries.length };
}

export function webDavStatusError(status: number): WebDavError {
  if (status === 401 || status === 403) return new WebDavError('WebDAV 用户名或密码错误，或当前账号没有访问权限。', 'WEBDAV_AUTH_FAILED', status);
  if (status === 404) return new WebDavError('WebDAV 远程文件不存在。', 'WEBDAV_NOT_FOUND', status);
  return new WebDavError(`WebDAV 返回了 HTTP ${status || '未知'}。`, 'WEBDAV_REQUEST_FAILED', status);
}
