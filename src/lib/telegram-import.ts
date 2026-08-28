import { normalizeTelegramUrl } from '../../shared/telegram';

export const TELEGRAM_IMPORT_PARAM = 'telegram';

export function parseTelegramImport(search: string): string | null {
  const value = new URLSearchParams(search).get(TELEGRAM_IMPORT_PARAM);
  if (value === null) return null;
  if (!value.trim()) throw new Error('INVALID_TELEGRAM_IMPORT');
  const link = normalizeTelegramUrl(value);
  return `https://t.me/${link.channel}/${link.messageId}`;
}

export function removeTelegramImport(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(TELEGRAM_IMPORT_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
