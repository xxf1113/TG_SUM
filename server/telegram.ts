import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import {
  fetchTelegramPreview as fetchSharedTelegramPreview,
  REQUEST_TIMEOUT,
  validatePublicPage,
} from '../shared/telegram';
import type { TelegramPreview } from './types';
import { TelegramFetchError } from '../shared/telegram';

const execFileAsync = promisify(execFile);
const REQUEST_USER_AGENT = 'ThreadBrief/0.1 (+local public-page reader)';
let activeProxyUrl: string | undefined;

export {
  deduplicateComments,
  normalizeTelegramUrl,
  parseCommentsPage,
  parsePostPage,
  stripHtml,
  TelegramFetchError,
} from '../shared/telegram';

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

export function fetchTelegramPreview(input: string, parentSignal?: AbortSignal): Promise<TelegramPreview> {
  return fetchSharedTelegramPreview(input, getPage, parentSignal);
}
