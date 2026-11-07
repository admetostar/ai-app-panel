/**
 * Drizzle schema — PostgreSQL.
 *
 * 设计要点：
 * - 统一 users 表（kind 列区分 local/oidc），相对参考实现的双表是刻意改进：
 *   M2 OIDC 共表后彻底消除「仅按 uid 隔离会同号串号」问题；对外身份头仍按
 *   (kind, uid) 契约（shared.IDENTITY_*）。
 * - 会话只存 token 的 SHA-256 哈希，DB 泄露也不能伪造会话。
 * - W1+W2 首批迁移：settings / users / local_credentials / sessions /
 *   login_attempts / ip_bans / pow_* / audit_logs。
 */
import { bigint, boolean, index, integer, pgTable, primaryKey, serial, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const settings = pgTable('settings', {
  key: varchar('key', { length: 191 }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    /** 'local' | 'oidc'（M2） */
    kind: text('kind').notNull().default('local'),
    /** local 唯一；oidc 为 null */
    username: varchar('username', { length: 191 }),
    /** OIDC IdP 的 subject（稳定标识，唯一；local 为 null） */
    subject: varchar('subject', { length: 191 }),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 191 }),
    name: varchar('name', { length: 191 }).notNull().default(''),
    avatar: text('avatar'),
    /** 'admin' | 'user'（M1 简化 RBAC；细粒度角色后继按需扩表） */
    role: text('role').notNull().default('user'),
    /** 'active' | 'disabled' | 'deletion_pending'（注销冷静期） */
    status: text('status').notNull().default('active'),
    /** 'free' | 'member'（M3 计费接入，M1 恒 free） */
    plan: text('plan').notNull().default('free'),
    /** 当前生效会员套餐（到期自动清空并移出对应分组） */
    membershipPlanId: integer('membership_plan_id'),
    /** 会员到期时间（null = 未开通/已过期） */
    membershipExpiresAt: bigint('membership_expires_at', { mode: 'number' }),
    /** 独立于 LLM Token 的积分余额 */
    pointsBalance: integer('points_balance').notNull().default(0),
    /** 新注册普通用户完成首次权益选择前禁止进入门户功能 */
    membershipSelectionRequired: boolean('membership_selection_required').notNull().default(false),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    deletionRequestedAt: bigint('deletion_requested_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastLoginAt: bigint('last_login_at', { mode: 'number' }),
    lastIp: text('last_ip'),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    // 邮箱/手机唯一（A2：邮箱或手机号唯一）；允许多个 NULL（OIDC 用户等）
    uniqueIndex('users_email_uq').on(t.email).where(sql`email IS NOT NULL`),
    uniqueIndex('users_phone_uq').on(t.phone).where(sql`phone IS NOT NULL`),
    uniqueIndex('users_subject_uq').on(t.subject).where(sql`subject IS NOT NULL`),
  ],
);

export const localCredentials = pgTable('local_credentials', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    tokenHash: varchar('token_hash', { length: 191 }).notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'password_ok' | 'mfa_pending' | 'full'（登录状态机，W4） */
    authState: text('auth_state').notNull().default('full'),
    /** 步升认证到期时间（敏感操作重验一次因子，5 分钟复用窗口） */
    stepUpUntil: bigint('step_up_until', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    ip: varchar('ip', { length: 191 }),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: serial('id').primaryKey(),
    ip: varchar('ip', { length: 191 }).notNull(),
    /** 账号键：'local:<username>'（oidc 后续 'oidc:<subject>'） */
    userKey: varchar('user_key', { length: 191 }).notNull(),
    success: boolean('success').notNull(),
    reason: text('reason'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('login_attempts_ip_idx').on(t.ip, t.createdAt),
    index('login_attempts_user_idx').on(t.userKey, t.createdAt),
  ],
);

export const ipBans = pgTable('ip_bans', {
  ip: varchar('ip', { length: 191 }).primaryKey(),
  bannedUntil: bigint('banned_until', { mode: 'number' }).notNull(),
  /** 累犯计数：每次到期后再犯 +1，封禁时长 = base * multiplier^repeat */
  repeatCount: integer('repeat_count').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const powChallenges = pgTable('pow_challenges', {
  id: varchar('id', { length: 512 }).primaryKey(),
  seed: text('seed').notNull(),
  difficulty: integer('difficulty').notNull(),
  ip: varchar('ip', { length: 191 }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

export const powTokens = pgTable('pow_tokens', {
  token: varchar('token', { length: 191 }).primaryKey(),
  ip: varchar('ip', { length: 191 }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    actor: text('actor').notNull(),
    ip: varchar('ip', { length: 191 }),
    action: text('action').notNull(),
    /** JSON 序列化的明细 */
    detail: text('detail'),
  },
  (t) => [index('audit_logs_ts_idx').on(t.ts)],
);

// ---------- A2：注册体系 ----------

/** 验证码（6 位、5 分钟、哈希存储、单次有效） */
export const verificationCodes = pgTable(
  'verification_codes',
  {
    id: serial('id').primaryKey(),
    /** 'email' | 'phone'（邮件验证码或阿里云 Dypnsapi 短信验证码） */
    channel: varchar('channel', { length: 191 }).notNull(),
    target: varchar('target', { length: 320 }).notNull(),
    /** 'register' | 'reset' | 'bind' */
    purpose: text('purpose').notNull(),
    /** sha256(salt:code)，salt:hash 存本列 */
    codeHash: text('code_hash').notNull(),
    ip: varchar('ip', { length: 191 }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    consumedAt: bigint('consumed_at', { mode: 'number' }),
  },
  (t) => [index('verification_codes_target_idx').on(t.channel, t.target, t.createdAt)],
);

/** 待激活注册（验证邮箱/手机通过后才建 users 行；废弃 N 天清理）。
 *  completed_at：注册完成时间——完成后保留行（而非删除），使同 IP 24h
 *  注册上限涵盖已完成注册（终审 P1-5）；完成行超过 24h 由清理任务删除。 */
export const registrations = pgTable(
  'registrations',
  {
    id: varchar('id', { length: 512 }).primaryKey(),
    username: varchar('username', { length: 191 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 191 }),
    inviteCode: text('invite_code'),
    ip: varchar('ip', { length: 191 }),
    /** 验证码尝试次数（≥5 作废整个注册） */
    attempts: integer('attempts').notNull().default(0),
    /** 注册完成时间（null = 待激活）；完成行继续计入同 IP 24h 名额 */
    completedAt: bigint('completed_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('registrations_created_idx').on(t.createdAt)],
);

/** 每个账号专属的邀请码；可复用，停用后只停止奖励、不阻止注册 */
export const inviteCodes = pgTable('invite_codes', {
  code: varchar('code', { length: 191 }).primaryKey(),
  ownerUserId: integer('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  useCount: integer('use_count').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [uniqueIndex('invite_codes_owner_user_id_uq').on(t.ownerUserId)]);

// ---------- B4：应用注册 ----------

export const apps = pgTable('apps', {
  id: varchar('id', { length: 512 }).primaryKey(), // 应用 slug；克隆使用 clone_ + 8 位十六进制
  name: varchar('name', { length: 191 }).notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon'),
  category: text('category').notNull().default('未分类'),
  /** 'public' 公开 | 'login' 站内共享（他人可克隆，不可直访） | 'private' 仅归属者 */
  visibility: text('visibility').notNull().default('login'),
  /** 应用形态：upstream 反代上游 | html 门户托管的静态页（简单 HTML / .awpk html 包） */
  kind: text('kind').notNull().default('upstream'),
  /** 归属者（用户自建应用默认私有可见的依据；管理员创建 = 该管理员 id） */
  ownerUserId: integer('owner_user_id'),
  /** 站内应用克隆的来源；非空时该应用固定为仅自己可见 */
  clonedFromAppId: varchar('cloned_from_app_id', { length: 512 }),
  /** 积分奖励已入账时保存当时的奖励值；null 表示尚未因公开发布获得奖励 */
  publicationRewardPoints: integer('publication_reward_points'),
  // ---- G：.awpk 包元数据（kind=package 时生效） ----
  manifestJson: text('manifest_json'),
  runtimeMode: text('runtime_mode'),
  reviewStatus: text('review_status').notNull().default('none'),
  reviewNote: text('review_note'),
  submittedAt: bigint('submitted_at', { mode: 'number' }),
  /** 包签名状态（Ed25519 信任链）：verified | untrusted | unsigned | invalid；官方签名免审（G4） */
  signatureStatus: text('signature_status'),
  inputSchema: text('input_schema'),
  /** 是否向上游注入签名身份头（X-AAP-Identity） */
  passUser: boolean('pass_user').notNull().default(false),
  /** 上游地址 http(s)://host[:port]/path?query（凭据不写这里，走 urlSecret） */
  upstream: text('upstream').notNull(),
  /** urlSecret 加密落盘：query 型 'token=xxx' / path 型 '__path__=/chat/xxx' */
  urlSecretEnc: text('url_secret_enc'),
  enabled: boolean('enabled').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  /** 'ok' | 'down' | 'unknown'（管理端状态仪表卡） */
  healthState: text('health_state').notNull().default('unknown'),
  lastProbeAt: bigint('last_probe_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [index('apps_owner_clone_idx').on(t.ownerUserId, t.clonedFromAppId)]);

// ---------- 用户分组（会员等级 / 自定义组） ----------

export const userGroups = pgTable('user_groups', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 191 }).notNull().unique(),
  note: text('note').notNull().default(''),
  /** 用户首次公开发布应用时，按所属分组奖励的积分 */
  appPublishRewardPoints: integer('app_publish_reward_points').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const userGroupMembers = pgTable(
  'user_group_members',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => userGroups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

// ---------- 应用环境变量 / 机密（G6：manifest.env 声明，AES-256-GCM 加密落盘，沙箱启动注入） ----------

/** 值统一加密存储（含非密钥）：GET 对 secret 只回配置状态与尾 4 位提示，永不回明文 */
export const appEnvVars = pgTable(
  'app_env_vars',
  {
    appId: varchar('app_id', { length: 512 })
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** 变量名（manifest.env 已校验：非保留名） */
    name: varchar('name', { length: 191 }).notNull(),
    /** encryptSecret() 密文（v1:iv:tag:cipher） */
    valueEnc: text('value_enc').notNull(),
    isSecret: boolean('is_secret').notNull().default(false),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.name] })],
);

// ---------- 包签名信任链（G4，Ed25519；设计参照 fnos-dashboard 的 ndash 方案） ----------

/** 受信任的签名公钥：key_id 命中 → verified（官方/可信签名者可免审）；builtin 内置不可删 */
export const trustedSigningKeys = pgTable('trusted_signing_keys', {
  id: serial('id').primaryKey(),
  /** 'SHA256:' + sha256(public_key) 前 16 字节 hex */
  keyId: varchar('key_id', { length: 191 }).notNull().unique(),
  name: varchar('name', { length: 191 }).notNull().default(''),
  /** base64 的 32 字节 Ed25519 公钥 */
  publicKey: text('public_key').notNull(),
  builtin: boolean('builtin').notNull().default(false),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// ---------- A3：MFA ----------

/** TOTP 密钥（AES-256-GCM 加密落盘；±1 窗口 + 计数器重放拒绝） */
export const totpSecrets = pgTable('totp_secrets', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** 加密后的 base32 密钥（secrets 加密见 lib/cryptoSecrets.ts） */
  secretEnc: text('secret_enc').notNull(),
  /** 值 = TOTP 周期步数（30s 一步）；重放拒绝：只接受 > 此值的匹配 */
  lastUsedCounter: integer('last_used_counter').notNull().default(-1),
  /** enroll 未确认前不生效 */
  confirmed: boolean('confirmed').notNull().default(false),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

/** 恢复码（10 枚、哈希存储、一枚一用） */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: bigint('used_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

/** Passkey 凭据（二次因子 + 无密码主登录双角色；多凭据） */
export const passkeys = pgTable(
  'passkeys',
  {
    /** WebAuthn credential ID（base64url） */
    id: varchar('id', { length: 512 }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(), // base64url
    counter: integer('counter').notNull().default(0),
    transports: text('transports'), // JSON 数组
    deviceType: text('device_type'),
    backedUp: boolean('backedUp').notNull().default(false),
    nickname: text('nickname').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

// ---------- C：LLM 网关（M2） ----------

/** 上游（OpenAI 兼容端点；真实 key 加密落盘，永不下发） */
export const llmUpstreams = pgTable('llm_upstreams', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 191 }).notNull(),
  baseUrl: text('base_url').notNull(), // 如 https://dashscope.aliyuncs.com/compatible-mode/v1
  apiKeyEnc: text('api_key_enc').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

/** 模型路由：公开模型名 → 上游实际模型；同 model 多行 = failover 候选（priority 小者优先，同优先级按 weight 加权） */
export const llmRoutes = pgTable(
  'llm_routes',
  {
    id: serial('id').primaryKey(),
    model: varchar('model', { length: 191 }).notNull(), // 应用请求里的 model 名（公开目录名）
    upstreamId: integer('upstream_id')
      .notNull()
      .references(() => llmUpstreams.id, { onDelete: 'cascade' }),
    upstreamModel: text('upstream_model').notNull(), // 上游侧真实模型名
    multiplier: integer('multiplier').notNull().default(100), // 计费倍率（千分比，100 = 1:1），M3 定价沿用
    /** 上游成本价（每 1k token 的成本，单位=分；毛利 = 收入倍率 − 成本价） */
    costPer1k: integer('cost_per_1k').notNull().default(0),
    priority: integer('priority').notNull().default(100),
    weight: integer('weight').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('llm_routes_model_idx').on(t.model)],
);

/** 网关凭据（应用级；只存 SHA-256，明文仅创建时展示一次；可吊销可限额） */
export const llmAppTokens = pgTable(
  'llm_app_tokens',
  {
    id: serial('id').primaryKey(),
    tokenHash: varchar('token_hash', { length: 191 }).notNull().unique(),
    appId: varchar('app_id', { length: 191 }).notNull(), // apps.id 或外部应用标识
    name: varchar('name', { length: 191 }).notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    perMinuteLimit: integer('per_minute_limit'), // 应用级限流（请求/分），null = 默认
    /** manifest 声明 llm 能力的包：上传时自动签发，明文加密保存供运行时注入（M4） */
    auto: boolean('auto').notNull().default(false),
    tokenEnc: text('token_enc'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => [index('llm_tokens_app_idx').on(t.appId)],
);

/** 用量/调额账本（append-only，只记不判；余额 = SUM(delta)） */
export const llmLedger = pgTable(
  'llm_ledger',
  {
    id: serial('id').primaryKey(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    userId: integer('user_id'), // null = 纯应用级调用（无用户归因）
    appId: varchar('app_id', { length: 191 }),
    kind: text('kind').notNull(), // 'usage' | 'grant' | 'adjust'
    model: varchar('model', { length: 191 }),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }),
    completionTokens: bigint('completion_tokens', { mode: 'number' }),
    /** 有符号变动量（usage 为负；grant/adjust 为正）；余额 = SUM(delta) */
    delta: bigint('delta', { mode: 'number' }).notNull(),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull().default('ok'), // usage 行：ok | error
    requestId: text('request_id'),
    note: text('note'),
  },
  (t) => [
    index('llm_ledger_user_idx').on(t.userId, t.ts),
    index('llm_ledger_app_idx').on(t.appId, t.ts),
  ],
);

/** 余额缓存（C6 预检闸门；由结算/事件失效重算，非账本） */
export const llmBalanceCache = pgTable('llm_balance_cache', {
  userId: integer('user_id').primaryKey(),
  balance: bigint('balance', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

/** OIDC 登录状态（state/nonce/PKCE，一次性） */
export const oidcStates = pgTable('oidc_states', {
  state: varchar('state', { length: 191 }).primaryKey(),
  nonce: text('nonce').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  ip: varchar('ip', { length: 191 }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

// ---------- D：计费（M3） ----------

/** 会员套餐：开通后把用户加入目标分组（可见性随分组走），到期自动降级 */
export const membershipPlans = pgTable('membership_plans', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 191 }).notNull().unique(),
  /** 开通后加入的分组 id（该组可见的应用集合即会员权益） */
  groupId: integer('group_id')
    .notNull()
    .references(() => userGroups.id, { onDelete: 'cascade' }),
  durationDays: integer('duration_days').notNull(),
  /** 计价单位 */
  priceCurrency: text('price_currency').$type<'CNY' | 'USD' | 'POINTS'>().notNull().default('CNY'),
  /** 人民币价格（分），历史套餐保持原值 */
  priceFen: integer('price_fen').notNull().default(0),
  /** 美元价格（美分） */
  priceCents: integer('price_cents').notNull().default(0),
  /** 积分价格（整数） */
  pricePoints: integer('price_points').notNull().default(0),
  /** 外部兑换码领取页面 */
  redeemUrl: text('redeem_url'),
  /** 开通赠送的 LLM 额度（token） */
  tokenGrant: bigint('token_grant', { mode: 'number' }).notNull().default(0),
  /** 权益等级：0 为基础权益，1–5 对应权益图标 */
  tier: integer('tier').notNull().default(0),
  /** 订阅用户可上传的托管应用总数 */
  appUploadLimit: integer('public_app_limit').notNull().default(10),
  /** 订阅用户可同时持有的站内应用克隆数 */
  appCloneLimit: integer('app_clone_limit').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

/** 充值/开通订单（支付渠道 adapter 对接；manual = 人工确认到账） */
export const topupOrders = pgTable(
  'topup_orders',
  {
    id: varchar('id', { length: 512 }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'tokens' 额度充值 | 'membership' 会员开通 */
    kind: text('kind').notNull(),
    planId: integer('plan_id'), // kind=membership 时指向套餐
    tokens: bigint('tokens', { mode: 'number' }), // kind=tokens 时到账额度
    /** 人民币/美元订单计价单位；历史订单默认为人民币 */
    priceCurrency: text('price_currency').$type<'CNY' | 'USD'>().notNull().default('CNY'),
    priceFen: integer('price_fen').notNull(),
    /** 美元订单价格（美分） */
    priceCents: integer('price_cents').notNull().default(0),
    channel: varchar('channel', { length: 191 }).notNull().default('manual'),
    /** 'pending' 待收款 | 'paid' 已到账 | 'cancelled' 已取消 */
    status: text('status').notNull().default('pending'),
    note: text('note'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    paidAt: bigint('paid_at', { mode: 'number' }),
  },
  (t) => [index('topup_orders_user_idx').on(t.userId, t.createdAt)],
);

/** 充值/会员卡券码（管理员批量生成，用户兑换；一次性） */
export const redeemCodes = pgTable('redeem_codes', {
  code: varchar('code', { length: 191 }).primaryKey(),
  batchId: text('batch_id').notNull(),
  /** 'tokens' 额度码 | 'membership' 会员码 */
  kind: text('kind').notNull(),
  tokens: bigint('tokens', { mode: 'number' }),
  planId: integer('plan_id'),
  /** 'unused' | 'used' | 'disabled' */
  status: text('status').notNull().default('unused'),
  note: text('note'),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  createdBy: integer('created_by'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  usedBy: integer('used_by'),
  usedAt: bigint('used_at', { mode: 'number' }),
});

/** 应用运行记录（G5：谁/哪个包/耗时/状态；LLM 用量在 llm_ledger 另行归因） */
export const appRuns = pgTable(
  'app_runs',
  {
    id: serial('id').primaryKey(),
    appId: varchar('app_id', { length: 191 }).notNull(),
    userId: integer('user_id'),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    /** 'ok' | 'error' | 'timeout' */
    status: text('status').notNull(),
    error: text('error'),
    logs: text('logs'),
  },
  (t) => [index('app_runs_app_idx').on(t.appId, t.ts)],
);

/** Persistent app lifecycle and gateway runtime events; request bodies and credentials are never stored. */
export const appRuntimeEvents = pgTable(
  'app_runtime_events',
  {
    id: serial('id').primaryKey(),
    appId: varchar('app_id', { length: 191 }).notNull(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    level: text('level').notNull(),
    event: varchar('event', { length: 64 }).notNull(),
    userId: integer('user_id'),
    method: varchar('method', { length: 16 }),
    path: varchar('path', { length: 512 }),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms'),
    details: text('details'),
  },
  (t) => [
    index('app_runtime_events_ts_idx').on(t.ts),
    index('app_runtime_events_app_ts_idx').on(t.appId, t.ts),
  ],
);
