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
  extractUpgradeToken,
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
