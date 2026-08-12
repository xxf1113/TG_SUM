import { describe, expect, it } from 'vitest';
import { summaryToMarkdown } from './markdown';

describe('summaryToMarkdown', () => {
  it('renders summary sections, source metadata, and evidence', () => {
    const markdown = summaryToMarkdown({
      question: '应该怎么做？',
      consensus: [{ text: '先备份数据', evidence: [{ commentId: 'comment-1', author: '用户 A', quote: '建议先备份数据。' }] }],
      disagreements: ['有人建议直接重装。'],
      recommendations: [],
      limitations: ['只分析了公开评论。'],
    }, {
      channel: 'example',
      messageId: 42,
      url: 'https://t.me/example/42',
      author: '频道作者',
      publishedAt: '2026-08-12T00:00:00.000Z',
      text: '主贴内容',
      hasMedia: false,
    });

    expect(markdown).toContain('# Telegram 帖子总结');
    expect(markdown).toContain('- 来源：[@example / 帖子 42](https://t.me/example/42)');
    expect(markdown).toContain('  - 评论依据（用户 A）：“建议先备份数据。”');
    expect(markdown).toContain('## 数据限制\n- 只分析了公开评论。');
  });
});
