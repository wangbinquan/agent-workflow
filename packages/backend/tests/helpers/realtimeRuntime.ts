import type { ActorSource } from '../../src/auth/actor'
import { createSqliteAuthRuntime } from '../../src/auth/composition'
import type { DbClient } from '../../src/db/client'
import type { IdentityAccessRuntime } from '../../src/modules/identity-access/composition'
import { composeSqliteRealtimeRuntime } from '../../src/modules/runtime-management/composition'
import type {
  RealtimeChannelAccess,
  RealtimeCredential,
  RealtimeCredentialAccess,
  RealtimeRuntime,
} from '../../src/modules/runtime-management/public/participants'
import { composeSqliteResourceCatalog } from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import { canViewMemory } from '../../src/services/memory'
import { batchOwnerUserId } from '../../src/services/repoBatchImport'
import { redactEventPayload } from '../../src/services/tokenRedaction'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './resourceScopeAuthority'

export const STUB_REALTIME_CHANNELS: RealtimeChannelAccess = Object.freeze({
  canViewTask: async () => false,
  canViewResource: async () => false,
  canViewMemory: async () => false,
  canViewStoredMemory: async () => false,
  replayTaskEvents: async () => [],
  repoImportOwnerUserId: () => null,
})

const STUB_DAEMON_CREDENTIAL: RealtimeCredential = Object.freeze({ kind: 'daemon' })

export const STUB_REALTIME_CREDENTIALS: RealtimeCredentialAccess = Object.freeze({
  allowLegacyDaemonTestAccess: true,
  resolveUpgrade: async () => ({
    actor: null,
    authority: null,
    credential: STUB_DAEMON_CREDENTIAL,
  }),
  reresolve: async () => null,
})

export const STUB_REALTIME_RUNTIME: RealtimeRuntime = Object.freeze({
  channels: STUB_REALTIME_CHANNELS,
  credentials: STUB_REALTIME_CREDENTIALS,
})

export function composeTestSqliteRealtimeRuntime(input: {
  readonly db: DbClient
  readonly identityAccess: IdentityAccessRuntime
  readonly repoImportOwnerUserId?: (batchId: string) => string | null
  readonly redactTaskEventPayload?: (payload: unknown, source: ActorSource) => unknown
}): RealtimeRuntime {
  const resourceCatalog = composeSqliteResourceCatalog({ db: input.db })
  return composeSqliteRealtimeRuntime({
    db: input.db,
    auth: createSqliteAuthRuntime({ db: input.db, revalidate: () => {} }),
    directAuthority: input.identityAccess.directAuthority,
    policy: {
      resourceVisibility: resourceCatalog.authorization,
      memoryVisibility: {
        async canViewMemory(authority, actor, scope) {
          return await canViewMemory(
            input.db,
            { authority, actor, authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION },
            scope,
          )
        },
      },
      repoImportOwnerUserId: input.repoImportOwnerUserId ?? batchOwnerUserId,
      redactTaskEventPayload: input.redactTaskEventPayload ?? redactEventPayload,
    },
  })
}
