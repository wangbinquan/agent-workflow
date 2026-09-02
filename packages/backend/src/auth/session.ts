// RFC-036 — three-track auth middleware (session token / PAT / daemon token).
// Prefix disambiguation guarantees no overlap:
//   aws_s_<32-hex>    → user session
//   aws_pat_<32-hex>  → personal access token
//   64-char raw hex   → legacy daemon token (resolves to __system__ admin actor)
// Any other shape returns 401.

import { timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { PAT_TOKEN_PREFIX, SESSION_TOKEN_PREFIX, type Permission } from '@agent-workflow/shared'
import { hashAuthToken, type AuthRuntime } from '@/auth/application/authRuntime'
import {
  legacySqliteAuthRuntimeOf,
  type LegacySqliteAuthRuntimeBinding,
  type LegacySqliteAuthRuntimeInput,
} from '@/auth/infrastructure/legacySqliteAuthRuntime'
import { ForbiddenError } from '@/util/errors'
import { UnauthorizedError } from '@/util/errors'
import { createInFlightCoalescer } from '@/util/inFlight'
import type {
  AdmittedDaemonCredential,
  AdmittedPatCredential,
  AdmittedSessionCredential,
  DirectAuthorityAdmission,
  DirectAuthorityIdentity,
  DirectRequestAuthority,
} from '@/modules/identity-access/public/participants'
import type { Actor } from './actor'

interface MultiAuthBaseDeps {
  daemonToken: string
  /** Bootstrap-owned runtime shared by HTTP, MCP and WS. */
  identityAccess: DirectAuthorityAdmissionRuntime
  /** Override for tests that want a fixed clock. */
  now?: () => number
}

export type MultiAuthDeps = MultiAuthBaseDeps &
  ({ readonly auth: AuthRuntime; readonly db?: never } | LegacySqliteAuthRuntimeBinding)

export type DirectAuthorityAdmissionRuntime = Readonly<{
  directAuthority: DirectAuthorityAdmission
}>

function admittedSessionCredential(userId: string): AdmittedSessionCredential {
  return Object.freeze({ userId }) as AdmittedSessionCredential
}

function admittedPatCredential(input: {
  readonly userId: string
  readonly scopes: ReadonlyArray<Permission>
  readonly purpose: AdmittedPatCredential['purpose']
  readonly patId: string
}): AdmittedPatCredential {
  return Object.freeze(input) as AdmittedPatCredential
}

const ADMITTED_DAEMON_CREDENTIAL = Object.freeze({}) as AdmittedDaemonCredential

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
  const auth = authRuntimeOf(deps)
  const daemonBuf = Buffer.from(deps.daemonToken, 'utf-8')
  // A browser commonly releases a burst of REST requests after one query
  // invalidation. Resolve one credential snapshot for that overlapping burst;
  // settled results are never cached, so the next request re-reads revocation,
  // status, grants and authority revision exactly as before.
  const resolveInFlight = createInFlightCoalescer<
    string,
    { identity: DirectAuthorityIdentity | null; bootstrapRequired: boolean }
  >()
  return async (c, next) => {
    if (isPublicAuthPath(c.req.path)) {
      await next()
      return
    }
    const raw = extractBearerToken(c)
    if (!raw) throw new UnauthorizedError()
    const now = deps.now ? deps.now() : Date.now()
    const resolved = await resolveInFlight(hashAuthToken(raw), async () => {
      const identity = await resolveIdentity(auth, raw, daemonBuf, deps.identityAccess, now)
      return {
        identity,
        bootstrapRequired:
          identity?.actor.source === 'daemon' && (await auth.isBootstrapRequired()),
      }
    })
    const actor = resolved.identity?.actor as Actor | undefined
    if (actor === undefined) throw new UnauthorizedError()
    c.set('actor', actor)
    if (
      actor.source === 'daemon' &&
      resolved.bootstrapRequired &&
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
  if (raw.startsWith(SESSION_TOKEN_PREFIX)) return { kind: 'session', hash: hashAuthToken(raw) }
  if (raw.startsWith(PAT_TOKEN_PREFIX)) return { kind: 'pat', hash: hashAuthToken(raw) }
  return { kind: 'daemon' }
}

export type WsCredentialFingerprint =
  | { readonly kind: 'session' | 'pat'; readonly hash: string }
  | { readonly kind: 'daemon' }

export type WsCredentialWithExpiry =
  | { readonly kind: 'session' | 'pat'; readonly hash: string; readonly expiresAt: number | null }
  | { readonly kind: 'daemon' }

/**
 * WS 升级专用：**一次解析同时产出 actor 与凭据指纹**。
 *
 * 为什么要有这个函数：`tryUpgrade` 原本先 `resolveActor(db, token)` 再
 * `buildWsCredential(db, token)`，两者**对同一个 token 各跑一遍 lookup**——
 * session 因此每次升级查 4 次、**写两次 `last_used_at`**（rolling renewal 被执行了两遍）。
 * `ws/server.ts` 那行注释自己就写着 "Computed from the same token resolveActor just consumed"，
 * 只是没把结果传下来。合并后每次升级 **5 读 2 写 → 3 读 1 写**，对所有 WS 连接生效。
 *
 * 语义与拆开时逐字一致：
 *   · session —— lookup 仍 touch 一次（原本两次里保留一次，rolling renewal 不受影响）；
 *   · PAT —— 原本 actor 侧 touch、凭据侧 `touch:false`，合并后仍恰好 touch 一次；
 *   · 凭据在 token 无效时也会返回（hash 是纯函数，expiry 为 null），调用方按 actor === null 判 401。
 */
export interface ResolvedUpgradeIdentity {
  readonly actor: Actor | null
  readonly authority: DirectRequestAuthority | null
  readonly credential: WsCredentialWithExpiry
}

export async function resolveActorWithWsCredential(
  authOrDb: AuthRuntime | LegacySqliteAuthRuntimeInput,
  raw: string,
  daemonTokenBuf: Buffer,
  identityAccess: DirectAuthorityAdmissionRuntime,
  now: number = Date.now(),
): Promise<ResolvedUpgradeIdentity> {
  const auth = authRuntimeOf(authOrDb)
  if (raw.startsWith(SESSION_TOKEN_PREFIX)) {
    const resolved = await auth.lookupActiveSession(raw, now)
    const credential = {
      kind: 'session' as const,
      hash: hashAuthToken(raw),
      expiresAt: resolved?.session.expiresAt ?? null,
    }
    if (!resolved) return { actor: null, authority: null, credential }
    const identity = await identityAccess.directAuthority.fromSession(
      admittedSessionCredential(resolved.user.id),
    )
    return {
      actor: (identity?.actor as Actor | undefined) ?? null,
      authority: identity?.authority ?? null,
      credential,
    }
  }
  if (raw.startsWith(PAT_TOKEN_PREFIX)) {
    const resolved = await auth.lookupActivePat(raw, now)
    const credential = {
      kind: 'pat' as const,
      hash: hashAuthToken(raw),
      expiresAt: resolved?.expiresAt ?? null,
    }
    if (!resolved) return { actor: null, authority: null, credential }
    const identity = await identityAccess.directAuthority.fromPat(
      admittedPatCredential({
        userId: resolved.user.id,
        scopes: resolved.scopes as ReadonlyArray<Permission>,
        purpose: resolved.purpose,
        patId: resolved.patId,
      }),
    )
    return {
      actor: (identity?.actor as Actor | undefined) ?? null,
      authority: identity?.authority ?? null,
      credential,
    }
  }
  // Legacy daemon token —— 与 resolveActor 同判据，凭据无需查库。
  if (!safeEqual(Buffer.from(raw, 'utf8'), daemonTokenBuf)) {
    return { actor: null, authority: null, credential: { kind: 'daemon' } }
  }
  if (
    (await auth.getLoginPolicy()).bootstrapCompletedAt !== null &&
    !auth.allowLegacyDaemonTestAccess
  ) {
    return { actor: null, authority: null, credential: { kind: 'daemon' } }
  }
  const identity = await identityAccess.directAuthority.fromDaemon(ADMITTED_DAEMON_CREDENTIAL)
  return {
    actor: (identity?.actor as Actor | undefined) ?? null,
    authority: identity?.authority ?? null,
    credential: { kind: 'daemon' },
  }
}

export async function resolveIdentity(
  authOrDb: AuthRuntime | LegacySqliteAuthRuntimeInput,
  raw: string,
  daemonTokenBuf: Buffer,
  identityAccess: DirectAuthorityAdmissionRuntime,
  now: number = Date.now(),
): Promise<DirectAuthorityIdentity | null> {
  const auth = authRuntimeOf(authOrDb)
  if (raw.startsWith(SESSION_TOKEN_PREFIX)) {
    const resolved = await auth.lookupActiveSession(raw, now)
    if (!resolved) return null
    return identityAccess.directAuthority.fromSession(admittedSessionCredential(resolved.user.id))
  }
  if (raw.startsWith(PAT_TOKEN_PREFIX)) {
    const resolved = await auth.lookupActivePat(raw, now)
    if (!resolved) return null
    return identityAccess.directAuthority.fromPat(
      admittedPatCredential({
        userId: resolved.user.id,
        scopes: resolved.scopes as ReadonlyArray<Permission>,
        purpose: resolved.purpose,
        patId: resolved.patId,
      }),
    )
  }
  // Legacy daemon token: any opaque string the daemon was launched with.
  // The 64-hex shape is what `generateToken()` produces but we accept the
  // value verbatim — tests and admins may rotate to other shapes.
  if (!safeEqual(Buffer.from(raw, 'utf8'), daemonTokenBuf)) return null
  if (
    (await auth.getLoginPolicy()).bootstrapCompletedAt !== null &&
    !auth.allowLegacyDaemonTestAccess
  )
    return null

  return identityAccess.directAuthority.fromDaemon(ADMITTED_DAEMON_CREDENTIAL)
}

/**
 * In-process daemon identity for daemon-owned background workers.
 *
 * `resolveIdentity`'s legacy daemon-token branch answers a different question:
 * may an **external HTTP caller** that presents the launch token act as the
 * daemon? That branch closes by design once the first administrator completes
 * bootstrap. A worker composed inside the daemon presents no token at all, so
 * routing it through the token branch made it fail closed on every real
 * install — RFC-238's MCP runtime-test `loadMcp` threw
 * `mcp-runtime-test-authority-not-admitted` and the turn hung in flight
 * forever (only in-memory test databases, which keep
 * `allowLegacyDaemonTestAccess`, stayed green).
 */
export function admitDaemonIdentity(
  identityAccess: DirectAuthorityAdmissionRuntime,
): Promise<DirectAuthorityIdentity | null> {
  return identityAccess.directAuthority.fromDaemon(ADMITTED_DAEMON_CREDENTIAL)
}

/**
 * Admit the owner of durable work the daemon is resuming on their behalf.
 *
 * The evidence is the durable row itself: the owner committed this work through
 * an authenticated request, the daemon died before finishing it, and boot
 * recovery has to finish it for them.  There is no live token to re-present, so
 * `resolveIdentity` cannot help — but the work still has to run **as the owner**,
 * because everything it touches is filtered by that account's visibility.
 *
 * `fromSession` is deliberate and matches `localOperator.forLegacyHttpUser`,
 * which made the same choice for the same reason ("preserves session semantics
 * so self-role and audit guards continue to see the acting account").  Unlike
 * that seam this one mints a **registered direct authority**, which is what the
 * RFC-345 Resource Catalog requires: `authorityForLegacyProjection` only
 * resolves a projection the registry itself minted, so hand-built actors fail
 * with `foreign-legacy-actor-projection`.
 *
 * A disabled or deleted account resolves to null; the caller must skip that row
 * rather than fall back to some other identity.
 */
export function admitDurableWorkOwner(
  identityAccess: DirectAuthorityAdmissionRuntime,
  ownerUserId: string,
): Promise<DirectAuthorityIdentity | null> {
  return identityAccess.directAuthority.fromSession(admittedSessionCredential(ownerUserId))
}

export async function resolveActor(
  authOrDb: AuthRuntime | LegacySqliteAuthRuntimeInput,
  raw: string,
  daemonTokenBuf: Buffer,
  identityAccess: DirectAuthorityAdmissionRuntime,
  now: number = Date.now(),
): Promise<Actor | null> {
  const identity = await resolveIdentity(authOrDb, raw, daemonTokenBuf, identityAccess, now)
  return (identity?.actor as Actor | undefined) ?? null
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
export async function reresolveIdentity(
  authOrDb: AuthRuntime | LegacySqliteAuthRuntimeInput,
  credential: WsCredentialFingerprint,
  identityAccess: DirectAuthorityAdmissionRuntime,
  now: number = Date.now(),
): Promise<DirectAuthorityIdentity | null> {
  const auth = authRuntimeOf(authOrDb)
  if (credential.kind === 'session') {
    const resolved = await auth.lookupActiveSessionByHash(credential.hash, now, { touch: false })
    if (!resolved) return null
    return identityAccess.directAuthority.fromSession(admittedSessionCredential(resolved.user.id))
  }
  if (credential.kind === 'pat') {
    const resolved = await auth.lookupActivePatByHash(credential.hash, now, { touch: false })
    if (!resolved) return null
    return identityAccess.directAuthority.fromPat(
      admittedPatCredential({
        userId: resolved.user.id,
        scopes: resolved.scopes as ReadonlyArray<Permission>,
        purpose: resolved.purpose,
        patId: resolved.patId,
      }),
    )
  }
  // daemon: RFC-221 makes this a one-way bootstrap credential. Revalidation
  // closes every existing daemon socket immediately after the first admin
  // transaction commits.
  if (
    (await auth.getLoginPolicy()).bootstrapCompletedAt !== null &&
    !auth.allowLegacyDaemonTestAccess
  )
    return null
  return identityAccess.directAuthority.fromDaemon(ADMITTED_DAEMON_CREDENTIAL)
}

export async function reresolveActor(
  authOrDb: AuthRuntime | LegacySqliteAuthRuntimeInput,
  credential: WsCredentialFingerprint,
  identityAccess: DirectAuthorityAdmissionRuntime,
  now: number = Date.now(),
): Promise<Actor | null> {
  const identity = await reresolveIdentity(authOrDb, credential, identityAccess, now)
  return (identity?.actor as Actor | undefined) ?? null
}

/**
 * RFC-285 B4（D8）—— REST 面唯一 token 入口：只认 `Authorization: Bearer`。
 * 旧 extractRawToken 还接受 `?token=` query（session/PAT 随 URL 进访问日志、
 * 浏览器历史、Referer 的泄露面）；query 形态收窄到唯一必需处——WS 升级
 * （下面的 extractUpgradeToken，浏览器 WebSocket API 发不了自定义头）。
 */
export function extractBearerToken(c: Context): string | null {
  const header = c.req.header('Authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S+)\s*$/i)
  if (!match || !match[1]) return null
  return match[1]
}

/**
 * RFC-285 B4 —— WS 升级面的 token 入口（query 是浏览器 WebSocket 唯一可用的
 * 凭据通道）。**仅 ws/server.ts 消费**；REST 面禁止 import——rfc285-b4 测试
 * 以源码文本锁钉死。
 */
export function extractUpgradeToken(url: URL): string | null {
  const token = url.searchParams.get('token')
  return token === null || token === '' ? null : token
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authRuntimeOf(
  input: MultiAuthDeps | AuthRuntime | LegacySqliteAuthRuntimeInput,
): AuthRuntime {
  return legacySqliteAuthRuntimeOf(input)
}
