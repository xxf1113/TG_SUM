export interface TelegramPost {
  channel: string;
  messageId: number;
  url: string;
  author: string;
  publishedAt: string;
  text: string;
  hasMedia: boolean;
  mediaLabel?: string;
  commentCount?: number;
}

export interface TelegramComment {
  id: string;
  author: string;
  publishedAt: string;
  text: string;
}

export interface TelegramPreview {
  post: TelegramPost;
  comments: TelegramComment[];
  warnings: string[];
  fetchedAt: string;
}

export interface SummaryEvidence {
  commentId: string;
  author: string;
  quote: string;
}

export interface SummaryItem {
  text: string;
  evidence: SummaryEvidence[];
}

export type SummarySectionItem = SummaryItem | string;

export interface SummaryResult {
  question: string;
  consensus: SummarySectionItem[];
  disagreements: SummarySectionItem[];
  recommendations: SummarySectionItem[];
  limitations: string[];
}

export interface HistoryEntry {
  id: string;
  url: string;
  channel: string;
  createdAt: string;
  post: TelegramPost;
  comments: TelegramComment[];
  warnings: string[];
  fetchedAt: string;
  summary: SummaryResult;
}
