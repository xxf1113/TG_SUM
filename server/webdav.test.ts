import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyWebDav } from './webdav';

afterEach(() => vi.unstubAllGlobals());

describe('WebDAV proxy', () => {
  it('sends Basic Auth and preserves remote status', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('alice:secret').toString('base64')}`);
      expect(init?.body).toBe('{"version":1}');
      return new Response('', { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await proxyWebDav({ method: 'PUT', serverUrl: 'https://dav.example.com/dav', remotePath: 'threadbrief/history.json', username: 'alice', password: 'secret', body: '{"version":1}' }, new AbortController().signal);
    expect(result).toEqual({ status: 201, body: '' });
  });

  it('returns a missing remote file without treating it as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(proxyWebDav({ method: 'GET', serverUrl: 'https://dav.example.com', remotePath: 'history.json', username: 'alice', password: 'secret' }, new AbortController().signal)).resolves.toEqual({ status: 404, body: '' });
  });
});
