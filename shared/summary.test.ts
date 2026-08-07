import { describe, expect, it } from 'vitest';
import { buildSummaryRequest, summarizeTelegramPostWithCompletion } from './summary';

const post = {
  channel: 'example_channel',
  messageId: 42,
  url: 'https://t.me/example_channel/42',
  author: '频道',
  publishedAt: '',
  text: '主贴内容',
  hasMedia: false,
};

const comments = [{ id: 'discussion/1', author: '用户 A', publishedAt: '', text: '建议先备份数据。' }];

describe('shared summary flow', () => {
  it('builds a non-streaming structured-output request', () => {
    const request = buildSummaryRequest(post, comments, [], 'custom-model');
    expect(request.model).toBe('custom-model');
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1].content).toContain('主贴内容');
    expect(request.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('normalizes completion output and keeps verified evidence', async () => {
    const result = await summarizeTelegramPostWithCompletion(
      post,
      comments,
      [],
      async () => JSON.stringify({
        question: '应该怎么做？',
        consensus: [{ text: '先备份数据', evidence: [{ commentId: 'discussion/1', quote: '先备份数据' }] }],
        disagreements: [],
        recommendations: [],
        limitations: [],
      }),
    );

    expect(result.consensus[0]).toEqual({
      text: '先备份数据',
      evidence: [{ commentId: 'discussion/1', author: '用户 A', quote: '先备份数据' }],
    });
  });
});
