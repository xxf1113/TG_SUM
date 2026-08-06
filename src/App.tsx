import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ExternalLink,
  FileText,
  Link2,
  LoaderCircle,
  MessageCircle,
  Quote,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { deleteHistory, listHistory, saveHistory } from './lib/history';
import type { HistoryEntry, SummaryItem, SummaryResult, SummarySectionItem, TelegramPreview } from './types';

type BusyAction = 'preview' | 'summary' | null;

async function requestJson<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || '请求失败。');
  return data;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatDate(value?: string): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function normalizeSummaryItem(item: SummarySectionItem): SummaryItem {
  return typeof item === 'string' ? { text: item, evidence: [] } : item;
}

function ResultSection({ title, items, tone }: { title: string; items: SummarySectionItem[]; tone: 'teal' | 'amber' | 'coral' | 'slate' }) {
  const normalizedItems = items.map(normalizeSummaryItem);
  return (
    <section className={`result-section ${tone}`}>
      <div className="result-section-title"><span className="section-dot" />{title}</div>
      {normalizedItems.length ? <ul>{normalizedItems.map((item, index) => <li key={`${item.text}-${index}`}><div className="result-item-text">{item.text}</div>{item.evidence.length > 0 && <div className="evidence-list"><div className="evidence-label"><Quote size={13} />评论依据</div>{item.evidence.map((evidence, evidenceIndex) => <div className="evidence-item" key={`${evidence.commentId}-${evidenceIndex}`}><strong>{evidence.author}</strong><span>“{evidence.quote}”</span></div>)}</div>}</li>)}</ul> : <p className="empty-copy">暂无明确内容</p>}
    </section>
  );
}

function App() {
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<TelegramPreview | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState('');
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listHistory().then(setHistory).catch(() => undefined);
  }, []);

  const sourceLabel = useMemo(() => preview ? `${preview.post.channel} / 帖子 ${preview.post.messageId}` : '等待公开帖子', [preview]);

  async function summarizePreview(nextPreview: TelegramPreview, requestUrl: string, signal: AbortSignal) {
    const result = await requestJson<SummaryResult>('/api/summary', { preview: nextPreview }, signal);
    setSummary(result);
    const entry: HistoryEntry = {
      id: `${nextPreview.post.channel}-${nextPreview.post.messageId}-${Date.now()}`,
      url: requestUrl,
      channel: nextPreview.post.channel,
      createdAt: new Date().toISOString(),
      post: nextPreview.post,
      comments: nextPreview.comments,
      warnings: nextPreview.warnings,
      fetchedAt: nextPreview.fetchedAt,
      summary: result,
    };
    await saveHistory(entry);
    setHistory(await listHistory());
    setActiveHistoryId(entry.id);
  }

  async function handlePreview() {
    const requestUrl = url.trim();
    if (!requestUrl || busy) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusy('preview');
    setError('');
    setSummary(null);
    setPreview(null);
    setActiveHistoryId(null);
    try {
      const nextPreview = await requestJson<TelegramPreview>('/api/telegram/preview', { url: requestUrl }, controller.signal);
      setPreview(nextPreview);
      setBusy('summary');
      await summarizePreview(nextPreview, requestUrl, controller.signal);
    } catch (err) {
      setError(isAbortError(err) ? '已取消当前请求。' : err instanceof Error ? err.message : '抓取失败，请稍后重试。');
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setBusy(null);
    }
  }

  function cancelRequest() {
    abortControllerRef.current?.abort();
  }

  async function openHistory(entry: HistoryEntry) {
    if (busy) return;
    setUrl(entry.url);
    setSummary(entry.summary);
    setActiveHistoryId(entry.id);
    setError('');

    if (entry.comments !== undefined) {
      setPreview({ post: entry.post, comments: entry.comments, warnings: entry.warnings ?? [], fetchedAt: entry.fetchedAt ?? entry.createdAt });
      return;
    }

    setPreview({ post: entry.post, comments: [], warnings: ['正在为旧历史记录重新抓取公开评论。'], fetchedAt: entry.createdAt });
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusy('preview');
    try {
      const refreshed = await requestJson<TelegramPreview>('/api/telegram/preview', { url: entry.url }, controller.signal);
      setPreview(refreshed);
      await saveHistory({ ...entry, comments: refreshed.comments, warnings: refreshed.warnings, fetchedAt: refreshed.fetchedAt });
      setHistory(await listHistory());
    } catch (err) {
      setPreview({ post: entry.post, comments: [], warnings: ['旧历史记录未保存评论，重新抓取失败，请重新输入链接抓取。'], fetchedAt: entry.createdAt });
      setError(isAbortError(err) ? '已取消重新抓取评论。' : err instanceof Error ? err.message : '重新抓取评论失败，请稍后重试。');
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setBusy(null);
    }
  }

  async function removeHistory(id: string) {
    await deleteHistory(id);
    setHistory(await listHistory());
    if (activeHistoryId === id) {
      setActiveHistoryId(null);
      setSummary(null);
      setPreview(null);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><span>ThreadBrief</span><em>TELEGRAM</em></div>
        <div className="privacy-note"><span className="privacy-dot" />本地运行 · 不保存服务器历史</div>
      </header>

      <main className="page-content">
        <section className="hero-row">
          <div>
            <p className="eyebrow">PUBLIC THREAD READER</p>
            <h1>把一条帖子，读成<br /><span>清晰的答案。</span></h1>
            <p className="hero-copy">粘贴公开 Telegram 帖子链接，先查看主贴和答复，再提炼共识、分歧与建议。</p>
          </div>
          <div className="hero-stat"><span>01</span><p>公开链接<br />即时整理</p></div>
        </section>

        <section className="input-bar" aria-label="Telegram 链接输入">
          <div className="input-icon"><Link2 size={19} /></div>
          <input value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handlePreview(); }} placeholder="https://t.me/channel/123" aria-label="Telegram 帖子链接" />
          {busy ? <><button className="primary-button progress-button" disabled><LoaderCircle className="spin" size={17} />{busy === 'preview' ? '正在抓取' : '正在总结'}</button><button className="cancel-button" onClick={cancelRequest} title="取消当前请求"><Square size={15} />取消</button></> : <button className="primary-button" onClick={() => void handlePreview()} disabled={!url.trim()}><ArrowRight size={17} />抓取并总结</button>}
        </section>

        {error && <div className="alert error-alert"><AlertTriangle size={18} /><span>{error}</span><button className="icon-button" title="关闭提示" onClick={() => setError('')}>×</button></div>}

        <div className="content-grid">
          <details className="reader-panel">
            <summary className="panel-heading reader-toggle">
              <div><p className="panel-kicker">SOURCE MATERIAL</p><h2>帖子内容</h2></div>
              <div className="reader-heading-actions">
                {preview && <a className="external-link" href={preview.post.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>打开原帖 <ExternalLink size={14} /></a>}
                <ChevronDown className="reader-chevron" size={18} aria-hidden="true" />
              </div>
            </summary>

            {!preview ? (
              <div className="empty-state"><div className="empty-icon"><FileText size={25} /></div><h3>从一条公开帖子开始</h3><p>输入链接后，这里会显示主贴正文与公开答复。</p></div>
            ) : (
              <>
                <div className="post-meta"><span className="channel-pill">@{preview.post.channel}</span><span>{formatDate(preview.post.publishedAt)}</span><span>{sourceLabel}</span></div>
                <article className="post-text">{preview.post.text}</article>
                {preview.post.hasMedia && <div className="media-note"><FileText size={15} />{preview.post.mediaLabel || '包含媒体附件，当前仅分析文字内容'}</div>}
                <div className="comments-heading"><div><MessageCircle size={17} /><strong>评论答复</strong><span>{preview.comments.length}{preview.post.commentCount ? ` / ${preview.post.commentCount}` : ''}</span></div><span className="visible-label">公开可见</span></div>
                {preview.comments.length ? <div className="comment-list">{preview.comments.map((comment) => <div className="comment-item" key={comment.id + comment.text}><div className="comment-avatar">{comment.author.slice(0, 1)}</div><div className="comment-body"><div className="comment-meta"><strong>{comment.author}</strong><time>{formatDate(comment.publishedAt)}</time></div><p>{comment.text}</p></div></div>)}</div> : <div className="no-comments">没有抓取到公开评论内容。</div>}
                {preview.warnings.map((warning) => <div className="alert warning-alert" key={warning}><AlertTriangle size={16} /><span>{warning}</span></div>)}
              </>
            )}
          </details>

          <section className="summary-panel">
            <div className="panel-heading"><div><p className="panel-kicker">AI SYNTHESIS</p><h2>总结结果</h2></div>{summary && <span className="ready-badge"><CheckCircle2 size={14} />已完成</span>}</div>
            {!summary ? <div className="summary-empty"><div className="summary-orbit"><Sparkles size={24} /></div><h3>等待一条值得总结的讨论</h3><p>生成后会把零散答复整理成问题、共识、分歧和建议。</p></div> : <div className="result-content"><div className="question-block"><span>主贴在问什么</span><h3>{summary.question}</h3></div><ResultSection title="评论区共识" items={summary.consensus} tone="teal" /><ResultSection title="观点分歧" items={summary.disagreements} tone="amber" /><ResultSection title="关键建议" items={summary.recommendations} tone="coral" />{summary.limitations.length > 0 && <ResultSection title="数据限制" items={summary.limitations} tone="slate" />}<div className="result-footer"><CheckCircle2 size={15} />内容根据当前公开可见帖子与评论生成</div></div>}
          </section>
        </div>

        <section className="history-section">
          <div className="history-heading"><div><p className="panel-kicker">LOCAL ARCHIVE</p><h2>最近总结</h2></div><span><Clock3 size={15} />{history.length} / 20</span></div>
          {history.length ? <div className="history-list">{history.map((entry) => <div className={`history-item ${activeHistoryId === entry.id ? 'active' : ''}`} key={entry.id} onClick={() => void openHistory(entry)}><div className="history-channel">@{entry.channel}</div><div className="history-question">{entry.summary.question}</div><time>{formatDate(entry.createdAt)}</time><button className="icon-button danger" title="删除历史记录" onClick={(event) => { event.stopPropagation(); void removeHistory(entry.id); }}><Trash2 size={16} /></button></div>)}</div> : <div className="history-empty"><Clock3 size={17} />完成第一次总结后，结果会出现在这里。</div>}
        </section>
      </main>
      <footer className="footer"><span>ThreadBrief</span><span>仅处理公开 Telegram 页面 · 由 OpenAI 生成总结</span><button className="refresh-button" title="重新读取本地历史" onClick={() => listHistory().then(setHistory)}><RefreshCw size={14} /></button></footer>
    </div>
  );
}

export default App;
