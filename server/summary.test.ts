import { afterEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { classifyOpenAIError, DEFAULT_OPENAI_BASE_URL, getOpenAIBaseUrl, normalizeSummaryResult } from './summary';

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

describe('OpenAI error classification', () => {
  it('distinguishes authentication, quota, model and structured output errors', () => {
    const headers = new Headers();
    expect(classifyOpenAIError(OpenAI.APIError.generate(401, { error: { message: 'invalid api key' } }, undefined, headers)).code).toBe('OPENAI_AUTH_FAILED');
    expect(classifyOpenAIError(OpenAI.APIError.generate(429, { error: { code: 'insufficient_quota' } }, undefined, headers)).code).toBe('OPENAI_INSUFFICIENT_QUOTA');
    expect(classifyOpenAIError(OpenAI.APIError.generate(404, { error: { message: 'model not found' } }, undefined, headers)).code).toBe('OPENAI_MODEL_NOT_FOUND');
    expect(classifyOpenAIError(OpenAI.APIError.generate(400, { error: { message: 'response_format json_schema is not supported' } }, undefined, headers)).code).toBe('OPENAI_STRUCTURED_OUTPUT_UNSUPPORTED');
  });

  it('distinguishes request timeouts', () => {
    expect(classifyOpenAIError(new OpenAI.APIConnectionTimeoutError()).code).toBe('OPENAI_TIMEOUT');
  });
});

describe('summary evidence normalization', () => {
  it('keeps evidence tied to fetched comments and replaces inaccurate quotes', () => {
    const comments = [{ id: 'discussion/1', author: '甲', publishedAt: '', text: '建议先备份数据再操作。' }];
    const result = normalizeSummaryResult({
      question: '应该怎么做？',
      consensus: [{ text: '先备份数据。', evidence: [{ commentId: 'discussion/1', quote: '不存在的原文' }, { commentId: 'fake/2', quote: '伪造引用' }] }],
      disagreements: [],
      recommendations: [],
      limitations: [],
    }, comments);

    expect(result?.consensus[0]).toEqual({
      text: '先备份数据。',
      evidence: [{ commentId: 'discussion/1', author: '甲', quote: '建议先备份数据再操作。' }],
    });
  });
});
