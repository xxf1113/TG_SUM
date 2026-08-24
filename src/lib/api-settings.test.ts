import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBrowserApiSettings,
  getBrowserApiRequestSettings,
  getBrowserApiSettings,
  saveBrowserApiSettings,
} from './api-settings';
import { buildSummaryRequestBody } from './runtime';
import type { TelegramPreview } from '../types';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const storage = new MemoryStorage();

afterEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
});

describe('browser API settings', () => {
  it('saves normalized settings and clears only the key', () => {
    vi.stubGlobal('localStorage', storage);
    saveBrowserApiSettings({ apiKey: '  key  ', baseUrl: 'https://relay.example/v1///', model: '  relay-model ' });

    expect(getBrowserApiSettings()).toEqual({ hasApiKey: true, baseUrl: 'https://relay.example/v1', model: 'relay-model' });
    expect(getBrowserApiRequestSettings()).toEqual({ apiKey: 'key', baseUrl: 'https://relay.example/v1', model: 'relay-model' });

    clearBrowserApiSettings();
    expect(getBrowserApiSettings().hasApiKey).toBe(false);
    expect(getBrowserApiRequestSettings()).toBeUndefined();
  });

  it('adds the complete custom configuration to summary requests', () => {
    vi.stubGlobal('localStorage', storage);
    const preview = {
      post: { channel: 'test', messageId: 1, url: 'https://t.me/test/1', author: 'test', publishedAt: '', text: 'test', hasMedia: false },
      comments: [],
      warnings: [],
      fetchedAt: '2026-08-24T00:00:00.000Z',
    } satisfies TelegramPreview;

    saveBrowserApiSettings({ apiKey: 'custom-key', baseUrl: 'https://custom.example/v1', model: 'custom-model' });
    expect(buildSummaryRequestBody(preview)).toEqual({ preview, apiKey: 'custom-key', baseUrl: 'https://custom.example/v1', model: 'custom-model' });
  });
});
