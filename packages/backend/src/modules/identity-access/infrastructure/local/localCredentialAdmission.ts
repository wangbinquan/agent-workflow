// RFC-370: standalone session/PAT/daemon credential adapter. Identity Access
// retains authority admission; transports no longer select the local mechanism.
import { timingSafeEqual } from 'node:crypto'
import { PAT_TOKEN_PREFIX, SESSION_TOKEN_PREFIX, type Permission } from '@agent-workflow/shared'
import { hashAuthToken, type AuthRuntime } from '@/auth/application/authRuntime'
import {
  compatibleAuthRuntimeOf,
  type CompatibleAuthRuntimeInput,
} from '@/auth/infrastructure/compatibleAuthRuntime'
import type { Actor } from '@/auth/actor'
import type {
  AdmittedDaemonCredential,
  AdmittedPatCredential,
  AdmittedSessionCredential,
  DirectAuthorityAdmission,
  DirectAuthorityIdentity,
  DirectRequestAuthority,
} from '../../public/participants'

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
  authOrDb: AuthRuntime | CompatibleAuthRuntimeInput,
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
      actor: identity?.actor ?? null,
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
      actor: identity?.actor ?? null,
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
    actor: identity?.actor ?? null,
    authority: identity?.authority ?? null,
    credential: { kind: 'daemon' },
  }
}

export async function resolveIdentity(
  authOrDb: AuthRuntime | CompatibleAuthRuntimeInput,
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

/** The registered Identity Access projection already satisfies Actor's shape. */
export function actorOfDirectAuthority(identity: DirectAuthorityIdentity): Actor {
  return identity.actor
}

export async function resolveActor(
  authOrDb: AuthRuntime | CompatibleAuthRuntimeInput,
  raw: string,
  daemonTokenBuf: Buffer,
  identityAccess: DirectAuthorityAdmissionRuntime,
  now: number = Date.now(),
): Promise<Actor | null> {
  const identity = await resolveIdentity(authOrDb, raw, daemonTokenBuf, identityAccess, now)
  return identity === null ? null : actorOfDirectAuthority(identity)
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
  authOrDb: AuthRuntime | CompatibleAuthRuntimeInput,
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
  authOrDb: AuthRuntime | CompatibleAuthRuntimeInput,
  credential: WsCredentialFingerprint,
  identityAccess: DirectAuthorityAdmissionRuntime,
  now: number = Date.now(),
): Promise<Actor | null> {
  const identity = await reresolveIdentity(authOrDb, credential, identityAccess, now)
  return identity?.actor ?? null
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authRuntimeOf(input: AuthRuntime | CompatibleAuthRuntimeInput): AuthRuntime {
  return compatibleAuthRuntimeOf(input)
}
