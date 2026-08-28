// ==UserScript==
// @name         TG 帖子总结一键发送
// @namespace    https://github.com/xxf1113/TG_SUM
// @version      1.0.0
// @description  将 Telegram Web A 的公开频道帖子发送到本地 TG 帖子总结项目
// @match        https://web.telegram.org/a/*
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_URL = 'http://127.0.0.1:5173/';
  const MESSAGE_SELECTOR = '#MiddleColumn .Message[data-message-id]';
  const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,}$/;
  const usernameByPeer = new Map();
  let scanQueued = false;
  let toastTimer;

  const style = document.createElement('style');
  style.textContent = `
    .threadbrief-action-group {
      display: flex !important;
      flex-direction: column !important;
      gap: 6px !important;
      height: auto !important;
    }
    .threadbrief-summary-button {
      flex: 0 0 36px !important;
      width: 36px !important;
      height: 36px !important;
      min-width: 36px !important;
      padding: 0 !important;
      font-family: Arial, sans-serif !important;
      font-size: 11px !important;
      font-weight: 800 !important;
      letter-spacing: 0 !important;
    }
    .threadbrief-summary-button[disabled] {
      cursor: wait !important;
      opacity: .7 !important;
    }
    #threadbrief-toast {
      position: fixed;
      z-index: 2147483647;
      left: 50%;
      bottom: 28px;
      max-width: min(420px, calc(100vw - 32px));
      padding: 10px 14px;
      color: #fff;
      background: rgba(24, 37, 43, .94);
      border: 1px solid rgba(255, 255, 255, .14);
      border-radius: 6px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .28);
      font: 13px/1.45 Arial, sans-serif;
      text-align: center;
      transform: translateX(-50%);
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function showToast(message) {
    let toast = document.getElementById('threadbrief-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'threadbrief-toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.remove(), 2600);
  }

  function activePeerId() {
    return document.querySelector('#MiddleColumn .ChatInfo [data-peer-id]')?.getAttribute('data-peer-id') || '';
  }

  function usernameFromText(value) {
    const text = value?.trim() || '';
    const match = text.match(/(?:https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/|^@)([a-zA-Z0-9_]{3,})(?:\/|$)/i);
    return match && USERNAME_PATTERN.test(match[1]) ? match[1].toLowerCase() : '';
  }

  function usernameFromCurrentRoute() {
    try {
      const route = decodeURIComponent(window.location.hash.slice(1));
      const parts = route.split('/').filter(Boolean);
      return parts.length >= 2 && USERNAME_PATTERN.test(parts.at(-2) || '') ? parts.at(-2).toLowerCase() : '';
    } catch {
      return '';
    }
  }

  function usernameFromPostLink(messageId) {
    for (const anchor of document.querySelectorAll('#MiddleColumn a[href]')) {
      try {
        const url = new URL(anchor.href);
        if (!['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(url.hostname.toLowerCase())) continue;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0]?.toLowerCase() === 's') parts.shift();
        if (parts.length !== 2 || Number(parts[1]) !== messageId || !USERNAME_PATTERN.test(parts[0])) continue;
        return parts[0].toLowerCase();
      } catch {
        // Ignore unrelated or malformed links in the message body.
      }
    }
    return '';
  }

  function channelInfoRoot() {
    return [...document.querySelectorAll('#RightColumn, aside, [role="dialog"], .popup, .modal')]
      .find((element) => isVisible(element) && !element.closest('.Message[data-message-id]')) || null;
  }

  function isChannelInfoOpen() {
    return Boolean(channelInfoRoot());
  }

  function usernameFromChannelInfo() {
    const root = channelInfoRoot();
    if (!root) return '';
    for (const element of root.querySelectorAll('a[href], [role="button"], [class*="title"], [class*="username"]')) {
      if (!isVisible(element)) continue;
      const username = usernameFromText(element.getAttribute('href')) || usernameFromText(element.textContent);
      if (username) return username;
    }
    return '';
  }

  function waitForChannelUsername(timeoutMs = 2500) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const username = usernameFromChannelInfo();
        if (username || Date.now() >= deadline) {
          resolve(username);
          return;
        }
        window.setTimeout(check, 60);
      };
      check();
    });
  }

  function closeChannelInfo() {
    const root = channelInfoRoot();
    const closeButton = root && [...root.querySelectorAll('button, [role="button"]')]
      .find((element) => isVisible(element) && /close|关闭|关闭面板|返回/i.test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.textContent || ''}`));
    closeButton?.click();
  }

  async function resolveUsername(messageId) {
    const peerId = activePeerId() || window.location.hash;
    const cached = peerId && usernameByPeer.get(peerId);
    if (cached) return cached;

    const linkedUsername = usernameFromPostLink(messageId) || usernameFromCurrentRoute();
    if (linkedUsername) {
      if (peerId) usernameByPeer.set(peerId, linkedUsername);
      return linkedUsername;
    }

    const panelWasOpen = isChannelInfoOpen();
    if (!panelWasOpen) {
      const chatInfo = document.querySelector('#MiddleColumn .ChatInfo');
      if (!(chatInfo instanceof HTMLElement)) return '';
      chatInfo.click();
    }

    try {
      const username = await waitForChannelUsername();
      if (username && peerId) usernameByPeer.set(peerId, username);
      return username;
    } finally {
      if (!panelWasOpen) closeChannelInfo();
    }
  }

  async function sendToThreadBrief(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const button = event.currentTarget;
    const message = button.closest('.Message[data-message-id]');
    const messageId = Number(message?.getAttribute('data-message-id'));
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      showToast('无法识别帖子 ID，仅支持公开频道帖子。');
      return;
    }

    button.disabled = true;
    button.textContent = '...';
    try {
      const username = await resolveUsername(messageId);
      if (!username) {
        showToast('无法识别公开频道用户名，仅支持公开频道帖子。');
        return;
      }
      const postUrl = `https://t.me/${username}/${messageId}`;
      const targetUrl = `${APP_URL}?telegram=${encodeURIComponent(postUrl)}`;
      GM_openInTab(targetUrl, { active: true, insert: true, setParent: true });
      showToast('已打开 TG 帖子总结。');
    } catch {
      showToast('发送失败，请稍后重试。');
    } finally {
      button.disabled = false;
      button.textContent = 'AI';
    }
  }

  function injectButton(message) {
    if (!(message instanceof HTMLElement) || !message.classList.contains('has-views')) return;
    const actionGroups = [...message.querySelectorAll('.message-action-buttons')];
    const actions = actionGroups.find((group) => group.querySelector('button[aria-label="Forward"]')) || actionGroups.at(-1);
    if (!actions || actions.querySelector('.threadbrief-summary-button')) return;

    actions.classList.add('threadbrief-action-group');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'Button message-action-button default translucent-white round threadbrief-summary-button';
    button.textContent = 'AI';
    button.title = '发送到 TG 帖子总结';
    button.setAttribute('aria-label', '发送到 TG 帖子总结');
    button.dataset.threadbriefInjected = 'true';
    button.addEventListener('click', sendToThreadBrief, true);
    actions.prepend(button);
  }

  function scanMessages() {
    scanQueued = false;
    document.querySelectorAll(MESSAGE_SELECTOR).forEach(injectButton);
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    window.requestAnimationFrame(scanMessages);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  scheduleScan();
})();
