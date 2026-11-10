/**
 * 门户托管静态应用（P4）与应用统一页面元素（P3）。
 *  - kind='html'：门户直接托管 data/appsites/<id>/（简单 HTML 页 / .awpk html 包）
 *  - kind='package'：python 包等待运行时（M4），占位页
 *  - 统一页面元素：HTML 响应注入 /portal-chrome.js（返回超级面板），
 *    失败静默不阻断（W0 契约：包作者不得遮挡右上角）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import type { AppRow } from './registry.js';

export function appSiteDir(appId: string): string {
  return path.join(config.dataDir, 'appsites', appId);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 写入托管应用的入口 HTML（简单 HTML 页接入） */
export function writeHtmlApp(appId: string, html: string): void {
  const dir = appSiteDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  relaxDirForSandbox(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
}

/** 沙箱降权启用时（SANDBOX_UID），包目录须允许沙箱 uid 在其中创建 storage/ 与
 *  app.sqlite（runner 以沙箱 uid 自建这两者）。容器内仅 root 与 aap(10001) 两个
 *  uid，0777 的放宽面只在容器内部；未启用降权的部署保持默认 0755。 */
function relaxDirForSandbox(dir: string): void {
  if (!process.env.SANDBOX_UID) return;
  try {
    fs.chmodSync(dir, 0o777);
  } catch {
    /* 尽力而为：失败时降权沙箱将无法写入该包，运行报错可见 */
  }
}

/** AWPK 是 ZIP 容器；只允许规范 ZIP 签名，不支持旧 .awpk 文件格式。 */
export function isAwpkFilename(filename: unknown): filename is string {
  return typeof filename === 'string' && /\.awpk$/i.test(filename);
}

/** 解压 AWPK 到托管目录并提取 manifest；signature.json 仅作普通包文件处理。 */
export function storePackageFiles(
  appId: string,
  zipBuffer: Buffer,
): {
  files: number;
  manifest: Record<string, unknown>;
} {
  if (
    zipBuffer.length < 4 ||
    !(
      zipBuffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
      zipBuffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
      zipBuffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
    )
  ) {
    throw new Error('AWPK 内容必须是有效的 ZIP 容器');
  }
  // adm-zip 延迟加载（纯 JS，无原生依赖）
  const req = createRequire(import.meta.url);
  type ZipEntry = { entryName: string; isError: boolean; getData: () => Buffer; header?: { size?: number } };
  const AdmZip = req('adm-zip') as new (b: Buffer) => { getEntries(): ZipEntry[] };
  const zip = new AdmZip(zipBuffer);
  const dir = appSiteDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  relaxDirForSandbox(dir);
  let files = 0;
  let manifest: Record<string, unknown> | null = null;
  // 解压放大防护（zip 炸弹）：15MB 包体可声明任意解压体积——条目数与累计解压
  // 字节双上限，超限整包拒绝（目录就地清理，调用方 catch 转 PACKAGE_INVALID）
  const MAX_ENTRIES = 2000;
  const MAX_UNCOMPRESSED = 100 * 1024 * 1024;
  let processed = 0;
  let uncompressed = 0;
  const rejectPackage = (reason: string): never => {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(reason);
  };
  for (const entry of zip.getEntries()) {
    if (entry.isError) continue;
    if (++processed > MAX_ENTRIES) rejectPackage('包内条目数超过上限（2000）');
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.includes('..') || name.startsWith('/') || name.endsWith('/')) continue;
    const dest = path.join(dir, name);
    // 防压缩包路径逃逸：relative 结果必须是 dir 内部相对路径
    // （startsWith(dir) 缺路径分隔符，"x" 可匹配兄弟目录 "x-secret"，已实测绕过）
    const rel = path.relative(dir, dest);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // header 声明值先拒一遍，避免为判超限而先完整解压超大条目（声明可伪造，
    // 解压后按实际字节数复核才是权威判定）
    const declared = Number(entry.header?.size ?? 0);
    if (declared > MAX_UNCOMPRESSED || uncompressed + declared > MAX_UNCOMPRESSED) {
      rejectPackage('包解压后总大小超过上限（100MB），疑似压缩炸弹');
    }
    const content = entry.getData();
    uncompressed += content.length;
    if (uncompressed > MAX_UNCOMPRESSED) {
      rejectPackage('包解压后总大小超过上限（100MB），疑似压缩炸弹');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    files++;
    if (name === 'manifest.json') {
      try {
        manifest = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new Error('manifest.json 不是合法 JSON');
      }
    }
  }
  if (!manifest) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('包内缺少 manifest.json');
  }
  return { files, manifest };
}

// ---------- manifest.env：应用环境变量 / 机密声明（G6） ----------

export interface ManifestEnvVar {
  /** true = 沙箱启动前必须已配置（invoked 执行 / persistent 拉起前强校验） */
  required: boolean;
  /** true = 机密：AES-256-GCM 加密落盘，接口永不回明文（只回配置状态与尾 4 位） */
  secret: boolean;
  description: string;
  /** 简单校验正则（保存配置时执行 test；不锚定，作者自行写 ^ $） */
  pattern: string | null;
  /** 未配置时的注入默认值（secret 不允许 default） */
  default: string | null;
}

/** 沙箱注入面保留名：平台托管（AAP_* / PORT / AAP_DB_PATH…）或宿主透传（代理 / Python 运行时），
 *  包声明即拒绝——否则可劫持 egress 代理（HTTP_PROXY）、身份归因（AAP_TOKEN）等平台机制 */
const RESERVED_ENV_NAMES = new Set(
  [
    'PORT',
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'PYTHONUNBUFFERED',
    'PYTHONPATH',
    'PYTHONHOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SANDBOX_UID',
    'SANDBOX_GID',
    'NODE_OPTIONS',
  ].map((k) => k.toUpperCase()),
);

export const MAX_ENV_VARS = 16;
export const MAX_REQUIREMENTS = 32;

/** manifest.requirements —— pip 依赖声明（skill v0.2.6 声明制）：上传时平台安装到
 *  应用 .deps 目录，沙箱 PYTHONPATH 前置。仅接受「名称[extras] + 版本约束」形态，
 *  显式拒 URL(@)/本地路径/-r/-e（缩小安装期指令面）；配合 --only-binary=:all:
 *  只装 wheel，安装期不执行 sdist setup.py 任意代码。 */
export function parseRequirements(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('manifest.requirements 必须是字符串数组');
  if (value.length > MAX_REQUIREMENTS) throw new Error(`manifest.requirements 最多声明 ${MAX_REQUIREMENTS} 条依赖`);
  const out: string[] = [];
  for (const v of value) {
    const s = String(v).trim();
    const req =
      /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]*\])?(\s*(===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.!+*]+(\.[A-Za-z0-9.!+*]+)*(,\s*(===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.!+*]+(\.[A-Za-z0-9.!+*]+)*)*)?$/.exec(
        s,
      );
    if (!req) {
      throw new Error(`manifest.requirements 条目非法（仅支持 名称[extras] + 版本约束，不支持 URL / 本地路径）: ${s}`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** 解析并校验 manifest.env 声明；支持两种写法：
 *  "NAME": "描述"（速记，required=true） 或 "NAME": { required, secret, description, pattern, default } */
export function parseEnvSpec(value: unknown): Record<string, ManifestEnvVar> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest.env 必须是对象');
  const raw = value as Record<string, unknown>;
  const names = Object.keys(raw);
  if (names.length > MAX_ENV_VARS) throw new Error(`manifest.env 最多声明 ${MAX_ENV_VARS} 个变量`);
  const out: Record<string, ManifestEnvVar> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`manifest.env 变量名非法: ${name}`);
    if (name.toUpperCase().startsWith('AAP_') || RESERVED_ENV_NAMES.has(name.toUpperCase())) {
      throw new Error(`manifest.env 变量名与平台保留名冲突: ${name}`);
    }
    const v = raw[name];
    let spec: ManifestEnvVar;
    if (typeof v === 'string') {
      spec = { required: true, secret: false, description: v, pattern: null, default: null };
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const secret = o.secret === true;
      const def = o.default != null ? String(o.default) : null;
      if (def != null && (def.length > 4096 || secret)) throw new Error(`manifest.env.${name} 的 default 非法（过长或机密变量不允许默认值）`);
      const pattern = o.pattern != null ? String(o.pattern) : null;
      if (pattern != null) {
        if (pattern.length > 200) throw new Error(`manifest.env.${name} 的 pattern 过长`);
        try {
          // eslint-disable-next-line no-new
          new RegExp(pattern);
        } catch {
          throw new Error(`manifest.env.${name} 的 pattern 不是合法正则`);
        }
      }
      spec = {
        required: o.required !== false,
        secret,
        description: String(o.description ?? '').slice(0, 200),
        pattern,
        default: def,
      };
    } else {
      throw new Error(`manifest.env.${name} 的声明必须是描述字符串或对象`);
    }
    out[name] = spec;
  }
  return out;
}

export interface ManifestRouteAccess {
  path: string;
  methods: string[];
  access: 'anonymous_read' | 'anonymous_write' | 'account';
}

/** 校验 .awpk manifest（app-develop.skill v0.3 契约），返回规范化字段 */
export function validateManifest(m: Record<string, unknown>): {
  name: string;
  displayName: string;
  version: string;
  type: 'html' | 'python';
  entry: string;
  runtime: string;
  capabilities: string[];
  network: string[];
  route: string | null;
  routes: ManifestRouteAccess[];
  env: Record<string, ManifestEnvVar>;
  requirements: string[];
} {
  const name = String(m.name ?? '');
  const type = String(m.type ?? '');
  if (!/^(?:[a-z0-9][a-z0-9-]{0,63}|clone_[0-9a-f]{8})$/.test(name)) {
    throw new Error('manifest.name 需为小写字母/数字/连字符，克隆 ID 可使用 clone_ 前缀');
  }
  if (type !== 'html' && type !== 'python') throw new Error('manifest.type 必须是 html 或 python');
  const entry = String(m.entry ?? (type === 'html' ? 'index.html' : ''));
  if (type === 'python' && !entry) throw new Error('python 包必须声明 entry');
  // entry 越界即执行包目录外的任意 .py（第二轮渗透 NEW-1 实锤：跨包代码执行）——
  // 上传口拒绝；packageEntryPath 另有运行时兜底
  if (entry.includes('..') || path.isAbsolute(entry)) throw new Error('manifest.entry 不得包含相对路径段或绝对路径');
  const runtime = String(m.runtime ?? 'invoked');
  if (type === 'python' && !['invoked', 'persistent'].includes(runtime)) throw new Error('manifest.runtime 非法');
  const caps = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
  for (const c of caps) {
    if (!['llm', 'db', 'storage'].includes(c)) throw new Error(`未知能力声明: ${c}`);
  }
  const network = Array.isArray(m.network) ? m.network.map(String) : [];
  const route = m.route ? String(m.route) : null;
  const routes = parseManifestRoutes(m.routes);
  if (type !== 'python' && m.requirements != null) throw new Error('manifest.requirements 仅 python 包支持');
  const requirements = parseRequirements(m.requirements);
  // display_name 会出现在门户卡片与网关错误页：限长并剥除 HTML 敏感字符（纵深，
  // 输出侧另有 escapeHtml 兜底）
  const displayName = String(m.display_name ?? name)
    .replace(/[<>"'`]/g, '')
    .trim()
    .slice(0, 64) || name;
  return {
    name,
    displayName,
    version: String(m.version ?? '0.0.0'),
    type,
    entry,
    runtime,
    capabilities: caps,
    network,
    route,
    routes,
    env: parseEnvSpec(m.env),
    requirements,
  };
}

const ROUTE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS']);

function parseManifestRoutes(value: unknown): ManifestRouteAccess[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error('manifest.routes 必须是最多 128 项的数组');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`manifest.routes[${index}] 必须是对象`);
    }
    const item = entry as Record<string, unknown>;
    const routePath = item.path;
    if (
      typeof routePath !== 'string' ||
      !routePath.startsWith('/') ||
      routePath.includes('?') ||
      routePath.includes('#') ||
      routePath.includes('\\') ||
      routePath.split('/').some((part) => part === '.' || part === '..') ||
      (routePath.includes('*') && !routePath.endsWith('*'))
    ) {
      throw new Error(`manifest.routes[${index}].path 必须是绝对路径或以 * 结尾的前缀路径`);
    }
    if (!Array.isArray(item.methods) || item.methods.length === 0) {
      throw new Error(`manifest.routes[${index}].methods 必须是非空数组`);
    }
    const methods = item.methods.map((method) => String(method).toUpperCase());
    if (methods.some((method) => !ROUTE_METHODS.has(method))) {
      throw new Error(`manifest.routes[${index}].methods 包含不支持的方法`);
    }
    if (new Set(methods).size !== methods.length) {
      throw new Error(`manifest.routes[${index}].methods 不能重复`);
    }
    const access = item.access;
    if (access !== 'anonymous_read' && access !== 'anonymous_write' && access !== 'account') {
      throw new Error(`manifest.routes[${index}].access 必须是 anonymous_read、anonymous_write 或 account`);
    }
    if (
      access === 'anonymous_read' &&
      methods.some((method) => !['GET', 'HEAD', 'OPTIONS'].includes(method))
    ) {
      throw new Error(`manifest.routes[${index}] 的 anonymous_read 仅允许 GET、HEAD、OPTIONS`);
    }
    for (const method of methods) {
      const key = `${routePath}\n${method}`;
      if (seen.has(key)) throw new Error(`manifest.routes 中路径和方法重复: ${routePath} ${method}`);
      seen.add(key);
    }
    return { path: routePath, methods, access };
  });
}

/**
 * 用户上传的 html/package 应用必须经 iframe 沙箱隔离（PRD G1：iframe sandbox
 * 属性 + 禁同源 cookie）。判据：归属者存在且不是管理员——管理员自建应用视为
 * 信任内容，保持既往直出行为。沙箱（无 allow-same-origin）下包代码运行在
 * opaque origin：不具备门户同源权限或 Cookie；当前应用的 raw 路径通过外壳受限桥接。
 */
export async function needsIframeSandbox(app: AppRow): Promise<boolean> {
  if (app.kind !== 'html' && app.kind !== 'package') return false;
  if (app.ownerUserId == null) return false;
  const owner = (await getDb().select({ role: users.role }).from(users).where(eq(users.id, app.ownerUserId)))[0];
  return owner?.role !== 'admin';
}

/** raw 通道前缀：沙箱外壳内 iframe 加载 /app/<id>/raw/…（内容不经门户源直出）。
 *  必须锚定段边界（raw 或 raw/…）：/^raw\/?/ 会把 rawfoo 也当 raw 直出，
 *  既绕过外壳又误伤以 raw 开头的正常资源 */
const RAW_PREFIX_RE = /^raw(?:\/|$)/;

/** raw 通道响应的 CSP：sandbox 标志与外壳 iframe sandbox 对齐（刻意不含
 *  allow-same-origin）——受害者被诱导顶层直达 raw URL 时，包代码同样被关进
 *  opaque origin（门户 /api 仍不可直接访问，iframe 本身不持有会话 cookie）。
 * 处理器内在全局通用 CSP 之后覆盖设置 */
export const RAW_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; object-src 'none'; base-uri 'none'";

export function stripRawPrefix(sub: string): string {
  return sub.replace(RAW_PREFIX_RE, '');
}

/** 沙箱外壳页：iframe sandbox 承载包内容，统一页面元素挂在外壳层（包代码不可触碰） */
export function sandboxShellHtml(appId: string, sub: string, query = ''): string {
  const gatewayPrefix = config.gatewayPrefix ?? '';
  const enc = stripRawPrefix(sub)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
  const target = `${gatewayPrefix}/app/${encodeURIComponent(appId)}/raw/${enc}`;
  const search = query ? `?${new URLSearchParams(query).toString()}`.replace(/&/g, '&amp;') : '';
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%}</style>` +
    `<script src="${gatewayPrefix}/portal-chrome.js" data-aap-app="${encodeURIComponent(appId)}" defer></script>` +
    `<script src="${gatewayPrefix}/portal-app-bridge-host.js" data-aap-app="${encodeURIComponent(appId)}"></script>` +
    `</head><body>` +
    `<iframe data-aap-app-frame sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock" ` +
    `referrerpolicy="no-referrer" src="${target}${search}" title="app"></iframe></body></html>`
  );
}

export interface AppShareMetadata {
  title: string;
  description: string;
  imageUrl: string | null;
}

function escapeMetaContent(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export function injectAppShareMetadata(html: string, metadata: AppShareMetadata): string {
  const imageTags = metadata.imageUrl
    ? `<meta property="og:image" content="${escapeMetaContent(metadata.imageUrl)}">` +
      `<link rel="image_src" href="${escapeMetaContent(metadata.imageUrl)}">` +
      '<meta name="twitter:card" content="summary">' +
      `<meta name="twitter:image" content="${escapeMetaContent(metadata.imageUrl)}">`
    : '';
  const escapedTitle = escapeMetaContent(metadata.title);
  const titleTag = `<title>${escapedTitle}</title>`;
  const tags =
    `<meta name="description" content="${escapeMetaContent(metadata.description)}">` +
    `<meta name="twitter:title" content="${escapedTitle}">` +
    `<meta name="twitter:description" content="${escapeMetaContent(metadata.description)}">` +
    `<meta property="og:title" content="${escapedTitle}">` +
    `<meta property="og:description" content="${escapeMetaContent(metadata.description)}">` +
    '<meta property="og:type" content="website">' +
    imageTags;
  const title = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i;
  const page = title.test(html) ? html.replace(title, titleTag) : html;
  const head = /<head(?:\s[^>]*)?>/i;
  if (head.test(page)) {
    return page.replace(head, (openingTag) => `${openingTag}${title.test(page) ? '' : titleTag}${tags}`);
  }
  const htmlTag = /<html(?:\s[^>]*)?>/i;
  if (htmlTag.test(page)) return page.replace(htmlTag, (openingTag) => `${openingTag}<head>${titleTag}${tags}</head>`);
  return `<!doctype html><html><head>${titleTag}${tags}</head><body>${page}</body></html>`;
}

export function serveSandboxShell(
  res: Response,
  appId: string,
  sub: string,
  query = '',
  shareMetadata?: AppShareMetadata,
): void {
  const html = sandboxShellHtml(appId, sub, query);
  res.type('html').send(shareMetadata ? injectAppShareMetadata(html, shareMetadata) : html);
}

/** 托管应用请求处理（已过门禁与限流；sub 为 /app/<id>/ 之后的路径） */
export function serveHtmlApp(
  req: Request,
  res: Response,
  app: AppRow,
  sub: string,
  noChrome = false,
  appOrigin = false,
  shareMetadata?: AppShareMetadata,
): void {
  // raw 通道（noChrome）：顶层直达 raw URL 时包代码在门户源裸奔执行（P0）——
  // 输出前覆盖全局通用 CSP，用 sandbox 指令把顶层导航也关进 opaque origin
  if (noChrome) res.setHeader('Content-Security-Policy', RAW_SANDBOX_CSP);
  if (app.kind === 'package') {
    res
      .status(503)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh">' +
          '<div style="text-align:center"><h2>该应用等待运行时支持</h2><p style="color:#888">Python 运行时将在 M4（生态）版本启用。</p></div>',
      );
    return;
  }

  const rel = (sub || 'index.html').replace(/^\/+/, '');
  const root = appSiteDir(app.id);
  const abs = path.resolve(root, rel);
  // 越界判断必须含路径分隔符语义（relative 非 ../ 开头且非绝对），
  // 裸 startsWith(root) 会被 "..%2F<兄弟目录>" 形式绕过（跨用户读文件，已实测）
  const relCheck = path.relative(root, abs);
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    res.status(400).type('html').send('Bad Path');
    return;
  }

  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const ext = path.extname(abs).toLowerCase();
    res.type(MIME[ext] ?? 'application/octet-stream');
    if (ext === '.html' || ext === '.htm') {
      // 托管 HTML 同样注入统一页面元素（沙箱 raw 通道不注入——chrome 在外壳层）
      const html = fs.readFileSync(abs, 'utf8');
      const bridged = noChrome ? injectSandboxBridge(html, app.id) : appOrigin ? html : injectChrome(html, app.id);
      res.send(!noChrome && shareMetadata ? injectAppShareMetadata(bridged, shareMetadata) : bridged);
    } else {
      res.send(fs.readFileSync(abs));
    }
    return;
  }

  // SPA 类条目回退到 index.html
  const indexPath = path.join(appSiteDir(app.id), 'index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    const bridged = noChrome ? injectSandboxBridge(html, app.id) : appOrigin ? html : injectChrome(html, app.id);
    res.type('html').send(!noChrome && shareMetadata ? injectAppShareMetadata(bridged, shareMetadata) : bridged);
    return;
  }
  res.status(404).type('html').send('Not Found');
}

/** Inject the client half before app scripts so same-app fetch/XHR calls can use the shell bridge. */
export function injectSandboxBridge(html: string, appId: string): string {
  if (/<script\b[^>]*src=["']\/portal-app-bridge-client\.js["'][^>]*>/i.test(html)) return html;
  const tag = `<script src="/portal-app-bridge-client.js" data-aap-app="${encodeURIComponent(appId)}"></script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + tag);
  if (/<!doctype[^>]*>/i.test(html)) return html.replace(/<!doctype[^>]*>/i, (doctype) => doctype + tag);
  if (/<html(?:\s[^>]*)?>/i.test(html)) return html.replace(/<html(?:\s[^>]*)?>/i, (open) => open + tag);
  return tag + html;
}

/** 统一页面元素注入：右下角站点名称悬浮入口 */
export function injectChrome(html: string, appId: string): string {
  const tag = `<script src="/portal-chrome.js" data-aap-app="${encodeURIComponent(appId)}" defer></script>`;
  if (html.includes('/portal-chrome.js')) return html; // 幂等
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
  return tag + html;
}

/** Parent-side request bridge. It only accepts messages from this shell's app iframe. */
export function sandboxBridgeHostJs(): string {
  return `(function(){
  var script=document.currentScript;
  var appId=script&&script.dataset.aapApp;
  if(!appId||window.__aapBridgeHost)return;
  window.__aapBridgeHost=true;
  var base='/app/'+encodeURIComponent(appId)+'/raw/';
  var pending=new Map();
  var methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE']);
  var deniedHeaders=new Set(['authorization','cookie','cookie2','host','origin','referer','content-length','connection','transfer-encoding','proxy-authorization']);
  var responseHeaders=new Set(['accept-ranges','cache-control','content-language','content-length','content-range','content-type','etag','expires','last-modified','location']);
  function reply(id,data,transfer){
    var frame=document.querySelector('[data-aap-app-frame]');
    if(frame&&frame.contentWindow)frame.contentWindow.postMessage(Object.assign({channel:'aap-app-bridge',id:id},data),'*',transfer||[]);
  }
  function validTarget(value){
    if(typeof value!=='string'||value.length>8192)return null;
    try{
      var u=new URL(value,location.origin+base);
      if(u.origin!==location.origin||u.username||u.password||!u.pathname.startsWith(base))return null;
      var segments=u.pathname.slice(base.length).split('/');
      for(var i=0;i<segments.length;i++){
        var decoded=decodeURIComponent(segments[i]);
        if(decoded==='.'||decoded==='..'||decoded.indexOf('/')>=0||decoded.indexOf('\\\\')>=0)return null;
      }
      u.hash='';
      return u;
    }catch(_){return null;}
  }
  function validHeaders(value){
    if(!Array.isArray(value)||value.length>32)return null;
    var out=new Headers(),total=0;
    for(var i=0;i<value.length;i++){
      var pair=value[i];
      if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||typeof pair[1]!=='string')return null;
      var name=pair[0].toLowerCase();
      total+=name.length+pair[1].length;
      if(total>16384)return null;
      if(!/^[!#$%&'*+.^_\`|~0-9a-z-]+$/.test(name)||name.startsWith('proxy-')||name.startsWith('sec-')||name.startsWith('x-aap-')||name.startsWith('x-forwarded-')||deniedHeaders.has(name)||pair[1].length>4096)return null;
      try{out.append(name,pair[1]);}catch(_){return null;}
    }
    return out;
  }
  async function readBounded(response){
    if(!response.body)return new ArrayBuffer(0);
    var reader=response.body.getReader(),chunks=[],size=0;
    while(true){
      var part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>5*1024*1024){await reader.cancel();throw new Error('RESPONSE_TOO_LARGE');}
      chunks.push(part.value);
    }
    var out=new Uint8Array(size),offset=0;
    for(var i=0;i<chunks.length;i++){out.set(chunks[i],offset);offset+=chunks[i].byteLength;}
    return out.buffer;
  }
  window.addEventListener('message',async function(event){
    var frame=document.querySelector('[data-aap-app-frame]');
    if(!frame)return;
    if(event.source!==frame.contentWindow)return;
    var data=event.data;
    if(!data||data.channel!=='aap-app-bridge'||typeof data.id!=='string'||data.id.length>128)return;
    if(data.type==='abort'){
      var active=pending.get(data.id);
      if(active)active.abort();
      return;
    }
    if(data.type!=='request'||pending.has(data.id))return;
    if(pending.size>=16){
      reply(data.id,{type:'error',error:'TOO_MANY_REQUESTS'});
      return;
    }
    var target=validTarget(data.url),method=typeof data.method==='string'?data.method.toUpperCase():'';
    var headers=validHeaders(data.headers);
    // Older cached child shims did not send credentials; default them to the
    // same-origin policy rather than making an otherwise valid request fail.
    var credentials=data.credentials==null||data.credentials==='same-origin'?'same-origin':data.credentials==='omit'?'omit':null;
    if(!target||!methods.has(method)||!headers||!credentials){
      reply(data.id,{type:'error',error:'INVALID_REQUEST'});
      return;
    }
    if((method==='GET'||method==='HEAD')&&data.body!=null){
      reply(data.id,{type:'error',error:'INVALID_REQUEST'});
      return;
    }
    if(data.body!=null&&(!(data.body instanceof ArrayBuffer)||data.body.byteLength>1024*1024)){
      reply(data.id,{type:'error',error:'REQUEST_TOO_LARGE'});
      return;
    }
    var controller=new AbortController();
    pending.set(data.id,controller);
    var timer=setTimeout(function(){controller.abort();},30000);
    var startedAt=Date.now();
    try{
      var response=await fetch(target.href,{method:method,headers:headers,body:data.body==null?undefined:data.body,credentials:credentials,redirect:'manual',signal:controller.signal});
      if(response.type==='opaqueredirect'){
        reply(data.id,{type:'error',error:'REDIRECT_BLOCKED'});
        return;
      }
      var body=await readBounded(response);
      var safeHeaders=[];
      response.headers.forEach(function(value,name){if(name.toLowerCase()!=='content-length'&&responseHeaders.has(name.toLowerCase()))safeHeaders.push([name,value]);});
      reply(data.id,{type:'response',status:response.status,statusText:response.statusText,headers:safeHeaders,body:body},[body]);
    }catch(error){
      if(!controller.signal.aborted)reply(data.id,{type:'error',error:error&&error.message==='RESPONSE_TOO_LARGE'?'RESPONSE_TOO_LARGE':'REQUEST_FAILED'});
      else if(Date.now()>=startedAt+30000)reply(data.id,{type:'error',error:'TIMEOUT'});
    }finally{
      clearTimeout(timer);
      pending.delete(data.id);
    }
  });
})();`;
}

/** Child-side fetch/XHR shim. The app keeps its opaque origin and never receives portal cookies. */
export function sandboxBridgeClientJs(): string {
  return `(function(){
  var script=document.currentScript;
  var appId=script&&script.dataset.aapApp;
  if(!appId||window.__aapBridgeClient||!window.parent||window.parent===window)return;
  window.__aapBridgeClient=true;
  var base='/app/'+encodeURIComponent(appId)+'/raw/';
  var portalOrigin=new URL(location.href).origin;
  var pending=new Map(),sequence=0;
  var methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE']);
  function isAppUrl(value){
    try{
      var u=new URL(value,location.href);
      return u.origin===portalOrigin&&u.pathname.startsWith(base);
    }catch(_){return false;}
  }
  async function readRequestBounded(request){
    if(!request.body)return null;
    var reader=request.clone().body.getReader(),chunks=[],size=0;
    while(true){
      var part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>1024*1024){await reader.cancel();throw new TypeError('Application bridge request body exceeds 1 MB');}
      chunks.push(part.value);
    }
    var out=new Uint8Array(size),offset=0;
    for(var i=0;i<chunks.length;i++){out.set(chunks[i],offset);offset+=chunks[i].byteLength;}
    return out.buffer;
  }
  function send(method,url,headers,body,signal,credentials){
    method=String(method||'GET').toUpperCase();
    if(!methods.has(method))return Promise.reject(new TypeError('Unsupported application bridge method'));
    var requestId='r'+Date.now().toString(36)+'-'+(++sequence).toString(36);
    return new Promise(function(resolve,reject){
      var done=false,timer,abortHandler;
      function finish(error,value){
        if(done)return;
        done=true;clearTimeout(timer);pending.delete(requestId);
        if(signal&&abortHandler)signal.removeEventListener('abort',abortHandler);
        error?reject(error):resolve(value);
      }
      pending.set(requestId,function(data){
        if(data.type==='error'){
          finish(data.error==='TIMEOUT'?new DOMException('The operation timed out','TimeoutError'):new TypeError('Application bridge request failed: '+data.error));
          return;
        }
        if(data.type!=='response'||!Number.isInteger(data.status)||data.status<200||data.status>599||!(data.body instanceof ArrayBuffer)){
          finish(new TypeError('Invalid application bridge response'));return;
        }
        try{finish(null,new Response(data.status===204||data.status===205||data.status===304?null:data.body,{status:data.status,statusText:data.statusText||'',headers:data.headers||[]}));}
        catch(error){finish(error);}
      });
      timer=setTimeout(function(){window.parent.postMessage({channel:'aap-app-bridge',type:'abort',id:requestId},'*');finish(new DOMException('The operation timed out','TimeoutError'));},35000);
      if(signal){
        abortHandler=function(){window.parent.postMessage({channel:'aap-app-bridge',type:'abort',id:requestId},'*');finish(new DOMException('The operation was aborted','AbortError'));};
        if(signal.aborted){abortHandler();return;}
        signal.addEventListener('abort',abortHandler,{once:true});
      }
      var message={channel:'aap-app-bridge',type:'request',id:requestId,method:method,url:url,headers:headers||[],body:body||null,credentials:credentials||'same-origin'};
      try{window.parent.postMessage(message,'*',body instanceof ArrayBuffer?[body]:[]);}
      catch(error){finish(error);}
    });
  }
  window.addEventListener('message',function(event){
    if(event.source!==window.parent||event.origin!==portalOrigin)return;
    var data=event.data;
    if(data&&data.channel==='aap-app-bridge'&&typeof data.id==='string'&&pending.has(data.id))pending.get(data.id)(data);
  });
  var nativeFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    var req;
    try{req=new Request(input,init);}catch(error){return Promise.reject(error);}
    if(!isAppUrl(req.url))return nativeFetch(input,init);
    if((req.method==='GET'||req.method==='HEAD')&&req.body)return Promise.reject(new TypeError('GET/HEAD requests cannot have a body'));
    return readRequestBounded(req).then(function(body){return send(req.method,req.url,Array.from(req.headers.entries()),body,req.signal,req.credentials==='omit'?'omit':'same-origin');});
  };

  var XHR=window.XMLHttpRequest,open=XHR.prototype.open,sendNative=XHR.prototype.send,setHeader=XHR.prototype.setRequestHeader;
  var xhrState=new WeakMap();
  XHR.prototype.open=function(method,url,async,user,password){
    if(async!==false&&isAppUrl(new URL(url,location.href).href)){
      var state={method:String(method).toUpperCase(),url:new URL(url,location.href).href,headers:[],responseHeaders:[],status:0,statusText:'',responseURL:'',responseText:'',response:null,responseType:'',readyState:1,timeout:0,sent:false,done:false,controller:null,timedOut:false};
      xhrState.set(this,state);
      var xhr=this;
      ['readyState','status','statusText','responseURL','responseText','response'].forEach(function(key){Object.defineProperty(xhr,key,{configurable:true,get:function(){return state[key];}});});
      Object.defineProperty(this,'responseType',{configurable:true,get:function(){return state.responseType;},set:function(value){state.responseType=String(value);}});
      Object.defineProperty(this,'timeout',{configurable:true,get:function(){return state.timeout;},set:function(value){state.timeout=Math.max(0,Number(value)||0);}});
      Object.defineProperty(this,'withCredentials',{configurable:true,get:function(){return false;},set:function(){}});
      this.dispatchEvent(new Event('readystatechange'));
      return;
    }
    xhrState.delete(this);
    return open.call(this,method,url,async,user,password);
  };
  XHR.prototype.setRequestHeader=function(name,value){
    var state=xhrState.get(this);
    if(!state)return setHeader.call(this,name,value);
    if(state.sent)throw new DOMException('The request has already been sent','InvalidStateError');
    state.headers.push([String(name),String(value)]);
  };
  XHR.prototype.send=function(body){
    var state=xhrState.get(this);
    if(!state)return sendNative.call(this,body);
    if(state.sent)throw new DOMException('The request has already been sent','InvalidStateError');
    if((state.method==='GET'||state.method==='HEAD')&&body!=null)throw new TypeError('GET/HEAD requests cannot have a body');
    state.sent=true;state.controller=new AbortController();
    var xhr=this,timer=null;
    this.dispatchEvent(new Event('loadstart'));
    if(state.timeout>0)timer=setTimeout(function(){state.timedOut=true;state.controller.abort();},state.timeout);
    var bodyRequest;
    try{bodyRequest=new Request(state.url,{method:state.method,headers:state.headers,body:body});}
    catch(error){bodyRequest=Promise.reject(error);}
    Promise.resolve(bodyRequest).then(function(request){return readRequestBounded(request).then(function(bytes){return send(state.method,state.url,Array.from(request.headers.entries()),bytes,state.controller.signal,'same-origin');});}).then(function(response){
      if(timer)clearTimeout(timer);
      state.readyState=2;state.status=response.status;state.statusText=response.statusText;state.responseURL=state.url;
      response.headers.forEach(function(value,name){state.responseHeaders.push([name,value]);});
      xhr.dispatchEvent(new Event('readystatechange'));
      return response.arrayBuffer();
    }).then(function(bytes){
      state.readyState=3;state.responseText=new TextDecoder().decode(bytes);
      state.response=state.responseType==='arraybuffer'?bytes:state.responseType==='blob'?new Blob([bytes]):state.responseType==='json'?parseJson(state.responseText):state.responseType===''||state.responseType==='text'?state.responseText:null;
      state.readyState=4;state.done=true;xhr.dispatchEvent(new Event('readystatechange'));
      if(state.responseType==='document'&&typeof DOMParser!=='undefined')state.response=new DOMParser().parseFromString(state.responseText,'text/html');
      xhr.dispatchEvent(new Event('load'));xhr.dispatchEvent(new Event('loadend'));
    }).catch(function(){
      if(timer)clearTimeout(timer);
      state.readyState=4;state.done=true;state.status=0;state.response=null;state.responseText='';
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new Event(state.timedOut?'timeout':'error'));xhr.dispatchEvent(new Event('loadend'));
    });
  };
  XHR.prototype.abort=function(){
    var state=xhrState.get(this);
    if(!state)return;
    if(state.done)return;
    if(state.controller)state.controller.abort();
    state.readyState=0;state.status=0;
    this.dispatchEvent(new Event('readystatechange'));this.dispatchEvent(new Event('abort'));this.dispatchEvent(new Event('loadend'));
  };
  var getHeader=XHR.prototype.getResponseHeader,getAll=XHR.prototype.getAllResponseHeaders;
  XHR.prototype.getResponseHeader=function(name){
    var state=xhrState.get(this);
    if(!state)return getHeader.call(this,name);
    if(state.readyState<2)return null;
    var wanted=String(name).toLowerCase(),entry=state.responseHeaders.find(function(pair){return pair[0].toLowerCase()===wanted;});
    return entry?entry[1]:null;
  };
  XHR.prototype.getAllResponseHeaders=function(){
    var state=xhrState.get(this);
    if(!state)return getAll.call(this);
    return state.readyState<2?'':state.responseHeaders.map(function(pair){return pair[0]+': '+pair[1]+'\\r\\n';}).join('');
  };
  function parseJson(text){try{return JSON.parse(text);}catch(_){return null;}}
})();`;
}

/** /portal-chrome.js 静态内容（小而自包含） */
export function portalChromeJs(siteName: string): string {
  return `(function(){
  if (window.__aapChrome) return;
  window.__aapChrome = true;
  var siteName = ${JSON.stringify(siteName)};
  var style = document.createElement('style');
  style.textContent = [
    '#aap-chrome{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;gap:6px;',
    'align-items:center;background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.08);',
    'border-radius:999px;padding:4px 8px;font:12px/1.6 system-ui,-apple-system,sans-serif;',
    'box-shadow:0 2px 8px rgba(0,0,0,.12)}',
    '#aap-chrome a{color:#1E5AA8;text-decoration:none;padding:2px 8px;border-radius:999px;white-space:nowrap}',
    '#aap-chrome a:hover{background:rgba(30,90,168,.1)}'
  ].join('');
  document.head.appendChild(style);
  var bar = document.createElement('div');
  bar.id = 'aap-chrome';
  var link = document.createElement('a');
  link.href = '/';
  link.textContent = siteName;
  bar.appendChild(link);
  document.body.appendChild(bar);
})();`;
}
