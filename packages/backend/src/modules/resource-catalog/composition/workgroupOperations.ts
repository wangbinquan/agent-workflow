import type { Workgroup } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import {
  assertNoMissingRefs,
  assertRefsUsableInTx,
  resolveRefsUsableById,
} from '@/services/resourceRefs'
import { nextResourceCopyName } from '@/services/resourceCopyName'
import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'
import { monotonicNow } from '@/util/time'
import { WORKGROUPS_CHANNEL, workgroupsBroadcaster } from '@/ws/broadcaster'
import { assertNameUnchangedForEditor } from '../application/resourceAccess'
import { createWorkgroupApplication } from '../application/workgroups/workgroupApplication'
import type {
  WorkgroupAccessPort,
  WorkgroupEventsPort,
  WorkgroupMutationClock,
} from '../application/workgroups/ports'
import {
  createSqliteWorkgroupRepository,
  type SqliteWorkgroupRepositoryDependencies,
} from '../infrastructure/sqliteWorkgroupRepository'
import {
  canViewResource,
  canViewResourceInTx,
  composeResourceAclOperationApplication,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
  resolveResourceAccessForInTx,
} from './resourceAcl'
import {
  createWorkgroupOperationDescriptors,
  type WorkgroupCatalogModule,
} from '../public/operations'
import type { WorkgroupOperationContext } from '../public/participants'

export interface WorkgroupCatalogCompositionDependencies {
  readonly db: DbClient
  readonly id?: () => string
  readonly now?: () => number
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
      const resolved = await resolveRefsUsableById(input.db, authority, 'agent', ids, {
        grandfatheredIds,
      })
      assertNoMissingRefs(resolved.missing)
    },
    assertAgentIdsUsableInTx: (tx, authority, ids) =>
      assertRefsUsableInTx(tx, authority, [{ type: 'agent', names: ids, domain: 'id' }]),
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
  const eventsValue: WorkgroupEventsPort = {
    created(workgroup) {
      workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
        type: 'workgroup.created',
        workgroupId: workgroup.id,
        name: workgroup.name,
        version: workgroup.version,
      })
    },
    updated(receipt) {
      workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
        type: 'workgroup.updated',
        workgroupId: receipt.revision.workgroupId,
        clientMutationId: receipt.clientMutationId,
        version: receipt.revision.version,
        snapshotHash: receipt.revision.snapshotHash,
        updatedAt: receipt.revision.updatedAt,
      })
    },
    deleted(result) {
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
  }
  const events = Object.freeze(eventsValue)
  const clockValue: WorkgroupMutationClock = {
    now,
    nextUpdatedAt: (workgroup) => monotonicNow(workgroup.updatedAt),
  }
  const clock = Object.freeze(clockValue)
  const application = createWorkgroupApplication({
    repository,
    projection,
    access,
    events,
    ids: Object.freeze({ next: input.id ?? ulid }),
    clock,
  })
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
  const operations = createWorkgroupOperationDescriptors(
    application.commands,
    application.queries,
    acl,
  )
  return Object.freeze({
    queries: application.queries,
    operations,
  })
}
