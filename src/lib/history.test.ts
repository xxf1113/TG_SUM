import { describe, expect, it } from 'vitest';
import { searchHistory } from './history';
import type { HistoryEntry } from '../types';

function entry(): HistoryEntry {
  return {
    id: 'telegram-example-42',
    url: 'https://t.me/example/42',
    channel: 'ExampleChannel',
    createdAt: '2026-08-12T00:00:00.000Z',
    post: {
      channel: 'ExampleChannel',
      messageId: 42,
      url: 'https://t.me/example/42',
      author: '作者',
      publishedAt: '2026-08-12T00:00:00.000Z',
      text: '这是帖子正文',
      hasMedia: false,
    },
    comments: [{ id: 'comment-1', author: '评论者', publishedAt: '', text: '评论中的关键词' }],
    warnings: [],
    fetchedAt: '2026-08-12T00:00:00.000Z',
    summary: {
      question: '总结中的问题',
      consensus: [{ text: '共识内容', evidence: [{ commentId: 'comment-1', author: '评论者', quote: '证据引用' }] }],
      disagreements: ['分歧内容'],
      recommendations: ['建议内容'],
      limitations: ['数据限制'],
    },
  };
}

describe('history search', () => {
  it('matches all searchable history content case-insensitively', () => {
    const history = [entry()];

    for (const query of ['examplechannel', '帖子正文', '关键词', '总结中的问题', '共识内容', '分歧内容', '建议内容', '数据限制', '证据引用']) {
      expect(searchHistory(history, query)).toHaveLength(1);
    }
  });

  it('trims the query and returns all entries for an empty query', () => {
    const history = [entry()];

    expect(searchHistory(history, '  关键词  ')).toHaveLength(1);
    expect(searchHistory(history, '不存在的内容')).toHaveLength(0);
    expect(searchHistory(history, '   ')).toBe(history);
  });
});
