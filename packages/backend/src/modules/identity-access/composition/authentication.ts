// RFC-370: bootstrap selects credential adapters; inbound middleware only
// consumes the public authentication query. RFC-472: the legacy `auth/session`
// facade is retired — the admission exports below serve bootstrap (daemon
// identity, durable-work owner re-admission) and the credential test fixtures.
export {
  createCrewStationSourceTokenVerifier as composeCrewStationSourceTokenVerifier,
  crewStationPlatformSourceAudiences,
} from '../infrastructure/crewstation/crewStationSourceToken'
export { createCrewStationRecoveryRequester as composeCrewStationRecoveryRequester } from '../infrastructure/crewstation/crewStationRecoveryRequester'
export { createLocalHttpAuthentication as composeLocalHttpAuthentication } from '../infrastructure/local/httpAuthentication'
export { createHttpAuthenticationMiddleware as composeHttpAuthenticationMiddleware } from '../inbound/http/authentication'
export {
  admitDaemonIdentity,
  admitDurableWorkOwner,
  actorOfDirectAuthority,
  describeCredential,
  resolveActor,
  resolveActorWithWsCredential,
  type DirectAuthorityAdmissionRuntime,
  type WsCredentialWithExpiry,
} from '../infrastructure/local/localCredentialAdmission'
export { createLocalWebSocketAuthentication as composeLocalWebSocketAuthentication } from '../infrastructure/local/webSocketAuthentication'

import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  HttpAuthenticationParticipant,
  WebSocketAuthenticationParticipant,
} from '../public/participants'
import { createLocalHttpAuthentication } from '../infrastructure/local/httpAuthentication'
import {
  actorOfDirectAuthority,
  admitDurableWorkOwner,
  type DirectAuthorityAdmissionRuntime,
} from '../infrastructure/local/localCredentialAdmission'
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
  readonly db: PersistenceDb
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

/** RFC-472 — re-admission of a durable-work owner, in the shape a consumer-owned port receives (intent's
 * `IntentOwnerAdmissionPort`, satisfied structurally and wired by bootstrap). The owner's registered actor —
 * the projection the authority registry itself minted, which `authorityForLegacyProjection` resolves back —
 * or null for a disabled or deleted account, whose work the caller skips. */
export function composeDurableWorkOwnerAdmission(identityAccess: DirectAuthorityAdmissionRuntime) {
  return Object.freeze({
    async admitOwner(ownerUserId: string) {
      const admitted = await admitDurableWorkOwner(identityAccess, ownerUserId)
      return admitted === null ? null : actorOfDirectAuthority(admitted)
    },
  })
}
