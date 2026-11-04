import { describe, expect, it } from 'vitest';
import { appIdFromHostname, isAppHostname } from '../gateway/appDomains.js';
import { appCookieHeader, safeAppSetCookies } from '../gateway/appCookies.js';

describe('应用子域名路由', () => {
  it('只匹配本站域名下的单层合法应用 ID', () => {
    expect(appIdFromHostname('photo.example.com', 'example.com')).toBe('photo');
    expect(appIdFromHostname('nested.photo.example.com', 'example.com')).toBe('');
    expect(appIdFromHostname('bad_id.example.com', 'example.com')).toBe('');
    expect(appIdFromHostname('example.com', 'example.com')).toBeNull();
    expect(appIdFromHostname(undefined, 'example.com')).toBeNull();
    expect(appIdFromHostname('', 'example.com')).toBeNull();
    expect(isAppHostname('photo.example.com', 'example.com')).toBe(true);
    expect(isAppHostname('portal.other.com', 'example.com')).toBe(false);
    expect(isAppHostname(undefined, 'example.com')).toBe(false);
  });

  it('平台会话 Cookie 不转发，应用 Cookie 限定为当前主机', () => {
    expect(appCookieHeader('aap_sid=platform; album=session', 'aap_sid')).toBe('album=session');
    expect(appCookieHeader('aap_sid=platform', 'aap_sid')).toBeUndefined();
    expect(safeAppSetCookies([
      'album=session; Domain=.example.com; Path=/; SameSite=None',
      'aap_sid=attacker; Domain=.example.com',
    ], true, 'aap_sid')).toEqual(['album=session; SameSite=None; Path=/; Secure']);
    expect(safeAppSetCookies(
      'album=session; Domain=.example.com; Path=/; SameSite=None; Secure',
      false,
      'aap_sid',
    )).toEqual(['album=session; SameSite=Lax; Path=/']);
  });
});
