// RFC-036 — user_pats store. Raw PAT token: `aws_pat_<32-hex>`. Same hash-only
// design as user_sessions but with optional scopes (PAT narrows the actor's
// effective account permissions; never widens them — see auth/actor.ts).

import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  PAT_TOKEN_PREFIX,
  type PatPublic,
  type PatPurpose,
  type Permission,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { userPats, users } from '@/db/schema'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { sha256Hex } from '@/util/hash'

export interface CreatePatInput {
  db: DbClient
  userId: string
  name: string
  scopes?: ReadonlyArray<Permission>
  /**
   * RFC-247 D2 — REQUIRED, with no default on purpose.
   *
   * A store-level default would have to guess, and both guesses are wrong in
   * some caller: `mcp_only` silently breaks every existing REST automation
   * fixture, `general` silently widens tokens the UI meant to scope to MCP.
   * Making it explicit moves the mistake to compile time, where the call site
   * that knows the answer is right there.
   */
  purpose: PatPurpose
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
  return sha256Hex(raw)
}

export async function createPat(input: CreatePatInput): Promise<CreatePatResult> {
  const now = input.now ?? Date.now()
  const token = generatePatToken()
  const id = ulid()
  const scopes = input.scopes ? Array.from(input.scopes) : []
  const purpose: PatPurpose = input.purpose
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
    purpose,
  }
  await input.db.insert(userPats).values(row)
  return {
    token,
    meta: {
      id,
      name: row.name,
      scopes,
      purpose,
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
  /** RFC-247 D2 — the purpose gate reads this; see auth/session.ts. */
  purpose: PatPurpose
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
    purpose: (pat.purpose === 'general' ? 'general' : 'mcp_only') as PatPurpose,
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
  triggerRevalidation('pat-revoked')
}

/**
 * RFC-247 D8 — every token on the platform, for the administrator's read-only
 * inventory. Carries `userId` (unlike `PatPublic`) because "whose token is
 * this" is the entire point of the admin view; the hash is never included, so
 * this cannot become a credential-recovery path.
 */
export async function listAllPats(db: DbClient): Promise<Array<PatPublic & { userId: string }>> {
  const rows = await db.select().from(userPats)
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    scopes: safeParseScopes(r.scopesJson),
    purpose: (r.purpose === 'general' ? 'general' : 'mcp_only') as PatPurpose,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }))
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
    purpose: (r.purpose === 'general' ? 'general' : 'mcp_only') as PatPurpose,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }))
}
