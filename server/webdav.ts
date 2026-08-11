import { buildWebDavFileUrl, MAX_WEBDAV_BYTES, WebDavError, normalizeWebDavPath, normalizeWebDavServerUrl, type WebDavMethod } from '../shared/webdav';

const WEBDAV_TIMEOUT_MS = 30_000;

export interface WebDavProxyInput {
  method: WebDavMethod;
  serverUrl: string;
  remotePath: string;
  username: string;
  password: string;
  body?: string;
}

export interface WebDavProxyResponse {
  status: number;
  body: string;
}

function timeoutSignal(parent: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let didTimeout = false;
  const onAbort = () => controller.abort(parent.reason);
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort('WEBDAV_TIMEOUT');
  }, WEBDAV_TIMEOUT_MS);
  if (parent.aborted) controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

export async function proxyWebDav(input: WebDavProxyInput, parentSignal: AbortSignal): Promise<WebDavProxyResponse> {
  if (input.method !== 'GET' && input.method !== 'PUT') throw new WebDavError('WebDAV 请求方法无效。', 'WEBDAV_INVALID_SETTINGS');
  const serverUrl = normalizeWebDavServerUrl(input.serverUrl);
  const remotePath = normalizeWebDavPath(input.remotePath);
  if (!input.username.trim() || !input.password) throw new WebDavError('WebDAV 用户名或密码不能为空。', 'WEBDAV_INVALID_SETTINGS');
  if (input.method === 'PUT' && (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > MAX_WEBDAV_BYTES)) throw new WebDavError('WebDAV 历史文件过大。', 'WEBDAV_RESPONSE_TOO_LARGE');

  const request = timeoutSignal(parentSignal);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Basic ${Buffer.from(`${input.username.trim()}:${input.password}`, 'utf8').toString('base64')}`,
    };
    if (input.method === 'PUT') headers['content-type'] = 'application/json; charset=utf-8';
    let response: Response;
    try {
      response = await fetch(buildWebDavFileUrl(serverUrl, remotePath), {
        method: input.method,
        headers,
        body: input.method === 'PUT' ? input.body : undefined,
        signal: request.signal,
        redirect: 'follow',
      });
    } catch (error) {
      if (request.timedOut()) throw new WebDavError('WebDAV 请求超时，请稍后重试。', 'WEBDAV_TIMEOUT');
      if (parentSignal.aborted) throw new WebDavError('WebDAV 请求已取消。', 'WEBDAV_REQUEST_FAILED');
      throw new WebDavError('无法连接 WebDAV 服务器，请检查地址和网络。', 'WEBDAV_REQUEST_FAILED');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_WEBDAV_BYTES) throw new WebDavError('WebDAV 响应内容过大。', 'WEBDAV_RESPONSE_TOO_LARGE');
    return { status: response.status, body };
  } finally {
    request.cleanup();
  }
}
