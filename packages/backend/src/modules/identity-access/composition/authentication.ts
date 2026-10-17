// RFC-370: bootstrap selects credential adapters; inbound middleware only
// consumes the public authentication query. Compatibility exports keep legacy
// local credential consumers on the same implementation during their cutover.
export { createCrewStationSourceTokenVerifier as composeCrewStationSourceTokenVerifier } from '../infrastructure/crewstation/crewStationSourceToken'
export { createCrewStationRecoveryRequester as composeCrewStationRecoveryRequester } from '../infrastructure/crewstation/crewStationRecoveryRequester'
export {
  createLocalHttpAuthentication as composeLocalHttpAuthentication,
  parseLocalBearerHeader,
} from '../infrastructure/local/httpAuthentication'
export { createHttpAuthenticationMiddleware as composeHttpAuthenticationMiddleware } from '../inbound/http/authentication'
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
} from '../infrastructure/local/localCredentialAdmission'
export {
  createLocalWebSocketAuthentication as composeLocalWebSocketAuthentication,
  extractUpgradeToken,
} from '../infrastructure/local/webSocketAuthentication'

import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  HttpAuthenticationParticipant,
  WebSocketAuthenticationParticipant,
} from '../public/participants'
import { createLocalHttpAuthentication } from '../infrastructure/local/httpAuthentication'
import type { DirectAuthorityAdmissionRuntime } from '../infrastructure/local/localCredentialAdmission'
import { createLocalWebSocketAuthentication } from '../infrastructure/local/webSocketAuthentication'
import { createCrewStationCredentialAdapters } from '../infrastructure/crewstation/crewStationAuthentication'
import {
  createCrewStationIdentityTokenVerifier,
  crewStationServiceAudience,
} from '../infrastructure/crewstation/crewStationIdentityToken'
import { createExternalIdentityProvisioning } from '../infrastructure/externalIdentityProvisioning'
import type { JWTVerifyGetKey } from 'jose'

/** What a deployment's credential mechanism may use; the daemon core supplies it. */
export interface CredentialAdapterDependencies {
  readonly db: ProviderNeutralDatabase
  readonly auth: AuthRuntime
  readonly daemonToken: string
  readonly identityAccess: DirectAuthorityAdmissionRuntime
}

/** One credential mechanism serves HTTP and WebSocket admission alike. */
export interface CredentialAdapters {
  readonly http: HttpAuthenticationParticipant
  readonly webSocket: WebSocketAuthenticationParticipant
}

/** RFC-370 v2 §3.6 — bootstrap selects the credential mechanism once. */
export type CredentialAdapterSelection = (deps: CredentialAdapterDependencies) => CredentialAdapters

/** Standalone: sessions, PATs and the first-administrator daemon token. */
export const composeLocalCredentialAdapters: CredentialAdapterSelection = (deps) =>
  Object.freeze({
    http: createLocalHttpAuthentication({
      auth: deps.auth,
      daemonToken: deps.daemonToken,
      identityAccess: deps.identityAccess,
    }),
    webSocket: createLocalWebSocketAuthentication({
      auth: deps.auth,
      daemonToken: deps.daemonToken,
      identityAccess: deps.identityAccess,
    }),
  })

/** CrewStation-hosted: the gateway's signed identity token. */
export function composeCrewStationCredentialAdapters(input: {
  readonly jwksUrl: string
  readonly project: string
  readonly service: string
  readonly administratorSubjects: readonly string[]
  /** Test seam; production fetches the platform JWKS. */
  readonly keys?: JWTVerifyGetKey
}): CredentialAdapterSelection {
  const verifier = createCrewStationIdentityTokenVerifier({
    jwksUrl: input.jwksUrl,
    audience: crewStationServiceAudience(input.project, input.service),
    ...(input.keys === undefined ? {} : { keys: input.keys }),
  })
  const administratorSubjects = new Set(input.administratorSubjects)
  return (deps) =>
    createCrewStationCredentialAdapters({
      auth: deps.auth,
      verifier,
      provisioning: createExternalIdentityProvisioning({ db: deps.db }),
      identityAccess: deps.identityAccess,
      administratorSubjects,
    })
}
