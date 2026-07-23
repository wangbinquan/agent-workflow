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
import { allowsLegacyDaemonTestAccess, type DbClient } from '@/db/client'
import { users } from '@/db/schema'
import { getAuthLoginPolicy, isBootstrapRequired } from '@/services/authLoginPolicy'
import { ForbiddenError } from '@/util/errors'
import { UnauthorizedError } from '@/util/errors'
import { buildActor, SYSTEM_USER_ID, type Actor } from './actor'
import { hashToken as hashPatToken, lookupActivePat, lookupActivePatByHash } from './patStore'
import {
  hashToken as hashSessionToken,
  lookupActiveSession,
  lookupActiveSessionByHash,
} from './sessionStore'

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

function isBootstrapDaemonPath(method: string, path: string): boolean {
  return (
    (method === 'GET' && path === '/api/whoami') ||
    (method === 'GET' && path === '/api/auth/bootstrap/status') ||
    (method === 'POST' && path === '/api/auth/bootstrap/admin')
  )
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
    if (
      actor.source === 'daemon' &&
      isBootstrapRequired(deps.db) &&
      !isBootstrapDaemonPath(c.req.method, c.req.path)
    ) {
      throw new ForbiddenError(
        'bootstrap-admin-required',
        'create the first administrator before using the application',
        { setupPath: '/setup/admin' },
      )
    }
    await next()
  }
}

/**
 * RFC-212 — classify a raw token into a WebSocket credential fingerprint, WITHOUT
 * its expiry (the frame-path expiry check needs expiry; the revalidation lookup
 * does not). Mirrors `resolveActor`'s prefix dispatch exactly so the two can
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

/**
 * RFC-212 — the fingerprint a live WebSocket stores, carrying the credential's
 * expiry so the frame path can close a silently-expired connection with zero DB
 * (natural expiry has no write hook to fire a revocation). Reads the expiry once
 * at upgrade time; the actor itself is resolved separately by `resolveActor`.
 */
export async function buildWsCredential(
  db: DbClient,
  raw: string,
): Promise<WsCredentialWithExpiry> {
  if (raw.startsWith(SESSION_TOKEN_PREFIX)) {
    const resolved = await lookupActiveSession(db, raw)
    return {
      kind: 'session',
      hash: hashSessionToken(raw),
      expiresAt: resolved?.session.expiresAt ?? null,
    }
  }
  if (raw.startsWith(PAT_TOKEN_PREFIX)) {
    const resolved = await lookupActivePatByHash(db, hashPatToken(raw), Date.now(), {
      touch: false,
    })
    return { kind: 'pat', hash: hashPatToken(raw), expiresAt: resolved?.expiresAt ?? null }
  }
  return { kind: 'daemon' }
}

export type WsCredentialWithExpiry =
  | { readonly kind: 'session' | 'pat'; readonly hash: string; readonly expiresAt: number | null }
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
  if (getAuthLoginPolicy(db).bootstrapCompletedAt !== null && !allowsLegacyDaemonTestAccess(db))
    return null

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

/**
 * RFC-212 — re-resolve an actor from a stored credential FINGERPRINT (see
 * describeCredential), for the revocation rescan. Read-only: it never writes
 * `last_used_at` (the rescan runs once per live socket on every revocation).
 * Returns null when the credential is revoked / expired / the user is disabled
 * — the caller closes the socket on null. The daemon-kind fingerprint has no
 * stored token row; it re-reads the __system__ user so a deleted system user
 * still closes the socket.
 */
export async function reresolveActor(
  db: DbClient,
  credential: WsCredentialFingerprint,
  now: number = Date.now(),
): Promise<Actor | null> {
  if (credential.kind === 'session') {
    const resolved = await lookupActiveSessionByHash(db, credential.hash, now, { touch: false })
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
  if (credential.kind === 'pat') {
    const resolved = await lookupActivePatByHash(db, credential.hash, now, { touch: false })
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
  // daemon: RFC-221 makes this a one-way bootstrap credential. Revalidation
  // closes every existing daemon socket immediately after the first admin
  // transaction commits.
  if (getAuthLoginPolicy(db).bootstrapCompletedAt !== null && !allowsLegacyDaemonTestAccess(db))
    return null
  const sysRows = await db.select().from(users).where(eq(users.id, SYSTEM_USER_ID)).limit(1)
  const sys = sysRows[0]
  if (!sys || sys.status !== 'active') return null
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
