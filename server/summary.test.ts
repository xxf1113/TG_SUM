import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OPENAI_BASE_URL, getOpenAIBaseUrl } from './summary';

const originalBaseUrl = process.env.OPENAI_BASE_URL;
const originalApiBase = process.env.OPENAI_API_BASE;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
  if (originalApiBase === undefined) delete process.env.OPENAI_API_BASE;
  else process.env.OPENAI_API_BASE = originalApiBase;
});

describe('OpenAI-compatible endpoint configuration', () => {
  it('uses the official API URL by default', () => {
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    expect(getOpenAIBaseUrl()).toBe(DEFAULT_OPENAI_BASE_URL);
  });

  it('uses OPENAI_BASE_URL and removes trailing slashes', () => {
    process.env.OPENAI_BASE_URL = 'https://relay.example.com/v1///';
    expect(getOpenAIBaseUrl()).toBe('https://relay.example.com/v1');
  });

  it('supports OPENAI_API_BASE as a compatibility alias', () => {
    delete process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_BASE = 'https://proxy.example.com/openai/v1';
    expect(getOpenAIBaseUrl()).toBe('https://proxy.example.com/openai/v1');
  });
});
