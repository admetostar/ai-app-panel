/**
 * 运行时配置（settings 表）——移植自参考实现 lib/settings.js 模式：
 * env 只作首次种子的初值；后台改值即时生效（getSetting 运行时读）。
 * 管理端展示用 SETTING_DEFS 的 desc（E2：一句话说明）与 advanced（高级项折叠）。
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { settings } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './cryptoSecrets.js';

/** secret 型配置的密文前缀（自描述；无前缀 = 存量明文，读取兼容） */
const ENC_PREFIX = 'enc:';

function storeValue(key: string, value: string): string {
  if (SETTING_DEFS[key]?.secret && value !== '' && !value.startsWith(ENC_PREFIX)) {
    try {
      return ENC_PREFIX + encryptSecret(value);
    } catch {
      return value; // 主密钥不可用时退回明文（保持可用性；与既往行为一致）
    }
  }
  return value;
}

export interface SettingDef {
  type: 'string' | 'int' | 'bool';
  /** 短名称（管理面板标签） */
  label: string;
  desc: string;
  /** 下拉选项（value→label）；渲染为 Select */
  choiceLabels?: Record<string, string>;
  /** 互斥组：同组配置只显示当前选中的那套（如 smtp vs resend） */
  exclusiveOf?: string;
  /** type=string 时可选的枚举值（管理端渲染为下拉） */
  options?: string[];
  /** 面板分组（E2：配置按功能块分区，不糊成一团） */
  group: string;
  /** 首次种子的初值（通常取自 env） */
  initial: () => string;
  /** 管理端只写不读，回显掩码 */
  secret?: boolean;
  /** 高级项：管理后台默认折叠（E2-③） */
  advanced?: boolean;
  /** 「默认值即可跑」标注（E2-③） */
  defaultsWork?: boolean;
}

export const SETTING_DEFS: Record<string, SettingDef> = {
  // ---- 品牌（A1，数据化品牌，默认纯净） ----
  SITE_NAME: {
    label: '站点名称',
    group: '站点与品牌', type: 'string', desc: '站点名称', initial: () => 'ai-app-panel', defaultsWork: true },
  BROWSER_TITLE: {
    label: '网站浏览器标题',
    group: '站点与品牌',
    type: 'string',
    desc: '浏览器标签页显示的标题；留空时使用站点名称',
    initial: () => '',
    defaultsWork: true,
  },
  SITE_DOMAIN: {
    label: '本站域名（应用子域名根）',
    group: '站点与品牌',
    type: 'string',
    desc: '应用将使用「应用 ID.本站域名」独立子域名；生产环境需配置通配 DNS 和 *.本站域名证书。留空时使用 *.localhost 供本地测试。',
    initial: () => '',
    defaultsWork: false,
  },
  SITE_TAGLINE: {
    label: '站点标语',
    group: '站点与品牌',
    type: 'string',
    desc: '站点标语（门户副标题）',
    initial: () => '轻量AI应用的统一托管平台',
    defaultsWork: true,
  },
  LOGO: {
    label: 'Logo 图片',
    group: '站点与品牌', type: 'string', desc: 'Logo 图片路径；可在此上传 PNG/JPEG/GIF/WebP（最大 5 MB），文件持久化到数据卷 admin/site-logo 目录。留空用站名文字', initial: () => '', defaultsWork: true },
  FOOTER_TEXT: {
    label: '页脚文案',
    group: '站点与品牌', type: 'string', desc: '页脚文案', initial: () => '', defaultsWork: true },
  FOOTER_COPYRIGHT: {
    label: '版权声明',
    group: '站点与品牌',
    type: 'string',
    desc: '页脚最后一行的版权声明；留空时默认显示 © 当前年份和站点名称',
    initial: () => '',
    defaultsWork: true,
  },
  ICP_NUMBER: {
    label: 'ICP 备案号',
    group: '站点与品牌', type: 'string', desc: 'ICP 备案号（自动带工信部查询链接，留空不显示）', initial: () => '', defaultsWork: true },
  POLICE_NUMBER: {
    label: '公安备案号',
    group: '站点与品牌', type: 'string', desc: '公安备案号（自动带公安备案查询链接，留空不显示）', initial: () => '', defaultsWork: true },

  // ---- 注册与账号（A2） ----
  MAX_ACCOUNTS_PER_IP_24H: {
    label: '同 IP 注册上限（24h）', group: '注册与账号', type: 'int', desc: '同一 IP 24 小时内最多注册账号数', initial: () => '5', defaultsWork: true },
  REGISTRATION_POINTS_GIFT: {
    label: '注册赠送积分',
    group: '注册与账号',
    type: 'int',
    desc: '每个新注册账号首次创建时获得的积分；已有账号不会追溯赠送',
    initial: () => '0',
    defaultsWork: true,
  },
  INVITE_REWARD_POINTS: {
    label: '邀请注册奖励积分',
    group: '注册与账号',
    type: 'int',
    desc: '每个有效邀请码成功邀请一名新用户后，奖励邀请码所属账号的积分；停用的邀请码不发奖励',
    initial: () => '100',
    defaultsWork: true,
  },
  CODE_SEND_DAILY_LIMIT: {
    label: '验证码日限额',
    group: '注册与账号',
    type: 'int',
    desc: '同一邮箱/手机 24 小时内最多收到的验证码条数（防轰炸）',
    initial: () => '10',
    defaultsWork: true,
  },
  REGISTRATION_VERIFY_CHANNEL: {
    label: '新用户注册验证方式',
    group: '注册与账号',
    type: 'string',
    choiceLabels: { email: '邮箱验证码', phone: '手机短信验证码' },
    desc: '作为注册页默认验证方式；用户可在邮件与已配置的阿里云短信间切换，登录仍使用用户名和密码',
    initial: () => 'email',
    defaultsWork: true,
  },
  DELETION_COOLDOWN_DAYS: {
    label: '注销冷静期（天）',
    group: '注册与账号',
    type: 'int',
    desc: '注销冷静期（天）：期内可撤回，到期数据匿名化',
    initial: () => '7',
    defaultsWork: true,
  },
  OIDC_ISSUER: {
    label: 'OIDC Issuer 地址',
        group: 'OIDC 单点登录', type: 'string',
    desc: 'OIDC Issuer URL（如 https://id.example.com；与 Client ID/Secret 同时配置即启用单点登录，重启生效）',
    initial: () => '', defaultsWork: false },
  OIDC_CLIENT_ID: {
    label: 'OIDC Client ID',
        group: 'OIDC 单点登录', type: 'string',
    desc: 'OIDC Client ID', initial: () => '', defaultsWork: false },
  OIDC_CLIENT_SECRET: {
    label: 'OIDC Client Secret',
        group: 'OIDC 单点登录', type: 'string',
    desc: 'OIDC Client Secret', initial: () => '', secret: true, defaultsWork: false },
  OIDC_ADMIN_SUBJECTS: {
    label: 'OIDC 管理员白名单',
        group: 'OIDC 单点登录', type: 'string',
    desc: '自动提升管理员的 subject/邮箱（逗号分隔；仅首次登录生效）',
    initial: () => '', defaultsWork: true, advanced: true },
  OIDC_NEW_USER_POLICY: {
    label: 'OIDC 新账户准入',
        group: 'OIDC 单点登录', type: 'string',
    choiceLabels: { admin_approval: '管理员批准', auto_enabled: '默认启用' },
    desc: '首次 OIDC 登录的账号准入：管理员批准（首次登录后待批准，批准前无法进入）或默认启用（IdP 内账号均可直接进入）',
    initial: () => 'admin_approval', defaultsWork: false },
  OIDC_DEFAULT_GROUP_ID: {
    label: '默认订阅分组 ID',
        group: 'OIDC 单点登录', type: 'int',
    desc: '新 OIDC 账号激活后自动加入的分组 ID（填 0 = 不加入；分组 ID 见 用户与注册 → 用户分组）',
    initial: () => '0', defaultsWork: true },
  REGISTRATION_PENDING_TTL_DAYS: {
    label: '废弃注册清理（天）',
    group: '注册与账号',
    type: 'int',
    desc: '废弃注册（未完成验证）N 天后清理',
    initial: () => '7',
    defaultsWork: true,
    advanced: true,
  },

  // ---- 安全栈调优（默认值即可跑） ----
  POW_ENABLED: {
    label: 'PoW 防爆破开关',
    group: '安全与限流', type: 'bool', desc: '登录失败超阈值后要求 PoW 工作量证明', initial: () => 'true', defaultsWork: true },
  AAP_SIGN_SECRET: {
    label: '身份签名密钥',
    group: '安全与限流',
    type: 'string',
    desc: '身份注入头 HMAC 签名密钥（应用侧验签用；泄露需轮换）',
    initial: () => process.env.AAP_SIGN_SECRET?.trim() || randomBytes(32).toString('hex'),
    secret: true,
    advanced: true,
  },
  SESSION_TTL: {
    label: '会话有效期（秒）',
    group: '安全与限流', type: 'int', desc: '会话有效期（秒）', initial: () => String(config.sessionTtlSec), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_BASE: {
    label: 'PoW 基础难度',
    group: '安全与限流', type: 'int', desc: 'PoW 基础难度（前导零位数）', initial: () => String(config.powDifficultyBase), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_STEP: {
    label: 'PoW 难度步进',
    group: '安全与限流', type: 'int', desc: 'PoW 难度步进（每超阈值失败数 +2）', initial: () => String(config.powDifficultyStep), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_MAX: {
    label: 'PoW 难度上限',
    group: '安全与限流', type: 'int', desc: 'PoW 难度上限（保证浏览器可解）', initial: () => String(config.powDifficultyMax), defaultsWork: true, advanced: true },
  POW_CHALLENGE_TTL: {
    label: 'PoW 挑战时效（秒）',
    group: '安全与限流', type: 'int', desc: 'PoW 挑战有效期（秒）', initial: () => String(config.powChallengeTtlSec), defaultsWork: true, advanced: true },
  POW_TOKEN_TTL: {
    label: 'PoW 凭证时效（秒）',
    group: '安全与限流', type: 'int', desc: 'PoW 凭证有效期（秒）', initial: () => String(config.powTokenTtlSec), defaultsWork: true, advanced: true },
  LOGIN_FAIL_WINDOW: {
    label: '登录失败窗口（秒）',
    group: '安全与限流', type: 'int', desc: '登录失败计数窗口（秒）', initial: () => String(config.loginFailWindowSec), defaultsWork: true, advanced: true },
  LOGIN_FAIL_THRESHOLD: {
    label: '登录失败阈值',
    group: '安全与限流', type: 'int', desc: '窗口内失败多少次触发 PoW / 封禁计数', initial: () => String(config.loginFailThreshold), defaultsWork: true, advanced: true },
  IP_BAN_THRESHOLD: {
    label: 'IP 封禁阈值',
    group: '安全与限流', type: 'int', desc: '窗口内失败多少次自动封禁 IP', initial: () => String(config.ipBanThreshold), defaultsWork: true, advanced: true },
  IP_BAN_BASE_SECONDS: {
    label: '封禁基础时长（秒）',
    group: '安全与限流', type: 'int', desc: '封禁基础时长（秒）', initial: () => String(config.ipBanBaseSec), defaultsWork: true, advanced: true },
  IP_BAN_MULTIPLIER: {
    label: '累犯时长倍数',
    group: '安全与限流', type: 'int', desc: '累犯封禁时长倍数（2 = 翻倍）', initial: () => String(config.ipBanMultiplier), defaultsWork: true, advanced: true },
  IP_BAN_MAX_SECONDS: {
    label: '封禁上限（秒）',
    group: '安全与限流', type: 'int', desc: '封禁时长上限（秒）', initial: () => String(config.ipBanMaxSec), defaultsWork: true, advanced: true },
  AUDIT_RETENTION_DAYS: {
    label: '审计保留（天）',
    group: '安全与限流', type: 'int', desc: '审计日志保留天数', initial: () => String(config.auditRetentionDays), defaultsWork: true, advanced: true },
  MFA_STEPUP_TTL: {
    label: '步升认证时效（秒）',
    group: '安全与限流',
    type: 'int',
    desc: '步升认证有效期（秒）：重验一次因子后免重验窗口',
    initial: () => '300',
    defaultsWork: true,
    advanced: true,
  },
  RATE_USER_PER_MIN: {
    label: '用户限流（次/分）',
    group: '应用网关', type: 'int', desc: '应用网关限流：每用户请求/分', initial: () => String(config.rateUserPerMin), defaultsWork: true, advanced: true },
  SHOW_TOPUP_PANEL: {
    label: '显示额度充值卡片',
    group: '计费', type: 'bool',
    desc: '用户中心是否显示「额度充值」面板（关闭后用户只能使用兑换码/管理员发放）',
    initial: () => 'false', defaultsWork: true },
  SHOW_ORDERS_PANEL: {
    label: '显示我的订单卡片',
    group: '计费', type: 'bool',
    desc: '用户中心是否显示「我的订单」面板',
    initial: () => 'false', defaultsWork: true },
  LLM_UNATTRIBUTED_POLICY: {
    label: '无归因 LLM 调用',
    group: '计费', type: 'string',
    choiceLabels: { reject: '拒绝（推荐）', allow: '放行（仅计量不计费）' },
    desc: '网关收到未携带用户身份归因（X-AAP-Identity）的调用时：拒绝（推荐，杜绝绕过余额闸门）或放行（可信内网应用的应用级调用）',
    initial: () => 'reject', defaultsWork: true },
  LLM_DEFAULT_MODEL: {
    label: '沙箱默认模型',
    group: '计费', type: 'string',
    desc: '沙箱包 aap.llm.chat 不指定 model 时使用的模型（须为「LLM 网关」里已配置的模型路由公开名）。留空 = 自动取模型目录中排序第一个',
    initial: () => '', defaultsWork: true },
  LLM_SANDBOX_MAX_TOKENS: {
    label: '沙箱 LLM max_tokens',
    group: '计费', type: 'int',
    desc: '沙箱包 aap.llm.chat 未显式指定 max_tokens 时注入的生成上限；0 = 不限制（模型自然收尾，实际用量照常归因计量）。推理型模型思考消耗大，建议保持 0 并依赖余额闸门',
    initial: () => '0', defaultsWork: true },
  TOPUP_TOKENS_PER_FEN: {
    label: '充值单价（token/分）',
    group: '计费', type: 'int',
    desc: '充值单价：每 1 分钱到账的 token 数（100 = 1 元 1000 token）',
    initial: () => '1000', defaultsWork: true },
  RATE_LLM_PER_MIN: {
    label: 'LLM 凭据限流（次/分）',
    group: '应用网关', type: 'int', desc: 'LLM 网关凭据默认限流（请求/分，凭据可单独覆写）', initial: () => '60', defaultsWork: true, advanced: true },
  RATE_IP_PER_MIN: {
    label: 'IP 限流（次/分）',
    group: '应用网关', type: 'int', desc: '应用网关限流：每 IP 兜底请求/分', initial: () => String(config.rateIpPerMin), defaultsWork: true, advanced: true },
  PROXY_TIMEOUT: {
    label: '上游超时（秒）',
    group: '应用网关', type: 'int', desc: '应用网关上游超时（秒，仅覆盖首字节/HTML 拉取，不断流式连接）', initial: () => String(config.proxyTimeoutSec), defaultsWork: true, advanced: true },
  SANDBOX_MAX_CONCURRENT_RUNS: {
    label: '沙箱并发执行上限',
    group: '应用网关', type: 'int', desc: '.awpk invoked 执行的全局并发进程数上限（超出排队，防进程炸弹）', initial: () => '8', defaultsWork: true, advanced: true },
  UPLOAD_PER_USER_PER_DAY: {
    label: '单用户每日上传上限',
    group: '应用网关', type: 'int', desc: '每用户 24 小时内最多提交的 .awpk 包次数（含版本更新）；0 = 不限。防脚本化刷包写满数据卷（内存计数，重启归零）', initial: () => '20', defaultsWork: true, advanced: true },
  UPLOAD_MIN_FREE_MB: {
    label: '上传磁盘水位（MB）',
    group: '应用网关', type: 'int', desc: '数据卷剩余空间低于该值（MB）时拒绝新包上传，防解压写满盘拖垮整站；0 = 不检查', initial: () => '512', defaultsWork: true, advanced: true },
  PIP_INDEX_URL: {
    label: 'pip 索引源',
    group: '应用网关', type: 'string', desc: 'python 包第三方依赖（manifest.requirements）安装源；留空用官方 PyPI，国内建议镜像（如 https://pypi.tuna.tsinghua.edu.cn/simple）', initial: () => '', defaultsWork: true, advanced: true },
  SANDBOX_IDLE_RECYCLE_SECONDS: {
    label: 'persistent 空闲回收（秒）',
    group: '应用网关', type: 'int', desc: '持久服务进程无访问多久后回收（下次访问重新拉起；任务型应用的状态应落 aap.db 不受影响）。最小 30', initial: () => '300', defaultsWork: true },
  LLM_STREAM_IDLE_TIMEOUT: {
    label: 'LLM 流式闲置超时（秒）',
    group: '应用网关', type: 'int', desc: '流式转发中连续无新字节的容忍时长，超时断开（防上游挂起占满连接）', initial: () => '60', defaultsWork: true, advanced: true },
  LLM_TTFB_TIMEOUT_SECONDS: {
    label: 'LLM 首字节超时（秒）',
    group: '应用网关', type: 'int', desc: '流式请求等待上游首字节的时长，超时切换下一候选（推理型模型首字节较慢时可调大）。最小 3', initial: () => '15', defaultsWork: true, advanced: true },
  LLM_TOTAL_TIMEOUT_SECONDS: {
    label: 'LLM 整体超时（秒）',
    group: '应用网关', type: 'int', desc: '非流式请求的整体时长上限。最小 10', initial: () => '120', defaultsWork: true, advanced: true },
  LLM_MEDIA_TIMEOUT_SECONDS: {
    label: 'LLM 媒体请求超时（秒）',
    group: '应用网关', type: 'int', desc: '含图片或视频的异步 chat 等待上游处理的时长上限。最小 30，默认 600', initial: () => '600', defaultsWork: true, advanced: true },
  EGRESS_INTRANET_ALLOWLIST: {
    label: '内网出站白名单',
    group: '应用网关', type: 'string',
    desc: '允许沙箱包访问的内网目标（逗号/换行分隔：域名、IP 或 IPv4 CIDR 如 192.168.1.0/24）。命中即完全放行（无需包 manifest 声明，管理员权威高于包声明）；169.254 链路本地始终拒绝。留空 = 禁止一切内网出站（默认，公网部署无需改动）',
    initial: () => '', defaultsWork: true, advanced: true },

  // ---- HTTPS / 证书（B3；默认纯门户模式 = 不启 HTTPS，反代外置） ----
  ACME_DOMAIN: {
    label: 'ACME 签发域名',
    group: '证书与 HTTPS', type: 'string', desc: 'ACME 签发根域名（使用 Cloudflare DNS-01 签发根域名及通配符证书；留空走纯门户模式）', initial: () => '', defaultsWork: true },
  ACME_EMAIL: {
    label: 'ACME 邮箱',
    group: '证书与 HTTPS', type: 'string', desc: 'ACME 账户邮箱（证书到期通知）', initial: () => '', defaultsWork: false },
  ACME_STAGING: {
    label: 'LE 测试环境',
    group: '证书与 HTTPS',
    type: 'bool',
    desc: '使用 Let\'s Encrypt 测试环境（避免触发正式环境限频，跑通后关闭）',
    initial: () => 'false',
    defaultsWork: true,
    advanced: true,
  },
  ACME_WILDCARD: {
    label: 'ACME 通配符证书',
    group: '证书与 HTTPS',
    type: 'bool',
    desc: '为本站根域名和 *.根域名签发证书，使用 Cloudflare DNS-01 验证并自动续期',
    initial: () => 'true',
    defaultsWork: true,
  },
  ACME_CLOUDFLARE_ZONE_ID: {
    label: 'Cloudflare Zone ID',
    group: '证书与 HTTPS',
    type: 'string',
    desc: 'Cloudflare 域名区域 ID；配合仅限该 Zone 的 DNS:Edit API Token 使用',
    initial: () => '',
    defaultsWork: false,
  },
  ACME_CLOUDFLARE_API_TOKEN: {
    label: 'Cloudflare DNS API Token',
    group: '证书与 HTTPS',
    type: 'string',
    desc: '建议创建仅对目标 Zone 有 DNS:Edit 权限的 API Token；加密保存，仅用于创建和删除 ACME TXT 记录',
    initial: () => '',
    secret: true,
    defaultsWork: false,
  },
  HTTPS_REDIRECT: {
    label: 'HTTP 跳转 HTTPS',
    group: '证书与 HTTPS', type: 'bool', desc: 'HTTP 请求自动跳转 HTTPS（ACME 挑战路径除外）', initial: () => 'false', defaultsWork: true },

  // ---- 人机验证（可选，填 key 即启用，默认 PoW 兜底） ----
  TURNSTILE_SITE_KEY: {
    group: '人机验证', label: 'Turnstile 站点密钥', type: 'string', desc: 'Cloudflare Turnstile 站点密钥（留空则只用 PoW）', initial: () => '', defaultsWork: true },
  TURNSTILE_SECRET_KEY: {
    group: '人机验证', label: 'Turnstile 服务端密钥', type: 'string', desc: 'Turnstile 服务端密钥', initial: () => '', secret: true, defaultsWork: true },

  // ---- 通知通道（A2，验证码发信：邮件 [Resend/SMTP] 与阿里云短信） ----
  SMTP_HOST: {
    label: 'SMTP 服务器',
    group: '通知通道（验证码发信）', type: 'string', desc: 'SMTP 服务器（注册/找回/绑定邮箱验证码发信）', initial: () => '', defaultsWork: false },
  SMTP_PORT: {
    label: 'SMTP 端口',
    group: '通知通道（验证码发信）', type: 'int', desc: 'SMTP 端口（465/587）', initial: () => '465', defaultsWork: false },
  SMTP_USER: {
    label: 'SMTP 用户名',
    group: '通知通道（验证码发信）', type: 'string', desc: 'SMTP 用户名', initial: () => '', defaultsWork: false },
  SMTP_PASS: {
    label: 'SMTP 密码',
    group: '通知通道（验证码发信）', type: 'string', desc: 'SMTP 密码/授权码', initial: () => '', secret: true, defaultsWork: false },
  SMTP_FROM: {
    label: 'SMTP 发件人',
    group: '通知通道（验证码发信）', type: 'string', desc: '发件人（如 "ai-app-panel <no-reply@example.com>"）', initial: () => '', defaultsWork: false },
  MAIL_PROVIDER: {
    label: '发信方式',
    group: '通知通道（验证码发信）', type: 'string', options: ['smtp', 'resend'],
    desc: '发信方式：smtp 经典 SMTP / resend API（仅需 API Key）', initial: () => 'smtp', defaultsWork: false },
  RESEND_API_KEY: {
    label: 'Resend API Key',
    group: '通知通道（验证码发信）', type: 'string',
    desc: 'Resend API Key（resend.com 后台获取，以 re_ 开头）。发信方式选 resend 时仅需填这一项即可发信',
    initial: () => '', secret: true, defaultsWork: false },
  RESEND_FROM: {
    label: 'Resend 发件人',
    group: '通知通道（验证码发信）', type: 'string',
    desc: 'Resend 发件人（留空：默认用沙箱发件人 onboarding@resend.dev，仅能发给本 Resend 账号注册邮箱；绑定自有域名后填 "ai-app-panel <no-reply@mail.example.com>" 即可发给任意用户）',
    initial: () => '', defaultsWork: true },
  ALIYUN_ACCESS_KEY_ID: {
    label: '阿里云 AccessKey ID',
    group: '通知通道（验证码发信）',
    type: 'string',
    desc: '调用阿里云 Dypnsapi 短信验证码接口的 AccessKey ID',
    initial: () => '',
    secret: true,
    defaultsWork: false,
  },
  ALIYUN_ACCESS_KEY_SECRET: {
    label: '阿里云 AccessKey Secret',
    group: '通知通道（验证码发信）',
    type: 'string',
    desc: '调用阿里云 Dypnsapi 短信验证码接口的 AccessKey Secret；加密保存',
    initial: () => '',
    secret: true,
    defaultsWork: false,
  },
  ALIYUN_SMS_SIGN_NAME: {
    label: '阿里云短信签名',
    group: '通知通道（验证码发信）',
    type: 'string',
    desc: 'SendSmsVerifyCode 接口要求的已审核短信签名',
    initial: () => '',
    defaultsWork: false,
  },
  ALIYUN_SMS_TEMPLATE_CODE: {
    label: '阿里云短信模板编码',
    group: '通知通道（验证码发信）',
    type: 'string',
    desc: '阿里云短信平台审核通过的验证码模板编码',
    initial: () => '',
    defaultsWork: false,
  },
  ALIYUN_SMS_TEMPLATE_PARAM: {
    label: '阿里云短信模板参数',
    group: '通知通道（验证码发信）',
    type: 'string',
    desc: 'JSON 格式的模板变量；验证码占位符使用 ##code##，例如 {"code":"##code##"}',
    initial: () => '',
    defaultsWork: false,
  },
  ALIYUN_SMS_SCHEME_NAME: {
    label: '阿里云短信方案名称',
    group: '通知通道（验证码发信）',
    type: 'string',
    desc: '可选；留空时使用阿里云默认方案',
    initial: () => '',
    defaultsWork: true,
  },
};

const settingCache = new Map<string, string>();

/** 首启把全部默认值种入 settings（冲突时不覆盖已有值；secret 型加密落盘） */
export async function seedSettings(): Promise<void> {
  const db = getDb();
  const now = Date.now();
  await db
    .insert(settings)
    .values(Object.entries(SETTING_DEFS).map(([key, def]) => ({ key, value: storeValue(key, def.initial()), updatedAt: now })))
    .onConflictDoNothing();
  const rows = await db.select().from(settings);
  settingCache.clear();
  for (const row of rows) settingCache.set(row.key, row.value);
}

export function getSetting(key: string): string | null {
  const value = settingCache.get(key) ?? null;
  if (value !== null && value.startsWith(ENC_PREFIX)) {
    try {
      return decryptSecret(value.slice(ENC_PREFIX.length));
    } catch (err) {
      // 主密钥缺失/轮换：解密失败按未配置处理（fail-closed），错误进日志
      console.error(`[settings] 密文配置 ${key} 解密失败:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  return value;
}

export function getSettingInt(key: string, fallback: number): number {
  const v = getSetting(key);
  const n = v === null || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettingBool(key: string, fallback: boolean): boolean {
  const v = getSetting(key);
  if (v === null || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export async function setSetting(key: string, value: string): Promise<void> {
  const storedValue = storeValue(key, value);
  await getDb()
    .insert(settings)
    .values({ key, value: storedValue, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value: storedValue, updatedAt: Date.now() } });
  settingCache.set(key, storedValue);
}

/** 管理端列表视图：secret 回显掩码（只写不读） */
export function listSettingsForAdmin(): Array<{ key: string; value: string; def: SettingDef }> {
  return Object.entries(SETTING_DEFS).map(([key, def]) => ({
    key,
    value: def.secret ? '********' : (getSetting(key) ?? ''),
    def,
  }));
}

/** 管理端写入：空值或掩码 = 不修改（secret 只写不读） */
export async function updateSettingFromAdmin(key: string, value: string): Promise<void> {
  const def = SETTING_DEFS[key];
  if (!def) throw new Error(`未知配置项: ${key}`);
  if (def.secret && (value === '' || value === '********')) return;
  await setSetting(key, value);
}
