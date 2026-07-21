// RFC-036 — three-track auth middleware (session token / PAT / daemon token).
// Prefix disambiguation guarantees no overlap:
//   aws_s_<32-hex>    → user session
//   aws_pat_<32-hex>  → personal access token
//   64-char raw hex   → legacy daemon token (resolves to __system__ admin actor)
// Any other shape returns 401.

import { timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import {
  PAT_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
import { UnauthorizedError } from '@/util/errors'
import { buildActor, SYSTEM_USER_ID, type Actor } from './actor'
import { hashToken as hashPatToken, lookupActivePat } from './patStore'
import { hashToken as hashSessionToken, lookupActiveSession } from './sessionStore'

export interface MultiAuthDeps {
  db: DbClient
  daemonToken: string
  /** Override for tests that want a fixed clock. */
  now?: () => number
}

// RFC-036 — public paths that bypass multiAuth entirely. The OIDC login flow
// must be reachable before the user has a session token (they are obtaining
// one via the IdP). Each entry is a path prefix; `:slug` segments are
// matched by the literal-then-/ shape, no regex required.
const PUBLIC_PATH_PREFIXES = [
  '/api/auth/oidc/providers', // list enabled providers for the login page
  '/api/auth/oidc/', // /api/auth/oidc/:slug/login/start + /callback
  '/api/auth/login',
] as const

function isPublicAuthPath(path: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => path === p || path.startsWith(p))
}

export function multiAuth(deps: MultiAuthDeps): MiddlewareHandler {
  const daemonBuf = Buffer.from(deps.daemonToken, 'utf-8')
  return async (c, next) => {
    if (isPublicAuthPath(c.req.path)) {
      await next()
      return
    }
    const raw = extractRawToken(c)
    if (!raw) throw new UnauthorizedError()
    const now = deps.now ? deps.now() : Date.now()
    const actor = await resolveActor(deps.db, raw, daemonBuf, now)
    if (!actor) throw new UnauthorizedError()
    c.set('actor', actor)
    await next()
  }
}

/**
 * RFC-212 — classify a raw token into the fingerprint a live WebSocket keeps for
 * revalidation. Mirrors `resolveActor`'s prefix dispatch exactly, so the two can
 * never disagree about which store a credential belongs to.
 */
export function describeCredential(raw: string): WsCredentialFingerprint {
  if (raw.startsWith(SESSION_TOKEN_PREFIX)) return { kind: 'session', hash: hashSessionToken(raw) }
  if (raw.startsWith(PAT_TOKEN_PREFIX)) return { kind: 'pat', hash: hashPatToken(raw) }
  return { kind: 'daemon' }
}

export type WsCredentialFingerprint =
  | { readonly kind: 'session' | 'pat'; readonly hash: string }
  | { readonly kind: 'daemon' }

export async function resolveActor(
  db: DbClient,
  raw: string,
  daemonTokenBuf: Buffer,
  now: number = Date.now(),
): Promise<Actor | null> {
  if (raw.startsWith(SESSION_TOKEN_PREFIX)) {
    const resolved = await lookupActiveSession(db, raw, now)
    if (!resolved) return null
    return buildActor({
      user: {
        id: resolved.user.id,
        username: resolved.user.username,
        displayName: resolved.user.displayName,
        role: resolved.user.role as Role,
        status: resolved.user.status as 'active' | 'disabled' | 'invited',
      },
      source: 'session',
    })
  }
  if (raw.startsWith(PAT_TOKEN_PREFIX)) {
    const resolved = await lookupActivePat(db, raw, now)
    if (!resolved) return null
    return buildActor({
      user: {
        id: resolved.user.id,
        username: resolved.user.username,
        displayName: resolved.user.displayName,
        role: resolved.user.role as Role,
        status: resolved.user.status as 'active' | 'disabled' | 'invited',
      },
      source: 'pat',
      patScopes: resolved.scopes as ReadonlyArray<Permission>,
    })
  }
  // Legacy daemon token: any opaque string the daemon was launched with.
  // The 64-hex shape is what `generateToken()` produces but we accept the
  // value verbatim — tests and admins may rotate to other shapes.
  if (!safeEqual(Buffer.from(raw, 'utf8'), daemonTokenBuf)) return null

  const sysRows = await db.select().from(users).where(eq(users.id, SYSTEM_USER_ID)).limit(1)
  const sys = sysRows[0]
  if (!sys) return null
  return buildActor({
    user: {
      id: sys.id,
      username: sys.username,
      displayName: sys.displayName,
      role: sys.role as Role,
      status: sys.status as 'active' | 'disabled' | 'invited',
    },
    source: 'daemon',
  })
}

function extractRawToken(c: Context): string | null {
  const query = c.req.query('token')
  if (query && query.length > 0) return query
  const header = c.req.header('Authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S+)\s*$/i)
  if (!match || !match[1]) return null
  return match[1]
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
