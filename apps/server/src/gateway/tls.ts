/**
 * HTTPS 证书管理（B3）：
 *  - 手动 PEM 上传 + 原子替换 + setSecureContext 热替换（移植自参考实现 lib/tls.js）
 *  - ACME 自动签发（Cloudflare DNS-01）+ 到期前自动续期
 *  - 纯门户模式：无证书时不启 HTTPS（反代外置给已有 Caddy/nginx）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import type { Express } from 'express';
import type { Server as HttpsServer } from 'node:https';
import { config } from '../config/index.js';
import { audit } from '../lib/audit.js';
import { setSecureCookie } from '../lib/session.js';
import { enableHsts, disableHsts } from '../lib/securityHeaders.js';
import { getSetting, getSettingBool } from '../lib/settings.js';

const TLS_DIR = path.join(config.dataDir, 'tls');
const CERT_FILE = path.join(TLS_DIR, 'cert.pem');
const KEY_FILE = path.join(TLS_DIR, 'key.pem');
const ACCOUNT_KEY_FILE = path.join(TLS_DIR, 'acme-account.key');

let httpsServer: HttpsServer | null = null;
let mainApp: Express | null = null;
let upgradeHandler: ((req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void) | null = null;
let lastAcmeError: string | null = null;
let lastAcmeSuccessAt: number | null = null;
let listenPortOverride: number | null = null;

export interface CertInfo {
  subject: string;
  issuer: string;
  domains: string[];
  validFrom: string;
  validTo: string;
  expired: boolean;
  daysRemaining: number;
  fingerprint: string;
}

/** 校验 PEM 并返回证书信息；不合法时抛错（message 面向管理员） */
export function validate(certPem: string, keyPem: string): CertInfo {
  let cert: crypto.X509Certificate;
  try {
    cert = new crypto.X509Certificate(certPem);
  } catch {
    throw new Error('证书不是有效的 PEM 格式（X.509）');
  }
  let pub: crypto.KeyObject;
  try {
    pub = crypto.createPublicKey(keyPem);
  } catch {
    throw new Error('私钥不是有效的 PEM 格式');
  }
  // 配对校验：公钥导出字节必须一致
  if (
    !cert.publicKey ||
    Buffer.compare(pub.export({ type: 'spki', format: 'der' }), cert.publicKey.export({ type: 'spki', format: 'der' })) !== 0
  ) {
    throw new Error('证书与私钥不配对');
  }
  const validTo = new Date(cert.validTo).getTime();
  const domains = [...(cert.subjectAltName ?? '').matchAll(/DNS:([^,]+)/g)]
    .map((match) => match[1]?.trim())
    .filter((domain): domain is string => Boolean(domain));
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    domains,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    expired: validTo <= Date.now(),
    daysRemaining: Math.floor((validTo - Date.now()) / 86_400_000),
    fingerprint: cert.fingerprint,
  };
}

function readStored(): { cert: string; key: string } | null {
  try {
    return { cert: fs.readFileSync(CERT_FILE, 'utf8'), key: fs.readFileSync(KEY_FILE, 'utf8') };
  } catch {
    return null;
  }
}

export interface TlsStatus {
  installed: boolean;
  httpsEnabled: boolean;
  mode: 'off' | 'manual' | 'acme';
  domain: string | null;
  email: string | null;
  wildcard: boolean;
  staging: boolean;
  dnsConfigured: boolean;
  httpsPort: number;
  cert: CertInfo | null;
  error?: string;
  acme: {
    inProgress: boolean;
    phase: 'preparing' | 'account' | 'dns' | 'validating' | 'installing' | null;
    lastError: string | null;
    lastSuccessAt: number | null;
  };
}

export function tlsMode(): 'off' | 'manual' | 'acme' {
  const domain = getSetting('ACME_DOMAIN');
  if (domain) return 'acme';
  if (readStored()) return 'manual';
  return 'off';
}

export function status(): TlsStatus {
  const stored = readStored();
  const mode = tlsMode();
  const base = {
    httpsEnabled: Boolean(httpsServer),
    mode,
    domain: getSetting('ACME_DOMAIN') || null,
    email: getSetting('ACME_EMAIL') || null,
    wildcard: getSettingBool('ACME_WILDCARD', true),
    staging: getSettingBool('ACME_STAGING', false),
    dnsConfigured: Boolean(getSetting('ACME_CLOUDFLARE_ZONE_ID') && getSetting('ACME_CLOUDFLARE_API_TOKEN')),
    httpsPort: config.httpsPort,
    cert: null as CertInfo | null,
    acme: {
      inProgress: acmeInProgress,
      phase: acmePhase,
      lastError: lastAcmeError,
      lastSuccessAt: lastAcmeSuccessAt,
    },
  };
  if (!stored) return { installed: false, ...base };
  try {
    return { installed: true, ...base, cert: validate(stored.cert, stored.key) };
  } catch (err) {
    return { installed: true, ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 跳转用 HTTPS 端口号 */
export function httpsPortNumber(): number {
  return config.httpsPort;
}

/** 关停 HTTPS server（进程退出用） */
export function stop(): void {
  if (httpsServer) {
    try {
      httpsServer.closeAllConnections();
    } catch {
      /* ignore */
    }
    httpsServer.close();
    httpsServer = null;
  }
}

/** 由 server.ts 注入主 app 与 upgrade 处理器（HTTPS server 复用整棵中间件栈与 WS 通道） */
export function init(
  app: Express,
  onUpgrade: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void,
  port?: number,
): void {
  mainApp = app;
  upgradeHandler = onUpgrade;
  listenPortOverride = port ?? null;
}

/** 当前 HTTPS 监听端口（未启用为 null；测试用临时端口时返回实际端口） */
export function httpsAddress(): number | null {
  if (!httpsServer) return null;
  const addr = httpsServer.address();
  return typeof addr === 'object' && addr !== null ? addr.port : null;
}

/** 启动或热替换 HTTPS 上下文；返回 httpsServer 或 null（损坏时抛错由调用方兜底） */
export function apply(): HttpsServer | null {
  const stored = readStored();
  if (!stored || !mainApp) {
    setSecureCookie(null);
    disableHsts();
    return null;
  }
  const info = validate(stored.cert, stored.key); // 损坏/不匹配时抛错
  const opts = { cert: stored.cert, key: stored.key };
  enableHsts(false); // HTTPS 实际生效：全站响应挂 HSTS（主域；子域未必全 HTTPS 不默认 include）
  if (httpsServer) {
    httpsServer.setSecureContext(opts); // 热替换，不中断现有连接
    return httpsServer;
  }
  const server = https.createServer(opts, mainApp);
  if (upgradeHandler) server.on('upgrade', upgradeHandler); // WS 双通道之一（B2）
  server.on('error', (err) => {
    console.error('[tls] HTTPS 服务错误:', err.message);
    if ('code' in err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (httpsServer === server) httpsServer = null;
    }
  });
  httpsServer = server;
  server.listen(listenPortOverride ?? config.httpsPort, () => {
    console.log(`[tls] HTTPS 已启用: https://localhost:${config.httpsPort}（HTTPS_PORT 可覆盖）`);
    console.log(`[tls] 证书: ${info.subject}（剩余 ${info.daysRemaining} 天）`);
  });
  setSecureCookie(true); // SESSION_SECURE auto：HTTPS 启用后 cookie 自动 Secure
  return server;
}

/** 上传 PEM 并立即生效 */
export async function installManual(certPem: string, keyPem: string): Promise<CertInfo> {
  const info = validate(certPem, keyPem);
  fs.mkdirSync(TLS_DIR, { recursive: true });
  // 先写临时文件再原子替换，避免半写状态
  const tmpCert = CERT_FILE + '.tmp';
  const tmpKey = KEY_FILE + '.tmp';
  fs.writeFileSync(tmpCert, certPem, { mode: 0o644 });
  fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 }); // 私钥仅属主可读
  fs.renameSync(tmpCert, CERT_FILE);
  fs.renameSync(tmpKey, KEY_FILE);
  apply();
  await audit('system', null, 'tls.cert.installed', { subject: info.subject, daysRemaining: info.daysRemaining });
  return info;
}

/** 删除证书并停止 HTTPS 服务 */
export async function remove(): Promise<void> {
  try {
    fs.rmSync(CERT_FILE, { force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(KEY_FILE, { force: true });
  } catch {
    /* ignore */
  }
  if (httpsServer) {
    const s = httpsServer;
    httpsServer = null;
    try {
      s.closeAllConnections(); // 立即断开 keep-alive，确保端口释放
    } catch {
      /* ignore */
    }
    s.close(() => console.log('[tls] HTTPS 服务已停止'));
  }
  setSecureCookie(false);
  disableHsts();
  await audit('system', null, 'tls.cert.removed', {});
}

// ---------- ACME（acme-client v5，Cloudflare DNS-01） ----------

let acmeInProgress = false;
let acmePhase: 'preparing' | 'account' | 'dns' | 'validating' | 'installing' | null = null;
const cloudflareRecordIds = new Map<string, string>();
const acmePhaseLabels = {
  preparing: '准备签发',
  account: '连接证书服务',
  dns: '创建 DNS 验证记录',
  validating: '等待域名验证',
  installing: '安装并启用证书',
} as const;

function formatErrorDetail(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  const message = `${error.message || error.name}${code && !error.message.includes(code) ? ` [${code}]` : ''}`;
  if (depth >= 3) return message;
  if (error instanceof AggregateError) {
    const errors = [...error.errors]
      .slice(0, 4)
      .map((inner) => formatErrorDetail(inner, depth + 1));
    if (errors.length) return `${message}: ${errors.join('; ')}`;
  }
  if (error.cause === undefined || error.cause === error) return message;
  return `${message}; 原因：${formatErrorDetail(error.cause, depth + 1)}`;
}

interface CloudflareApiResponse<T> {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
}

async function cloudflareRequest<T>(
  apiToken: string,
  path: string,
  init: { method: 'POST' | 'DELETE'; body?: Record<string, unknown> },
): Promise<T> {
  const { axios } = await import('acme-client');
  axios.defaults.family = 4;
  const url = `https://api.cloudflare.com/client/v4${path}`;
  let responseData: CloudflareApiResponse<T> | string;
  let status: number;
  try {
    const response = await axios.request<CloudflareApiResponse<T> | string>({
      url,
      method: init.method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      data: init.body,
      timeout: 10_000,
      validateStatus: () => true,
    });
    responseData = response.data;
    status = response.status;
  } catch (error) {
    throw new Error(`Cloudflare DNS API request failed (${init.method} ${path})`, { cause: error });
  }
  let payload = responseData;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as CloudflareApiResponse<T>;
    } catch {
      throw new Error(`Cloudflare DNS API returned invalid JSON (HTTP ${status})`);
    }
  }
  if (status < 200 || status >= 300 || payload.success !== true || payload.result === undefined) {
    const details = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
    throw new Error(`Cloudflare DNS API failed (HTTP ${status})${details ? `: ${details}` : ''}`);
  }
  return payload.result;
}

/** Create the exact DNS-01 TXT record and retain its ID for safe, scoped cleanup. */
export async function createCloudflareDnsChallenge(
  authz: { identifier: { value: string } },
  challenge: { type: string; token: string },
  dnsAuthorization: string,
  zoneId: string,
  apiToken: string,
): Promise<void> {
  if (challenge.type !== 'dns-01') throw new Error('Cloudflare DNS integration only supports dns-01 challenges');
  const identifier = authz.identifier.value.replace(/^\*\./, '');
  const name = `_acme-challenge.${identifier}`;
  const result = await cloudflareRequest<{ id?: string }>(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
    method: 'POST',
    body: { type: 'TXT', name, content: dnsAuthorization, ttl: 60 },
  });
  if (!result.id) throw new Error('Cloudflare DNS API did not return a record ID');
  cloudflareRecordIds.set(challenge.token, result.id);
}

/** Remove only the TXT record created for this challenge. */
export async function removeCloudflareDnsChallenge(
  challenge: { type: string; token: string },
  zoneId: string,
  apiToken: string,
): Promise<void> {
  if (challenge.type !== 'dns-01') return;
  const recordId = cloudflareRecordIds.get(challenge.token);
  if (!recordId) return;
  await cloudflareRequest<{ id?: string }>(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' },
  );
  cloudflareRecordIds.delete(challenge.token);
}

function accountKey(): Buffer {
  try {
    return fs.readFileSync(ACCOUNT_KEY_FILE);
  } catch {
    // acme-client 导出的 crypto.createPrivateKey 生成账户密钥
    return Buffer.alloc(0);
  }
}

/**
 * 使用 Cloudflare DNS-01 签发/续期根域名与通配符证书。完成后自动 apply()。
 */
export async function acmeIssue(domain: string, email: string): Promise<CertInfo> {
  if (acmeInProgress) throw new Error('已有签发任务进行中');
  acmeInProgress = true;
  acmePhase = 'preparing';
  lastAcmeError = null;
  try {
    const acme = await import('acme-client');
    // ECS may resolve an IPv6 address without having an IPv6 route.
    acme.axios.defaults.family = 4;
    let accountKeyBuf = accountKey();
    if (accountKeyBuf.length === 0) {
      accountKeyBuf = await acme.crypto.createPrivateKey();
      fs.mkdirSync(TLS_DIR, { recursive: true });
      fs.writeFileSync(ACCOUNT_KEY_FILE, accountKeyBuf, { mode: 0o600 });
    }

    const staging = getSettingBool('ACME_STAGING', false);
    const client = new acme.Client({
      directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
      accountKey: accountKeyBuf,
    });

    acmePhase = 'account';
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: [`mailto:${email}`],
    });

    // 注意：acme-client v5 createCsr 返回顺序是 [私钥, CSR]，与我们直觉相反
    const domains = [domain, `*.${domain}`];
    const [keyPemBuf, csrPemBuf] = await acme.crypto.createCsr({
      commonName: domain,
      altNames: domains,
    });

    const challengePriority = ['dns-01'];
    const zoneId = getSetting('ACME_CLOUDFLARE_ZONE_ID')?.trim() ?? '';
    const cloudflareToken = getSetting('ACME_CLOUDFLARE_API_TOKEN')?.trim() ?? '';
    if (!/^[a-f0-9]{32}$/i.test(zoneId) || !cloudflareToken) {
      throw new Error('通配符证书需要配置 Cloudflare Zone ID 和 API Token');
    }

    acmePhase = 'dns';
    const certPem = await client.auto({
      csr: csrPemBuf,
      email,
      termsOfServiceAgreed: true,
      challengePriority,
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        acmePhase = 'dns';
        await createCloudflareDnsChallenge(_authz, challenge, keyAuthorization, zoneId, cloudflareToken);
        acmePhase = 'validating';
      },
      challengeRemoveFn: async (_authz, challenge) => {
        await removeCloudflareDnsChallenge(challenge, zoneId, cloudflareToken);
      },
    });

    acmePhase = 'installing';
    fs.mkdirSync(TLS_DIR, { recursive: true });
    const keyPem = Buffer.isBuffer(keyPemBuf) ? keyPemBuf.toString('utf8') : String(keyPemBuf);
    fs.writeFileSync(CERT_FILE, certPem, { mode: 0o644 });
    fs.writeFileSync(KEY_FILE, keyPem, { mode: 0o600 });
    const info = validate(certPem, keyPem);
    apply();
    lastAcmeSuccessAt = Date.now();
    await audit('system', null, 'tls.cert.issued', { domain, wildcard: true, staging, daysRemaining: info.daysRemaining });
    return info;
  } catch (err) {
    const phase = acmePhase ?? 'preparing';
    lastAcmeError = `阶段「${acmePhaseLabels[phase]}」失败：${formatErrorDetail(err)}`;
    throw err;
  } finally {
    acmeInProgress = false;
    acmePhase = null;
  }
}

/** 续期循环：每日检查，ACME 模式且剩余 <30 天时重签 */
export function startRenewalLoop(): void {
  const run = async (): Promise<void> => {
    if (tlsMode() !== 'acme') return;
    const stored = readStored();
    if (stored) {
      try {
        const info = validate(stored.cert, stored.key);
        if (info.daysRemaining > 30) return;
      } catch {
        // 证书损坏 → 重签
      }
    }
    const domain = getSetting('ACME_DOMAIN');
    const email = getSetting('ACME_EMAIL');
    if (!domain || !email) return;
    void acmeIssue(domain, email).catch((err) => {
      console.error('[tls] ACME 自动续期失败:', lastAcmeError ?? formatErrorDetail(err));
    });
  };
  setInterval(run, 24 * 3600_000).unref();
  setTimeout(run, 30_000).unref();
}

/** 启动时恢复：有证书则拉起 HTTPS */
export function restore(): void {
  try {
    apply();
  } catch (err) {
    console.error('[tls] 证书恢复失败（HTTPS 未启用）:', err instanceof Error ? err.message : err);
  }
}
