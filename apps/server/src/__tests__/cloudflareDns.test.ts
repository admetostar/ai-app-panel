import { afterEach, describe, expect, it, vi } from 'vitest';
import { axios } from 'acme-client';
import * as tls from '../gateway/tls.js';

const originalAdapter = axios.defaults.adapter;
const originalFamily = axios.defaults.family;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  axios.defaults.family = originalFamily;
  vi.restoreAllMocks();
});

describe('Cloudflare DNS-01 challenge', () => {
  it('creates and removes only the TXT record created for the challenge', async () => {
    const requests: Array<{
      url?: string;
      method?: string;
      authorization?: unknown;
      data?: unknown;
      family?: unknown;
    }> = [];
    const results = [
      { status: 200, data: { success: true, result: { id: 'record-123' } } },
      { status: 200, data: { success: true, result: { id: 'record-123' } } },
    ];
    axios.defaults.adapter = async (config) => {
      requests.push({
        url: config.url,
        method: config.method,
        authorization: config.headers.get('Authorization'),
        data: config.data,
        family: config.family,
      });
      const result = results.shift()!;
      return { ...result, statusText: 'OK', headers: {}, config };
    };

    const authz = { identifier: { value: '*.example.com' } };
    const challenge = { type: 'dns-01', token: 'challenge-123' };
    await tls.createCloudflareDnsChallenge(authz, challenge, 'dns-authorization', 'zone-123', 'secret-api-token');
    await tls.removeCloudflareDnsChallenge(challenge, 'zone-123', 'secret-api-token');

    expect(requests[0]?.url).toBe('https://api.cloudflare.com/client/v4/zones/zone-123/dns_records');
    expect(requests[0]?.method).toBe('post');
    expect(requests[0]?.authorization).toBe('Bearer secret-api-token');
    expect(requests[0]?.data).toBe(
      JSON.stringify({ type: 'TXT', name: '_acme-challenge.example.com', content: 'dns-authorization', ttl: 60 }),
    );
    expect(requests[0]?.family).toBe(4);
    expect(requests[1]?.url).toBe('https://api.cloudflare.com/client/v4/zones/zone-123/dns_records/record-123');
    expect(requests[1]?.method).toBe('delete');
    expect(requests[1]?.family).toBe(4);
  });

  it('reports Cloudflare API errors without exposing the API token', async () => {
    axios.defaults.adapter = async (config) => ({
      data: { success: false, errors: [{ message: 'permission denied' }] },
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      config,
    });

    await expect(
      tls.createCloudflareDnsChallenge(
        { identifier: { value: 'example.com' } },
        { type: 'dns-01', token: 'challenge-456' },
        'dns-authorization',
        'zone-123',
        'secret-api-token',
      ),
    ).rejects.toThrow('Cloudflare DNS API failed (HTTP 403): permission denied');
  });

  it('preserves the underlying network error when the request fails', async () => {
    axios.defaults.adapter = async (config) => {
      throw Object.assign(new Error('network request aborted'), { code: 'ECONNABORTED', config });
    };

    let caught: unknown;
    try {
      await tls.createCloudflareDnsChallenge(
        { identifier: { value: 'example.com' } },
        { type: 'dns-01', token: 'challenge-789' },
        'dns-authorization',
        'zone-123',
        'secret-api-token',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error('Expected Cloudflare request to fail');
    expect(caught.message).toContain('Cloudflare DNS API request failed (POST /zones/zone-123/dns_records)');
    expect(caught.cause).toBeInstanceOf(Error);
    if (!(caught.cause instanceof Error)) throw new Error('Expected fetch error to be retained');
    expect(caught.cause.message).toBe('network request aborted');
    expect(caught.cause).toMatchObject({ code: 'ECONNABORTED' });
    expect(JSON.stringify(caught)).not.toContain('secret-api-token');
  });
});
