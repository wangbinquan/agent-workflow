// RFC-370: compatibility facade for standalone credential callers. New HTTP
// roots inject Identity Access's authentication query through composition.
import type { Context, MiddlewareHandler } from 'hono'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import {
  compatibleAuthRuntimeOf,
  type CompatibleAuthRuntimeBinding,
} from '@/auth/infrastructure/compatibleAuthRuntime'
import {
  composeLocalHttpAuthentication,
  composeHttpAuthenticationMiddleware,
  parseLocalBearerHeader,
  type DirectAuthorityAdmissionRuntime,
} from '@/modules/identity-access/composition/authentication'

export {
  admitDaemonIdentity,
  admitDurableWorkOwner,
  actorOfDirectAuthority,
  describeCredential,
  resolveActor,
  resolveActorWithWsCredential,
  resolveIdentity,
  reresolveActor,
  reresolveIdentity,
  type DirectAuthorityAdmissionRuntime,
  type ResolvedUpgradeIdentity,
  type WsCredentialFingerprint,
  type WsCredentialWithExpiry,
} from '@/modules/identity-access/composition/authentication'

interface MultiAuthBaseDeps {
  daemonToken: string
  identityAccess: DirectAuthorityAdmissionRuntime
  now?: () => number
}
export type MultiAuthDeps = MultiAuthBaseDeps &
  ({ readonly auth: AuthRuntime; readonly db?: never } | CompatibleAuthRuntimeBinding)

export function multiAuth(deps: MultiAuthDeps): MiddlewareHandler {
  return composeHttpAuthenticationMiddleware(
    composeLocalHttpAuthentication({
      auth: compatibleAuthRuntimeOf(deps),
      daemonToken: deps.daemonToken,
      identityAccess: deps.identityAccess,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  )
}

/** REST compatibility helper: standalone HTTP continues to read only Bearer. */
export function extractBearerToken(c: Context): string | null {
  return parseLocalBearerHeader(c.req.header('Authorization'))
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
