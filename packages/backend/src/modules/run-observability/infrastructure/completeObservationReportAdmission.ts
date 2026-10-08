import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationPlatformSources,
  observationReportCounts,
  observationReportReceipts,
  observationReportRows,
  observationReports,
  users,
} from '@/db/schema'
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { CompleteObservationError } from '../domain/completeObservationError'
import type { CompleteObservationStoredReport } from '../ports/completeObservationReport'
import type { PlatformSyncState } from '../domain/platformSync'
import { assertCompleteReportIntegrity } from './completeObservationReportIntegrity'
import type { CompleteObservationTaskSource } from '../ports/taskObservations'

export type CompleteReportTaskSource = (
  db: ProviderNeutralDatabase,
) => Pick<CompleteObservationTaskSource, 'get' | 'visibleIds'>

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
  sources: Pick<CompleteObservationTaskSource, 'get'>,
  taskId?: string,
) {
  if (
    actor.user.status !== 'active' ||
    (!actor.permissions.has('tasks:read:all') && !actor.permissions.has('tasks:read:own'))
  )
    throw new CompleteObservationError('scope-changed', 'Original observation permission changed')
  if (actor.source !== 'daemon') {
    const user = await db
      .select({ status: users.status, revision: users.accessRevision })
      .from(users)
      .where(eq(users.id, actor.user.id))
      .get()
    if (!user || user.status !== 'active' || user.revision !== (actor.authorityRevision ?? 0))
      throw new CompleteObservationError('scope-changed', 'Original observation actor changed')
  }
  if (taskId !== undefined) {
    const task = await sources.get(actor, taskId)
    if (!task) throw new CompleteObservationError('not-found', 'Original Task is not available')
  }
}
/** Validate the retained population against current original grants, without reselecting a newer cohort. */
export async function assertCompleteReportPopulation(
  db: ProviderNeutralDatabase,
  actor: Actor,
  sources: Pick<CompleteObservationTaskSource, 'visibleIds'>,
  id: string,
  expectedTasks: string,
) {
  let taskAfter: string | undefined
  let visibleTasks = 0n
  for (;;) {
    const rows = await db
      .select({ key: observationReportRows.key })
      .from(observationReportRows)
      .where(
        and(
          eq(observationReportRows.reportId, id),
          eq(observationReportRows.section, 'tasks'),
          eq(observationReportRows.parent, ''),
          taskAfter === undefined ? undefined : gt(observationReportRows.key, taskAfter),
        ),
      )
      .orderBy(asc(observationReportRows.key))
      .limit(200)
      .all()
    const visible = new Set(
      await sources.visibleIds(
        actor,
        rows.map((row) => row.key),
      ),
    )
    if (visible.size !== rows.length || rows.some((row) => !visible.has(row.key)))
      throw new CompleteObservationError(
        'scope-changed',
        'Original report Task visibility or retained facts changed; refresh',
      )
    visibleTasks += BigInt(rows.length)
    if (rows.length < 200) break
    const next = rows.at(-1)!.key
    if (taskAfter !== undefined && next <= taskAfter)
      throw new Error('Original retained observation source cursor did not advance')
    taskAfter = next
  }
  if (String(visibleTasks) !== expectedTasks)
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
          eq(sql<string>`substr(${observationReportReceipts.key}, 1, 11)`, 'visibility/'),
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
  sources: Pick<CompleteObservationTaskSource, 'get' | 'visibleIds'>,
  integrity: typeof assertCompleteReportIntegrity = assertCompleteReportIntegrity,
) {
  await assertCompleteReportActor(db, actor, sources, report.request.taskId)
  const content =
    report.report.state === 'ready'
      ? report.report
      : report.report.state === 'not-ready'
        ? report.report.facts
        : undefined
  if (!content) return
  await integrity(db, report)
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
  if ((count?.total ?? '0') !== content.summary.inventory.tasks)
    throw new Error('Complete original Task report count changed')
  await assertCompleteReportPopulation(
    db,
    actor,
    sources,
    report.id,
    content.summary.inventory.tasks,
  )
}
