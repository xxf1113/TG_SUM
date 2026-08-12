import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardPaste,
  ChevronDown,
  ChevronUp,
  Cloud,
  Clock3,
  ExternalLink,
  FileText,
  Github,
  Link2,
  LoaderCircle,
  MessageCircle,
  Quote,
  RefreshCw,
  Search,
  Save,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from '../shared/summary';
import { DEFAULT_WEBDAV_PATH, MAX_HISTORY_ENTRIES, WebDavError, buildWebDavFileUrl, mergeHistory, normalizeWebDavPath, normalizeWebDavServerUrl, parseHistoryArchive, serializeHistory, webDavStatusError, type WebDavSettings } from '../shared/webdav';
import { deleteHistory, listHistory, replaceHistory, saveHistory, searchHistory } from './lib/history';
import { isStandaloneAndroid, runtimeApi, type RuntimeSettings } from './lib/runtime';
import type { HistoryEntry, SummaryItem, SummaryResult, SummarySectionItem, TelegramPreview } from './types';

type BusyAction = 'preview' | 'summary' | null;
const HISTORY_PREVIEW_COUNT = 5;

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
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_OPENAI_BASE_URL);
  const [model, setModel] = useState(DEFAULT_OPENAI_MODEL);
  const [webDavSettings, setWebDavSettings] = useState<WebDavSettings | null>(null);
  const [webDavOpen, setWebDavOpen] = useState(false);
  const [webDavBusy, setWebDavBusy] = useState(false);
  const [webDavError, setWebDavError] = useState('');
  const [webDavStatus, setWebDavStatus] = useState('');
  const [webDavServerUrl, setWebDavServerUrl] = useState('');
  const [webDavRemotePath, setWebDavRemotePath] = useState(DEFAULT_WEBDAV_PATH);
  const [webDavUsername, setWebDavUsername] = useState('');
  const [webDavPassword, setWebDavPassword] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listHistory().then(setHistory).catch(() => undefined);
    runtimeApi.getSettings().then((nextSettings) => {
      setSettings(nextSettings);
      setBaseUrl(nextSettings.baseUrl);
      setModel(nextSettings.model);
      if (isStandaloneAndroid && !nextSettings.hasApiKey) setSettingsOpen(true);
    }).catch(() => {
      if (isStandaloneAndroid) setSettingsError('无法读取 Android 本地配置，请重启应用后重试。');
    });
    runtimeApi.getWebDavSettings().then(setWebDavSettings).catch(() => undefined);
  }, []);

  const sourceLabel = useMemo(() => preview ? `${preview.post.channel} / 帖子 ${preview.post.messageId}` : '等待公开帖子', [preview]);
  const historySearchActive = historyQuery.trim().length > 0;
  const filteredHistory = useMemo(() => searchHistory(history, historyQuery), [history, historyQuery]);
  const visibleHistory = historySearchActive ? filteredHistory : historyExpanded ? history : history.slice(0, HISTORY_PREVIEW_COUNT);

  async function summarizePreview(nextPreview: TelegramPreview, requestUrl: string, signal: AbortSignal) {
    const result = await runtimeApi.summary(nextPreview, signal);
    setSummary(result);
    const entry: HistoryEntry = {
      id: `telegram-${encodeURIComponent(nextPreview.post.channel)}-${nextPreview.post.messageId}`,
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

  function openSettings() {
    setSettingsError('');
    setSettingsOpen(true);
  }

  async function saveSettingsForm() {
    const nextBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const nextModel = model.trim();
    const nextApiKey = apiKey.trim();
    if (!nextApiKey && !settings?.hasApiKey) {
      setSettingsError('请输入 OpenAI API Key。');
      return;
    }
    try {
      const parsedBaseUrl = new URL(nextBaseUrl);
      if (parsedBaseUrl.protocol !== 'https:') throw new Error('OpenAI Base URL 必须使用 HTTPS。');
      if (!nextModel) throw new Error('请输入模型名称。');
      setSettingsBusy(true);
      await runtimeApi.saveSettings({ apiKey: nextApiKey || undefined, baseUrl: nextBaseUrl, model: nextModel });
      const nextSettings = await runtimeApi.getSettings();
      setSettings(nextSettings);
      setApiKey('');
      setBaseUrl(nextSettings.baseUrl);
      setModel(nextSettings.model);
      setSettingsError('');
      setSettingsOpen(false);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '保存配置失败，请重试。');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function clearSettings() {
    try {
      setSettingsBusy(true);
      await runtimeApi.clearSettings();
      const nextSettings = await runtimeApi.getSettings();
      setSettings(nextSettings);
      setApiKey('');
      setBaseUrl(nextSettings.baseUrl);
      setModel(nextSettings.model);
      setSettingsError('已清除本地 API Key。');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '清除配置失败，请重试。');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function openWebDavSettings() {
    setWebDavError('');
    try {
      const nextSettings = await runtimeApi.getWebDavSettings();
      setWebDavSettings(nextSettings);
      setWebDavServerUrl(nextSettings.serverUrl);
      setWebDavRemotePath(nextSettings.remotePath || DEFAULT_WEBDAV_PATH);
      setWebDavUsername(nextSettings.username);
      setWebDavPassword('');
      setWebDavOpen(true);
    } catch (err) {
      setWebDavError(err instanceof Error ? err.message : '无法读取 WebDAV 配置。');
      setWebDavOpen(true);
    }
  }

  async function saveWebDavForm() {
    try {
      const nextServerUrl = normalizeWebDavServerUrl(webDavServerUrl);
      const nextRemotePath = normalizeWebDavPath(webDavRemotePath);
      buildWebDavFileUrl(nextServerUrl, nextRemotePath);
      if (!webDavUsername.trim()) throw new WebDavError('请输入 WebDAV 用户名。', 'WEBDAV_INVALID_SETTINGS');
      if (!webDavPassword.trim() && !webDavSettings?.hasPassword) throw new WebDavError('请输入 WebDAV 密码。', 'WEBDAV_INVALID_SETTINGS');
      setWebDavBusy(true);
      await runtimeApi.saveWebDavSettings({ serverUrl: nextServerUrl, remotePath: nextRemotePath, username: webDavUsername.trim(), password: webDavPassword.trim() || undefined });
      const nextSettings = await runtimeApi.getWebDavSettings();
      setWebDavSettings(nextSettings);
      setWebDavPassword('');
      setWebDavError('');
      setWebDavOpen(false);
      setWebDavStatus('WebDAV 配置已保存。');
    } catch (err) {
      setWebDavError(err instanceof Error ? err.message : '保存 WebDAV 配置失败，请重试。');
    } finally {
      setWebDavBusy(false);
    }
  }

  async function clearWebDav() {
    try {
      setWebDavBusy(true);
      await runtimeApi.clearWebDavSettings();
      const nextSettings = await runtimeApi.getWebDavSettings();
      setWebDavSettings(nextSettings);
      setWebDavServerUrl('');
      setWebDavRemotePath(DEFAULT_WEBDAV_PATH);
      setWebDavUsername('');
      setWebDavPassword('');
      setWebDavError('');
      setWebDavStatus('WebDAV 配置已清除。');
    } catch (err) {
      setWebDavError(err instanceof Error ? err.message : '清除 WebDAV 配置失败，请重试。');
    } finally {
      setWebDavBusy(false);
    }
  }

  async function syncWebDav() {
    if (webDavBusy || busy) return;
    const currentSettings = webDavSettings ?? await runtimeApi.getWebDavSettings().catch(() => null);
    if (!currentSettings?.serverUrl || !currentSettings.hasPassword) {
      await openWebDavSettings();
      return;
    }
    const controller = new AbortController();
    setWebDavBusy(true);
    setWebDavError('');
    setWebDavStatus('正在读取 WebDAV 历史…');
    try {
      const remoteResponse = await runtimeApi.requestWebDav({ method: 'GET' }, controller.signal);
      let remoteEntries: HistoryEntry[] = [];
      let invalidEntries = 0;
      if (remoteResponse.status !== 404) {
        if (remoteResponse.status < 200 || remoteResponse.status >= 300) throw webDavStatusError(remoteResponse.status);
        const parsed = parseHistoryArchive(remoteResponse.body);
        remoteEntries = parsed.entries;
        invalidEntries = parsed.invalidEntries;
      }
      const localEntries = await listHistory();
      const mergedEntries = mergeHistory(localEntries, remoteEntries);
      setWebDavStatus('正在上传合并后的历史…');
      const uploadResponse = await runtimeApi.requestWebDav({ method: 'PUT', body: serializeHistory(mergedEntries) }, controller.signal);
      if (uploadResponse.status < 200 || uploadResponse.status >= 300) throw webDavStatusError(uploadResponse.status);
      await replaceHistory(mergedEntries);
      setHistory(await listHistory());
      setWebDavStatus(`同步完成：共 ${mergedEntries.length} 条${invalidEntries ? `，忽略 ${invalidEntries} 条无效远程记录` : ''}。`);
    } catch (err) {
      setWebDavError(err instanceof Error ? err.message : 'WebDAV 同步失败，请稍后重试。');
      setWebDavStatus('');
    } finally {
      setWebDavBusy(false);
    }
  }

  async function handlePreview() {
    const requestUrl = url.trim();
    if (!requestUrl || busy) return;
    if (isStandaloneAndroid && !settings?.hasApiKey) {
      setSettingsError('请先保存 OpenAI API Key。');
      setSettingsOpen(true);
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusy('preview');
    setError('');
    setSummary(null);
    setPreview(null);
    setActiveHistoryId(null);
    try {
      const nextPreview = await runtimeApi.preview(requestUrl, controller.signal);
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

  async function pasteUrl() {
    try {
      const pastedUrl = (await navigator.clipboard.readText()).trim();
      if (!pastedUrl) {
        setError('剪贴板没有可粘贴的内容。');
        return;
      }
      setUrl(pastedUrl);
      setError('');
    } catch {
      setError('无法读取剪贴板，请允许剪贴板权限后重试。');
    }
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
      const refreshed = await runtimeApi.preview(entry.url, controller.signal);
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

  function clearHistorySearch() {
    setHistoryQuery('');
    setHistoryExpanded(false);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><span>ThreadBrief</span><em>TELEGRAM</em></div>
        <div className="topbar-actions"><a className="github-button" href="https://github.com/xxf1113/TG_SUM" target="_blank" rel="noreferrer" title="打开 GitHub 项目" aria-label="打开 GitHub 项目"><Github size={16} />GitHub</a><button className="settings-button" onClick={() => void openWebDavSettings()} title="打开 WebDAV 配置" aria-label="打开 WebDAV 配置"><Cloud size={17} /></button>{isStandaloneAndroid && <button className="settings-button" onClick={openSettings} title="打开 Android 配置" aria-label="打开 Android 配置"><Settings size={17} /></button>}</div>
      </header>

      {webDavOpen && <div className="settings-backdrop" role="presentation">
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="webdav-title">
          <div className="settings-heading"><div><p className="panel-kicker">WEBDAV SYNC</p><h2 id="webdav-title">WebDAV 同步</h2></div><button className="icon-button" onClick={() => setWebDavOpen(false)} title="关闭 WebDAV 配置" aria-label="关闭 WebDAV 配置"><X size={18} /></button></div>
          <p className="settings-copy">只同步“最近总结”中的最近 {MAX_HISTORY_ENTRIES} 条帖子记录。API Key、OpenAI 配置和 WebDAV 密码不会写入远程文件。</p>
          <label className="settings-field"><span>WebDAV 地址</span><input value={webDavServerUrl} onChange={(event) => setWebDavServerUrl(event.target.value)} inputMode="url" placeholder="https://dav.example.com/remote.php/dav/files/user" /></label>
          <label className="settings-field"><span>远程文件路径</span><input value={webDavRemotePath} onChange={(event) => setWebDavRemotePath(event.target.value)} placeholder={DEFAULT_WEBDAV_PATH} /></label>
          <label className="settings-field"><span>用户名</span><input value={webDavUsername} onChange={(event) => setWebDavUsername(event.target.value)} autoComplete="username" /></label>
          <label className="settings-field"><span>密码 {webDavSettings?.hasPassword && <em>已保存，留空表示保持不变</em>}</span><input type="password" value={webDavPassword} onChange={(event) => setWebDavPassword(event.target.value)} autoComplete="current-password" placeholder={webDavSettings?.hasPassword ? '已保存的密码' : '请输入 WebDAV 密码'} /></label>
          {webDavError && <div className="alert error-alert settings-alert"><AlertTriangle size={16} /><span>{webDavError}</span></div>}
          <div className="settings-actions"><button className="text-button danger-text" onClick={() => void clearWebDav()} disabled={webDavBusy || !webDavSettings?.serverUrl}>清除配置</button><span /><button className="secondary-button" onClick={() => setWebDavOpen(false)} disabled={webDavBusy}>取消</button><button className="primary-button" onClick={() => void saveWebDavForm()} disabled={webDavBusy}><Save size={16} />{webDavBusy ? '保存中' : '保存配置'}</button></div>
        </section>
      </div>}

      {settingsOpen && isStandaloneAndroid && <div className="settings-backdrop" role="presentation">
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="settings-heading"><div><p className="panel-kicker">ANDROID CONFIGURATION</p><h2 id="settings-title">应用配置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} title="关闭配置" aria-label="关闭配置"><X size={18} /></button></div>
          <p className="settings-copy">API Key 只保存于本机的 Android 加密存储中，不会写入网页历史或应用资源。</p>
          <label className="settings-field"><span>OpenAI API Key {settings?.hasApiKey && <em>已保存，留空表示保持不变</em>}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder={settings?.hasApiKey ? '已保存的 Key' : 'sk-...'} /></label>
          <label className="settings-field"><span>OpenAI Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} inputMode="url" placeholder={DEFAULT_OPENAI_BASE_URL} /></label>
          <label className="settings-field"><span>模型名称</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder={DEFAULT_OPENAI_MODEL} /></label>
          {settingsError && <div className="alert error-alert settings-alert"><AlertTriangle size={16} /><span>{settingsError}</span></div>}
          <div className="settings-actions"><button className="text-button danger-text" onClick={() => void clearSettings()} disabled={settingsBusy || !settings?.hasApiKey}>清除 Key</button><span /><button className="secondary-button" onClick={() => setSettingsOpen(false)} disabled={settingsBusy}>取消</button><button className="primary-button" onClick={() => void saveSettingsForm()} disabled={settingsBusy}><Save size={16} />{settingsBusy ? '保存中' : '保存配置'}</button></div>
        </section>
      </div>}

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
          {busy ? <><button className="primary-button progress-button" disabled><LoaderCircle className="spin" size={17} />{busy === 'preview' ? '正在抓取' : '正在总结'}</button><button className="cancel-button" onClick={cancelRequest} title="取消当前请求"><Square size={15} />取消</button></> : <><button className="secondary-button paste-button" onClick={() => void pasteUrl()} title="从剪贴板粘贴"><ClipboardPaste size={17} />粘贴</button><button className="primary-button" onClick={() => void handlePreview()} disabled={!url.trim()}><ArrowRight size={17} />抓取并总结</button></>}
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
          <div className="history-heading"><div><p className="panel-kicker">LOCAL ARCHIVE</p><h2>最近总结</h2></div><div className="history-heading-actions"><label className="history-search"><Search size={15} /><input value={historyQuery} onChange={(event) => { setHistoryQuery(event.target.value); if (!event.target.value.trim()) setHistoryExpanded(false); }} placeholder="搜索历史帖子" aria-label="搜索历史帖子" />{historySearchActive && <button type="button" className="history-search-clear" onClick={clearHistorySearch} title="清除搜索" aria-label="清除搜索"><X size={14} /></button>}</label><span><Clock3 size={15} />{historySearchActive ? `${filteredHistory.length} / ${history.length}` : `${history.length} / ${MAX_HISTORY_ENTRIES}`}</span><button className="secondary-button history-sync-button" onClick={() => void syncWebDav()} disabled={webDavBusy || Boolean(busy)} title="读取并合并 WebDAV 历史"><Cloud size={15} />{webDavBusy ? '同步中' : 'WebDAV 同步'}</button></div></div>
          {webDavStatus && <div className="webdav-status"><Cloud size={15} /><span>{webDavStatus}</span></div>}
          {webDavError && !webDavOpen && <div className="alert error-alert webdav-alert"><AlertTriangle size={16} /><span>{webDavError}</span><button className="icon-button" title="关闭提示" onClick={() => setWebDavError('')}>×</button></div>}
          {visibleHistory.length ? <><div className="history-list">{visibleHistory.map((entry) => <div className={`history-item ${activeHistoryId === entry.id ? 'active' : ''}`} key={entry.id} onClick={() => void openHistory(entry)}><div className="history-channel">@{entry.channel}</div><div className="history-question">{entry.summary.question}</div><time>{formatDate(entry.createdAt)}</time><button className="icon-button danger" title="删除历史记录" onClick={(event) => { event.stopPropagation(); void removeHistory(entry.id); }}><Trash2 size={16} /></button></div>)}</div>{!historySearchActive && history.length > HISTORY_PREVIEW_COUNT && <button className="history-expand-button" onClick={() => setHistoryExpanded((expanded) => !expanded)} aria-expanded={historyExpanded}>{historyExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}{historyExpanded ? '收起' : '展开'}<span>{historyExpanded ? '' : `（还有 ${history.length - HISTORY_PREVIEW_COUNT} 条）`}</span></button>}</> : historySearchActive ? <div className="history-empty"><Search size={17} />没有找到匹配的历史帖子。</div> : <div className="history-empty"><Clock3 size={17} />完成第一次总结后，结果会出现在这里。</div>}
        </section>
      </main>
      <footer className="footer"><span>ThreadBrief</span><span>仅处理公开 Telegram 页面 · 由 OpenAI 生成总结</span><button className="refresh-button" title="重新读取本地历史" onClick={() => listHistory().then(setHistory)}><RefreshCw size={14} /></button></footer>
    </div>
  );
}

export default App;
