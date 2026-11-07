/**
 * .awpk 运行与发布（M4，G3/G4/G5）：
 *  - POST /api/apps/:id/run            invoked 执行（可见性门禁；公开应用允许匿名，运行记录入 app_runs + 审计）
 *  - GET  /api/apps/:id/meta           执行页元数据（入参 schema 等；匿名按可见性门禁可读公开应用）
 *  - POST /api/apps/submit             用户上传 .awpk（requireAuth；默认私有可见，归属=上传者；
 *                                      正式目录写入一律在归属校验之后，防止同名包清空他人应用）
 *  - POST /api/apps/:id/publish        用户设置应用可见范围（默认公开，requireAuth）
 *  - GET  /api/apps/mine               我的应用（requireAuth）
 */
import fs, { statfsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import express, { Router } from 'express';
import { and, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { AppCard, OwnedAppCard } from '@aap/shared';
import { getDb } from '../db/index.js';
import {
  appRuns,
  apps,
  llmAppTokens,
  membershipPlans,
  userGroupMembers,
  userGroups,
  users,
} from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAuth, requireStepUp } from '../lib/auth.js';
import { appHasLlmCapability, canAccess, isVisibleInPortal } from '../gateway/registry.js';
import { allowRequest } from '../gateway/limiter.js';
import { appSiteDir, isAwpkFilename } from '../gateway/staticApp.js';
import { loopbackPlatformPort, runInvoked } from '../lib/sandbox.js';
import { ensureAutoProvisionedToken, modelCatalog } from '../lib/llm.js';
import { config } from '../config/index.js';
import { storePackageFiles, validateManifest, parseEnvSpec, type ManifestEnvVar } from '../gateway/staticApp.js';
import { audit } from '../lib/audit.js';
import { encryptSecret, decryptSecret } from '../lib/cryptoSecrets.js';
import { missingRequiredEnv } from '../lib/appEnv.js';
import { stopPersistentFor } from '../lib/sandbox.js';
import { getSettingInt } from '../lib/settings.js';
import { appEnvVars } from '../db/schema.js';
import { assertAppUploadQuota } from '../lib/billing.js';
import { installPyDeps } from '../lib/pydeps.js';

// ---------- 上传限频（每用户每日；内存计数，重启归零，软防护） ----------

const uploadHits = new Map<number, { day: number; n: number }>();

function uploadAllowed(uid: number): boolean {
  const max = getSettingInt('UPLOAD_PER_USER_PER_DAY', 20);
  if (max <= 0) return true;
  const day = Math.floor(Date.now() / 86_400_000);
  const rec = uploadHits.get(uid);
  if (!rec || rec.day !== day) {
    uploadHits.set(uid, { day, n: 1 });
    if (uploadHits.size > 10_000) {
      for (const [k, v] of uploadHits) if (v.day !== day) uploadHits.delete(k);
    }
    return true;
  }
  rec.n += 1;
  return rec.n <= max;
}

export const appsRunRouter = Router();

async function loadApp(id: string) {
  return (await getDb().select().from(apps).where(eq(apps.id, id)))[0];
}

export function appIconDir(appId: string): string {
  const directoryId = createHash('sha256').update(appId).digest('hex');
  return path.join(config.dataDir, 'app-private', 'icons', directoryId);
}

function iconFilenameFor(app: { id: string; icon: string | null }): string | null {
  const prefix = `/api/apps/${encodeURIComponent(app.id)}/icon/`;
  if (!app.icon?.startsWith(prefix)) return null;
  const filename = app.icon.slice(prefix.length);
  return /^icon-[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)$/.test(filename) ? filename : null;
}

function removePreviousIcon(app: { id: string; icon: string | null }, keepFilename?: string): void {
  const current = iconFilenameFor(app);
  if (!current || current === keepFilename) return;
  try {
    fs.rmSync(path.join(appIconDir(app.id), current), { force: true });
  } catch (error) {
    console.error(`[apps] failed to remove previous icon for ${app.id}:`, error);
  }
}

appsRunRouter.get(
  '/apps/:id/icon/:filename',
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    const canView = app?.visibility === 'login'
      ? Boolean(req.user && req.user.authState === 'full')
      : Boolean(app && isVisibleInPortal(app, req.user ?? null));
    const filename = String(req.params.filename);
    if (
      !app ||
      !canView ||
      iconFilenameFor(app) !== filename
    ) {
      throw new HttpError(404, 'APP_ICON_NOT_FOUND', '应用图标不存在或不可访问');
    }

    const extension = path.extname(filename);
    const file = path.join(appIconDir(app.id), filename);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(extension).send(fs.readFileSync(file));
  }),
);

appsRunRouter.post(
  '/apps/:id/icon',
  requireAuth,
  express.json({ limit: '3mb' }),
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.ownerUserId !== req.user!.id) throw new HttpError(403, 'FORBIDDEN', '只有应用归属者可以修改应用图标');
    if (app.kind === 'upstream') throw new HttpError(400, 'NOT_PACKAGE', '仅托管应用可以上传图标');

    const body = (req.body ?? {}) as { dataBase64?: unknown };
    const encoded = body.dataBase64;
    const maxBytes = 2 * 1024 * 1024;
    const maxBase64Length = Math.ceil(maxBytes / 3) * 4;
    if (
      typeof encoded !== 'string' ||
      encoded.length === 0 ||
      encoded.length > maxBase64Length ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw new HttpError(400, 'INVALID_APP_ICON', '请上传有效的图片文件（最大 2 MB）');
    }

    const image = Buffer.from(encoded, 'base64');
    if (image.length === 0 || image.length > maxBytes || image.toString('base64') !== encoded) {
      throw new HttpError(400, 'INVALID_APP_ICON', '请上传有效的图片文件（最大 2 MB）');
    }
    const extension = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'png'
      : image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        ? 'jpg'
        : image.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)
          ? 'gif'
          : image.length >= 12 &&
              image.subarray(0, 4).toString('ascii') === 'RIFF' &&
              image.subarray(8, 12).toString('ascii') === 'WEBP'
            ? 'webp'
            : null;
    if (!extension) {
      throw new HttpError(400, 'UNSUPPORTED_APP_ICON_FORMAT', '应用图标仅支持 PNG、JPEG、GIF 或 WebP 图片');
    }

    const filename = `icon-${randomBytes(16).toString('hex')}.${extension}`;
    const directory = appIconDir(app.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, filename);
    fs.writeFileSync(file, image, { flag: 'wx', mode: 0o600 });
    const icon = `/api/apps/${encodeURIComponent(app.id)}/icon/${filename}`;
    try {
      await getDb().update(apps).set({ icon, updatedAt: Date.now() }).where(eq(apps.id, app.id));
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    }
    removePreviousIcon(app, filename);
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.icon.uploaded', {
      appId: app.id,
      bytes: image.length,
      extension,
    });
    res.json({ icon });
  }),
);

appsRunRouter.delete(
  '/apps/:id/icon',
  requireAuth,
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.ownerUserId !== req.user!.id) throw new HttpError(403, 'FORBIDDEN', '只有应用归属者可以修改应用图标');
    await getDb().update(apps).set({ icon: null, updatedAt: Date.now() }).where(eq(apps.id, app.id));
    removePreviousIcon(app);
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.icon.removed', { appId: app.id });
    res.json({ ok: true });
  }),
);

// ---------- 执行页元数据 ----------

appsRunRouter.get(
  '/apps/:id/meta',
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    if (!app || !app.enabled) {
      throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在或不可访问');
    }
    if (!await canAccess(app, req.user ?? null)) {
      if (!req.user && app.visibility !== 'public') {
        throw new HttpError(401, 'LOGIN_REQUIRED', '请先登录平台账号后访问此应用');
      }
      throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在或不可访问');
    }
    let inputSchema: unknown = null;
    if (app.inputSchema) {
      try {
        inputSchema = JSON.parse(app.inputSchema);
      } catch {
        inputSchema = null;
      }
    }
    res.json({
      id: app.id,
      name: app.name,
      description: app.description,
      kind: app.kind,
      runtimeMode: app.runtimeMode,
      inputSchema,
    });
  }),
);

// ---------- invoked 执行（G5） ----------

appsRunRouter.post(
  '/apps/:id/run',
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    if (!app || !app.enabled || app.kind !== 'package') {
      throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在或不是可执行包');
    }
    if (!await canAccess(app, req.user ?? null)) {
      if (!req.user && app.visibility !== 'public') {
        throw new HttpError(401, 'LOGIN_REQUIRED', '请先登录平台账号后访问此应用');
      }
      throw new HttpError(403, 'FORBIDDEN', '无权访问该应用');
    }
    if (app.runtimeMode !== 'invoked') {
      throw new HttpError(400, 'NOT_INVOKED', '该应用为持久服务，请经 /app/<id>/ 访问');
    }
    let manifest: { entry?: string } = {};
    try {
      manifest = JSON.parse(app.manifestJson ?? '{}');
    } catch {
      /* ignore */
    }
    const entry = manifest.entry || 'mod.py';
    const input = (req.body ?? {}) as { input?: unknown };
    const publicLlmApp = app.visibility === 'public' && appHasLlmCapability(app);
    let executionUserId: number | null;
    if (publicLlmApp) {
      const ownerId = app.ownerUserId;
      if (
        ownerId == null
        || !(await getDb().select({ id: users.id }).from(users).where(eq(users.id, ownerId)))[0]
      ) {
        throw new HttpError(503, 'APP_OWNER_UNAVAILABLE', '无法确认公开应用的归属账号，暂时无法运行');
      }
      executionUserId = ownerId;
    } else {
      executionUserId = req.user?.authState === 'full' ? req.user.id : null;
    }
    const auditUserId = req.user?.authState === 'full' ? req.user.id : null;
    const limiterUserId = publicLlmApp ? executionUserId : auditUserId;
    const userKey = limiterUserId == null
      ? null
      : publicLlmApp ? `owner:${limiterUserId}` : `${req.user!.kind}:${limiterUserId}`;
    if (!allowRequest(userKey, req.clientIp ?? 'unknown')) {
      throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    }

    // 必填环境变量未配置 → 明确报错（而不是让包在运行时莫名拿不到配置）
    const missing = await missingRequiredEnv(app.id);
    if (missing.length > 0) {
      throw new HttpError(400, 'ENV_MISSING', `缺少必填环境变量：${missing.join('、')}（请在应用的环境变量配置中填写后重试）`);
    }

    const started = Date.now();
    // 平台地址取明文 HTTP 环回口（TLS 到达时回落 config.port，见
    // loopbackPlatformPort）。绝不能用请求 Host——那会注入沙箱的净网守卫
    // 放行面，也是 AAP_TOKEN 的外泄目标（渗透测试 P1-8 关联项）
    const platformBase = `http://127.0.0.1:${loopbackPlatformPort(req.socket.localPort, config)}`;
    const result = await runInvoked(app.id, entry, input.input ?? {}, { userId: executionUserId, timeoutMs: 30_000, platformBase });

    await getDb()
      .insert(appRuns)
      .values({
        appId: app.id,
        userId: auditUserId,
        ts: Date.now(),
        durationMs: result.durationMs,
        status: result.status,
        error: result.error ?? null,
        logs: result.logs ?? null,
      });
    await audit(auditUserId === null ? 'anonymous' : `user:${auditUserId}`, req.clientIp ?? null, 'app.run', {
      appId: app.id,
      status: result.status,
      durationMs: result.durationMs,
    });

    res.json({
      status: result.status,
      result: result.result ?? null,
      error: result.error ?? null,
      logs: result.logs ?? '',
      durationMs: result.durationMs,
    });
  }),
);

// ---------- 应用环境变量 / 机密（G6：manifest.env 声明，AES-256-GCM 落盘，沙箱启动注入） ----------

async function envSpecOfStored(appId: string): Promise<Record<string, ManifestEnvVar>> {
  const app = await loadApp(appId);
  if (!app?.manifestJson) return {};
  try {
    const m = JSON.parse(app.manifestJson) as Record<string, unknown>;
    return parseEnvSpec(m.env);
  } catch {
    return {};
  }
}

function canManageEnv(app: { ownerUserId: number | null }, user: { id: number; role: string }): boolean {
  return user.role === 'admin' || (app.ownerUserId != null && app.ownerUserId === user.id);
}

async function updateOwnedAppVisibility(
  appId: string,
  userId: number,
  visibility: 'public' | 'login' | 'private',
  options: { name?: string; description?: string; enable?: boolean } = {},
  llmOwnerConsent = false,
): Promise<number> {
  return getDb().transaction(async (tx) => {
    const app = (await tx.select().from(apps).where(eq(apps.id, appId)).for('update'))[0];
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.ownerUserId !== userId) throw new HttpError(403, 'FORBIDDEN', '只有应用归属者可以修改应用设置');
    if (app.kind === 'upstream') throw new HttpError(400, 'NOT_PACKAGE', '仅托管应用可以修改可见范围');
    if (visibility === 'public' && appHasLlmCapability(app)) {
      if (app.ownerUserId == null) {
        throw new HttpError(409, 'LLM_OWNER_REQUIRED', '公开的大模型应用必须关联有效的属主账号');
      }
      if (app.visibility !== 'public' && !llmOwnerConsent) {
        throw new HttpError(409, 'LLM_PUBLICATION_CONSENT_REQUIRED', '公开此应用前，请确认大模型 Token 消耗将记入您的账号');
      }
    }
    if (app.clonedFromAppId && visibility !== 'private') {
      throw new HttpError(403, 'CLONED_APP_PRIVATE', '站内应用克隆只能保持仅自己可见');
    }

    let rewardPoints = app.publicationRewardPoints;
    let awarded = 0;
    if (visibility === 'public' && app.visibility !== 'public' && rewardPoints === null) {
      const membershipGroup = (
        await tx
          .select({ rewardPoints: userGroups.appPublishRewardPoints })
          .from(users)
          .innerJoin(membershipPlans, eq(users.membershipPlanId, membershipPlans.id))
          .innerJoin(userGroups, eq(membershipPlans.groupId, userGroups.id))
          .where(and(eq(users.id, userId), gt(users.membershipExpiresAt, Date.now())))
          .limit(1)
      )[0];
      let groupRewardPoints = membershipGroup?.rewardPoints;
      if (groupRewardPoints === undefined) {
        const memberGroup = (
          await tx
            .select({ rewardPoints: userGroups.appPublishRewardPoints })
            .from(userGroupMembers)
            .innerJoin(userGroups, eq(userGroupMembers.groupId, userGroups.id))
            .where(eq(userGroupMembers.userId, userId))
            .orderBy(userGroupMembers.groupId)
            .limit(1)
        )[0];
        groupRewardPoints = memberGroup?.rewardPoints;
      }
      rewardPoints = groupRewardPoints ?? 0;
      awarded = rewardPoints;
      if (awarded > 0) {
        await tx
          .update(users)
          .set({ pointsBalance: sql`${users.pointsBalance} + ${awarded}` })
          .where(eq(users.id, userId));
      }
    }

    await tx
      .update(apps)
      .set({
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.enable ? { enabled: true } : {}),
        visibility,
        updatedAt: Date.now(),
        ...(rewardPoints !== app.publicationRewardPoints ? { publicationRewardPoints: rewardPoints } : {}),
      })
      .where(eq(apps.id, app.id));
    return awarded;
  });
}

appsRunRouter.put(
  '/apps/:id/settings',
  requireAuth,
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.ownerUserId !== req.user!.id) throw new HttpError(403, 'FORBIDDEN', '只有应用归属者可以修改应用设置');
    if (app.kind === 'upstream') throw new HttpError(400, 'NOT_PACKAGE', '仅托管应用可以修改这些设置');

    const body = (req.body ?? {}) as { name?: unknown; description?: unknown; visibility?: unknown; llmOwnerConsent?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 191) {
      throw new HttpError(400, 'INVALID_NAME', '应用名称不能为空且不能超过 191 个字符');
    }
    if (typeof body.description !== 'string' || body.description.length > 4000) {
      throw new HttpError(400, 'INVALID_DESCRIPTION', '应用描述不能超过 4000 个字符');
    }
    const visibility = body.visibility;
    if (visibility !== 'public' && visibility !== 'login' && visibility !== 'private') {
      throw new HttpError(400, 'INVALID_VISIBILITY', '可见范围必须是公开、站内或仅自己');
    }

    const values = {
      name: body.name.trim(),
      description: body.description.trim(),
      visibility,
    };
    const llmOwnerConsent = body.llmOwnerConsent === true;
    const pointsAwarded = await updateOwnedAppVisibility(app.id, req.user!.id, visibility, values, llmOwnerConsent);
    await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.settings.update', {
      appId: app.id,
      visibility: values.visibility,
      pointsAwarded,
      llmOwnerConsentAccepted:
        visibility === 'public' && app.visibility !== 'public' && appHasLlmCapability(app) && llmOwnerConsent,
    });
    res.json({ ok: true, pointsAwarded });
  }),
);

appsRunRouter.get(
  '/apps/:id/env',
  requireAuth,
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (!canManageEnv(app, req.user!)) throw new HttpError(403, 'FORBIDDEN', '只有归属者或管理员可以查看环境变量');
    if (app.kind !== 'package') throw new HttpError(400, 'NOT_PACKAGE', '环境变量仅对 .awpk 包生效');

    const spec = await envSpecOfStored(app.id);
    const hasModelVariable = Object.keys(spec).some((name) => /(?:^|_)MODEL(?:_NAME)?$/i.test(name));
    const rows = await getDb()
      .select({ name: appEnvVars.name, valueEnc: appEnvVars.valueEnc, isSecret: appEnvVars.isSecret })
      .from(appEnvVars)
      .where(eq(appEnvVars.appId, app.id));
    const byName = new Map(rows.map((r) => [r.name, r]));

    const declared = Object.entries(spec).map(([name, s]) => {
      const row = byName.get(name);
      const configured = row != null;
      const entry: Record<string, unknown> = {
        name,
        required: s.required,
        secret: s.secret,
        description: s.description,
        pattern: s.pattern,
        default: s.default,
        configured,
      };
      if (configured) {
        if (s.secret) {
          // 机密永不回明文：只给配置状态 + 尾 4 位提示（帮助确认配的是哪个 key）
          try {
            const v = decryptSecret(row!.valueEnc);
            entry.hint = `••••${v.slice(-4)}`;
          } catch {
            entry.hint = '••••';
          }
        } else {
          try {
            entry.value = decryptSecret(row!.valueEnc);
          } catch {
            entry.value = '';
          }
        }
      }
      return entry;
    });
    // 存储里还有、当前 manifest 已不声明的（版本更新删了声明）：列出便于清理
    const undeclared = rows.filter((r) => !(r.name in spec)).map((r) => r.name);
    res.json({ declared, undeclared, ...(hasModelVariable ? { models: await modelCatalog() } : {}) });
  }),
);

appsRunRouter.put(
  '/apps/:id/env',
  requireAuth,
  h(async (req, res) => {
    const app = await loadApp(String(req.params.id));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (!canManageEnv(app, req.user!)) throw new HttpError(403, 'FORBIDDEN', '只有归属者或管理员可以修改环境变量');
    if (app.kind !== 'package') throw new HttpError(400, 'NOT_PACKAGE', '环境变量仅对 .awpk 包生效');

    const spec = await envSpecOfStored(app.id);
    const body = (req.body ?? {}) as { values?: Record<string, unknown> };
    const values = body.values ?? {};
    if (typeof values !== 'object' || Array.isArray(values)) throw new HttpError(400, 'INVALID_BODY', 'values 必须是对象');
    const names = Object.keys(values);
    if (names.length > 64) throw new HttpError(400, 'INVALID_BODY', '单次最多更新 64 个变量');

    const now = Date.now();
    const saved: string[] = [];
    const cleared: string[] = [];
    for (const name of names) {
      const s = spec[name];
      if (!s) throw new HttpError(400, 'ENV_VAR_NOT_DECLARED', `变量未在 manifest.env 中声明: ${name}`);
      const value = values[name];
      if (typeof value !== 'string') throw new HttpError(400, 'INVALID_BODY', `变量值必须是字符串: ${name}`);
      if (value.length > 8192) throw new HttpError(400, 'INVALID_BODY', `变量值过长（上限 8192 字符）: ${name}`);
      if (value === '') {
        // 空串 = 清除该变量配置
        await getDb().delete(appEnvVars).where(and(eq(appEnvVars.appId, app.id), eq(appEnvVars.name, name)));
        cleared.push(name);
        continue;
      }
      if (s.pattern) {
        try {
          if (!new RegExp(s.pattern).test(value)) {
            throw new HttpError(400, 'ENV_PATTERN_MISMATCH', `变量 ${name} 不满足格式要求${s.description ? `（${s.description}）` : ''}`);
          }
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, 'ENV_PATTERN_MISMATCH', `变量 ${name} 的格式校验规则无效`);
        }
      }
      await getDb()
        .insert(appEnvVars)
        .values({ appId: app.id, name, valueEnc: encryptSecret(value), isSecret: s.secret, updatedAt: now })
        .onConflictDoUpdate({
          target: [appEnvVars.appId, appEnvVars.name],
          set: { valueEnc: encryptSecret(value), isSecret: s.secret, updatedAt: now },
        });
      saved.push(name);
    }

    // persistent 进程已带旧环境在跑：杀掉，下次访问以新环境重新拉起
    if (saved.length + cleared.length > 0 && app.runtimeMode === 'persistent') stopPersistentFor(app.id);
    if (saved.length + cleared.length > 0) {
      await audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.env.set', {
        appId: app.id,
        saved,
        cleared,
      });
    }
    res.json({ ok: true, saved, cleared });
  }),
);

// ---------- 用户提交 AWPK（默认私有；版本更新直接更新） ----------

appsRunRouter.post(
  '/apps/submit',
  requireAuth,
  // 大包体解析在鉴权之后（匿名 15MB JSON 解析 DoS 面收敛）
  express.json({ limit: '15mb' }),
  h(async (req, res) => {
    const body = (req.body ?? {}) as { filename?: string; dataBase64?: string };
    if (!isAwpkFilename(body.filename)) {
      throw new HttpError(400, 'INVALID_PACKAGE_EXT', '应用包文件必须使用 .awpk 扩展名');
    }
    // 每用户每日上传上限（内存计数，重启归零——软防护，防脚本化刷包写满数据卷；
    // admin 上传路径不设限，管理员可信）
    if (!uploadAllowed(req.user!.id)) {
      throw new HttpError(429, 'UPLOAD_RATE_LIMITED', `今日上传次数已达上限（${getSettingInt('UPLOAD_PER_USER_PER_DAY', 20)}），请明日再试`);
    }
    // 磁盘水位：托管数据卷剩余空间不足时拒绝新包（防解压写满盘拖垮整站）
    try {
      const st = statfsSync(config.dataDir);
      const freeMb = (Number(st.bavail) * Number(st.bsize)) / (1024 * 1024);
      const minFreeMb = getSettingInt('UPLOAD_MIN_FREE_MB', 512);
      if (minFreeMb > 0 && freeMb < minFreeMb) {
        throw new HttpError(503, 'DISK_ALMOST_FULL', '存储空间不足，请联系管理员扩容后再试');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // statfs 不可用（异常挂载）时不阻断上传——包体上限与限频仍在
    }

    if (!body.dataBase64) throw new HttpError(400, 'INVALID_PACKAGE', '缺少包文件内容');
    let zipBuf: Buffer;
    try {
      zipBuf = Buffer.from(body.dataBase64, 'base64');
    } catch {
      throw new HttpError(400, 'INVALID_PACKAGE', '包内容不是合法的 base64');
    }

    // 解压与 manifest 校验只发生在临时目录；正式目录的任何写入/删除
    // 都必须等到归属校验之后（否则任何人可用同名包清空他人应用文件）。
    // 临时目录按请求唯一命名：并发提交共用固定目录会互踩。
    let rawManifest: Record<string, unknown>;
    let manifest: ReturnType<typeof validateManifest>;
    const tmpDir = `submit_tmp_${randomBytes(8).toString('hex')}`;
    try {
      const r = storePackageFiles(tmpDir, zipBuf);
      rawManifest = r.manifest;
      manifest = validateManifest(r.manifest);
    } catch (err) {
      fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
      throw new HttpError(400, 'PACKAGE_INVALID', err instanceof Error ? err.message : '包校验失败');
    }
    const now = Date.now();
    const existing = (await getDb().select().from(apps).where(eq(apps.id, manifest.name)))[0];
    if (existing) {
      // 版本更新：仅归属者或管理员；通过包校验后直接更新
      const isOwner = existing.ownerUserId === req.user!.id;
      if (!isOwner && req.user!.role !== 'admin') {
        fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
        throw new HttpError(409, 'APP_EXISTS', '同名应用已存在');
      }
    }
    if (!existing && req.user!.role !== 'admin') {
      try {
        await assertAppUploadQuota(req.user!.id);
      } catch (err) {
        fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
        throw err;
      }
    }
    try {
      if (manifest.type === 'python') await installPyDeps(tmpDir, manifest.requirements);
    } catch (err) {
      fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
      throw err;
    }

    if (existing) {
      const to = appSiteDir(manifest.name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(appSiteDir(tmpDir), to);
      const previousManifest = safeParse(existing.manifestJson) || {};
      const previousPlatform = previousManifest._aap && typeof previousManifest._aap === 'object'
        ? previousManifest._aap as Record<string, unknown>
        : {};
      await getDb()
        .update(apps)
        .set({
          description: String(rawManifest.description ?? existing.description),
          // 新包字段优先，旧 manifest 仅补足校验器不感知的字段（如 description）
          manifestJson: JSON.stringify({
            ...previousManifest,
            ...rawManifest,
            ...manifest,
            _aap: { ...previousPlatform, packageSizeBytes: zipBuf.length },
          }),
          kind: manifest.type === 'html' ? 'html' : 'package',
          runtimeMode: manifest.type === 'python' ? manifest.runtime : null,
          signatureStatus: null,
          updatedAt: now,
        })
        .where(eq(apps.id, manifest.name));
      stopPersistentFor(manifest.name);
      await audit(`user:${req.user!.id}`, req.clientIp ?? null, 'app.package.update', {
        name: manifest.name,
      });
      res.json({ ok: true, id: manifest.name });
      return;
    }

    const to = appSiteDir(manifest.name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(appSiteDir(tmpDir), to);

    const isHtml = manifest.type === 'html';
    await getDb()
      .insert(apps)
      .values({
        id: manifest.name,
        name: manifest.displayName,
        description: String(rawManifest.description ?? ''),
        category: '用户提交',
        visibility: 'private', // 用户自建默认仅自己可见（G3）
        kind: isHtml ? 'html' : 'package',
        ownerUserId: req.user!.id,
        passUser: manifest.capabilities.includes('llm'),
        upstream: '',
        manifestJson: JSON.stringify({
          ...rawManifest,
          ...manifest,
          _aap: { packageSizeBytes: zipBuf.length },
        }),
        signatureStatus: null,
        runtimeMode: manifest.type === 'python' ? manifest.runtime : null,
        enabled: true, // 私有即可用（G4：上传 → 校验 → 私有可用）
        createdAt: now,
        updatedAt: now,
      });
    await ensureAutoProvisionedToken(manifest.name);
    await audit(`user:${req.user!.id}`, req.clientIp ?? null, 'app.package.submit', {
      name: manifest.name,
      type: manifest.type,
      capabilities: manifest.capabilities,
    });
    res.json({ ok: true, id: manifest.name });
  }),
);

function safeParse(v: string | null): Record<string, unknown> | null {
  if (!v) return null;
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------- 我的应用（归属者视角） ----------

appsRunRouter.get(
  '/apps/mine',
  requireAuth,
  h(async (req, res) => {
    const uid = req.user!.id;
    const rows = await getDb()
      .select()
      .from(apps)
      .where(and(eq(apps.ownerUserId, uid), ne(apps.kind, 'upstream')))
      .orderBy(sql`updated_at DESC`);
    res.json({
      apps: rows.map((r): OwnedAppCard => {
        const manifest = safeParse(r.manifestJson);
        const platform = manifest?._aap && typeof manifest._aap === 'object'
          ? manifest._aap as Record<string, unknown>
          : null;
        const capabilities = Array.isArray(manifest?.capabilities)
          ? manifest.capabilities.filter((value): value is string => typeof value === 'string')
          : [];
        const network = Array.isArray(manifest?.network)
          ? manifest.network.filter((value): value is string => typeof value === 'string')
          : [];
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          icon: r.icon,
          category: r.category,
          kind: r.kind as OwnedAppCard['kind'],
          runtimeMode: r.runtimeMode as OwnedAppCard['runtimeMode'],
          visibility: r.visibility as AppCard['visibility'],
          isClone: r.clonedFromAppId !== null,
          status: (r.healthState as AppCard['status']) ?? 'unknown',
          sort: r.sort,
          accessible: r.enabled,
          signatureStatus: r.signatureStatus,
          enabled: r.enabled,
          updatedAt: r.updatedAt,
          installedAt: r.createdAt,
          version: typeof manifest?.version === 'string' ? manifest.version : null,
          packageSizeBytes: typeof platform?.packageSizeBytes === 'number' && Number.isFinite(platform.packageSizeBytes)
            ? platform.packageSizeBytes
            : null,
          capabilities,
          network,
        };
      }),
    });
  }),
);

appsRunRouter.get(
  '/apps/shared',
  requireAuth,
  h(async (req, res) => {
    const uid = req.user!.id;
    const rows = await getDb()
      .select()
      .from(apps)
      .where(and(
        eq(apps.enabled, true),
        ne(apps.kind, 'upstream'),
        eq(apps.visibility, 'public'),
      ));
    const visibleRows = rows.filter((app) => app.ownerUserId !== uid);
    const cards = await Promise.all(visibleRows.map(async (app): Promise<AppCard | null> => {
      if (!await canAccess(app, req.user!)) return null;
      return {
        id: app.id,
        name: app.name,
        description: app.description,
        icon: app.icon,
        category: app.category,
        visibility: app.visibility as AppCard['visibility'],
        accessible: true,
        status: (app.healthState as AppCard['status']) ?? 'unknown',
        sort: app.sort,
        kind: app.kind as AppCard['kind'],
        runtimeMode: app.runtimeMode as AppCard['runtimeMode'],
      };
    }));
    res.json({ apps: cards.filter((app): app is AppCard => app !== null) });
  }),
);

appsRunRouter.get(
  '/apps/site-shared',
  requireAuth,
  h(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(apps)
      .where(and(
        eq(apps.enabled, true),
        ne(apps.kind, 'upstream'),
        eq(apps.visibility, 'login'),
      ));
    res.json({
      apps: rows
        .filter((app) => app.ownerUserId !== req.user!.id)
        .map((app): AppCard => ({
          id: app.id,
          name: app.name,
          description: app.description,
          icon: app.icon,
          category: app.category,
          visibility: app.visibility as AppCard['visibility'],
          accessible: false,
          status: (app.healthState as AppCard['status']) ?? 'unknown',
          sort: app.sort,
          kind: app.kind as AppCard['kind'],
          runtimeMode: app.runtimeMode as AppCard['runtimeMode'],
        })),
    });
  }),
);

appsRunRouter.post(
  '/apps/:id/clone',
  requireAuth,
  h(async (req, res) => {
    const sourceId = String(req.params.id);
    let cloneId = '';
    const now = Date.now();
    let cloneIcon: string | null = null;
    let createdOnDisk = false;
    let iconOnDisk = false;

    try {
      await getDb().transaction(async (tx) => {
        const source = (await tx.select().from(apps).where(eq(apps.id, sourceId)).for('update'))[0];
        if (!source || source.clonedFromAppId !== null || !source.enabled || source.kind === 'upstream' || source.visibility !== 'login') {
          throw new HttpError(404, 'SITE_APP_NOT_FOUND', '站内共享应用不存在或已不可克隆');
        }
        if (source.ownerUserId === req.user!.id) {
          throw new HttpError(409, 'APP_ALREADY_OWNED', '不能克隆自己拥有的应用');
        }
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const candidate = `clone_${randomBytes(4).readUInt32BE(0).toString(16).padStart(8, '0')}`;
          const existing = (await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, candidate)).limit(1))[0];
          if (!existing) {
            cloneId = candidate;
            break;
          }
        }
        if (!cloneId) throw new HttpError(503, 'CLONE_ID_UNAVAILABLE', '暂时无法生成唯一的克隆应用 ID，请重试');

        const user = (await tx
          .select({ membershipPlanId: users.membershipPlanId, membershipExpiresAt: users.membershipExpiresAt })
          .from(users)
          .where(eq(users.id, req.user!.id))
          .for('update'))[0];
        if (!user) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
        const plan = user.membershipPlanId && user.membershipExpiresAt && user.membershipExpiresAt > now
          ? (await tx.select().from(membershipPlans).where(eq(membershipPlans.id, user.membershipPlanId)))[0]
          : undefined;
        const used = Number((await tx
          .select({ count: sql<number>`count(*)` })
          .from(apps)
          .where(and(eq(apps.ownerUserId, req.user!.id), isNotNull(apps.clonedFromAppId))))[0]?.count ?? 0);
        const limit = plan?.appCloneLimit ?? 0;
        if (used >= limit) {
          throw new HttpError(403, 'APP_CLONE_LIMIT_REACHED', `当前权益可克隆应用数量已达上限（${used}/${limit}），请升级权益或删除已有克隆`);
        }

        const sourceDir = appSiteDir(source.id);
        if (!fs.existsSync(sourceDir)) throw new HttpError(409, 'APP_FILES_NOT_FOUND', '源应用文件已缺失，暂时无法克隆');
        createdOnDisk = true;
        fs.cpSync(sourceDir, appSiteDir(cloneId), {
          recursive: true,
          errorOnExist: true,
          filter: (file) => {
            const relative = path.relative(sourceDir, file);
            return relative !== 'app.sqlite'
              && relative !== 'storage'
              && !relative.startsWith(`storage${path.sep}`);
          },
        });
        const uploadedIcon = iconFilenameFor(source);
        if (uploadedIcon) {
          const sourceIcon = path.join(appIconDir(source.id), uploadedIcon);
          if (!fs.existsSync(sourceIcon)) throw new HttpError(409, 'APP_ICON_NOT_FOUND', '源应用图标文件已缺失，暂时无法克隆');
          iconOnDisk = true;
          fs.mkdirSync(appIconDir(cloneId), { recursive: true });
          fs.copyFileSync(sourceIcon, path.join(appIconDir(cloneId), uploadedIcon));
          cloneIcon = `/api/apps/${encodeURIComponent(cloneId)}/icon/${uploadedIcon}`;
        } else {
          cloneIcon = source.icon;
        }

        let manifest = safeParse(source.manifestJson);
        if (manifest) {
          const cloneName = `${source.name}（副本）`.slice(0, 191);
          manifest = { ...manifest, name: cloneId, displayName: cloneName };
          const manifestPath = path.join(appSiteDir(cloneId), 'manifest.json');
          if (fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        }
        const cloneName = `${source.name}（副本）`.slice(0, 191);
        await tx.insert(apps).values({
          id: cloneId,
          name: cloneName,
          description: source.description,
          icon: cloneIcon,
          category: source.category,
          visibility: 'private',
          kind: source.kind,
          ownerUserId: req.user!.id,
          clonedFromAppId: source.id,
          manifestJson: manifest ? JSON.stringify(manifest) : source.manifestJson,
          runtimeMode: source.runtimeMode,
          reviewStatus: 'none',
          signatureStatus: null,
          inputSchema: source.inputSchema,
          passUser: source.passUser,
          upstream: '',
          enabled: true,
          sort: 0,
          healthState: 'unknown',
          createdAt: now,
          updatedAt: now,
        });

        const envVars = await tx.select().from(appEnvVars).where(eq(appEnvVars.appId, source.id));
        if (envVars.length > 0) {
          await tx.insert(appEnvVars).values(envVars.map((variable) => ({
            appId: cloneId,
            name: variable.name,
            valueEnc: variable.valueEnc,
            isSecret: variable.isSecret,
            updatedAt: now,
          })));
        }
      });
    } catch (error) {
      if (createdOnDisk) fs.rmSync(appSiteDir(cloneId), { recursive: true, force: true });
      if (iconOnDisk) fs.rmSync(appIconDir(cloneId), { recursive: true, force: true });
      throw error;
    }

    try {
      await ensureAutoProvisionedToken(cloneId);
    } catch (error) {
      await getDb().delete(apps).where(eq(apps.id, cloneId));
      fs.rmSync(appSiteDir(cloneId), { recursive: true, force: true });
      if (iconOnDisk) fs.rmSync(appIconDir(cloneId), { recursive: true, force: true });
      throw error;
    }
    await audit(`user:${req.user!.id}`, req.clientIp ?? null, 'app.clone', {
      appId: cloneId,
      sourceAppId: sourceId,
    });
    res.status(201).json({ ok: true, id: cloneId });
  }),
);

appsRunRouter.delete(
  '/apps/:id',
  requireStepUp,
  h(async (req, res) => {
    const id = String(req.params.id);
    const app = await loadApp(id);
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.ownerUserId !== req.user!.id) throw new HttpError(403, 'FORBIDDEN', '只能删除自己创建的应用');
    if (app.kind === 'upstream') throw new HttpError(400, 'NOT_PACKAGE', '仅托管应用可以在个人中心删除');

    stopPersistentFor(id);
    const pointsDeducted = await getDb().transaction(async (tx) => {
      const current = (
        await tx.select().from(apps).where(eq(apps.id, id)).for('update')
      )[0];
      if (!current) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
      if (current.ownerUserId !== req.user!.id) {
        throw new HttpError(403, 'FORBIDDEN', '只能删除自己创建的应用');
      }
      if (current.kind === 'upstream') throw new HttpError(400, 'NOT_PACKAGE', '仅托管应用可以在个人中心删除');

      let deducted = 0;
      if (current.publicationRewardPoints !== null && current.publicationRewardPoints > 0) {
        const account = (
          await tx
            .select({ pointsBalance: users.pointsBalance })
            .from(users)
            .where(eq(users.id, req.user!.id))
            .for('update')
        )[0];
        if (!account) throw new Error(`Missing user account for app owner ${req.user!.id}`);
        deducted = Math.min(Math.max(account.pointsBalance, 0), current.publicationRewardPoints);
        await tx
          .update(users)
          .set({ pointsBalance: Math.max(account.pointsBalance - current.publicationRewardPoints, 0) })
          .where(eq(users.id, req.user!.id));
      }
      await tx.delete(llmAppTokens).where(eq(llmAppTokens.appId, id));
      await tx.delete(apps).where(eq(apps.id, id));
      return deducted;
    });
    fs.rmSync(appSiteDir(id), { recursive: true, force: true });
    fs.rmSync(appIconDir(id), { recursive: true, force: true });
    await audit(`user:${req.user!.id}`, req.clientIp ?? null, 'app.delete', { appId: id, pointsDeducted });
    res.json({ ok: true, pointsDeducted });
  }),
);

// ---------- 公开发布 ----------

appsRunRouter.post(
  '/apps/:id/publish',
  requireAuth,
  h(async (req, res) => {
    const body = (req.body ?? {}) as { visibility?: unknown; llmOwnerConsent?: unknown };
    const visibility = body.visibility ?? 'public';
    if (visibility !== 'public' && visibility !== 'login' && visibility !== 'private') {
      throw new HttpError(400, 'INVALID_VISIBILITY', '可见范围必须是公开、站内或仅自己');
    }
    const app = await loadApp(String(req.params.id));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.ownerUserId !== req.user!.id) {
      throw new HttpError(403, 'FORBIDDEN', '只有应用归属者可以发布');
    }
    if (app.kind === 'upstream') throw new HttpError(400, 'NOT_PACKAGE', '仅托管应用包可以发布');
    const llmOwnerConsent = body.llmOwnerConsent === true;
    const pointsAwarded = await updateOwnedAppVisibility(
      app.id,
      req.user!.id,
      visibility,
      { enable: true },
      llmOwnerConsent,
    );
    await audit(
      `user:${req.user!.id}`,
      req.clientIp ?? null,
      visibility === 'public' ? 'app.publish.public' : 'app.visibility.update',
      {
        appId: String(req.params.id),
        visibility,
        pointsAwarded,
        llmOwnerConsentAccepted:
          visibility === 'public' && app.visibility !== 'public' && appHasLlmCapability(app) && llmOwnerConsent,
      },
    );
    res.json({ ok: true, visibility, pointsAwarded });
  }),
);
