import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TransactionScope } from '@/platform/persistence/transactionScope'
import { TrackUserPresence } from './application/commands/trackUserPresence'
import { GetUserPresence } from './application/queries/getUserPresence'
import { projectDelegatedLegacyActor } from './application/legacyActorProjection'
import {
  InMemoryUserPresenceStore,
  PerformanceMonotonicClock,
  TimeoutPresenceTimer,
} from './infrastructure/inMemoryPresence'
import { CreateManagedUser } from './application/commands/createManagedUser'
import { UpdateUserAccess } from './application/commands/updateUserAccess'
import {
  AuthorityClaimRegistry,
  DelegatedOperationContextFactory,
  DirectAuthorityRuntime,
  DirectOperationContextFactory,
  LocalOperatorContextFactory,
} from './application/operationContext'
import { GetUserAccess } from './application/queries/getUserAccess'
import { GetUserGitCommitIdentity } from './application/queries/getUserGitCommitIdentity'
import { GetUserProfile } from './application/queries/getUserProfile'
import { UpdateOwnProfile } from './application/commands/updateOwnProfile'
import { SyncOidcProfile } from './application/commands/syncOidcProfile'
import { ResolveAuthority } from './application/queries/resolveAuthority'
import {
  SQLiteUserAccessRepository,
  SQLiteUserAccessTransactionRunner,
  insertInitialUserAccessInTransaction,
  syncOidcProfileInTransaction,
} from './infrastructure/sqliteUserAccessRepository'
import {
  PostgresqlAuthorityFenceCache,
  PostgresqlUserAccessRepository,
  PostgresqlUserAccessTransactionRunner,
} from './infrastructure/postgresqlUserAccessRepository'
import { mapOidcEmailConstraint } from './application/commands/syncOidcProfile'
import type {
  SyncOidcProfileCommand,
  SyncOidcProfileResult,
} from './application/commands/syncOidcProfile'
import {
  IdentityAccessObservability,
  type IdentityAccessDiagnostics,
} from './infrastructure/identityAccessObservability'
import type {
  DelegatedRequestAuthorityFactory,
  DirectCommandContextFactory,
  DirectAuthorityAdmission,
  DirectAuthorityBinding,
  DirectQueryContextFactory,
  InitialUserAccessProvisioner,
  InitialUserAccessProvision,
  LegacyActorProjectionFactory,
  PresenceConnectionTracker,
  PresenceLease,
  PresenceQuery,
} from './public/participants'
import type {
  PublicUserDirectory,
  UserAccessFenceReader,
  UserAccessReadRepository,
} from './application/ports/userAccessRepository'
import type { UserAccessTransactionRunner } from './application/ports/userAccessTransaction'

const SYSTEM_USER_ID = '__system__'

interface RuntimeIdentityAccessEventSink {
  authorityRevisionChanged(input: {
    readonly userId: string
    readonly revision: number
    readonly onFailure: (error: unknown) => void
  }): void
}

interface RuntimePresenceProjectionSink {
  publish(changes: ReadonlyArray<{ readonly userId: string; readonly online: boolean }>): void
}

/** Composition-only bridge. Public consumers receive only the provisioner
 * returned for the currently live transaction scope. */
export interface InitialUserAccessTransactionBinding {
  forTransaction(transactionScope: TransactionScope): InitialUserAccessProvisioner
}

class RuntimePresenceConnections implements PresenceConnectionTracker {
  private readonly live = new Set<PresenceLease>()

  constructor(
    private readonly direct: DirectAuthorityRuntime,
    private readonly tracker: TrackUserPresence,
  ) {}

  open(authority: Parameters<PresenceConnectionTracker['open']>[0]): PresenceLease | null {
    const actor = this.direct.legacyProjectionForAuthority(authority)
    if (actor.source !== 'session') return null
    this.tracker.opened(actor.userId)
    let released = false
    const lease = Object.freeze({
      release: () => {
        if (released) return
        released = true
        this.live.delete(lease)
        this.tracker.closed(actor.userId)
      },
    }) as PresenceLease
    this.live.add(lease)
    return lease
  }

  shutdown(): void {
    for (const lease of [...this.live]) lease.release()
  }
}

export interface IdentityAccessRuntime {
  readonly contexts: DirectCommandContextFactory & DirectQueryContextFactory
  readonly directAuthority: DirectAuthorityAdmission & DirectAuthorityBinding
  /** Composition-only local CLI participant; not an HTTP/MCP authority mint. */
  readonly localOperator: LocalOperatorContextFactory
  readonly delegatedRequests: DelegatedRequestAuthorityFactory
  readonly legacyProjection: LegacyActorProjectionFactory
  readonly createManagedUser: CreateManagedUser
  readonly updateUserAccess: UpdateUserAccess
  readonly getUserAccess: GetUserAccess
  readonly getUserProfile: GetUserProfile
  readonly getUserGitCommitIdentity: GetUserGitCommitIdentity
  readonly updateOwnProfile: UpdateOwnProfile
  readonly userDirectory: PublicUserDirectory
  readonly initialUserAccess: InitialUserAccessTransactionBinding
  readonly syncOidcProfile: SyncOidcProfile
  readonly syncOidcProfileInTransaction: (
    transactionScope: TransactionScope,
    command: SyncOidcProfileCommand,
    now?: number,
  ) => SyncOidcProfileResult
  readonly mapOidcEmailConstraint: (error: unknown) => unknown
  readonly resolveAuthority: ResolveAuthority
  readonly authorityFence: UserAccessFenceReader
  readonly diagnostics: IdentityAccessDiagnostics
  readonly presenceConnections: PresenceConnectionTracker
  readonly presenceQuery: PresenceQuery
  shutdown(): void
}

export type IdentityAccessModule = IdentityAccessRuntime
export type IdentityAccessFixtureRuntime = Omit<IdentityAccessRuntime, 'contexts'> & {
  /** Explicit test-only plain-principal context seam. */
  readonly contexts: DirectOperationContextFactory
  readonly trackUserPresence: TrackUserPresence
  readonly getUserPresence: GetUserPresence
}

export interface CreateIdentityAccessRuntimeInput {
  readonly db: DbClient
  readonly events?: RuntimeIdentityAccessEventSink
  readonly presenceProjection?: RuntimePresenceProjectionSink
  readonly id?: () => string
  readonly now?: () => number
}

/**
 * PostgreSQL account bootstrap/OIDC linking must join the caller's surrounding
 * async transaction.  The platform composition root supplies these opaque-
 * scope bridges; identity-access never receives a raw PostgreSQL transaction.
 */
export interface PostgresqlIdentityAccessCrossContextBindings {
  readonly initialUserAccess: InitialUserAccessTransactionBinding
  readonly syncOidcProfileInTransaction: IdentityAccessRuntime['syncOidcProfileInTransaction']
}

export interface CreatePostgresqlIdentityAccessRuntimeInput {
  readonly db: PostgresqlDatabaseClient
  /** Required: account bootstrap and OIDC linking must join their owning PG transaction. */
  readonly crossContextTransactions: PostgresqlIdentityAccessCrossContextBindings
  readonly events?: RuntimeIdentityAccessEventSink
  readonly presenceProjection?: RuntimePresenceProjectionSink
  readonly id?: () => string
  readonly now?: () => number
}

interface IdentityAccessPersistence {
  readonly repository: UserAccessReadRepository & UserAccessFenceReader
  readonly transactions: UserAccessTransactionRunner
  readonly initialUserAccess: InitialUserAccessTransactionBinding
  readonly syncOidcProfileInTransaction: IdentityAccessRuntime['syncOidcProfileInTransaction']
}

/** Pure composition factory.  Runtime lifetime belongs to the caller; there is
 * deliberately no DB-keyed cache and no WS import in this module. */
export function createIdentityAccessRuntime(
  input: CreateIdentityAccessRuntimeInput,
): IdentityAccessRuntime {
  return buildIdentityAccessRuntime(input, sqlitePersistence(input.db), false)
}

/** PostgreSQL composition root. Provider mechanics remain below composition;
 * callers receive the same IdentityAccessRuntime Promise surface. */
export function createPostgresqlIdentityAccessRuntime(
  input: CreatePostgresqlIdentityAccessRuntimeInput,
): IdentityAccessRuntime {
  const fenceCache = new PostgresqlAuthorityFenceCache()
  const repository = new PostgresqlUserAccessRepository(input.db, fenceCache)
  return buildIdentityAccessRuntime(
    input,
    {
      repository,
      transactions: new PostgresqlUserAccessTransactionRunner(input.db, fenceCache),
      initialUserAccess: input.crossContextTransactions.initialUserAccess,
      syncOidcProfileInTransaction: input.crossContextTransactions.syncOidcProfileInTransaction,
    },
    false,
  )
}

function buildIdentityAccessRuntime(
  input: Omit<CreateIdentityAccessRuntimeInput, 'db'>,
  persistence: IdentityAccessPersistence,
  exposeFixtures: false,
): IdentityAccessRuntime
function buildIdentityAccessRuntime(
  input: Omit<CreateIdentityAccessRuntimeInput, 'db'>,
  persistence: IdentityAccessPersistence,
  exposeFixtures: true,
): IdentityAccessFixtureRuntime
function buildIdentityAccessRuntime(
  input: Omit<CreateIdentityAccessRuntimeInput, 'db'>,
  persistence: IdentityAccessPersistence,
  exposeFixtures: boolean,
): IdentityAccessRuntime | IdentityAccessFixtureRuntime {
  const { repository, transactions } = persistence
  const observability = new IdentityAccessObservability()
  const resolveAuthority = new ResolveAuthority({ repository, observer: observability })
  const factoryDeps = { id: input.id ?? ulid, now: input.now ?? Date.now }
  const registry = new AuthorityClaimRegistry()
  const directAuthority = new DirectAuthorityRuntime(resolveAuthority, registry)
  const contexts = new DirectOperationContextFactory(factoryDeps, registry)
  const delegatedRequests = new DelegatedOperationContextFactory(
    factoryDeps,
    resolveAuthority,
    registry,
  )
  const legacyProjection: LegacyActorProjectionFactory = Object.freeze({
    fromResolvedSubject: projectDelegatedLegacyActor,
  })

  const presenceStore = new InMemoryUserPresenceStore()
  const presenceClock = new PerformanceMonotonicClock()
  const graceTimer = new TimeoutPresenceTimer()
  const batchTimer = new TimeoutPresenceTimer()
  const trackUserPresence = new TrackUserPresence({
    store: presenceStore,
    graceTimer,
    batchTimer,
    clock: presenceClock,
    observer: {
      presenceChanged(changes) {
        input.presenceProjection?.publish(changes)
      },
    },
  })
  const getUserPresence = new GetUserPresence(presenceStore, presenceClock)
  const presenceConnections = new RuntimePresenceConnections(directAuthority, trackUserPresence)
  const publicContexts: DirectCommandContextFactory & DirectQueryContextFactory = Object.freeze({
    fromAuthority: contexts.fromAuthority.bind(contexts),
    fromAuthorityWithIdempotency: contexts.fromAuthorityWithIdempotency.bind(contexts),
    resolveCommandContext: contexts.resolveCommandContext.bind(contexts),
    queryFromAuthority: contexts.queryFromAuthority.bind(contexts),
    resolveQueryContext: contexts.resolveQueryContext.bind(contexts),
  })

  const runtime: IdentityAccessRuntime = Object.freeze({
    contexts: publicContexts,
    directAuthority,
    localOperator: new LocalOperatorContextFactory(resolveAuthority, contexts),
    delegatedRequests,
    legacyProjection,
    createManagedUser: new CreateManagedUser({
      transactions,
      auditId: factoryDeps.id,
      systemUserId: SYSTEM_USER_ID,
      observer: observability,
    }),
    updateUserAccess: new UpdateUserAccess({
      transactions,
      auditId: factoryDeps.id,
      systemUserId: SYSTEM_USER_ID,
      events: {
        authorityRevisionChanged(event) {
          input.events?.authorityRevisionChanged({
            userId: event.subjectRef.userId,
            revision: event.revision,
            onFailure(error) {
              observability.targetedRefreshFailure({
                userId: event.subjectRef.userId,
                revision: event.revision,
                error,
              })
            },
          })
        },
      },
      observer: observability,
    }),
    getUserAccess: new GetUserAccess(repository),
    getUserProfile: new GetUserProfile(repository),
    getUserGitCommitIdentity: new GetUserGitCommitIdentity(repository, SYSTEM_USER_ID),
    updateOwnProfile: new UpdateOwnProfile({
      transactions,
      systemUserId: SYSTEM_USER_ID,
      auditId: factoryDeps.id,
    }),
    userDirectory: Object.freeze({
      findByUsername: repository.findByUsername.bind(repository),
      search: repository.search.bind(repository),
      lookup: repository.lookup.bind(repository),
    }),
    initialUserAccess: Object.freeze({
      forTransaction: persistence.initialUserAccess.forTransaction,
    }),
    syncOidcProfile: new SyncOidcProfile({
      transactions,
      auditId: factoryDeps.id,
      operationId: factoryDeps.id,
      now: factoryDeps.now,
    }),
    syncOidcProfileInTransaction: persistence.syncOidcProfileInTransaction,
    mapOidcEmailConstraint,
    presenceConnections,
    presenceQuery: Object.freeze({ snapshot: () => getUserPresence.snapshot() }),
    resolveAuthority,
    authorityFence: repository,
    diagnostics: observability,
    shutdown() {
      presenceConnections.shutdown()
      graceTimer.clear()
      batchTimer.clear()
    },
  })
  if (!exposeFixtures) return runtime
  return Object.freeze({
    ...runtime,
    contexts,
    trackUserPresence,
    getUserPresence,
  })
}

function bindInitialUserAccessProvisioner(
  transactionScope: TransactionScope,
): InitialUserAccessProvisioner {
  return Object.freeze({
    insert(provision: InitialUserAccessProvision): void {
      insertInitialUserAccessInTransaction(transactionScope, provision)
    },
  })
}

/** Explicit local/test fixture factory. Production daemon/server code receives
 * one createIdentityAccessRuntime result from its bootstrap root. */
export function composeIdentityAccess(db: DbClient): IdentityAccessFixtureRuntime {
  return buildIdentityAccessRuntime({}, sqlitePersistence(db), true)
}

function sqlitePersistence(db: DbClient): IdentityAccessPersistence {
  const repository = new SQLiteUserAccessRepository(db)
  return {
    repository,
    transactions: new SQLiteUserAccessTransactionRunner(db),
    initialUserAccess: Object.freeze({ forTransaction: bindInitialUserAccessProvisioner }),
    syncOidcProfileInTransaction,
  }
}
