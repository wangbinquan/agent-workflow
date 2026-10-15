// RFC-370 M0 — credential admission of a CrewStation-hosted instance.
//
// The platform gateway authenticates every user-domain request and forwards a
// signed identity token; this adapter verifies it, maps the platform subject
// to its aw account (creating it on first sight) and admits that account
// exactly like a standalone login session. Local passwords, OIDC, PATs and the
// daemon bootstrap token do not exist behind the gateway.
import { ForbiddenError, UnauthorizedError } from '@/util/errors'
import { createInFlightCoalescer } from '@/util/inFlight'
import type {
  AdmittedSessionCredential,
  DirectAuthorityIdentity,
  HttpAuthenticationParticipant,
  WebSocketAuthenticationParticipant,
} from '../../public/participants'
import type { ExternalIdentityProvisioning } from '../externalIdentityProvisioning'
import type { DirectAuthorityAdmissionRuntime } from '../local/localCredentialAdmission'
import {
  CREWSTATION_IDENTITY_HEADER,
  CREWSTATION_ISSUER,
  type CrewStationIdentityTokenVerifier,
} from './crewStationIdentityToken'

interface CrewStationWebSocketCredential {
  readonly kind: 'crewstation'
  readonly userId: string
}

export interface CrewStationCredentialAdapters {
  readonly http: HttpAuthenticationParticipant
  readonly webSocket: WebSocketAuthenticationParticipant
}

type Admission =
  | {
      readonly kind: 'admitted'
      readonly userId: string
      readonly identity: DirectAuthorityIdentity
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'disabled' }

function sessionCredential(userId: string): AdmittedSessionCredential {
  return Object.freeze({ userId }) as AdmittedSessionCredential
}

export function createCrewStationCredentialAdapters(input: {
  readonly verifier: CrewStationIdentityTokenVerifier
  readonly provisioning: ExternalIdentityProvisioning
  readonly identityAccess: DirectAuthorityAdmissionRuntime
  /** Platform subjects (`user:<uuid>`) whose first access creates an administrator. */
  readonly administratorSubjects: ReadonlySet<string>
  readonly now?: () => number
}): CrewStationCredentialAdapters {
  const now = input.now ?? Date.now
  const admitUser = (userId: string) =>
    input.identityAccess.directAuthority.fromSession(sessionCredential(userId))
  // A browser releases bursts of requests carrying the same per-request token.
  const admitInFlight = createInFlightCoalescer<string, Admission>()
  const admit = (token: string | null): Promise<Admission> => {
    if (token === null || token.length === 0) return Promise.resolve({ kind: 'missing' })
    return admitInFlight(token, async () => {
      const claims = await input.verifier.verify(token)
      if (claims === null) return { kind: 'invalid' }
      const userId = await input.provisioning.resolve({
        issuer: CREWSTATION_ISSUER,
        subject: claims.subject,
        displayName: claims.name,
        email: claims.email,
        administrator: input.administratorSubjects.has(claims.subject),
        now: now(),
      })
      const identity = await admitUser(userId)
      return identity === null ? { kind: 'disabled' } : { kind: 'admitted', userId, identity }
    })
  }

  const http = Object.freeze({
    async authenticate(request) {
      const admission = await admit(request.header(CREWSTATION_IDENTITY_HEADER))
      if (admission.kind === 'admitted') {
        return { kind: 'authenticated', identity: admission.identity } as const
      }
      if (admission.kind === 'disabled') {
        throw new ForbiddenError('account-disabled', 'this account is disabled in agent-workflow')
      }
      throw new UnauthorizedError()
    },
  } satisfies HttpAuthenticationParticipant)

  const webSocket = Object.freeze({
    async resolveUpgrade(request) {
      const admission = await admit(request.header(CREWSTATION_IDENTITY_HEADER))
      if (admission.kind === 'admitted') {
        const credential: CrewStationWebSocketCredential = {
          kind: 'crewstation',
          userId: admission.userId,
        }
        return {
          actor: admission.identity.actor,
          authority: admission.identity.authority,
          credential,
        }
      }
      return {
        actor: null,
        authority: null,
        credential: Object.freeze({ kind: 'crewstation-rejected' }),
        rejection:
          admission.kind === 'disabled'
            ? {
                code: 'account-disabled',
                message: 'this account is disabled in agent-workflow',
                status: 403 as const,
              }
            : {
                code: 'unauthorized',
                message: 'the CrewStation identity token is missing or invalid',
                status: 401 as const,
              },
      }
    },
    // The upgrade token only authenticates the connection; afterwards the
    // account's current state decides, exactly like a session-backed socket.
    async reresolve(credential) {
      const hosted = credential as Partial<CrewStationWebSocketCredential>
      if (hosted.kind !== 'crewstation' || hosted.userId === undefined) return null
      return await admitUser(hosted.userId)
    },
    revalidationKey(credential) {
      const hosted = credential as Partial<CrewStationWebSocketCredential>
      return `crewstation\u0000${hosted.userId ?? ''}`
    },
    expiresAt: () => null,
  } satisfies WebSocketAuthenticationParticipant)

  return Object.freeze({ http, webSocket })
}
