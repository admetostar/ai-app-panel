import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { llmMediaFiles } from '../db/schema.js';
import { HttpError } from './httpError.js';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_MEDIA_COUNT = 20;

export async function resolveStagedMediaMessages(
  messages: unknown[],
  mediaIds: unknown,
  appId: string,
  userId: number | null,
): Promise<{ messages: unknown[]; mediaTypes: Array<'image' | 'video'> }> {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0 || mediaIds.length > MAX_MEDIA_COUNT
    || mediaIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new HttpError(400, 'INVALID_MEDIA_REFERENCE', '媒体引用列表无效');
  }
  const ids = mediaIds as string[];
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'INVALID_MEDIA_REFERENCE', '媒体引用不能重复');

  const rows = await getDb().select().from(llmMediaFiles).where(inArray(llmMediaFiles.id, ids));
  if (rows.length !== ids.length || rows.some((row) => row.appId !== appId || row.userId !== userId || row.expiresAt <= Date.now())) {
    throw new HttpError(404, 'MEDIA_NOT_FOUND', '媒体不存在、已过期或不属于当前应用/用户');
  }
  if (rows.reduce((total, row) => total + row.size, 0) > MAX_MEDIA_BYTES) {
    throw new HttpError(413, 'MEDIA_BATCH_TOO_LARGE', '单次 chat 的媒体文件总量不能超过 50 MB');
  }

  const mediaById = new Map(rows.map((row) => [row.id, row]));
  const referencedIds: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'aap_media') continue;
      const id = (part as Record<string, unknown>).media_id;
      if (typeof id !== 'string' || !mediaById.has(id)) throw new HttpError(400, 'INVALID_MEDIA_REFERENCE', '消息包含无效媒体引用');
      referencedIds.push(id);
    }
  }
  if (referencedIds.length !== ids.length || new Set(referencedIds).size !== ids.length) {
    throw new HttpError(400, 'INVALID_MEDIA_REFERENCE', '每个已上传媒体必须在消息中恰好引用一次');
  }

  const data = new Map<string, string>();
  for (const row of rows) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(config.dataDir, 'llm-media', row.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'MEDIA_NOT_FOUND', '暂存媒体文件已过期或丢失');
      }
      throw error;
    }
    if (bytes.length !== row.size) throw new HttpError(400, 'INVALID_MEDIA_FILE', '暂存媒体文件长度校验失败');
    data.set(row.id, bytes.toString('base64'));
  }

  const mediaTypes = [...new Set(rows.map((row) => row.mimeType.startsWith('video/') ? 'video' : 'image'))];
  const resolvedMessages = messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) return message;
    return {
      ...record,
      content: record.content.map((part) => {
        if (!part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'aap_media') return part;
        const id = String((part as Record<string, unknown>).media_id);
        const row = mediaById.get(id)!;
        const dataUri = `data:${row.mimeType};base64,${data.get(id)!}`;
        return row.mimeType.startsWith('video/')
          ? { type: 'video_url', video_url: { url: dataUri } }
          : { type: 'image_url', image_url: { url: dataUri } };
      }),
    };
  });
  return { messages: resolvedMessages, mediaTypes };
}
