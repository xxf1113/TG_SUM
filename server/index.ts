import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { fetchTelegramPreview, TelegramFetchError } from './telegram';
import { summarizeTelegramPost } from './summary';
import type { TelegramPreview } from './types';

try {
  loadEnvFile();
} catch {
  // Environment variables can also be supplied by the shell or process manager.
}

const port = Number(process.env.PORT || 8787);
const rootDir = fileURLToPath(new URL('..', import.meta.url));

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 2_000_000) throw new Error('REQUEST_TOO_LARGE');
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object') throw new Error('INVALID_JSON');
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): { status: number; message: string } {
  if (error instanceof TelegramFetchError) return { status: error.status === 429 ? 429 : 400, message: error.message };
  if (error instanceof Error) {
    if (error.message === 'OPENAI_API_KEY_MISSING') return { status: 503, message: '服务端尚未配置 OPENAI_API_KEY。' };
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
  const requested = decodeURIComponent(request.url.split('?')[0]);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const candidate = normalize(join(distDir, relative));
  if (!candidate.startsWith(normalize(distDir)) || !existsSync(candidate) || !statSync(candidate).isFile()) return false;
  const types: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'content-type': `${types[extname(candidate)] || 'application/octet-stream'}; charset=utf-8` });
  response.end(readFileSync(candidate));
  return true;
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type' });
    response.end();
    return;
  }
  if (serveStatic(request, response)) return;
  if (request.url === '/api/health' && request.method === 'GET') {
    json(response, 200, { ok: true });
    return;
  }
  try {
    if (request.url === '/api/telegram/preview' && request.method === 'POST') {
      const body = await readJson(request);
      if (typeof body.url !== 'string') throw new TelegramFetchError('请提供 Telegram 帖子链接。');
      json(response, 200, await fetchTelegramPreview(body.url));
      return;
    }
    if (request.url === '/api/summary' && request.method === 'POST') {
      const body = await readJson(request);
      const preview = body.preview as TelegramPreview | undefined;
      if (!preview?.post?.text || !Array.isArray(preview.comments)) throw new Error('INVALID_JSON');
      json(response, 200, await summarizeTelegramPost(preview.post, preview.comments, preview.warnings || []));
      return;
    }
    json(response, 404, { message: '接口不存在。' });
  } catch (error) {
    const result = errorMessage(error);
    json(response, result.status, { message: result.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ThreadBrief server listening at http://127.0.0.1:${port}`);
});
