// RFC-349 — realtime credential resolution belongs to runtime-management.

import type { AuthRuntime } from '@/auth/application/authRuntime'
import { reresolveIdentity, resolveActorWithWsCredential } from '@/auth/session'
import type { DirectAuthorityAdmission } from '@/modules/identity-access/public/participants'
import type { RealtimeCredential, RealtimeCredentialAccess } from '../public/participants'

export function createRealtimeCredentialAccess(input: {
  readonly auth: AuthRuntime
  readonly directAuthority: DirectAuthorityAdmission
}): RealtimeCredentialAccess {
  const access: RealtimeCredentialAccess = {
    allowLegacyDaemonTestAccess: input.auth.allowLegacyDaemonTestAccess,
    async resolveUpgrade(rawToken: string, daemonToken: Uint8Array, now?: number) {
      return await resolveActorWithWsCredential(
        input.auth,
        rawToken,
        Buffer.from(daemonToken),
        { directAuthority: input.directAuthority },
        now,
      )
    },
    async reresolve(credential: RealtimeCredential, now?: number) {
      return await reresolveIdentity(
        input.auth,
        credential,
        { directAuthority: input.directAuthority },
        now,
      )
    },
  }
  return Object.freeze(access)
}
