import type { ActorSource } from '../../src/auth/actor'
import { createAuthRuntimeFor } from '../../src/auth/composition'
import type { DbClient } from '../../src/db/client'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import type { ProviderApplicationBinding } from './eachProvider'
import type { IdentityAccessRuntime } from '../../src/modules/identity-access/composition'
import {
  composePostgresqlRealtimeRuntime,
  composeSqliteRealtimeRuntime,
  type RealtimeCompositionPolicy,
} from '../../src/modules/runtime-management/composition'
import type {
  RealtimeChannelAccess,
  RealtimeCredential,
  RealtimeCredentialAccess,
  RealtimeRuntime,
} from '../../src/modules/runtime-management/public/participants'
import {
  composeResourceCatalogFor,
  composeSqliteResourceCatalog,
} from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import { batchOwnerUserId } from '../../src/services/repoBatchImport'
import { redactEventPayload } from '../../src/services/tokenRedaction'
import { memoryCatalogOf } from './memoryCatalog'

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
    auth: createAuthRuntimeFor({ db: input.db, onCredentialRevoked: () => {} }),
    directAuthority: input.identityAccess.directAuthority,
    policy: {
      resourceVisibility: resourceCatalog.authorization,
      memoryVisibility: {
        async canViewMemory(authority, actor, scope) {
          return await memoryCatalogOf(input.db).queries.canView({ authority, actor }, scope)
        },
      },
      repoImportOwnerUserId: input.repoImportOwnerUserId ?? batchOwnerUserId,
      redactTaskEventPayload: input.redactTaskEventPayload ?? redactEventPayload,
    },
  })
}

/**
 * RFC-359 AC-6 —— 按 provider 分派的实时运行时。WS 那一簇（11 个文件）的第一层拦路石。
 *
 * 底下本来就全是中立的：`DrizzleRealtimeStore` 的构造器收 `ProviderNeutralDatabase`，
 * `composeSqliteRealtimeRuntime` 与 `composePostgresqlRealtimeRuntime` 的函数体**逐字相同**
 * （差别只在导出包装声明的 `db` 类型），资源目录那边 `composeResourceCatalogFor` 本身就是
 * 导出的中立函数、根本不用分派。
 *
 * 所以这里只在**测试侧**按 harness 的 `applicationBinding` 判别式分派——那个联合本来就带着
 * 类型已对上的 `db`，与 `rfc359-w12-realtime-composition.test.ts` 已有的写法一致。
 *
 * **刻意不把那对孪生合成一个中立导出**：它是 RFC-349「provider-selected composition」有意留的
 * 形状，`rfc359-w12-realtime-composition` 正是钉它的；合不合并是那条线自己的决定，不该作为
 * 一次测试迁移的副作用。
 */
export function composeTestProviderRealtimeRuntime(input: {
  readonly binding: ProviderApplicationBinding
  readonly neutralDb: ProviderNeutralDatabase
  readonly identityAccess: IdentityAccessRuntime
  readonly repoImportOwnerUserId?: (batchId: string) => string | null
  readonly redactTaskEventPayload?: (payload: unknown, source: ActorSource) => unknown
}): RealtimeRuntime {
  const { binding, neutralDb } = input
  const policy: RealtimeCompositionPolicy = {
    resourceVisibility: composeResourceCatalogFor({ db: neutralDb }).authorization,
    memoryVisibility: {
      async canViewMemory(authority, actor, scope) {
        return await memoryCatalogOf(neutralDb).queries.canView({ authority, actor }, scope)
      },
    },
    repoImportOwnerUserId: input.repoImportOwnerUserId ?? batchOwnerUserId,
    redactTaskEventPayload: input.redactTaskEventPayload ?? redactEventPayload,
  }
  const directAuthority = input.identityAccess.directAuthority
  if (binding.provider === 'sqlite') {
    return composeSqliteRealtimeRuntime({
      db: binding.db,
      auth: createAuthRuntimeFor({ db: binding.db, onCredentialRevoked: () => {} }),
      directAuthority,
      policy,
    })
  }
  return composePostgresqlRealtimeRuntime({
    db: binding.db,
    auth: createAuthRuntimeFor({ db: binding.db, onCredentialRevoked: () => {} }),
    directAuthority,
    policy,
  })
}
