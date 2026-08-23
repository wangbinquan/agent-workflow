import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { PRESENCE_CHANNEL, presenceBroadcaster } from '@/ws/broadcaster'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
import { TrackUserPresence } from './application/commands/trackUserPresence'
import { GetUserPresence } from './application/queries/getUserPresence'
import {
  InMemoryUserPresenceStore,
  PerformanceMonotonicClock,
  TimeoutPresenceTimer,
} from './infrastructure/inMemoryPresence'
import { CreateManagedUser } from './application/commands/createManagedUser'
import { UpdateUserAccess } from './application/commands/updateUserAccess'
import {
  DelegatedOperationContextFactory,
  DirectOperationContextFactory,
} from './application/operationContext'
import { GetUserAccess } from './application/queries/getUserAccess'
import { ResolveAuthority } from './application/queries/resolveAuthority'
import { ResolveDelegatedAuthority } from './application/queries/resolveDelegatedAuthority'
import {
  SQLiteUserAccessRepository,
  SQLiteUserAccessTransactionRunner,
} from './infrastructure/sqliteUserAccessRepository'
import {
  IdentityAccessObservability,
  type IdentityAccessDiagnostics,
} from './infrastructure/identityAccessObservability'
import type {
  DelegatedAuthorityResolver,
  DelegatedOperationContextFactory as DelegatedOperationContextFactoryPort,
} from './public/participants'
import type { UserAccessFenceReader } from './application/ports/userAccessRepository'

const SYSTEM_USER_ID = '__system__'

export interface IdentityAccessModule {
  readonly contexts: DirectOperationContextFactory
  readonly delegatedAuthority: DelegatedAuthorityResolver
  readonly delegatedContexts: DelegatedOperationContextFactoryPort
  readonly createManagedUser: CreateManagedUser
  readonly updateUserAccess: UpdateUserAccess
  readonly getUserAccess: GetUserAccess
  readonly resolveAuthority: ResolveAuthority
  /**
   * RFC-317 T41 —— 出站授权围栏的**同步**读。
   *
   * 唯一消费者是 WS 广播器（`ws/registry.ts`）：它此前手写
   * `SELECT status, access_revision FROM users WHERE id = ?`，把本 context 的两列
   * 硬编码在传输层里。走这条端口之后，列名只有 identity-access 知道。
   */
  readonly authorityFence: UserAccessFenceReader
  readonly diagnostics: IdentityAccessDiagnostics
  /** RFC-312 —— presence 写侧（由 WS 连接开/关驱动）。 */
  readonly trackUserPresence: TrackUserPresence
  /** RFC-312 —— presence 读侧（快照 / 单点查询）。 */
  readonly getUserPresence: GetUserPresence
}

const modules = new WeakMap<object, IdentityAccessModule>()

/** Bootstrap/composition is the only place concrete SQLite adapters and
 * process event delivery are assembled. Callers receive public use cases only. */
export function composeIdentityAccess(db: DbClient): IdentityAccessModule {
  const cached = modules.get(db)
  if (cached !== undefined) return cached

  const repository = new SQLiteUserAccessRepository(db)
  const transactions = new SQLiteUserAccessTransactionRunner(db)
  const observability = new IdentityAccessObservability()
  const resolveAuthority = new ResolveAuthority({ repository, observer: observability })
  const factoryDeps = { id: ulid, now: Date.now }
  const events = {
    authorityRevisionChanged(event: {
      readonly subjectRef: { readonly userId: string }
      readonly revision: number
    }): void {
      triggerAuthorityRevalidation(db, event.subjectRef.userId, event.revision, (error) => {
        observability.targetedRefreshFailure({
          userId: event.subjectRef.userId,
          revision: event.revision,
          error,
        })
      })
    },
  }
  // RFC-312 —— presence 全部落在进程内存：不建表、不查库、不轮询。
  // 变更出口只有这一条接线（bootstrap 装配，唯一实现）：合并窗口刷出 → 广播 presence.changed。
  const presenceStore = new InMemoryUserPresenceStore()
  const presenceClock = new PerformanceMonotonicClock()
  const trackUserPresence = new TrackUserPresence({
    store: presenceStore,
    graceTimer: new TimeoutPresenceTimer(),
    batchTimer: new TimeoutPresenceTimer(),
    clock: presenceClock,
    observer: {
      presenceChanged(changes) {
        const [head, ...rest] = changes
        if (head === undefined) return
        presenceBroadcaster.broadcast(PRESENCE_CHANNEL, {
          type: 'presence.changed',
          changes: [head, ...rest],
        })
      },
    },
  })
  const getUserPresence = new GetUserPresence(presenceStore, presenceClock)

  const module: IdentityAccessModule = Object.freeze({
    contexts: new DirectOperationContextFactory(factoryDeps),
    delegatedAuthority: new ResolveDelegatedAuthority(resolveAuthority),
    delegatedContexts: new DelegatedOperationContextFactory(factoryDeps),
    createManagedUser: new CreateManagedUser({
      transactions,
      auditId: ulid,
      systemUserId: SYSTEM_USER_ID,
      observer: observability,
    }),
    updateUserAccess: new UpdateUserAccess({
      transactions,
      auditId: ulid,
      systemUserId: SYSTEM_USER_ID,
      events,
      observer: observability,
    }),
    getUserAccess: new GetUserAccess(repository),
    trackUserPresence,
    getUserPresence,
    resolveAuthority,
    // 同一个 SQLite 适配器同时实现读仓与围栏读——装配处是唯一知道这件事的地方。
    authorityFence: repository,
    diagnostics: observability,
  })
  modules.set(db, module)
  return module
}
