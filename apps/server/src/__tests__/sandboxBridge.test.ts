import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { sandboxBridgeClientJs, sandboxBridgeHostJs, sandboxShellHtml } from '../gateway/staticApp.js';

type BridgeMessage = { source: unknown; origin: string; data: unknown };

class FakeXHR {
  [key: string]: unknown;
  private listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    const handler = this[`on${event.type}`];
    if (typeof handler === 'function') handler.call(this, event);
    return true;
  }

  open(_method?: string, _url?: string): void {}
  send(_body?: unknown): void {}
  setRequestHeader(): void {}
  getResponseHeader(): null { return null; }
  getAllResponseHeaders(): string { return ''; }
  abort(): void {}
}

describe('沙箱应用请求桥', () => {
  it('桥接监听器在 iframe 启动前就注册，并在消息到达时定位 iframe', () => {
    const shell = sandboxShellHtml('usrhtml', '');
    expect(shell.indexOf('/portal-app-bridge-host.js')).toBeGreaterThan(-1);
    expect(shell.indexOf('/portal-app-bridge-host.js')).toBeLessThan(shell.indexOf('data-aap-app-frame'));
    expect(sandboxBridgeHostJs()).toContain("document.querySelector('[data-aap-app-frame]')");
  });

  it('沙箱外壳将查询参数安全地转发给 iframe', () => {
    const shell = sandboxShellHtml('usrhtml', 'settings', 'q=1&label=hello world');
    expect(shell).toContain('src="/app/usrhtml/raw/settings?q=1&amp;label=hello+world"');
  });

  it('fetch 与 XHR 可调用本应用接口，且父页拒绝应用外 URL', async () => {
    const origin = 'http://localhost';
    const appUrl = `${origin}/app/web-album/raw/index.html`;
    const hostListeners: Array<(event: BridgeMessage) => void> = [];
    const clientListeners: Array<(event: BridgeMessage) => void> = [];
    const fetched: string[] = [];
    const credentialsSeen: string[] = [];

    const parentWindow: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: BridgeMessage) => void) => hostListeners.push(listener),
    };
    const clientWindow: Record<string, unknown> = {
      parent: parentWindow,
      XMLHttpRequest: FakeXHR,
      addEventListener: (_type: string, listener: (event: BridgeMessage) => void) => clientListeners.push(listener),
      postMessage: (data: unknown) => setTimeout(() => {
        for (const listener of clientListeners) listener({ source: parentWindow, origin, data });
      }, 0),
    };
    const frame = { contentWindow: clientWindow };
    (parentWindow as { postMessage?: (data: unknown) => void }).postMessage = (data) => setTimeout(() => {
      for (const listener of hostListeners) listener({ source: clientWindow, origin: 'null', data });
    }, 0);

    const appFetch = async (input: string, init?: RequestInit): Promise<Response> => {
      fetched.push(input);
      credentialsSeen.push(String(init?.credentials));
      expect(init?.redirect).toBe('manual');
      return new Response(JSON.stringify({ url: new URL(input).pathname }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const shared = {
      AbortController,
      ArrayBuffer,
      Blob,
      Date,
      DOMException,
      Event,
      Headers,
      Map,
      Promise,
      Request: class extends Request {
        constructor(input: string | URL | Request, init?: RequestInit) {
          super(typeof input === 'string' ? new URL(input, appUrl).href : input, init);
        }
      },
      Response,
      Set,
      TextDecoder,
      URL,
      Uint8Array,
      clearTimeout,
      fetch: appFetch,
      setTimeout,
    };

    const hostContext = vm.createContext({
      ...shared,
      document: { currentScript: { dataset: { aapApp: 'web-album' } }, querySelector: () => frame },
      location: { origin },
      window: parentWindow,
    });
    vm.runInContext(sandboxBridgeHostJs(), hostContext);

    const clientContext = vm.createContext({
      ...shared,
      document: { currentScript: { dataset: { aapApp: 'web-album' } } },
      location: { href: appUrl },
      window: { ...clientWindow, fetch: appFetch },
    });
    vm.runInContext(sandboxBridgeClientJs(), clientContext);

    const bridgedFetch = (clientContext.window as { fetch: (url: string, init?: RequestInit) => Promise<Response> }).fetch;
    const response = await bridgedFetch('api/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: '/app/web-album/raw/api/' });
    expect(fetched).toHaveLength(1);
    expect(credentialsSeen).toEqual(['same-origin']);

    const xhr = new FakeXHR() as FakeXHR & { onload: (() => void) | null; status: number; responseText: string };
    const xhrDone = new Promise<void>((resolve) => { xhr.onload = resolve; });
    xhr.open('GET', 'api/');
    xhr.send();
    await xhrDone;
    expect(xhr.status).toBe(200);
    expect(JSON.parse(xhr.responseText)).toEqual({ url: '/app/web-album/raw/api/' });
    expect(fetched).toHaveLength(2);

    const sendHostRequest = (id: string, url: string, headers: string[][] = [], credentials?: string) => hostListeners[0]!({
      source: clientWindow,
      origin: 'null',
      data: {
        channel: 'aap-app-bridge',
        type: 'request',
        id,
        method: 'GET',
        url,
        headers,
        body: null,
        ...(credentials ? { credentials } : {}),
      },
    });
    sendHostRequest('old-client', `${origin}/app/web-album/raw/api/`, [['accept', '*/*']]);
    expect(fetched).toHaveLength(3);
    expect(credentialsSeen[2]).toBe('same-origin');
    sendHostRequest('outside-app', `${origin}/api/admin/apps`);
    sendHostRequest('path-traversal', `${origin}/app/web-album/raw/%2e%2e/%2e%2e/api/admin/apps`);
    sendHostRequest('auth-header', `${origin}/app/web-album/raw/api/`, [['authorization', 'Bearer secret']]);
    expect(fetched).toHaveLength(3);

    const omitResponse = await bridgedFetch('api/', { credentials: 'omit' });
    expect(omitResponse.status).toBe(200);
    expect(credentialsSeen).toEqual(['same-origin', 'same-origin', 'same-origin', 'omit']);
    expect(fetched).toHaveLength(4);
  });
});
