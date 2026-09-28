import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { WebSocketAuthenticationParticipant } from '../../public/participants'
import {
  resolveActorWithWsCredential,
  reresolveIdentity,
  type DirectAuthorityAdmissionRuntime,
  type WsCredentialWithExpiry,
} from './localCredentialAdmission'

/** The query token is a standalone WS convention, never an HTTP credential. */
export function extractUpgradeToken(url: URL): string | null {
  const token = url.searchParams.get('token')
  return token === null || token === '' ? null : token
}

export function createLocalWebSocketAuthentication(input: {
  readonly auth: AuthRuntime
  readonly daemonToken: string
  readonly identityAccess: DirectAuthorityAdmissionRuntime
}): WebSocketAuthenticationParticipant {
  const daemonToken = Buffer.from(input.daemonToken, 'utf8')
  return Object.freeze({
    async resolveUpgrade(request, now) {
      const raw = extractUpgradeToken(new URL(request.url))
      if (raw === null) return { actor: null, authority: null, credential: { kind: 'daemon' } }
      const resolved = await resolveActorWithWsCredential(
        input.auth,
        raw,
        daemonToken,
        input.identityAccess,
        now,
      )
      if (resolved.actor?.source === 'daemon' && !input.auth.allowLegacyDaemonTestAccess) {
        return {
          ...resolved,
          rejection: {
            code: 'bootstrap-admin-required',
            message: 'complete first-administrator setup before opening application channels',
            status: 403 as const,
          },
        }
      }
      return resolved
    },
    // These references are issued by this selected local adapter. The shared
    // transport holds them opaquely and returns them to the same adapter.
    async reresolve(credential, now) {
      return await reresolveIdentity(
        input.auth,
        credential as WsCredentialWithExpiry,
        input.identityAccess,
        now,
      )
    },
    revalidationKey(credential) {
      const local = credential as WsCredentialWithExpiry
      return local.kind === 'daemon' ? 'daemon' : `${local.kind}\u0000${local.hash}`
    },
    expiresAt(credential) {
      const local = credential as WsCredentialWithExpiry
      return local.kind === 'daemon' ? null : local.expiresAt
    },
  } satisfies WebSocketAuthenticationParticipant)
}
