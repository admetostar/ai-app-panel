import { randomBytes } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../db/index.js';
import { inviteCodes, users } from '../db/schema.js';

function randomInviteCode(): string {
  const value = randomBytes(8).toString('hex').toUpperCase();
  return value.match(/.{1,4}/g)!.join('-');
}

export async function ensureInviteCode(userId: number, executor: DbExecutor = getDb()): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await executor
      .select({ code: inviteCodes.code })
      .from(inviteCodes)
      .where(eq(inviteCodes.ownerUserId, userId)))[0];
    if (existing) return existing.code;

    const [created] = await executor
      .insert(inviteCodes)
      .values({ code: randomInviteCode(), ownerUserId: userId, createdAt: Date.now() })
      .onConflictDoNothing()
      .returning({ code: inviteCodes.code });
    if (created) return created.code;
  }
  throw new Error(`Could not create an invite code for user ${userId}`);
}

export async function ensureInviteCodesForExistingUsers(): Promise<void> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .leftJoin(inviteCodes, eq(users.id, inviteCodes.ownerUserId))
    .where(isNull(inviteCodes.ownerUserId));
  for (const row of rows) await ensureInviteCode(row.id);
}
