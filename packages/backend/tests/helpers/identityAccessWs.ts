import type { Actor } from '../../src/auth/actor'
import type { IdentityAccessRuntime } from '../../src/modules/identity-access/composition'
import type {
  DirectAuthenticatedAuthority,
  DirectRequestAuthority,
} from '../../src/modules/identity-access/public/participants'
import type { IdentityAccessWsBinding } from '../../src/ws/registry'
import { admitTestDirectAuthority } from './identityAccessAuthority'

export const TEST_DIRECT_AUTHORITY = Object.freeze({}) as DirectRequestAuthority

export function stubIdentityAccessWsBinding(revision = 0): IdentityAccessWsBinding {
  return Object.freeze({
    directAuthority: {
      fromSession: async () => null,
      fromPat: async () => null,
      fromDaemon: async () => null,
    },
    authorityFence: {
      readAuthorityFence: () => ({ status: 'active' as const, accessRevision: revision }),
    },
    presenceConnections: {
      open: () => null,
    },
    presenceQuery: {
      snapshot: () => [],
    },
    requestAuthorityRevalidation: () => {},
  })
}

export function bindIdentityAccessWs(
  runtime: IdentityAccessRuntime,
  requestAuthorityRevalidation: IdentityAccessWsBinding['requestAuthorityRevalidation'] = () => {},
): IdentityAccessWsBinding {
  return Object.freeze({
    directAuthority: runtime.directAuthority,
    authorityFence: runtime.authorityFence,
    presenceConnections: runtime.presenceConnections,
    presenceQuery: runtime.presenceQuery,
    requestAuthorityRevalidation,
  })
}

export async function admitWsIdentity(
  runtime: IdentityAccessRuntime,
  userId: string,
  source: 'session' | 'pat' | 'daemon' = 'session',
): Promise<{
  readonly actor: Actor
  readonly authority: DirectRequestAuthority
  readonly identityAccess: IdentityAccessWsBinding
}> {
  const identity = await admitTestDirectAuthority(runtime.directAuthority, { userId, source })
  if (identity === null) throw new Error(`test identity '${userId}' is not active`)
  return Object.freeze({
    actor: identity.actor as DirectAuthenticatedAuthority as Actor,
    authority: identity.authority,
    identityAccess: bindIdentityAccessWs(runtime),
  })
}
