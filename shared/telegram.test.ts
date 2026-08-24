import { describe, expect, it } from 'vitest';
import { fetchTelegramPreview } from './telegram';

describe('shared Telegram preview flow', () => {
  it('fetches the post and discussion comments through an injected page transport', async () => {
    const requests: string[] = [];
    const postHtml = `
      <div class="tgme_widget_message_wrap" data-post="example_channel/42">
        <div class="tgme_widget_message_owner_name"><span>频道</span></div>
        <time datetime="2026-08-04T12:00:00+00:00">04 Aug</time>
        <div class="tgme_widget_message_text">主贴内容</div>
        <a class="tgme_widget_message_replies" href="https://t.me/example_channel/42?comment=9">2 replies</a>
      </div>`;
    const discussionHtml = `
      <div class="tgme_post_discussion"></div>
      <div class="tgme_widget_message_wrap" data-post="discussion/1">
        <span class="tgme_widget_message_owner_name">用户 A</span>
        <div class="tgme_widget_message_text">评论内容</div>
      </div>`;
    const preview = await fetchTelegramPreview('https://t.me/example_channel/42', async (url) => {
      requests.push(url);
      return url.includes('discussion=1') ? discussionHtml : postHtml;
    });

    expect(preview.post.text).toBe('主贴内容');
    expect(preview.comments).toEqual([{ id: 'discussion/1', author: '用户 A', publishedAt: '', text: '评论内容' }]);
    expect(requests[0]).toBe('https://t.me/s/example_channel/42');
  });

  it('normalizes case-insensitive channel names before fetching', async () => {
    const requests: string[] = [];
    const html = `
      <div class="tgme_widget_message_wrap" data-post="example_channel/42">
        <div class="tgme_widget_message_text">主贴内容</div>
      </div>`;

    const preview = await fetchTelegramPreview('https://t.me/Example_Channel/42', async (url) => {
      requests.push(url);
      return html;
    });

    expect(requests[0]).toBe('https://t.me/s/example_channel/42');
    expect(preview.post.channel).toBe('example_channel');
    expect(preview.post.text).toBe('主贴内容');
  });
});
