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

export interface SummaryResult {
  question: string;
  consensus: string[];
  disagreements: string[];
  recommendations: string[];
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
