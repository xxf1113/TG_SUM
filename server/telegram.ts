import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { TelegramComment, TelegramPost, TelegramPreview } from './types';

const MAX_COMMENTS = 500;
const MAX_DISCUSSION_PAGES = 120;
const TOTAL_FETCH_TIMEOUT = 90_000;
const REQUEST_TIMEOUT = 15_000;
const PUBLIC_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);
const execFileAsync = promisify(execFile);
const REQUEST_USER_AGENT = 'ThreadBrief/0.1 (+local public-page reader)';
let activeProxyUrl: string | undefined;

export interface TelegramLink {
  channel: string;
  messageId: number;
  publicUrl: string;
}

export class TelegramFetchError extends Error {
  status?: number;
  code?: 'TELEGRAM_TIMEOUT' | 'TELEGRAM_CANCELLED';
  constructor(message: string, status?: number, code?: 'TELEGRAM_TIMEOUT' | 'TELEGRAM_CANCELLED') {
    super(message);
    this.name = 'TelegramFetchError';
    this.status = status;
    this.code = code;
  }
}

interface TimeoutSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

function createTimeoutSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): TimeoutSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);
  const onAbort = () => controller.abort(parentSignal?.reason || new DOMException('Request cancelled', 'AbortError'));
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'TimeoutError';
}

function abortError(signal: AbortSignal, timedOut = false): TelegramFetchError {
  return timedOut || isTimeoutReason(signal.reason)
    ? new TelegramFetchError('Telegram request timed out.', undefined, 'TELEGRAM_TIMEOUT')
    : new TelegramFetchError('Telegram request cancelled.', undefined, 'TELEGRAM_CANCELLED');
}

function hasStableCommentId(comment: TelegramComment): boolean {
  return Boolean(comment.id) && !comment.id.startsWith('comment-');
}

export function deduplicateComments(comments: TelegramComment[]): TelegramComment[] {
  const seenIds = new Set<string>();
  const seenTextWithoutId = new Set<string>();
  return comments.filter((comment) => {
    if (hasStableCommentId(comment)) {
      if (seenIds.has(comment.id)) return false;
      seenIds.add(comment.id);
      return true;
    }
    if (seenTextWithoutId.has(comment.text)) return false;
    seenTextWithoutId.add(comment.text);
    return true;
  });
}

export function normalizeTelegramUrl(input: string): TelegramLink {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new TelegramFetchError('请输入有效的 Telegram 帖子链接。');
  }

  if (!PUBLIC_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new TelegramFetchError('只支持公开的 t.me Telegram 帖子链接。');
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() === 's') parts.shift();
  if (parts[0]?.toLowerCase() === 'c') {
    throw new TelegramFetchError('只支持公开频道帖子，不支持私有或需要登录的 Telegram 链接。');
  }
  if (parts.length !== 2) {
    throw new TelegramFetchError('链接需要符合 t.me/频道名/帖子ID 格式。');
  }

  const channel = parts[0].replace(/^@/, '');
  const messageId = Number(parts[1]);
  if (!/^[a-zA-Z0-9_]{3,}$/.test(channel) || !Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new TelegramFetchError('频道名或帖子 ID 无效。');
  }

  return {
    channel,
    messageId,
    publicUrl: `https://t.me/s/${channel}/${messageId}`,
  };
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
      const number = code.toLowerCase().startsWith('x') ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : '';
    })
    .replace(/&([a-z]+);/gi, (_, name: string) => named[name.toLowerCase()] ?? `&${name};`);
}

export function stripHtml(value: string): string {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>(\r?\n)?/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\u00a0/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstMatch(html: string, pattern: RegExp): string | undefined {
  return html.match(pattern)?.[1];
}

function allMatches(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((match) => match[1]);
}

function messageBlock(html: string, postKey: string): string {
  const start = html.indexOf(`data-post="${postKey}"`);
  if (start < 0) return html;
  const blockStart = html.lastIndexOf('<div class="tgme_widget_message_wrap', start);
  const nextBlock = html.indexOf('<div class="tgme_widget_message_wrap', start + 1);
  return html.slice(blockStart >= 0 ? blockStart : 0, nextBlock >= 0 ? nextBlock : html.length);
}

function extractText(block: string): string {
  const content = firstMatch(block, /<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  return content ? stripHtml(content) : '';
}

function extractAuthor(block: string): string {
  const content = firstMatch(block, /<(?:a|span)[^>]+class="[^"]*tgme_widget_message_owner_name[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/i)
    ?? firstMatch(block, /<(?:a|span)[^>]+class="[^"]*tgme_widget_message_author_name[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/i);
  return content ? stripHtml(content) : '匿名用户';
}

function extractDate(block: string): string {
  return firstMatch(block, /<time[^>]+datetime="([^"]+)"/i) ?? '';
}

function extractRepliesUrl(block: string): string | undefined {
  const href = firstMatch(block, /<a[^>]+class="[^"]*tgme_widget_message_replies[^"]*"[^>]+href="([^"]+)"/i);
  return href?.replace(/&amp;/g, '&');
}

function extractCommentCount(block: string): number | undefined {
  const replies = firstMatch(block, /<a[^>]+class="[^"]*tgme_widget_message_replies[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (!replies) return undefined;
  const count = stripHtml(replies).match(/[\d,]+/);
  return count ? Number(count[0].replace(/,/g, '')) : undefined;
}

function extractMedia(block: string): { hasMedia: boolean; mediaLabel?: string } {
  const hasImage = /tgme_widget_message_photo_wrap|tgme_widget_message_video|tgme_widget_message_document/i.test(block);
  const hasAudio = /tgme_widget_message_audio/i.test(block);
  if (hasAudio) return { hasMedia: true, mediaLabel: '音频' };
  if (hasImage) return { hasMedia: true, mediaLabel: '媒体附件' };
  return { hasMedia: false };
}

export function parsePostPage(html: string, link: TelegramLink): { post: TelegramPost; repliesUrl?: string } {
  if (!html.includes(`data-post="${link.channel}/${link.messageId}"`)) {
    throw new TelegramFetchError('没有找到对应的公开帖子，可能是帖子已删除或 Telegram 页面结构已变化。');
  }
  const block = messageBlock(html, `${link.channel}/${link.messageId}`);
  const text = extractText(block);
  const media = extractMedia(block);
  const post: TelegramPost = {
    channel: link.channel,
    messageId: link.messageId,
    url: `https://t.me/${link.channel}/${link.messageId}`,
    author: extractAuthor(block),
    publishedAt: extractDate(block),
    text: text || (media.hasMedia ? '[帖子仅包含媒体附件]' : ''),
    ...media,
    commentCount: extractCommentCount(block),
  };
  if (!post.text) throw new TelegramFetchError('没有解析到帖子正文，可能是私有帖子或 Telegram 页面结构已变化。');
  return { post, repliesUrl: extractRepliesUrl(block) };
}

function parseCommentBlock(block: string, index: number): TelegramComment | undefined {
  const text = extractText(block);
  if (!text) return undefined;
  const dataPost = firstMatch(block, /data-post="([^"]+)"/i);
  const dataPostId = firstMatch(block, /data-post-id="([^"]+)"/i);
  return {
    id: dataPost ?? dataPostId ?? `comment-${index}`,
    author: extractAuthor(block),
    publishedAt: extractDate(block),
    text,
  };
}

function extractDiscussionBefore(html: string): string | undefined {
  return firstMatch(html, /class="[^"]*js-messages_more[^"]*"[^>]+data-before="([^"]+)"/i);
}

function isDiscussionPage(html: string): boolean {
  return /tgme_post_discussion|comments on this post/i.test(html);
}

function extractDiscussionCommentCount(html: string): number | undefined {
  const count = firstMatch(html, /class="[^"]*js-header[^"]*"[^>]*>([\d,]+)\s+comments?/i);
  return count ? Number(count.replace(/,/g, '')) : undefined;
}

async function fetchDiscussionComments(link: TelegramLink, signal?: AbortSignal): Promise<{ comments: TelegramComment[]; available: boolean; commentCount?: number }> {
  const baseUrl = `https://t.me/${link.channel}/${link.messageId}?embed=1&discussion=1`;
  let page = await getPage(baseUrl, signal);
  let comments = parseCommentsPage(page, `${link.channel}/${link.messageId}`);
  let before = extractDiscussionBefore(page);
  let pageCount = 0;
  const commentCount = extractDiscussionCommentCount(page);

  while (before && comments.length < MAX_COMMENTS && pageCount < MAX_DISCUSSION_PAGES) {
    const morePage = await getPage(`${baseUrl}&comment=${encodeURIComponent(before)}`, signal);
    const moreComments = parseCommentsPage(morePage, `${link.channel}/${link.messageId}`);
    const merged = deduplicateComments([...comments, ...moreComments]);
    if (merged.length === comments.length) break;
    comments = merged;
    const nextBefore = extractDiscussionBefore(morePage);
    if (!nextBefore || nextBefore === before) break;
    before = nextBefore;
    page = morePage;
    pageCount += 1;
  }

  return { comments: comments.slice(0, MAX_COMMENTS), available: isDiscussionPage(page), commentCount };
}

export function parseCommentsPage(html: string, postKey: string): TelegramComment[] {
  const blocks = allMatches(
    html,
    /(<div class="tgme_widget_message_wrap[\s\S]*?)(?=<div class="tgme_widget_message_wrap|<\/body>|$)/gi,
  );
  return deduplicateComments(
    blocks
      .map((block, index) => parseCommentBlock(block, index))
      .filter((comment): comment is TelegramComment => comment !== undefined && comment.id !== postKey),
  );
}

function validatePublicPage(html: string): string {
  if (/tgme_page_icon|tgme_widget_message/i.test(html) === false) {
    throw new TelegramFetchError('Telegram 没有返回公开帖子页面，可能需要登录或页面不可访问。');
  }
  return html;
}

async function fetchWithNode(url: string, parentSignal?: AbortSignal): Promise<string> {
  const proxyUrl = getTelegramProxyUrl();
  if (proxyUrl && proxyUrl !== activeProxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    activeProxyUrl = proxyUrl;
  }
  const timeout = createTimeoutSignal(parentSignal, REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: timeout.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': REQUEST_USER_AGENT,
      },
    });
    if (!response.ok) {
      if (response.status === 429) throw new TelegramFetchError('Telegram 暂时限制了访问，请稍后重试。', response.status);
      if (response.status === 404) throw new TelegramFetchError('帖子不存在，或该频道不是公开频道。', response.status);
      throw new TelegramFetchError(`Telegram 返回了 HTTP ${response.status}。`, response.status);
    }
    return validatePublicPage(await response.text());
  } catch (error) {
    if (error instanceof TelegramFetchError) throw error;
    if (timeout.signal.aborted) throw abortError(timeout.signal, timeout.timedOut());
    throw error;
  } finally {
    timeout.dispose();
  }
}

async function fetchWithCurl(url: string, signal?: AbortSignal): Promise<string> {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const proxy = getTelegramProxyUrl();
  const args = [
    '--location',
    '--silent',
    '--show-error',
    '--max-time',
    String(Math.ceil(REQUEST_TIMEOUT / 1000)),
    '--user-agent',
    REQUEST_USER_AGENT,
    '--header',
    'accept: text/html,application/xhtml+xml',
    '--write-out',
    '\n__THREADBRIEF_STATUS__%{http_code}',
    url,
  ];
  if (proxy) args.splice(args.length - 1, 0, '--proxy', proxy);
  try {
    const { stdout } = await execFileAsync(curl, args, { maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal });
    const marker = '\n__THREADBRIEF_STATUS__';
    const markerIndex = stdout.lastIndexOf(marker);
    const status = Number(stdout.slice(markerIndex + marker.length).trim());
    const html = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
    if (status === 429) throw new TelegramFetchError('Telegram 暂时限制了访问，请稍后重试。', status);
    if (status === 404) throw new TelegramFetchError('帖子不存在，或该频道不是公开频道。', status);
    if (!status || status < 200 || status >= 300) throw new TelegramFetchError(`Telegram 返回了 HTTP ${status || '未知'}。`, status);
    return validatePublicPage(html);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }
}

function normalizeProxyUrl(value: string): string {
  const raw = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return raw;
  const httpsProxy = raw.match(/(?:^|;)https?=([^;]+)/i)?.[1];
  if (httpsProxy) return normalizeProxyUrl(httpsProxy);
  const socksProxy = raw.match(/(?:^|;)socks(?:5h?)?=([^;]+)/i)?.[1];
  if (socksProxy) return `socks5h://${socksProxy}`;
  return `http://${raw}`;
}

function getWindowsSystemProxy(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const output = execFileSync('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', windowsHide: true });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return undefined;
    const proxyServer = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
    return proxyServer ? normalizeProxyUrl(proxyServer) : undefined;
  } catch {
    return undefined;
  }
}

export function getTelegramProxyUrl(): string | undefined {
  const configured = process.env.TELEGRAM_PROXY_URL?.trim() || process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim() || process.env.ALL_PROXY?.trim();
  return configured ? normalizeProxyUrl(configured) : getWindowsSystemProxy();
}

async function getPage(url: string, signal?: AbortSignal): Promise<string> {
  try {
    return await fetchWithNode(url, signal);
  } catch (nodeError) {
    if (nodeError instanceof TelegramFetchError) throw nodeError;
    if (signal?.aborted) throw abortError(signal);
    try {
      return await fetchWithCurl(url, signal);
    } catch (curlError) {
      if (curlError instanceof TelegramFetchError) throw curlError;
      if (signal?.aborted) throw abortError(signal);
      throw new TelegramFetchError(
        getTelegramProxyUrl()
          ? '无法连接 Telegram 公开页面，请检查代理地址和代理是否正在运行。'
          : '当前环境无法直连 Telegram。请配置 TELEGRAM_PROXY_URL 后重试。',
      );
    }
  }
}

export async function fetchTelegramPreview(input: string, parentSignal?: AbortSignal): Promise<TelegramPreview> {
  const totalTimeout = createTimeoutSignal(parentSignal, TOTAL_FETCH_TIMEOUT);
  try {
    const link = normalizeTelegramUrl(input);
    const html = await getPage(link.publicUrl, totalTimeout.signal);
    const parsed = parsePostPage(html, link);
    const warnings: string[] = [];
    let comments: TelegramComment[] = [];

    try {
      const discussion = await fetchDiscussionComments(link, totalTimeout.signal);
      comments = discussion.comments;
      parsed.post.commentCount = discussion.commentCount ?? parsed.post.commentCount;
      if (!discussion.available) warnings.push('该帖子没有公开讨论区，或评论内容不可访问。');
    } catch (error) {
      if (error instanceof TelegramFetchError && error.code) throw error;
      if (parsed.repliesUrl) {
        try {
          const repliesHtml = await getPage(parsed.repliesUrl, totalTimeout.signal);
          comments = parseCommentsPage(repliesHtml, `${link.channel}/${link.messageId}`);
        } catch (error) {
          if (error instanceof TelegramFetchError && error.code) throw error;
          warnings.push('评论讨论页无法公开访问，当前结果只包含主贴内容。');
        }
      } else {
        warnings.push('评论讨论页无法公开访问，当前结果只包含主贴内容。');
      }
    }

    const unique = deduplicateComments(comments).slice(0, MAX_COMMENTS);
    if (parsed.post.commentCount && parsed.post.commentCount > unique.length) {
      warnings.push(`Telegram 显示约 ${parsed.post.commentCount} 条评论，当前抓取到 ${unique.length} 条公开评论。`);
    }
    if (!unique.length && parsed.post.commentCount) {
      warnings.push('该帖子有评论数量提示，但评论内容没有公开展示。');
    }

    return { post: parsed.post, comments: unique, warnings, fetchedAt: new Date().toISOString() };
  } finally {
    totalTimeout.dispose();
  }
}
