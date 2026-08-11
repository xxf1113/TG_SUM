import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_ENTRIES, WebDavError, mergeHistory, parseHistoryArchive, serializeHistory } from './webdav';
import type { HistoryEntry } from './types';

function entry(id: string, createdAt: string): HistoryEntry {
  return {
    id,
    url: `https://t.me/channel/${id}`,
    channel: 'channel',
    createdAt,
    post: { channel: 'channel', messageId: Number(id) || 1, url: `https://t.me/channel/${id}`, author: '频道', publishedAt: createdAt, text: '主贴', hasMedia: false },
    comments: [{ id: `comment-${id}`, author: '用户', publishedAt: createdAt, text: '评论' }],
    warnings: [],
    fetchedAt: createdAt,
    summary: { question: '问题', consensus: [{ text: '共识', evidence: [{ commentId: `comment-${id}`, author: '用户', quote: '评论' }] }], disagreements: [], recommendations: [], limitations: [] },
  };
}

describe('WebDAV history archive', () => {
  it('merges by id, keeps the newer entry, and caps at 500 records', () => {
    const local = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) => entry(String(index), `2026-08-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`));
    const remote = [entry('0', '2027-01-01T00:00:00.000Z'), entry('new', '2028-01-01T00:00:00.000Z')];
    const merged = mergeHistory(local, remote);
    expect(merged).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(merged[0].id).toBe('new');
    expect(merged.find((item) => item.id === '0')?.createdAt).toBe('2027-01-01T00:00:00.000Z');
    expect(mergeHistory([entry('duplicate', '2026-01-01T00:00:00.000Z'), entry('duplicate', '2025-01-01T00:00:00.000Z')], [])).toHaveLength(1);
  });

  it('round-trips comments and evidence without sensitive settings', () => {
    const payload = serializeHistory([entry('1', '2026-08-12T00:00:00.000Z')]);
    const parsed = parseHistoryArchive(payload);
    expect(parsed.entries[0].comments[0].text).toBe('评论');
    expect(parsed.entries[0].summary.consensus[0]).toMatchObject({ text: '共识' });
    expect(payload).not.toContain('apiKey');
    expect(payload).not.toContain('password');
  });

  it('rejects malformed archives', () => {
    expect(() => parseHistoryArchive('{"version": 1}')).toThrow(WebDavError);
    expect(() => parseHistoryArchive('not-json')).toThrow('不是有效 JSON');
  });
});
