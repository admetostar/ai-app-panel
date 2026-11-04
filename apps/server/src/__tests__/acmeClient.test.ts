import { afterEach, describe, expect, it } from 'vitest';
import { axios } from 'acme-client';

const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

describe('ACME HTTP client error handling', () => {
  it('preserves network errors without an HTTP response', async () => {
    const networkError = Object.assign(new Error('original network failure'), {
      code: 'ECONNABORTED',
    });

    axios.defaults.adapter = async (config) => {
      Object.assign(networkError, { config });
      throw networkError;
    };

    await expect(axios.get('https://example.invalid')).rejects.toBe(networkError);
  });
});
