import type { SaveWorkgroupReceipt, Workgroup, WorkgroupDetail } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nextResourceCopyName } from '@/services/resourceCopyName'
import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'
import { monotonicNow } from '@/util/time'
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
  createWorkgroupRepository,
  type WorkgroupRepositoryDependencies,
} from '../infrastructure/workgroupRepository'
import {
  assertAgentIdsUsableInTransaction,
  assertNoMissingResourceRefs,
  listGrantedUserIdsInTransaction,
  resolveAccessInTransaction,
  resolveAgentIdsUsable,
} from '../infrastructure/referenceUsability'
import { composeProviderResourceAclOperationApplication } from './resourceAcl'
import type { ProviderResourceCatalogComposition } from './providerResourceCatalog'
import { canViewAccess } from '../domain/resourceAccess'
import { createWorkgroupOperationDescriptors } from './catalogOperationDescriptors'
import type { WorkgroupCatalogModule } from '../public/operations'
import type { WorkgroupOperationContext } from '../public/participants'

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

/**
 * RFC-359 W4-D18 —— Workgroup 目录一份装配（此前 SQLite / PG 各一份）：仓库是中立的 `createWorkgroupRepository`，
 * 引用可用性 / 访问解析走中立的 `referenceUsability`，访问判定与 ACL 操作经资源目录的 provider 中立应用。
 */
export interface WorkgroupCatalogCompositionDependencies extends Omit<
  WorkgroupCatalogAdapterCompositionDependencies,
  'repository' | 'projection' | 'access' | 'acl'
> {
  readonly db: ProviderNeutralDatabase
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

/** 仓库依赖一份：引用可用性 / 访问解析 / 授权用户清单 / 定时任务引用 / 复制命名（测试也从这里拿）。 */
export function workgroupRepositoryDependencies(input: {
  readonly db: ProviderNeutralDatabase
  readonly id?: () => string
  readonly now?: () => number
}): WorkgroupRepositoryDependencies {
  const now = input.now ?? Date.now
  const assertUsable = (missing: readonly string[]): void =>
    assertNoMissingResourceRefs(missing.map((name) => ({ type: 'agent' as const, name })))
  const dependencies: WorkgroupRepositoryDependencies = {
    canViewInTransaction: async (transaction, authority, row) =>
      canViewAccess(await resolveAccessInTransaction(transaction, authority, 'workgroup', row)),
    resolveAccessInTransaction: (transaction, authority, row) =>
      resolveAccessInTransaction(transaction, authority, 'workgroup', row),
    async assertAgentIdsUsable(authority, ids, grandfatheredIds) {
      assertUsable(await resolveAgentIdsUsable(input.db, authority, ids, grandfatheredIds))
    },
    async assertAgentIdsUsableInTransaction(transaction, authority, ids) {
      assertUsable(await assertAgentIdsUsableInTransaction(transaction, authority, ids))
    },
    listGrantedUserIdsInTransaction: (transaction, workgroupId) =>
      listGrantedUserIdsInTransaction(transaction, 'workgroup', workgroupId),
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
  return Object.freeze(dependencies)
}

export function composeWorkgroupCatalog(
  input: WorkgroupCatalogCompositionDependencies,
): WorkgroupCatalogModule {
  const now = input.now ?? Date.now
  const { repository, projection } = createWorkgroupRepository(
    input.db,
    workgroupRepositoryDependencies({ db: input.db, id: input.id, now }),
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
