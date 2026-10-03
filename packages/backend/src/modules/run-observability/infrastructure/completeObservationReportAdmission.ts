import { and, asc, eq, gt, inArray, like, sql } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { taskVisibilityCondition, type ProviderNeutralDatabase } from '@/db/query'
import {
  observationPlatformSources,
  observationReportCounts,
  observationReportReceipts,
  observationReportRows,
  observationReports,
  tasks,
  users,
} from '@/db/schema'
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { CompleteObservationError } from '../domain/completeObservationError'
import type { CompleteObservationStoredReport } from '../ports/completeObservationReport'
import type { PlatformSyncState } from '../domain/platformSync'
import { assertCompleteReportIntegrity } from './completeObservationReportIntegrity'

export interface CompleteCostVisibilityReceipt {
  readonly kind: 'cost-visibility'
  readonly sourceKey: string
  readonly costVisibility: PlatformSyncState['costVisibility']
  readonly visibilityRevision: number | null
}
/** Shared by cache and staging without a runtime import cycle between those adapters. */
export async function ownedCompleteReport(tx: DatabaseTransaction, id: string, owner: string) {
  await engineOf(tx).lockAggregateRoot(tx, observationReports, observationReports.id, id)
  const row = await tx.select().from(observationReports).where(eq(observationReports.id, id)).get()
  if (!row || row.owner !== owner || row.state !== 'building')
    throw new Error('Original complete report build ownership changed')
  return row
}
export async function assertCompleteReportActor(
  db: ProviderNeutralDatabase,
  actor: Actor,
  taskId?: string,
) {
  if (
    actor.user.status !== 'active' ||
    (!actor.permissions.has('tasks:read:all') && !actor.permissions.has('tasks:read:own'))
  )
    throw new CompleteObservationError('scope-changed', 'Original observation permission changed')
  if (actor.source !== 'daemon') {
    const user = await db
      .select({ status: users.status, role: users.role, revision: users.accessRevision })
      .from(users)
      .where(eq(users.id, actor.user.id))
      .get()
    if (
      !user ||
      user.status !== 'active' ||
      user.role !== actor.user.role ||
      user.revision !== (actor.authorityRevision ?? 0)
    )
      throw new CompleteObservationError('scope-changed', 'Original observation actor changed')
  }
  if (taskId !== undefined) {
    const task = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, taskId),
          taskVisibilityCondition(db, {
            userId: actor.user.id,
            canReadAllTasks: actor.permissions.has('tasks:read:all'),
          }),
        ),
      )
      .get()
    if (!task) throw new CompleteObservationError('not-found', 'Original Task is not available')
  }
}
/** Validate the retained population against current original grants, without reselecting a newer cohort. */
export async function assertCompleteReportPopulation(
  db: ProviderNeutralDatabase,
  actor: Actor,
  id: string,
  expectedTasks: string,
) {
  const row = await db
    .select({ total: sql<string>`cast(count(*) as text)` })
    .from(observationReportRows)
    .innerJoin(tasks, eq(tasks.id, observationReportRows.key))
    .where(
      and(
        eq(observationReportRows.reportId, id),
        eq(observationReportRows.section, 'tasks'),
        eq(observationReportRows.parent, ''),
        taskVisibilityCondition(db, {
          userId: actor.user.id,
          canReadAllTasks: actor.permissions.has('tasks:read:all'),
        }),
      ),
    )
    .get()
  if (row?.total !== expectedTasks)
    throw new CompleteObservationError(
      'scope-changed',
      'Original report Task visibility or retained facts changed; refresh',
    )
  let after: string | undefined
  for (;;) {
    const rows = await db
      .select({ key: observationReportReceipts.key, document: observationReportReceipts.document })
      .from(observationReportReceipts)
      .where(
        and(
          eq(observationReportReceipts.reportId, id),
          like(observationReportReceipts.key, 'visibility/%'),
          after === undefined ? undefined : gt(observationReportReceipts.key, after),
        ),
      )
      .orderBy(asc(observationReportReceipts.key))
      .limit(200)
      .all()
    const receipts = rows.map((row) => JSON.parse(row.document) as CompleteCostVisibilityReceipt)
    const originals = receipts.length
      ? await db
          .select()
          .from(observationPlatformSources)
          .where(
            inArray(
              observationPlatformSources.id,
              receipts.map((row) => row.sourceKey),
            ),
          )
          .all()
      : []
    const byId = new Map(
      originals.map((row) => [row.id, JSON.parse(row.document) as PlatformSyncState]),
    )
    for (const receipt of receipts) {
      const state = byId.get(receipt.sourceKey)
      if (
        !state ||
        receipt.kind !== 'cost-visibility' ||
        state.costVisibility !== receipt.costVisibility ||
        state.visibilityRevision !== receipt.visibilityRevision
      )
        throw new CompleteObservationError(
          'scope-changed',
          'Original platform cost visibility changed; refresh',
        )
    }
    if (rows.length < 200) break
    const next = rows.at(-1)!.key
    if (after !== undefined && next <= after)
      throw new Error('Original cost visibility receipt cursor did not advance')
    after = next
  }
}
export async function assertStoredCompleteReport(
  db: ProviderNeutralDatabase,
  actor: Actor,
  report: CompleteObservationStoredReport,
) {
  await assertCompleteReportActor(db, actor, report.request.taskId)
  if (report.report.state !== 'ready') return
  await assertCompleteReportIntegrity(db, report)
  const count = await db
    .select({ total: observationReportCounts.total })
    .from(observationReportCounts)
    .where(
      and(
        eq(observationReportCounts.reportId, report.id),
        eq(observationReportCounts.section, 'tasks'),
        eq(observationReportCounts.parent, ''),
      ),
    )
    .get()
  if ((count?.total ?? '0') !== report.report.summary.inventory.tasks)
    throw new Error('Complete original Task report count changed')
  await assertCompleteReportPopulation(db, actor, report.id, report.report.summary.inventory.tasks)
}
