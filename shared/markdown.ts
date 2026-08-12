import type { SummaryResult, SummarySectionItem, TelegramPost } from './types';

function markdownText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function sectionMarkdown(title: string, items: SummarySectionItem[]): string[] {
  const lines = [`## ${title}`];
  if (!items.length) return [...lines, '暂无明确内容', ''];

  for (const rawItem of items) {
    const item = typeof rawItem === 'string' ? { text: rawItem, evidence: [] } : rawItem;
    lines.push(`- ${markdownText(item.text).replace(/\n/g, '\n  ')}`);
    for (const evidence of item.evidence) {
      lines.push(`  - 评论依据（${markdownText(evidence.author)}）：“${markdownText(evidence.quote)}”`);
    }
  }
  return [...lines, ''];
}

export function summaryToMarkdown(summary: SummaryResult, post?: TelegramPost | null): string {
  const lines = ['# Telegram 帖子总结', ''];

  if (post) {
    lines.push(`- 来源：[${markdownText(`@${post.channel} / 帖子 ${post.messageId}`)}](${post.url})`);
    lines.push(`- 作者：${markdownText(post.author || '未知')}`);
    lines.push(`- 发布时间：${markdownText(post.publishedAt || '未知')}`);
    lines.push('');
  }

  lines.push('## 主贴在问什么', markdownText(summary.question), '');
  lines.push(...sectionMarkdown('评论区共识', summary.consensus));
  lines.push(...sectionMarkdown('观点分歧', summary.disagreements));
  lines.push(...sectionMarkdown('关键建议', summary.recommendations));
  if (summary.limitations.length) lines.push(...sectionMarkdown('数据限制', summary.limitations));

  return `${lines.join('\n').trim()}\n`;
}
