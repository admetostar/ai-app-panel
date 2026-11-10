/**
 * .awpk 沙箱平台侧（M4，G2/G5）：
 *  - POST /api/aap/llm/chat   沙箱内 aap.llm.chat 的平台代理：透传已签名运行身份；LLM 费用归属应用属主
 *  - POST /api/aap/egress     沙箱内 aap.http.fetch 的唯一出口：manifest 域名白名单逐请求核验
 * 认证：X-AAP-Token（应用网关凭据，运行时由平台注入沙箱环境）。
 * 白名单执行点在平台代理侧，沙箱进程无法绕过（防 DNS rebinding/直连 IP）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { eq, inArray, lt } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps, llmChatJobs, llmMediaFiles, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { appLlmAllowed, resolveAppToken, resolveDefaultModel, resolveRouteCandidates, type AppTokenRow } from '../lib/llm.js';
import { loopbackPlatformPort } from '../lib/sandbox.js';
import { signIdentity, verifyIdentity } from '../gateway/identity.js';
import { IDENTITY_TTL_MS } from '@aap/shared';
import { config } from '../config/index.js';
import { getSetting, getSettingInt } from '../lib/settings.js';

export const aapRouter = Router();

async function auth(req: Request): Promise<AppTokenRow> {
  const bearer = (req.headers['x-aap-token'] as string | undefined) ?? '';
  const token = await resolveAppToken(bearer);
  if (!token) throw new HttpError(401, 'AAP_AUTH', '沙箱凭据无效');
  return token;
}

aapRouter.use(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    req.aapToken = await auth(req);
    next();
  } catch (err) {
    const e = err as HttpError;
    res.status(e.status ?? 401).json({ error: { code: e.code ?? 'AAP_AUTH', message: e.message } });
  }
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      aapToken?: AppTokenRow;
    }
  }
}

const IMAGE_LIMIT = 5 * 1024 * 1024;
const VIDEO_LIMIT = 50 * 1024 * 1024;
const CHAT_MEDIA_LIMIT = 50 * 1024 * 1024;
const MEDIA_TTL_MS = 60 * 60 * 1000;
const MAX_MEDIA_PER_CHAT = 20;
const activeChatJobs = new Set<string>();
const CHAT_JOB_CONCURRENCY = 2;
let runningChatJobs = 0;
const queuedChatJobs: Array<() => void> = [];

async function acquireChatJobSlot(): Promise<void> {
  if (runningChatJobs < CHAT_JOB_CONCURRENCY) {
    runningChatJobs += 1;
    return;
  }
  await new Promise<void>((resolve) => queuedChatJobs.push(resolve));
}

function releaseChatJobSlot(): void {
  const next = queuedChatJobs.shift();
  if (next) next();
  else runningChatJobs = Math.max(0, runningChatJobs - 1);
}

const MEDIA_TYPES: Record<string, { kind: 'image' | 'video'; extensions: string[]; limit: number }> = {
  'image/jpeg': { kind: 'image', extensions: ['.jpg', '.jpeg'], limit: IMAGE_LIMIT },
  'image/png': { kind: 'image', extensions: ['.png'], limit: IMAGE_LIMIT },
  'image/webp': { kind: 'image', extensions: ['.webp'], limit: IMAGE_LIMIT },
  'image/gif': { kind: 'image', extensions: ['.gif'], limit: IMAGE_LIMIT },
  'video/mp4': { kind: 'video', extensions: ['.mp4'], limit: VIDEO_LIMIT },
  'video/webm': { kind: 'video', extensions: ['.webm'], limit: VIDEO_LIMIT },
  'video/quicktime': { kind: 'video', extensions: ['.mov'], limit: VIDEO_LIMIT },
};

interface MediaReference {
  id: string;
}

function mediaDirectory(): string {
  return path.join(config.dataDir, 'llm-media');
}

function mediaFilePath(id: string): string {
  return path.join(mediaDirectory(), id);
}

function chatFilePath(id: string): string {
  return path.join(mediaDirectory(), 'jobs', `${id}.json`);
}

function mediaUserId(req: Request, appId: string): number | null {
  const payload = req.headers['x-aap-identity'];
  const sig = req.headers['x-aap-identity-sig'];
  if (typeof payload !== 'string' || typeof sig !== 'string') return null;
  const secret = getSetting('AAP_SIGN_SECRET');
  if (!secret) return null;
  const identity = verifyIdentity(payload, sig, secret, appId, { allowReplay: true });
  if (!identity.ok) return null;
  const userId = Number(identity.payload.uid);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function mediaJobUserId(req: Request, appId: string, createdAt: number): number | null {
  const payload = req.headers['x-aap-identity'];
  const sig = req.headers['x-aap-identity-sig'];
  if (typeof payload !== 'string' || typeof sig !== 'string') return null;
  const secret = getSetting('AAP_SIGN_SECRET');
  if (!secret) return null;
  const identity = verifyIdentity(payload, sig, secret, appId, { allowReplay: true, allowExpired: true });
  if (!identity.ok) return null;
  const issuedAt = Number(identity.payload.iat);
  const expiresAt = Number(identity.payload.exp);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || issuedAt > createdAt || expiresAt < createdAt || expiresAt - issuedAt > IDENTITY_TTL_MS) return null;
  const userId = Number(identity.payload.uid);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

async function cleanupExpiredMedia(now = Date.now()): Promise<void> {
  const db = getDb();
  const expiredMedia = await db.delete(llmMediaFiles).where(lt(llmMediaFiles.expiresAt, now)).returning({ id: llmMediaFiles.id });
  await Promise.all(expiredMedia.map(({ id }) => rm(mediaFilePath(id), { force: true })));
  const expiredJobs = await db.delete(llmChatJobs).where(lt(llmChatJobs.expiresAt, now)).returning({ id: llmChatJobs.id });
  await Promise.all(expiredJobs.map(({ id }) => rm(chatFilePath(id), { force: true })));
}

const mediaCleanupTimer = setInterval(() => {
  void cleanupExpiredMedia().catch((err) => console.error('[llm-media-cleanup] Cleanup failed', err));
}, 10 * 60 * 1000);
mediaCleanupTimer.unref();

// ---------- 大文件媒体上传与异步 chat 任务 ----------

aapRouter.post(
  '/llm/media',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    if (!await appLlmAllowed(token.appId)) throw new HttpError(403, 'CAPABILITY_NOT_DECLARED', '该应用 manifest 未声明 llm 能力');
    await cleanupExpiredMedia();

    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]!.toLowerCase();
    const mediaType = MEDIA_TYPES[contentType];
    if (!mediaType) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '仅支持 JPEG、PNG、WebP、GIF 图片及 MP4、WebM、MOV 视频');

    const contentLength = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      throw new HttpError(411, 'CONTENT_LENGTH_REQUIRED', '媒体上传必须提供有效的 Content-Length');
    }
    if (contentLength > mediaType.limit) {
      throw new HttpError(413, 'MEDIA_TOO_LARGE', `单个${mediaType.kind === 'image' ? '图片' : '视频'}最大支持 ${Math.floor(mediaType.limit / 1024 / 1024)} MB`);
    }

    let filename = '';
    try {
      filename = decodeURIComponent(String(req.headers['x-aap-media-name'] ?? ''));
    } catch {
      throw new HttpError(400, 'INVALID_FILENAME', '文件名编码无效');
    }
    filename = path.basename(filename).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
    if (!filename || !mediaType.extensions.includes(path.extname(filename).toLowerCase())) {
      throw new HttpError(415, 'MEDIA_TYPE_MISMATCH', '文件扩展名与媒体类型不匹配');
    }

    const id = randomUUID();
    const filePath = mediaFilePath(id);
    const startedAt = Date.now();
    await mkdir(mediaDirectory(), { recursive: true });
    const file = await open(filePath, 'wx', 0o600);
    let size = 0;
    let header = Buffer.alloc(0);
    try {
      for await (const chunk of req) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > mediaType.limit || size > contentLength) {
          throw new HttpError(413, 'MEDIA_TOO_LARGE', '媒体文件超过声明大小或单文件限制');
        }
        if (header.length < 16) header = Buffer.concat([header, data.subarray(0, 16 - header.length)]);
        let offset = 0;
        while (offset < data.length) {
          const written = await file.write(data, offset, data.length - offset);
          if (written.bytesWritten <= 0) throw new Error('Failed to write uploaded media');
          offset += written.bytesWritten;
        }
      }
      if (size !== contentLength || !isValidMediaHeader(contentType, header)) {
        throw new HttpError(400, 'INVALID_MEDIA_FILE', '文件内容与声明的媒体类型不匹配或上传不完整');
      }
    } catch (err) {
      await file.close();
      await rm(filePath, { force: true });
      throw err;
    }
    await file.close();

    const now = Date.now();
    const userId = mediaUserId(req, token.appId);
    try {
      await getDb().insert(llmMediaFiles).values({
        id,
        appId: token.appId,
        userId,
        filename,
        mimeType: contentType,
        size,
        uploadMs: now - startedAt,
        createdAt: now,
        expiresAt: now + MEDIA_TTL_MS,
      });
    } catch (err) {
      await rm(filePath, { force: true });
      throw err;
    }
    res.status(201).json({ id, type: mediaType.kind, mimeType: contentType, filename, size, uploadMs: now - startedAt, expiresAt: now + MEDIA_TTL_MS });
  }),
);

function isValidMediaHeader(mimeType: string, header: Buffer): boolean {
  if (mimeType === 'image/jpeg') return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mimeType === 'image/png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6));
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') return header.toString('ascii', 4, 8) === 'ftyp';
  if (mimeType === 'video/webm') return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

aapRouter.post(
  '/llm/chat/jobs',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    const body = (req.body ?? {}) as { messages?: unknown; media?: unknown; model?: unknown; max_tokens?: unknown; temperature?: unknown };
    if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'INVALID_INPUT', 'messages 必须是非空数组');
    if (!await appLlmAllowed(token.appId)) throw new HttpError(403, 'CAPABILITY_NOT_DECLARED', '该应用 manifest 未声明 llm 能力');

    const model = typeof body.model === 'string' ? body.model.trim() : await resolveDefaultModel() ?? '';
    if (!model) throw new HttpError(400, 'INVALID_INPUT', '未指定 model，且网关模型目录为空');
    if (!Array.isArray(body.media)) throw new HttpError(400, 'INVALID_INPUT', 'media 必须是已上传媒体引用数组');
    const references: MediaReference[] = body.media.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'INVALID_INPUT', 'media 中包含无效引用');
      const id = (item as Record<string, unknown>).id;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'INVALID_INPUT', 'media 中包含无效媒体 ID');
      return { id };
    });
    if (references.length === 0 || references.length > MAX_MEDIA_PER_CHAT) {
      throw new HttpError(400, 'INVALID_INPUT', `media 必须包含 1-${MAX_MEDIA_PER_CHAT} 个已上传媒体文件`);
    }
    const uniqueIds = [...new Set(references.map((item) => item?.id))];
    if (uniqueIds.length !== references.length) {
      throw new HttpError(400, 'INVALID_INPUT', 'media 中包含无效或重复的媒体 ID');
    }
    if (activeChatJobs.size >= 100) throw new HttpError(429, 'MEDIA_JOB_QUEUE_FULL', '媒体任务队列已满，请稍后重试');
    const mediaRows = await getDb().select().from(llmMediaFiles).where(inArray(llmMediaFiles.id, uniqueIds));
    const userId = mediaUserId(req, token.appId);
    if (mediaRows.length !== references.length || mediaRows.some((item) => item.appId !== token.appId || item.userId !== userId || item.expiresAt <= Date.now())) {
      throw new HttpError(404, 'MEDIA_NOT_FOUND', '媒体不存在、已过期或不属于当前应用/用户');
    }
    const totalBytes = mediaRows.reduce((total, item) => total + item.size, 0);
    if (totalBytes > CHAT_MEDIA_LIMIT) throw new HttpError(413, 'MEDIA_BATCH_TOO_LARGE', '单次 chat 的媒体文件总量不能超过 50 MB');

    const userMessages = body.messages.filter((message): message is Record<string, unknown> => (
      Boolean(message) && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'user'
    ));
    const lastUser = userMessages.at(-1);
    if (!lastUser) throw new HttpError(400, 'INVALID_INPUT', 'messages 至少需要一条 user 消息用于附加媒体');
    const currentContent = lastUser.content;
    const content = typeof currentContent === 'string'
      ? [{ type: 'text', text: currentContent }]
      : Array.isArray(currentContent) ? [...currentContent] : [];
    for (const reference of references) content.push({ type: 'aap_media', media_id: reference.id });
    lastUser.content = content;

    const mediaTypes = [...new Set(mediaRows.map((item) => MEDIA_TYPES[item.mimeType]?.kind).filter((kind): kind is 'image' | 'video' => kind !== undefined))];
    const candidates = await resolveRouteCandidates(model, mediaTypes);
    if (candidates.length === 0) throw new HttpError(404, 'MODEL_OR_MEDIA_ROUTE_NOT_FOUND', '没有可处理该媒体类型的启用模型路由');

    const now = Date.now();
    const id = randomUUID();
    const jobFile = chatFilePath(id);
    await mkdir(path.dirname(jobFile), { recursive: true });
    await writeFile(jobFile, JSON.stringify({
      model,
      messages: body.messages,
      mediaIds: mediaRows.map(({ id: mediaId }) => mediaId),
      mediaTypes,
      max_tokens: typeof body.max_tokens === 'number' && body.max_tokens > 0 ? Math.floor(body.max_tokens) : undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      uploadMs: mediaRows.reduce((total, item) => total + item.uploadMs, 0),
    }), { mode: 0o600 });
    if (activeChatJobs.size >= 100) {
      await rm(jobFile, { force: true });
      throw new HttpError(429, 'MEDIA_JOB_QUEUE_FULL', '媒体任务队列已满，请稍后重试');
    }
    try {
      await getDb().insert(llmChatJobs).values({
        id,
        appId: token.appId,
        userId,
        model,
        status: 'queued',
        stage: 'queued',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + MEDIA_TTL_MS,
      });
    } catch (err) {
      await rm(jobFile, { force: true });
      throw err;
    }
    res.status(202).json({ id, status: 'queued', stage: 'queued', createdAt: now, expiresAt: now + MEDIA_TTL_MS });
    activeChatJobs.add(id);
    const bearer = String(req.headers['x-aap-token'] ?? '');
    const identityHeaders = {
      ...(typeof req.headers['x-aap-identity'] === 'string' ? { 'x-aap-identity': req.headers['x-aap-identity'] } : {}),
      ...(typeof req.headers['x-aap-identity-sig'] === 'string' ? { 'x-aap-identity-sig': req.headers['x-aap-identity-sig'] } : {}),
    };
    const platformPort = loopbackPlatformPort(req.socket.localPort, config);
    void processChatJob(id, bearer, platformPort, identityHeaders).catch((err) => {
      console.error('[llm-media-job] Unhandled job failure', id, err);
    });
  }),
);

async function processChatJob(
  id: string,
  bearer: string,
  platformPort: number,
  identityHeaders: Record<string, string>,
): Promise<void> {
  await acquireChatJobSlot();
  let db: ReturnType<typeof getDb>;
  let job: typeof llmChatJobs.$inferSelect | undefined;
  try {
    db = getDb();
    job = (await db.select().from(llmChatJobs).where(eq(llmChatJobs.id, id)))[0];
  } catch (err) {
    try {
      await rm(chatFilePath(id), { force: true });
    } catch (cleanupError) {
      console.error('[llm-media-job] Failed to remove request file after DB read error', id, cleanupError);
    }
    activeChatJobs.delete(id);
    releaseChatJobSlot();
    throw err;
  }
  if (!job) {
    try {
      await rm(chatFilePath(id), { force: true });
    } catch (cleanupError) {
      console.error('[llm-media-job] Failed to remove orphaned request file', id, cleanupError);
    }
    activeChatJobs.delete(id);
    releaseChatJobSlot();
    return;
  }
  const started = Date.now();
  const updateStage = async (stage: string): Promise<void> => {
    await db.update(llmChatJobs).set({ status: 'processing', stage, updatedAt: Date.now() }).where(eq(llmChatJobs.id, id));
  };
  try {
    await updateStage('preparing');
    const payload = JSON.parse(await readFile(chatFilePath(id), 'utf8')) as {
      model: string;
      messages: Array<Record<string, unknown>>;
      mediaIds: string[];
      mediaTypes: Array<'image' | 'video'>;
      max_tokens?: number;
      temperature?: number;
      uploadMs: number;
    };
    await updateStage('routing');
    const upstreamStarted = Date.now();
    const response = await fetch(`http://127.0.0.1:${platformPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'x-aap-job-id': id,
        ...identityHeaders,
      },
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        _aap_media_ids: payload.mediaIds,
        ...(payload.max_tokens ? { max_tokens: payload.max_tokens } : {}),
        ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
        _aap_media_types: payload.mediaTypes,
      }),
      signal: AbortSignal.timeout(Math.max(30_000, getSettingInt('LLM_MEDIA_TIMEOUT_SECONDS', 600) * 1000)),
    });
    const responseText = await response.text();
    const requestId = response.headers.get('x-aap-request-id');
    const now = Date.now();
    const timings = {
      uploadMs: payload.uploadMs,
      queueMs: Math.max(0, started - job.createdAt),
      prepareMs: Math.max(0, upstreamStarted - started),
      gatewayMs: Math.max(0, now - upstreamStarted),
      totalMs: Math.max(0, now - job.createdAt),
    };
    if (!response.ok) {
      const error = responseText.slice(0, 2000);
      await db.update(llmChatJobs).set({
        status: 'failed',
        stage: 'failed',
        error,
        timingsJson: JSON.stringify({ ...timings, requestId }),
        updatedAt: now,
      }).where(eq(llmChatJobs.id, id));
      return;
    }
    await db.update(llmChatJobs).set({
      status: 'completed',
      stage: 'completed',
      resultJson: responseText,
      timingsJson: JSON.stringify({ ...timings, requestId }),
      updatedAt: now,
    }).where(eq(llmChatJobs.id, id));
  } catch (err) {
    const now = Date.now();
    await db.update(llmChatJobs).set({
      status: 'failed',
      stage: 'failed',
      error: err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000),
      timingsJson: JSON.stringify({ totalMs: Math.max(0, now - job.createdAt) }),
      updatedAt: now,
    }).where(eq(llmChatJobs.id, id));
  } finally {
    try {
      await rm(chatFilePath(id), { force: true });
    } catch (cleanupError) {
      console.error('[llm-media-job] Failed to remove request file', id, cleanupError);
    } finally {
      activeChatJobs.delete(id);
      releaseChatJobSlot();
    }
  }
}

aapRouter.get(
  '/llm/chat/jobs/:id',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    const id = String(req.params.id);
    const row = (await getDb().select().from(llmChatJobs).where(eq(llmChatJobs.id, id)))[0];
    if (!row || row.appId !== token.appId || row.userId !== mediaJobUserId(req, token.appId, row.createdAt) || row.expiresAt <= Date.now()) {
      throw new HttpError(404, 'JOB_NOT_FOUND', '任务不存在或已过期');
    }
    if ((row.status === 'queued' || row.status === 'processing') && row.stage !== 'completed') {
      const runtimeJob = activeChatJobs.has(id);
      if (!runtimeJob) {
        await getDb().update(llmChatJobs).set({
          status: 'failed',
          stage: 'failed',
          error: '服务器重启导致任务中断，请重新提交。',
          updatedAt: Date.now(),
        }).where(eq(llmChatJobs.id, id));
        row.status = 'failed';
        row.stage = 'failed';
        row.error = '服务器重启导致任务中断，请重新提交。';
      }
    }
    res.json({
      id: row.id,
      status: row.status,
      stage: row.stage,
      model: row.model,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
      timings: JSON.parse(row.timingsJson),
      ...(row.resultJson ? { result: JSON.parse(row.resultJson) } : {}),
      ...(row.error ? { error: row.error } : {}),
    });
  }),
);

// ---------- aap.llm.chat 平台代理（签名归因 → 网关） ----------

aapRouter.post(
  '/llm/chat',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    const body = (req.body ?? {}) as {
      messages?: unknown;
      model?: string;
      max_tokens?: number;
      temperature?: number;
      identityPayload?: string;
      identitySig?: string;
    };
    if (!Array.isArray(body.messages)) {
      throw new HttpError(400, 'INVALID_INPUT', 'messages 必填');
    }
    // 能力声明校验（G1）：未声明 llm 的包不允许调用（与 /v1 网关同一判定，审计 F1）
    if (!await appLlmAllowed(token.appId)) {
      throw new HttpError(403, 'CAPABILITY_NOT_DECLARED', '该应用 manifest 未声明 llm 能力');
    }
    // 规范 §3.1「不填用平台默认模型」：缺省取 LLM_DEFAULT_MODEL 设置，未设置取目录第一个
    let model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      model = await resolveDefaultModel() ?? '';
      if (!model) {
        throw new HttpError(400, 'INVALID_INPUT', '未指定 model，且网关模型目录为空——请管理员先在「LLM 网关」配置模型路由（或在设置中指定沙箱默认模型）');
      }
    }
    // max_tokens：包显式指定优先；未指定时按 LLM_SANDBOX_MAX_TOKENS 注入（0 = 不限制，
    // 模型自然收尾，实际用量照常归因计量——推理型模型思考消耗大，由平台统一治理而非包内硬编码）
    let maxTokens: number | null = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : null;
    if (maxTokens === null) {
      const configured = getSettingInt('LLM_SANDBOX_MAX_TOKENS', 0);
      if (configured > 0) maxTokens = configured;
    }
    // 归因：SDK 透传运行身份头（invoked=运行用户；persistent=门户代理注入的请求身份），验签 aud=appId
    let userId: number | null = null;
    const idPayload = req.headers['x-aap-identity'];
    const idSig = req.headers['x-aap-identity-sig'];
    if (typeof idPayload === 'string' && typeof idSig === 'string') {
      const secret = getSetting('AAP_SIGN_SECRET');
      if (secret) {
        // allowReplay：invoked 沙箱在一次运行内多次调用复用同一环境身份；
        // 重放防护由面向外部的网关侧验签承担
        const v = verifyIdentity(idPayload, idSig, secret, token.appId, { allowReplay: true });
        if (v.ok) userId = Number(v.payload.uid) || null;
      }
    }

    // 平台自签身份头转发网关（invoked：运行用户；persistent 无头时仅应用级计量）
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${(req.headers['x-aap-token'] as string) ?? ''}`,
    };
    if (userId !== null) {
      const user = (await getDb().select().from(users).where(eq(users.id, userId)))[0];
      if (user) {
        const idn = signIdentity(
          {
            id: user.id,
            kind: user.kind === 'oidc' ? 'oidc' : 'local',
            subject: `local:${user.username ?? user.id}`,
            username: user.username,
            email: user.email,
            phone: user.phone,
            name: user.name,
            avatar: user.avatar,
            role: user.role === 'admin' ? 'admin' : 'user',
            status: user.status,
            sessionId: 'aap-egress',
            authState: 'full' as const,
            stepUpUntil: null,
            plan: user.plan === 'member' ? 'member' : 'free',
            mfaEnabled: Boolean(user.mfaEnabled),
            mustChangePassword: Boolean(user.mustChangePassword),
            membershipSelectionRequired: Boolean(user.membershipSelectionRequired),
          },
          token.appId,
        );
        if (idn) {
          headers['x-aap-identity'] = idn.payload;
          headers['x-aap-identity-sig'] = idn.sig;
        }
      }
    }

    // 平台地址取明文 HTTP 环回口（TLS 到达时回落 config.port，同 appsRun 的
    // loopbackPlatformPort 修正：非常规端口部署不打空，TLS 口明文调用不悬断）
    const platformPort = loopbackPlatformPort(req.socket.localPort, config);
    const gwRes = await fetch(`http://127.0.0.1:${platformPort}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: body.messages,
        model,
        ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      }),
    });
    const text = await gwRes.text();
    res.status(gwRes.status).type('application/json').send(text);
  }),
);
// ---------- aap.http.fetch 出站代理（白名单执行点） ----------

function hostAllowed(hostname: string, network: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const entry of network) {
    const e = entry.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host === e) return true;
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // .example.com
      if (host.endsWith(suffix) || host === suffix.slice(1)) return true;
    }
  }
  return false;
}

/** 私网/保留段 IP 判定（IPv4 + IPv6）。对 DNS 解析结果逐条复核，防
 *  `127.0.0.1.nip.io` 类域名经白名单解析到内网（已实测 SSRF 利用路径）。 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // v4 映射
    // fc00::/7 ULA、fe80::/10 链路本地、2001:db8::/32 文档段
    const first = parseInt(lower.split(':')[0] ?? 'ffff', 16);
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    if (first === 0x2001 && (lower.startsWith('2001:db8:') || lower.startsWith('2001:db8::'))) return true;
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // 非法格式按拒绝处理
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 本网络/私网/环回
  if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24、192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段
  if (a >= 224) return true; // 组播/保留/广播
  return false;
}

/** 解析域名全部 A/AAAA 记录；失败返回 null（按拒绝处理） */
function resolveHostIps(hostname: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err || !addrs || addrs.length === 0) resolve(null);
      else resolve(addrs.map((a) => a.address));
    });
  });
}

// ---------- 内网出站白名单（管理员级；供内网部署放行局域网目标） ----------

export interface IntranetAllowlist {
  /** 精确域名 / IP 字面量（小写） */
  hosts: Set<string>;
  /** IPv4 CIDR */
  cidrs: Array<{ net: number; prefix: number }>;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255 || !/^\d+$/.test(p)) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function parseIntranetAllowlist(raw: string | null | undefined): IntranetAllowlist {
  const hosts = new Set<string>();
  const cidrs: Array<{ net: number; prefix: number }> = [];
  for (const rawEntry of (raw ?? '').split(/[,\n;]+/)) {
    const entry = rawEntry.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (!entry) continue;
    const [base, suffix] = entry.split('/');
    if (!base) continue;
    // 仅当「base 是 IPv4 且后缀是纯数字」才按 CIDR 解析；否则视为域名/IP 字面量
    if (suffix !== undefined && /^\d+$/.test(suffix)) {
      const net = ipv4ToInt(base);
      const prefix = Number(suffix);
      if (net === null || prefix < 0 || prefix > 32) continue;
      cidrs.push({ net, prefix });
    } else {
      hosts.add(base);
    }
  }
  return { hosts, cidrs };
}

export function ipInAllowCidr(ip: string, cidrs: IntranetAllowlist['cidrs']): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false; // IPv6 仅支持精确条目，不走 CIDR
  return cidrs.some(({ net, prefix }) => prefix === 0 || ((n ^ net) >>> (32 - prefix)) === 0);
}

/**
 * 单跳出站闸门：IP 字面量与内网主机名默认拒绝；管理员「内网出站白名单」
 * 命中（精确域名/IP 或 CIDR 覆盖）即完全放行——管理员权威高于包声明，
 * CIDR 区间无法要求包逐 IP 自我声明。未命中时包的 manifest network
 * 白名单照常生效。
 */
export function egressHostGate(
  hostname: string,
  network: string[],
  allow: IntranetAllowlist,
): { ok: true } | { ok: false; message: string } {
  const host = hostname.toLowerCase();
  const adminVouched = allow.hosts.has(host) || (net.isIP(host) && ipInAllowCidr(host, allow.cidrs));
  if (adminVouched) return { ok: true };
  if (net.isIP(host)) {
    return { ok: false, message: '禁止直连 IP/内网地址（如需内网出站，管理员可在「内网出站白名单」放行）' };
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, message: '禁止访问内网主机名（如需内网出站，管理员可在「内网出站白名单」放行）' };
  }
  if (!hostAllowed(host, network)) {
    return { ok: false, message: `域名 ${hostname} 不在该应用 manifest network 白名单内` };
  }
  return { ok: true };
}

const MAX_EGRESS_HOPS = 5;

aapRouter.post(
  '/egress',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    const body = (req.body ?? {}) as { url?: string; headers?: Record<string, unknown> };
    const url = String(body.url ?? '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, 'INVALID_URL', 'URL 不合法');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(400, 'INVALID_URL', '仅支持 http/https 出站');
    }
    // 包自定义请求头（如第三方 API 的鉴权头，密钥来自门户注入的环境变量，不落代码）：
    // 名称/数量/长度受限；逐跳与托管类头一律剥除（防流控/长度/代理语义被包改写）
    const HOP_BY_HOP = /^(host|connection|keep-alive|proxy-connection|transfer-encoding|te|trailer|upgrade|expect|content-length|content-type|proxy-authorization|proxy-authenticate|cookie2)$/i;
    let fwdHeaders: Record<string, string> | undefined;
    if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
      fwdHeaders = {};
      for (const [k, v] of Object.entries(body.headers)) {
        if (Object.keys(fwdHeaders).length >= 16) break;
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || HOP_BY_HOP.test(k)) continue;
        fwdHeaders[k] = (await String(v)).slice(0, 4096);
      }
      if (Object.keys(fwdHeaders).length === 0) fwdHeaders = undefined;
    }
    const app = (await getDb().select().from(apps).where(eq(apps.id, token.appId)))[0];
    let network: string[] = [];
    if (app?.manifestJson) {
      try {
        const m = JSON.parse(app.manifestJson) as { network?: unknown };
        if (Array.isArray(m.network)) network = m.network.map(String);
      } catch {
        /* ignore */
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const allow = parseIntranetAllowlist(getSetting('EGRESS_INTRANET_ALLOWLIST'));
    try {
      // 白名单与 IP 黑名单逐跳校验：redirect 用 manual 手动跟进，
      // 防白名单域名经 302 跳转内网/平台自身（SSRF 绕过）
      let current = parsed;
      for (let hop = 0; ; hop++) {
        if (hop > MAX_EGRESS_HOPS) {
          throw new HttpError(502, 'EGRESS_REDIRECT_LOOP', '出站重定向次数超限');
        }
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          throw new HttpError(400, 'INVALID_URL', '仅支持 http/https 出站');
        }
        const gate = egressHostGate(current.hostname, network, allow);
        if (!gate.ok) {
          throw new HttpError(403, 'EGRESS_DENIED', gate.message);
        }
        // 解析后 IP 复核：白名单域名若指向内网/保留地址（nip.io 类 DNS 绕过）
        // 一律拦截；对全部 A/AAAA 记录判定。管理员「内网出站白名单」可放行：
        // 精确主机名（vouch 其全部解析）或 CIDR（覆盖解析 IP）。169.254/fe80 链路
        // 本地（云元数据）无条件拒绝。
        if (!net.isIP(current.hostname)) {
          const ips = await resolveHostIps(current.hostname);
          if (!ips) {
            throw new HttpError(403, 'EGRESS_DENIED', `域名 ${current.hostname} 无法解析`);
          }
          const linkLocal = ips.some((ip) => ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fe80:'));
          if (linkLocal) {
            throw new HttpError(403, 'EGRESS_DENIED', '链路本地地址（云元数据段）始终拒绝');
          }
          const vouched = allow.hosts.has(current.hostname.toLowerCase());
          const uncovered = (ip: string): boolean => isPrivateIp(ip) && !ipInAllowCidr(ip, allow.cidrs);
          if (!vouched && ips.some(uncovered)) {
            throw new HttpError(403, 'EGRESS_DENIED', `域名 ${current.hostname} 解析到内网/保留地址，已拦截`);
          }
        }
        const up = await fetch(current.toString(), { method: 'GET', signal: ctrl.signal, redirect: 'manual', headers: fwdHeaders });
        const loc = up.status >= 300 && up.status < 400 ? up.headers.get('location') : null;
        if (loc) {
          up.body?.cancel();
          current = new URL(loc, current);
          continue;
        }
        const text = (await up.text()).slice(0, 2 * 1024 * 1024);
        res.json({ status: up.status, body: text.slice(0, 500_000) });
        return;
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // 错误详情（DNS/连接错误信息可作内网探测 oracle）只进服务端日志，不回传调用者
      console.error('[aap] egress failed:', err instanceof Error ? err.message : err);
      throw new HttpError(504, 'EGRESS_FAILED', '出站请求失败');
    } finally {
      clearTimeout(timer);
    }
  }),
);
