import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
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

const SYSTEM_USER_ID = '__system__'

export interface IdentityAccessModule {
  readonly contexts: DirectOperationContextFactory
  readonly delegatedAuthority: DelegatedAuthorityResolver
  readonly delegatedContexts: DelegatedOperationContextFactoryPort
  readonly createManagedUser: CreateManagedUser
  readonly updateUserAccess: UpdateUserAccess
  readonly getUserAccess: GetUserAccess
  readonly resolveAuthority: ResolveAuthority
  readonly diagnostics: IdentityAccessDiagnostics
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
    resolveAuthority,
    diagnostics: observability,
  })
  modules.set(db, module)
  return module
}
