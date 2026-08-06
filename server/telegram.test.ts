import { describe, expect, it } from 'vitest';
import { getTelegramProxyUrl, normalizeTelegramUrl, parseCommentsPage, parsePostPage, stripHtml } from './telegram';

describe('normalizeTelegramUrl', () => {
  it('normalizes public t.me post links', () => {
    expect(normalizeTelegramUrl('https://t.me/s/example_channel/42?comment=99')).toEqual({
      channel: 'example_channel',
      messageId: 42,
      publicUrl: 'https://t.me/s/example_channel/42',
    });
  });

  it('rejects private channel paths and unrelated hosts', () => {
    expect(() => normalizeTelegramUrl('https://t.me/c/123/42')).toThrow('只支持公开');
    expect(() => normalizeTelegramUrl('https://example.com/foo/42')).toThrow('只支持公开');
  });
});

describe('Telegram proxy configuration', () => {
  it('uses the explicit Telegram proxy setting', () => {
    const original = process.env.TELEGRAM_PROXY_URL;
    process.env.TELEGRAM_PROXY_URL = 'http://127.0.0.1:7890';
    expect(getTelegramProxyUrl()).toBe('http://127.0.0.1:7890');
    if (original === undefined) delete process.env.TELEGRAM_PROXY_URL;
    else process.env.TELEGRAM_PROXY_URL = original;
  });
});

describe('telegram html parsing', () => {
  const postHtml = `
    <div class="tgme_widget_message_wrap" data-post="example_channel/42">
      <div class="tgme_widget_message_owner_name"><span>Example Channel</span></div>
      <time datetime="2026-08-04T12:00:00+00:00">04 Aug</time>
      <div class="tgme_widget_message_text">这是主贴<br>需要大家回答 &amp; 讨论。</div>
      <a class="tgme_widget_message_replies" href="https://t.me/example_channel/42?comment=9">12 replies</a>
      <div class="tgme_widget_message_photo_wrap"></div>
    </div>`;

  it('cleans entities and line breaks', () => {
    expect(stripHtml('<p>A &amp; B</p><br> C')).toBe('A & B\n\nC');
  });

  it('parses post metadata, replies url and media marker', () => {
    const parsed = parsePostPage(postHtml, { channel: 'example_channel', messageId: 42, publicUrl: 'https://t.me/s/example_channel/42' });
    expect(parsed.post.text).toContain('这是主贴');
    expect(parsed.post.hasMedia).toBe(true);
    expect(parsed.post.commentCount).toBe(12);
    expect(parsed.repliesUrl).toContain('comment=9');
  });

  it('deduplicates repeated ids but keeps same-text comments from different users', () => {
    const html = `
      <div class="tgme_widget_message_wrap" data-post="example_channel/42"><div class="tgme_widget_message_text">主贴</div></div>
      <div class="tgme_widget_message_wrap" data-post="discussion/1"><span class="tgme_widget_message_owner_name">甲</span><div class="tgme_widget_message_text">同一个答案</div></div>
      <div class="tgme_widget_message_wrap" data-post="discussion/1"><span class="tgme_widget_message_owner_name">甲</span><div class="tgme_widget_message_text">同一个答案</div></div>
      <div class="tgme_widget_message_wrap" data-post="discussion/2"><span class="tgme_widget_message_owner_name">乙</span><div class="tgme_widget_message_text">同一个答案</div></div>
      <div class="tgme_widget_message_wrap" data-post="discussion/3"><div class="tgme_widget_message_text"></div></div>`;
    const comments = parseCommentsPage(html, 'example_channel/42');
    expect(comments).toHaveLength(2);
    expect(comments[0].text).toBe('同一个答案');
    expect(comments[1].text).toBe('同一个答案');
  });

  it('uses text as a fallback when a comment has no stable id', () => {
    const html = `
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message_text">没有 ID 的评论</div></div>
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message_text">没有 ID 的评论</div></div>`;
    expect(parseCommentsPage(html, 'example_channel/42')).toHaveLength(1);
  });

  it('parses discussion-widget comments and their author ids', () => {
    const html = `
      <div class="tme_messages_more js-messages_more" data-before="100"></div>
      <div class="tgme_widget_message_wrap js-widget_message_wrap">
        <div class="tgme_widget_message" data-post-id="99">
          <span class="tgme_widget_message_author_name">评论用户</span>
          <time datetime="2026-08-04T13:00:00+00:00"></time>
          <div class="tgme_widget_message_text js-message_text">这是评论内容</div>
        </div>
      </div>`;
    const comments = parseCommentsPage(html, 'example_channel/42');
    expect(comments).toEqual([
      { id: '99', author: '评论用户', publishedAt: '2026-08-04T13:00:00+00:00', text: '这是评论内容' },
    ]);
  });
});
