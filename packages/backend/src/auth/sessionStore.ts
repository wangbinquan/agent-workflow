// RFC-036 — user_sessions store. Raw session token: `aws_s_<32-hex>`; only
// sha256(raw) lands in DB. Caller is responsible for setting actor.user only
// after status='active' is confirmed (handled here by lookupActiveSession).

import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { ulid } from 'ulid'
import { SESSION_TOKEN_PREFIX } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { userSessions, users } from '@/db/schema'
import { triggerRevalidation } from '@/ws/revalidationHook'

/** 7 days by default — matches design.md §R4. */
export const SESSION_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionRecord {
  id: string
  userId: string
  userAgent: string | null
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  revokedAt: number | null
}

export function generateSessionToken(): string {
  // 32 bytes of entropy → 64 hex chars; plus the 6-char prefix.
  return `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export interface CreateSessionInput {
  db: DbClient
  userId: string
  userAgent?: string | null
  ttlMs?: number
  now?: number
}

export interface CreateSessionResult {
  token: string
  session: SessionRecord
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const now = input.now ?? Date.now()
  const ttl = input.ttlMs ?? SESSION_DEFAULT_TTL_MS
  const token = generateSessionToken()
  const id = ulid()
  const row = {
    id,
    userId: input.userId,
    tokenHash: hashToken(token),
    userAgent: input.userAgent ?? null,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + ttl,
    revokedAt: null,
  }
  await input.db.insert(userSessions).values(row)
  return {
    token,
    session: {
      id: row.id,
      userId: row.userId,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: null,
    },
  }
}

export interface ResolvedSession {
  session: SessionRecord
  user: typeof users.$inferSelect
}

export async function lookupActiveSession(
  db: DbClient,
  raw: string,
  now: number = Date.now(),
): Promise<ResolvedSession | null> {
  if (!raw.startsWith(SESSION_TOKEN_PREFIX)) return null
  return lookupActiveSessionByHash(db, hashToken(raw), now)
}

/**
 * RFC-212 — the same lookup keyed by the token HASH instead of the raw token,
 * so a live WebSocket can be re-checked without keeping the plaintext
 * credential in memory for the lifetime of the connection.
 *
 * `touch: false` additionally skips the rolling `last_used_at` write. The
 * revalidation pass runs once per live connection on every revocation, so
 * leaving the write in would turn a single ACL edit into one write per open
 * socket AND make `last_used_at` (surfaced on /account) report a credential as
 * "just used" merely because a tab was left open.
 */
export async function lookupActiveSessionByHash(
  db: DbClient,
  hash: string,
  now: number = Date.now(),
  opts: { touch?: boolean } = {},
): Promise<ResolvedSession | null> {
  const touch = opts.touch ?? true
  const rows = await db.select().from(userSessions).where(eq(userSessions.tokenHash, hash)).limit(1)
  const session = rows[0]
  if (!session) return null
  if (session.revokedAt !== null) return null
  if (session.expiresAt < now) return null

  const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1)
  const user = userRows[0]
  if (!user || user.status !== 'active') return null

  // Rolling renewal: bump last_used_at on every successful lookup — except on
  // the read-only revalidation path (RFC-212), see the doc comment above.
  if (touch) {
    await db.update(userSessions).set({ lastUsedAt: now }).where(eq(userSessions.id, session.id))
  }
  return {
    user,
    session: {
      id: session.id,
      userId: session.userId,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastUsedAt: touch ? now : session.lastUsedAt,
      expiresAt: session.expiresAt,
      revokedAt: null,
    },
  }
}

export async function revokeSession(
  db: DbClient,
  sessionId: string,
  now: number = Date.now(),
): Promise<void> {
  await db.update(userSessions).set({ revokedAt: now }).where(eq(userSessions.id, sessionId))
  // RFC-212 — close any live WS the revoked session opened. After the write.
  triggerRevalidation(db, 'session-revoked')
}

export async function revokeAllSessionsForUser(
  db: DbClient,
  userId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(userSessions)
    .set({ revokedAt: now })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
  // RFC-212 — the bulk path (change-password / "log out other sessions") does
  // NOT go through revokeSession, so it needs its own trigger.
  triggerRevalidation(db, 'sessions-revoked-bulk')
}

export async function sweepExpiredSessions(
  db: DbClient,
  now: number = Date.now(),
): Promise<number> {
  // Hard-delete fully-expired rows that were already revoked — sessions store grows otherwise.
  const result = await db
    .delete(userSessions)
    .where(and(lt(userSessions.expiresAt, now), lt(userSessions.expiresAt, now)))
  // Drizzle returns the underlying bun:sqlite ChangeStats; treat unknown safely.
  const changes = (result as unknown as { changes?: number }).changes
  return typeof changes === 'number' ? changes : 0
}

export async function listActiveSessionsForUser(
  db: DbClient,
  userId: string,
  now: number = Date.now(),
): Promise<SessionRecord[]> {
  const rows = await db
    .select()
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId)))
  return rows
    .filter((r) => r.revokedAt === null && r.expiresAt >= now)
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
    }))
}
