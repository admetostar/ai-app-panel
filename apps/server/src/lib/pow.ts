/**
 * 工作量证明（hashcash 风格，SHA-256 前导零位）——移植自参考实现 lib/pow.js。
 * 挑战：给定 seed 与 difficulty（前导零位数），客户端求 nonce 使
 * SHA-256(seed + ':' + nonce) 二进制前 difficulty 位为 0。
 * 服务端校验读后即删（一次性）、绑 IP、短时效。
 */
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { powChallenges } from '../db/schema.js';
import { getSettingInt } from './settings.js';
import { issuePowToken, powDifficulty } from './security.js';

export interface PowChallenge {
  challengeId: string;
  seed: string;
  difficulty: number;
}

export async function issueChallenge(ip: string): Promise<PowChallenge> {
  const challengeId = randomBytes(16).toString('hex');
  const seed = randomBytes(16).toString('hex');
  const difficulty = await powDifficulty(ip);
  const now = Date.now();
  const ttl = getSettingInt('POW_CHALLENGE_TTL', 300);
  await getDb().insert(powChallenges).values({
    id: challengeId,
    seed,
    difficulty,
    ip,
    createdAt: now,
    expiresAt: now + ttl * 1000,
  });
  return { challengeId, seed, difficulty };
}

export type PowVerifyResult = { ok: true; token: string } | { ok: false; error: string };

/** 服务端校验：返回 PoW token（绑 IP）；挑战读后即删防重放 */
export async function verifyPow(challengeId: string, nonce: string, ip: string): Promise<PowVerifyResult> {
  const [ch] = await getDb()
    .delete(powChallenges)
    .where(eq(powChallenges.id, challengeId))
    .returning({
      id: powChallenges.id,
      seed: powChallenges.seed,
      difficulty: powChallenges.difficulty,
      ip: powChallenges.ip,
      created_at: powChallenges.createdAt,
      expires_at: powChallenges.expiresAt,
    });
  if (!ch) return { ok: false, error: 'CHALLENGE_NOT_FOUND' };
  if (ch.expires_at <= Date.now()) return { ok: false, error: 'CHALLENGE_EXPIRED' };
  if (ch.ip !== ip) return { ok: false, error: 'IP_MISMATCH' };

  // nonce 必须是纯数字（客户端 WebCrypto 循环产物）
  if (!/^[0-9]+$/.test(String(nonce))) return { ok: false, error: 'INVALID_NONCE' };

  const hashHex = createHash('sha256').update(`${ch.seed}:${nonce}`).digest('hex');
  if (!hasLeadingZeroBits(hashHex, ch.difficulty)) {
    return { ok: false, error: 'PROOF_INVALID' };
  }
  return { ok: true, token: await issuePowToken(ip) };
}

/** 判断十六进制哈希的前 N 个二进制位是否全为 0（按 nibble 逐位判断） */
export function hasLeadingZeroBits(hashHex: string, bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < hashHex.length && remaining > 0; i++) {
    const nibble = parseInt(hashHex[i]!, 16);
    if (nibble === 0) {
      remaining -= 4;
      continue;
    }
    let z = 0;
    for (let b = 3; b >= 0; b--) {
      if ((nibble >> b) & 1) break;
      z++;
    }
    return z >= remaining;
  }
  return remaining <= 0;
}
