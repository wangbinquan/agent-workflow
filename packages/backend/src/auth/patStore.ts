// RFC-036 — user_pats store. Raw PAT token: `aws_pat_<32-hex>`. Same hash-only
// design as user_sessions but with optional scopes (PAT narrows the actor's
// role permissions; never widens them — see auth/actor.ts).

import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { PAT_TOKEN_PREFIX, type Permission, type PatPublic } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { userPats, users } from '@/db/schema'
import { triggerRevalidation } from '@/ws/revalidationHook'

export interface CreatePatInput {
  db: DbClient
  userId: string
  name: string
  scopes?: ReadonlyArray<Permission>
  expiresAt?: number | null
  now?: number
}

export interface CreatePatResult {
  /** Raw token — returned ONCE; caller must surface to user immediately. */
  token: string
  meta: PatPublic
}

export function generatePatToken(): string {
  return `${PAT_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export async function createPat(input: CreatePatInput): Promise<CreatePatResult> {
  const now = input.now ?? Date.now()
  const token = generatePatToken()
  const id = ulid()
  const scopes = input.scopes ? Array.from(input.scopes) : []
  const row = {
    id,
    userId: input.userId,
    name: input.name,
    tokenHash: hashToken(token),
    scopesJson: JSON.stringify(scopes),
    createdAt: now,
    lastUsedAt: null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
  }
  await input.db.insert(userPats).values(row)
  return {
    token,
    meta: {
      id,
      name: row.name,
      scopes,
      createdAt: row.createdAt,
      lastUsedAt: null,
      expiresAt: row.expiresAt,
      revokedAt: null,
    },
  }
}

export interface ResolvedPat {
  user: typeof users.$inferSelect
  scopes: ReadonlyArray<Permission>
  patId: string
  /** RFC-212 — surfaced so a WS credential can carry the PAT's expiry. */
  expiresAt: number | null
}

export async function lookupActivePat(
  db: DbClient,
  raw: string,
  now: number = Date.now(),
): Promise<ResolvedPat | null> {
  if (!raw.startsWith(PAT_TOKEN_PREFIX)) return null
  return lookupActivePatByHash(db, hashToken(raw), now)
}

/** RFC-212 — hash-keyed twin of `lookupActivePat`; see lookupActiveSessionByHash. */
export async function lookupActivePatByHash(
  db: DbClient,
  hash: string,
  now: number = Date.now(),
  opts: { touch?: boolean } = {},
): Promise<ResolvedPat | null> {
  const touch = opts.touch ?? true
  const rows = await db.select().from(userPats).where(eq(userPats.tokenHash, hash)).limit(1)
  const pat = rows[0]
  if (!pat) return null
  if (pat.revokedAt !== null) return null
  if (pat.expiresAt !== null && pat.expiresAt < now) return null

  const userRows = await db.select().from(users).where(eq(users.id, pat.userId)).limit(1)
  const user = userRows[0]
  if (!user || user.status !== 'active') return null

  if (touch) {
    await db.update(userPats).set({ lastUsedAt: now }).where(eq(userPats.id, pat.id))
  }
  return {
    user,
    scopes: safeParseScopes(pat.scopesJson),
    patId: pat.id,
    expiresAt: pat.expiresAt,
  }
}

function safeParseScopes(raw: string): Permission[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is Permission => typeof x === 'string')
  } catch {
    return []
  }
}

export async function revokePat(
  db: DbClient,
  patId: string,
  now: number = Date.now(),
): Promise<void> {
  await db.update(userPats).set({ revokedAt: now }).where(eq(userPats.id, patId))
  // RFC-212 — close any live WS the revoked PAT opened.
  triggerRevalidation(db, 'pat-revoked')
}

export async function listPatsForUser(db: DbClient, userId: string): Promise<PatPublic[]> {
  const rows = await db
    .select()
    .from(userPats)
    .where(and(eq(userPats.userId, userId)))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scopes: safeParseScopes(r.scopesJson),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }))
}
