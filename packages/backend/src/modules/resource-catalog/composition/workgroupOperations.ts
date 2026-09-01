import type { SaveWorkgroupReceipt, Workgroup, WorkgroupDetail } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { nextResourceCopyName } from '@/services/resourceCopyName'
import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'
import { monotonicNow } from '@/util/time'
import { ValidationError } from '@/util/errors'
import { WORKGROUPS_CHANNEL, workgroupsBroadcaster } from '@/ws/broadcaster'
import { assertNameUnchangedForEditor } from '../application/resourceAccess'
import { createWorkgroupApplication } from '../application/workgroups/workgroupApplication'
import type {
  WorkgroupAccessPort,
  WorkgroupDeleteResult,
  WorkgroupEventsPort,
  WorkgroupMutationClock,
  WorkgroupProjection,
  WorkgroupRepository,
} from '../application/workgroups/ports'
import {
  createSqliteWorkgroupRepository,
  type SqliteWorkgroupRepositoryDependencies,
} from '../infrastructure/sqliteWorkgroupRepository'
import {
  createPostgresqlWorkgroupRepository,
  type PostgresqlWorkgroupRepositoryDependencies,
} from '../infrastructure/postgresqlWorkgroupRepository'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  assertPostgresqlAgentIdsUsableInTransaction,
  listPostgresqlGrantedUserIdsInTransaction,
  resolvePostgresqlAccessInTransaction,
  resolvePostgresqlAgentIdsUsable,
} from '../infrastructure/postgresqlReferenceUsability'
import {
  assertNoMissingResourceRefs,
  assertResourceIdsUsableInTx,
  resolveResourceIdsUsableById,
} from '../infrastructure/sqliteReferenceUsability'
import {
  canViewResource,
  canViewResourceInTx,
  composeProviderResourceAclOperationApplication,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
  resolveResourceAccessForInTx,
} from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { canViewAccess } from '../domain/resourceAccess'
import { createWorkgroupOperationDescriptors } from './catalogOperationDescriptors'
import type { WorkgroupCatalogModule } from '../public/operations'
import type { WorkgroupOperationContext } from '../public/participants'

export interface WorkgroupCatalogCompositionDependencies {
  readonly db: DbClient
  readonly id?: () => string
  readonly now?: () => number
}

type WorkgroupAclOperationApplication = Parameters<typeof createWorkgroupOperationDescriptors>[2]

export interface WorkgroupCatalogAdapterCompositionDependencies {
  readonly repository: WorkgroupRepository
  readonly projection: WorkgroupProjection
  readonly access: WorkgroupAccessPort
  readonly acl: WorkgroupAclOperationApplication
  readonly events?: WorkgroupEventsPort
  readonly id?: () => string
  readonly now?: () => number
}

export interface PostgresqlWorkgroupCatalogCompositionDependencies extends Omit<
  WorkgroupCatalogAdapterCompositionDependencies,
  'repository' | 'projection' | 'access' | 'acl'
> {
  readonly db: PostgresqlDatabaseClient
  readonly resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>
}

function createWorkgroupEvents(): WorkgroupEventsPort {
  return Object.freeze({
    created(workgroup: WorkgroupDetail) {
      workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
        type: 'workgroup.created',
        workgroupId: workgroup.id,
        name: workgroup.name,
        version: workgroup.version,
      })
    },
    updated(receipt: SaveWorkgroupReceipt) {
      workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
        type: 'workgroup.updated',
        workgroupId: receipt.revision.workgroupId,
        clientMutationId: receipt.clientMutationId,
        version: receipt.revision.version,
        snapshotHash: receipt.revision.snapshotHash,
        updatedAt: receipt.revision.updatedAt,
      })
    },
    deleted(result: WorkgroupDeleteResult) {
      workgroupsBroadcaster.broadcast(
        WORKGROUPS_CHANNEL,
        {
          type: 'workgroup.deleted',
          workgroupId: result.receipt.id,
          clientMutationId: result.receipt.clientMutationId,
          deletedVersion: result.receipt.deletedVersion,
        },
        {
          ...result.audience,
          grantedUserIds: new Set(result.audience.grantedUserIds),
        },
      )
    },
  })
}

export function composeWorkgroupCatalogFromAdapters(
  input: WorkgroupCatalogAdapterCompositionDependencies,
): WorkgroupCatalogModule {
  const now = input.now ?? Date.now
  const clock: WorkgroupMutationClock = Object.freeze({
    now,
    nextUpdatedAt: (workgroup: Workgroup) => monotonicNow(workgroup.updatedAt),
  })
  const application = createWorkgroupApplication({
    repository: input.repository,
    projection: input.projection,
    access: input.access,
    events: input.events ?? createWorkgroupEvents(),
    ids: Object.freeze({ next: input.id ?? ulid }),
    clock,
  })
  const operations = createWorkgroupOperationDescriptors(
    application.commands,
    application.queries,
    input.acl,
  )
  return Object.freeze({ queries: application.queries, operations })
}

export function composePostgresqlWorkgroupCatalog(
  input: PostgresqlWorkgroupCatalogCompositionDependencies,
): WorkgroupCatalogModule {
  const now = input.now ?? Date.now
  const assertUsable = (missing: readonly string[]): void => {
    if (missing.length === 0) return
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${missing.map((id) => `agent '${id}'`).join(', ')}`,
      { missing: missing.map((name) => ({ type: 'agent' as const, name })) },
    )
  }
  const { repository, projection } = createPostgresqlWorkgroupRepository(
    input.db,
    Object.freeze({
      canViewInTransaction: async (transaction, authority, row) =>
        canViewAccess(
          await resolvePostgresqlAccessInTransaction(transaction, authority, 'workgroup', row),
        ),
      resolveAccessInTransaction: (transaction, authority, row) =>
        resolvePostgresqlAccessInTransaction(transaction, authority, 'workgroup', row),
      async assertAgentIdsUsable(authority, ids, grandfatheredIds) {
        assertUsable(
          await resolvePostgresqlAgentIdsUsable(input.db, authority, ids, grandfatheredIds),
        )
      },
      async assertAgentIdsUsableInTransaction(transaction, authority, ids) {
        assertUsable(await assertPostgresqlAgentIdsUsableInTransaction(transaction, authority, ids))
      },
      listGrantedUserIdsInTransaction: (transaction, workgroupId) =>
        listPostgresqlGrantedUserIdsInTransaction(transaction, 'workgroup', workgroupId),
      scheduledReferences: (rows, workgroupId) =>
        scheduledRowsReferencing(rows, {
          launchKind: 'workgroup',
          payloadKey: 'workgroupId',
          id: workgroupId,
        }),
      nextCopyName: (sourceName, occupiedNames) =>
        nextResourceCopyName(sourceName, occupiedNames, 'workgroup'),
      assertNameUnchangedForEditor,
      memberId: input.id ?? ulid,
      now,
    } satisfies PostgresqlWorkgroupRepositoryDependencies),
  )
  const access = Object.freeze({
    filterVisible: (authority, rows) =>
      input.resourceCatalog.authorization.filterVisibleRows(authority, 'workgroup', rows),
    canView: (authority, row) =>
      input.resourceCatalog.authorization.canViewResource(authority, 'workgroup', row),
    requireResourceEdit: async (authority, row) => {
      await input.resourceCatalog.authorization.requireResourceEdit(authority, 'workgroup', row)
    },
    requireResourceGovern: (authority, row) =>
      input.resourceCatalog.authorization.requireResourceGovern(authority, 'workgroup', row),
  } satisfies WorkgroupAccessPort)
  const events = input.events ?? createWorkgroupEvents()
  const acl = composeProviderResourceAclOperationApplication<
    WorkgroupOperationContext,
    'workgroup',
    Workgroup
  >({
    ...input.resourceCatalog,
    type: 'workgroup',
    load: (id) => repository.get(id),
    afterUpdated: (workgroupId) => {
      workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
        type: 'workgroup.acl.updated',
        workgroupId,
      })
    },
  })
  return composeWorkgroupCatalogFromAdapters({
    repository,
    projection,
    access,
    acl,
    events,
    id: input.id,
    now,
  })
}

export function composeWorkgroupCatalog(
  input: WorkgroupCatalogCompositionDependencies,
): WorkgroupCatalogModule {
  const now = input.now ?? Date.now
  const repositoryDependenciesValue: SqliteWorkgroupRepositoryDependencies = {
    canViewInTx: (tx, authority, row) => canViewResourceInTx(tx, authority, 'workgroup', row),
    resolveAccessInTx: (tx, authority, row) =>
      resolveResourceAccessForInTx(tx, authority, 'workgroup', row),
    async assertAgentIdsUsable(authority, ids, grandfatheredIds) {
      const resolved = await resolveResourceIdsUsableById(input.db, authority, 'agent', ids, {
        grandfatheredIds,
      })
      assertNoMissingResourceRefs(resolved.missing)
    },
    assertAgentIdsUsableInTx: (tx, authority, ids) =>
      assertResourceIdsUsableInTx(tx, authority, 'agent', ids),
    scheduledReferences: (rows, workgroupId) =>
      scheduledRowsReferencing(rows, {
        launchKind: 'workgroup',
        payloadKey: 'workgroupId',
        id: workgroupId,
      }),
    nextCopyName: (sourceName, occupiedNames) =>
      nextResourceCopyName(sourceName, occupiedNames, 'workgroup'),
    assertNameUnchangedForEditor,
    memberId: input.id ?? ulid,
    now,
  }
  const repositoryDependencies = Object.freeze(repositoryDependenciesValue)
  const { repository, projection } = createSqliteWorkgroupRepository(
    input.db,
    repositoryDependencies,
  )
  const access: WorkgroupAccessPort = Object.freeze({
    filterVisible: (authority: WorkgroupOperationContext, rows: readonly Workgroup[]) =>
      filterVisibleRows<Workgroup>(input.db, authority, 'workgroup', rows),
    canView: (authority: WorkgroupOperationContext, row: Workgroup) =>
      canViewResource(input.db, authority, 'workgroup', row),
    requireResourceEdit: async (authority: WorkgroupOperationContext, row: Workgroup) => {
      await requireResourceEdit(input.db, authority, 'workgroup', row)
    },
    requireResourceGovern: (authority: WorkgroupOperationContext, row: Workgroup) =>
      requireResourceGovern(input.db, authority, 'workgroup', row),
  })
  const events = createWorkgroupEvents()
  const acl = composeResourceAclOperationApplication<WorkgroupOperationContext, Workgroup>({
    db: input.db,
    type: 'workgroup',
    load: (id) => repository.get(id),
    afterUpdated: (workgroupId) => {
      workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
        type: 'workgroup.acl.updated',
        workgroupId,
      })
    },
  })
  return composeWorkgroupCatalogFromAdapters({
    repository,
    projection,
    access,
    acl,
    events,
    id: input.id,
    now,
  })
}
