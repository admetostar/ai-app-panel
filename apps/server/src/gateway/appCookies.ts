export function appCookieHeader(cookieHeader: string | undefined, platformCookieName: string): string | undefined {
  const cookies = (cookieHeader ?? '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      const separator = cookie.indexOf('=');
      return separator > 0 && cookie.slice(0, separator).trim() !== platformCookieName;
    });
  return cookies.length ? cookies.join('; ') : undefined;
}

export function safeAppSetCookies(
  value: string | string[] | undefined,
  secure: boolean,
  platformCookieName: string,
): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((header) => {
    const [cookie, ...rawAttributes] = header.split(';');
    const separator = cookie?.indexOf('=') ?? -1;
    const name = separator > 0 ? cookie!.slice(0, separator).trim() : '';
    if (!cookie || !name || name === platformCookieName) return [];
    let hasSameSite = false;
    const attributes = rawAttributes.flatMap((attribute) => {
      const trimmed = attribute.trim();
      const [rawKey, rawValue] = trimmed.split('=', 2);
      const key = rawKey?.toLowerCase();
      if (key === 'domain' || key === 'path' || key === 'secure') return [];
      if (key === 'samesite' && rawValue !== undefined) {
        hasSameSite = true;
        if (!secure && rawValue?.trim().toLowerCase() === 'none') return ['SameSite=Lax'];
      }
      return [trimmed];
    });
    attributes.push('Path=/');
    if (!hasSameSite) attributes.push('SameSite=Lax');
    if (secure) attributes.push('Secure');
    return [[cookie.trim(), ...attributes.map((attribute) => attribute.trim())].join('; ')];
  });
}
