import { Capacitor, registerPlugin } from '@capacitor/core';
import type { SummaryMessage } from '../../shared/summary';
import type { WebDavMethod, WebDavSettings } from '../../shared/webdav';

export interface NativeSettings {
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
}

export interface NativeHtmlResponse {
  status: number;
  body: string;
}

export interface NativeWebDavResponse {
  status: number;
  body: string;
}

interface ThreadBriefNativePlugin {
  requestHtml(options: { url: string; requestId: string }): Promise<NativeHtmlResponse>;
  chatJson(options: {
    baseUrl: string;
    model: string;
    messages: SummaryMessage[];
    responseFormat: unknown;
    requestId: string;
  }): Promise<{ content: string }>;
  getSettings(): Promise<NativeSettings>;
  saveSettings(options: { apiKey?: string; baseUrl: string; model: string }): Promise<void>;
  clearSettings(): Promise<void>;
  getWebDavSettings(): Promise<WebDavSettings>;
  saveWebDavSettings(options: { serverUrl: string; remotePath: string; username: string; password?: string }): Promise<void>;
  clearWebDavSettings(): Promise<void>;
  requestWebDav(options: { method: WebDavMethod; body?: string; requestId: string }): Promise<NativeWebDavResponse>;
  cancel(options: { requestId: string }): Promise<void>;
}

export const ThreadBriefNative = registerPlugin<ThreadBriefNativePlugin>('ThreadBriefNative');

export function isAndroidRuntime(): boolean {
  return Capacitor.getPlatform() === 'android';
}

function makeRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function abortError(): DOMException {
  return new DOMException('Request cancelled.', 'AbortError');
}

function normalizeNativeError(error: unknown): Error {
  if (error instanceof Error) return error;
  const value = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : {};
  const normalized = new Error(typeof value.message === 'string' ? value.message : 'Android 原生请求失败。');
  if (typeof value.code === 'string') normalized.name = value.code;
  return normalized;
}

async function callNative<T>(call: (requestId: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const requestId = makeRequestId();
  if (signal?.aborted) throw abortError();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void ThreadBriefNative.cancel({ requestId }).catch(() => undefined);
      reject(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    void call(requestId).then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }).catch((error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(normalizeNativeError(error));
    });
  });
}

export function requestNativeHtml(url: string, signal?: AbortSignal): Promise<NativeHtmlResponse> {
  return callNative((requestId) => ThreadBriefNative.requestHtml({ url, requestId }), signal);
}

export function requestNativeChatJson(
  options: Omit<Parameters<ThreadBriefNativePlugin['chatJson']>[0], 'requestId'>,
  signal?: AbortSignal,
): Promise<{ content: string }> {
  return callNative((requestId) => ThreadBriefNative.chatJson({ ...options, requestId }), signal);
}

export function getNativeSettings(): Promise<NativeSettings> {
  return ThreadBriefNative.getSettings();
}

export function saveNativeSettings(options: { apiKey?: string; baseUrl: string; model: string }): Promise<void> {
  return ThreadBriefNative.saveSettings(options);
}

export function clearNativeSettings(): Promise<void> {
  return ThreadBriefNative.clearSettings();
}

export function getNativeWebDavSettings(): Promise<WebDavSettings> {
  return ThreadBriefNative.getWebDavSettings();
}

export function saveNativeWebDavSettings(options: { serverUrl: string; remotePath: string; username: string; password?: string }): Promise<void> {
  return ThreadBriefNative.saveWebDavSettings(options);
}

export function clearNativeWebDavSettings(): Promise<void> {
  return ThreadBriefNative.clearWebDavSettings();
}

export function requestNativeWebDav(options: Omit<Parameters<ThreadBriefNativePlugin['requestWebDav']>[0], 'requestId'>, signal?: AbortSignal): Promise<NativeWebDavResponse> {
  return callNative((requestId) => ThreadBriefNative.requestWebDav({ ...options, requestId }), signal);
}
