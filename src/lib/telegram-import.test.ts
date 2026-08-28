import { describe, expect, it } from 'vitest';
import { parseTelegramImport, removeTelegramImport } from './telegram-import';

describe('Telegram userscript import', () => {
  it.each([
    ['?telegram=https%3A%2F%2Ft.me%2FExample_Channel%2F42', 'https://t.me/example_channel/42'],
    ['?telegram=https%3A%2F%2Ft.me%2Fs%2FExample_Channel%2F42', 'https://t.me/example_channel/42'],
    ['?telegram=https%3A%2F%2Ft.me%2Fexample_channel%2F42%3Fcomment%3D9', 'https://t.me/example_channel/42'],
  ])('normalizes a public post link from %s', (search, expected) => {
    expect(parseTelegramImport(search)).toBe(expected);
  });

  it('returns null when the import parameter is absent', () => {
    expect(parseTelegramImport('?other=value')).toBeNull();
  });

  it.each([
    '?telegram=',
    '?telegram=not-a-url',
    '?telegram=https%3A%2F%2Fexample.com%2Fchannel%2F42',
    '?telegram=https%3A%2F%2Ft.me%2Fc%2F123%2F42',
  ])('rejects an invalid or private import from %s', (search) => {
    expect(() => parseTelegramImport(search)).toThrow();
  });

  it('removes only the consumed parameter and preserves the hash', () => {
    expect(removeTelegramImport('http://127.0.0.1:5173/?other=value&telegram=post#result'))
      .toBe('/?other=value#result');
  });
});
