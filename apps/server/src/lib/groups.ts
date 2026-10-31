/**
 * 用户分组（P）：会员等级 / 自定义组。应用可见性（restricted）的目标集合；
 * M3 的会员等级直接落成分组（不同分组可见不同应用、配发不同 LLM 额度）。
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { userGroupMembers, userGroups } from '../db/schema.js';
import { HttpError } from './httpError.js';

export interface GroupRow {
  id: number;
  name: string;
  note: string;
  createdAt: number;
  memberCount: number;
}

export async function listGroups(): Promise<GroupRow[]> {
  const rows = await getDb()
    .select({
      id: userGroups.id,
      name: userGroups.name,
      note: userGroups.note,
      createdAt: userGroups.createdAt,
      memberCount: sql<number>`(select count(*) from user_group_members m where m.group_id = ${userGroups.id})`,
    })
    .from(userGroups)
    .orderBy(sql`id`);
  return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount) }));
}

export async function createGroup(name: string, note: string): Promise<number> {
  const exists = (await getDb().select({ id: userGroups.id }).from(userGroups).where(eq(userGroups.name, name)))[0];
  if (exists) throw new HttpError(409, 'GROUP_EXISTS', '同名分组已存在');
  const [created] = await getDb()
    .insert(userGroups)
    .values({ name: name.trim().slice(0, 64), note: note.slice(0, 200), createdAt: Date.now() })
    .returning({ id: userGroups.id });
  if (!created) throw new Error('Failed to create group');
  return created.id;
}

export async function updateGroup(id: number, patch: { name?: string; note?: string }): Promise<void> {
  const set: Partial<typeof userGroups.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 64);
  if (patch.note !== undefined) set.note = patch.note.slice(0, 200);
  await getDb().update(userGroups).set(set).where(eq(userGroups.id, id));
}

export async function deleteGroup(id: number): Promise<void> {
  await getDb().delete(userGroups).where(eq(userGroups.id, id));
}

export async function groupMemberIds(groupId: number): Promise<number[]> {
  const rows = await getDb()
    .select({ userId: userGroupMembers.userId })
    .from(userGroupMembers)
    .where(eq(userGroupMembers.groupId, groupId));
  return rows.map((r) => r.userId);
}

/** 全量替换组成员（管理端多选保存） */
export async function setGroupMembers(groupId: number, userIds: number[]): Promise<void> {
  const db = getDb();
  await db.delete(userGroupMembers).where(eq(userGroupMembers.groupId, groupId));
  const now = Date.now();
  for (const uid of [...new Set(userIds)]) {
    await db.insert(userGroupMembers).values({ groupId, userId: uid, createdAt: now });
  }
}

/** 用户所属分组 id 集合（可见性判定用） */
export async function userGroupIds(userId: number): Promise<Set<number>> {
  const rows = await getDb()
    .select({ groupId: userGroupMembers.groupId })
    .from(userGroupMembers)
    .where(eq(userGroupMembers.userId, userId));
  return new Set(rows.map((r) => r.groupId));
}
