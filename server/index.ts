import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative as relativePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { fetchTelegramPreview, TelegramFetchError } from './telegram';
import { OpenAISummaryError, summarizeTelegramPost, type OpenAIRequestSettings } from './summary';
import { proxyWebDav } from './webdav';
import { MAX_WEBDAV_BYTES, WebDavError } from '../shared/webdav';
import type { TelegramPreview } from './types';

try {
  loadEnvFile();
} catch {
  // Environment variables can also be supplied by the shell or process manager.
}

const port = Number(process.env.PORT || 8787);
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);

function isAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

function json(response: ServerResponse, status: number, body: unknown, request?: IncomingMessage): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(request ? corsHeaders(request) : {}),
  });
  response.end(JSON.stringify(body));
}

function createRequestSignal(request: IncomingMessage, response: ServerResponse): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort('REQUEST_ABORTED');
  const close = () => {
    if (!response.writableEnded) abort();
  };
  request.once('aborted', abort);
  response.once('close', close);
  return {
    signal: controller.signal,
    cleanup: () => {
      request.removeListener('aborted', abort);
      response.removeListener('close', close);
    },
  };
}

async function readJson(request: IncomingMessage, maxBytes = 2_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).length > maxBytes) throw new Error('REQUEST_TOO_LARGE');
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object') throw new Error('INVALID_JSON');
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): { status: number; message: string } {
  if (error instanceof TelegramFetchError) {
    if (error.code === 'TELEGRAM_TIMEOUT') return { status: 504, message: 'Telegram 抓取超时，请缩小目标帖子或稍后重试。' };
    if (error.code === 'TELEGRAM_CANCELLED') return { status: 499, message: '抓取已取消。' };
    return { status: error.status === 429 ? 429 : 400, message: error.message };
  }
  if (error instanceof OpenAISummaryError) {
    const messages: Record<string, string> = {
      OPENAI_AUTH_FAILED: 'OpenAI Key 无效或已过期，请检查 OPENAI_API_KEY。',
      OPENAI_PERMISSION_DENIED: 'OpenAI Key 没有访问该模型或接口的权限。',
      OPENAI_INSUFFICIENT_QUOTA: 'OpenAI 账户余额或配额不足，请检查计费设置。',
      OPENAI_RATE_LIMITED: 'OpenAI 请求过于频繁，请稍后重试。',
      OPENAI_MODEL_NOT_FOUND: '模型不存在，或当前 API 不支持所选模型。',
      OPENAI_STRUCTURED_OUTPUT_UNSUPPORTED: '当前模型或中转站不支持结构化 JSON 输出，请更换模型或中转站。',
      OPENAI_TIMEOUT: 'OpenAI 请求超时，请稍后重试或降低评论内容量。',
      OPENAI_CANCELLED: '总结已取消。',
      OPENAI_REQUEST_FAILED: 'OpenAI 请求失败，请检查中转站地址、网络和模型配置。',
    };
    return { status: error.code === 'OPENAI_TIMEOUT' ? 504 : error.code === 'OPENAI_CANCELLED' ? 499 : 502, message: messages[error.code] || messages.OPENAI_REQUEST_FAILED };
  }
  if (error instanceof WebDavError) {
    if (error.code === 'WEBDAV_AUTH_FAILED') return { status: 401, message: error.message };
    if (error.code === 'WEBDAV_TIMEOUT') return { status: 504, message: error.message };
    if (error.code === 'WEBDAV_RESPONSE_TOO_LARGE') return { status: 413, message: error.message };
    if (error.code === 'WEBDAV_INVALID_SETTINGS') return { status: 400, message: error.message };
    return { status: 502, message: error.message };
  }
  if (error instanceof Error) {
    if (error.message === 'OPENAI_API_KEY_MISSING') return { status: 503, message: '服务端尚未配置 OPENAI_API_KEY。' };
    if (error.message === 'CUSTOM_API_SETTINGS_INVALID') return { status: 400, message: '自定义 API 配置不完整，请重新填写 Key、Base URL 和模型名称。' };
    if (error.message === 'OPENAI_INVALID_RESPONSE') return { status: 502, message: '模型返回格式异常，请重试。' };
    if (error.message === 'OPENAI_REQUEST_FAILED') return { status: 502, message: 'OpenAI 请求失败，请检查 Key、模型配置或网络。' };
    if (error.message === 'REQUEST_TOO_LARGE') return { status: 413, message: '请求内容过大。' };
    if (error.message === 'INVALID_JSON') return { status: 400, message: '请求格式无效。' };
  }
  return { status: 500, message: '服务暂时不可用，请稍后重试。' };
}

function serveStatic(request: IncomingMessage, response: ServerResponse): boolean {
  if (!request.url || request.method !== 'GET') return false;
  const distDir = join(rootDir, 'dist');
  if (!existsSync(distDir)) return false;
  let requested: string;
  try {
    requested = decodeURIComponent(request.url.split('?')[0]);
  } catch {
    return false;
  }
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const candidate = normalize(join(distDir, relative));
  const outsideRoot = relativePath(normalize(distDir), candidate);
  if (outsideRoot === '..' || outsideRoot.startsWith(`..${sep}`) || isAbsolute(outsideRoot) || !existsSync(candidate) || !statSync(candidate).isFile()) return false;
  const types: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'content-type': `${types[extname(candidate)] || 'application/octet-stream'}; charset=utf-8` });
  response.end(readFileSync(candidate));
  return true;
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin(request)) {
      json(response, 403, { message: '不允许的请求来源。' });
      return;
    }
    response.writeHead(204, { ...corsHeaders(request), 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type' });
    response.end();
    return;
  }
  if (serveStatic(request, response)) return;
  if (!isAllowedOrigin(request)) {
    json(response, 403, { message: '不允许的请求来源。' });
    return;
  }
  const requestContext = createRequestSignal(request, response);
  if (request.url === '/api/health' && request.method === 'GET') {
    json(response, 200, { ok: true }, request);
    requestContext.cleanup();
    return;
  }
  try {
    if (request.url === '/api/telegram/preview' && request.method === 'POST') {
      const body = await readJson(request);
      if (typeof body.url !== 'string') throw new TelegramFetchError('请提供 Telegram 帖子链接。');
      json(response, 200, await fetchTelegramPreview(body.url, requestContext.signal), request);
      return;
    }
    if (request.url === '/api/webdav' && request.method === 'POST') {
      const body = await readJson(request, MAX_WEBDAV_BYTES + 256_000);
      if (body.method !== 'GET' && body.method !== 'PUT' || typeof body.serverUrl !== 'string' || typeof body.remotePath !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') {
        throw new WebDavError('WebDAV 请求参数无效。', 'WEBDAV_INVALID_SETTINGS');
      }
      const result = await proxyWebDav({
        method: body.method,
        serverUrl: body.serverUrl,
        remotePath: body.remotePath,
        username: body.username,
        password: body.password,
        body: typeof body.body === 'string' ? body.body : undefined,
      }, requestContext.signal);
      json(response, 200, result, request);
      return;
    }
    if (request.url === '/api/summary' && request.method === 'POST') {
      const body = await readJson(request);
      const preview = body.preview as TelegramPreview | undefined;
      if (!preview?.post?.text || !Array.isArray(preview.comments)) throw new Error('INVALID_JSON');
      let settings: OpenAIRequestSettings | undefined;
      if (body.apiKey !== undefined && typeof body.apiKey !== 'string' || body.baseUrl !== undefined && typeof body.baseUrl !== 'string' || body.model !== undefined && typeof body.model !== 'string') {
        throw new Error('INVALID_JSON');
      }
      const hasCustomSettings = body.apiKey !== undefined || body.baseUrl !== undefined || body.model !== undefined;
      if (hasCustomSettings) {
        if (typeof body.apiKey !== 'string' || typeof body.baseUrl !== 'string' || typeof body.model !== 'string') throw new Error('CUSTOM_API_SETTINGS_INVALID');
        settings = { apiKey: body.apiKey, baseUrl: body.baseUrl, model: body.model };
      }
      json(response, 200, await summarizeTelegramPost(preview.post, preview.comments, preview.warnings || [], requestContext.signal, settings), request);
      return;
    }
    json(response, 404, { message: '接口不存在。' }, request);
  } catch (error) {
    if (requestContext.signal.aborted && response.destroyed) return;
    const result = errorMessage(error);
    json(response, result.status, { message: result.message }, request);
  } finally {
    requestContext.cleanup();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ThreadBrief server listening at http://127.0.0.1:${port}`);
});
