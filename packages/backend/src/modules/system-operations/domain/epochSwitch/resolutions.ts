// RFC-626 §3.3 / §3.7: where the two stages of an automatic upgrade's decisions meet.
//
// The conversion summary is final when the conversion ends and cannot be amended afterwards:
// the target rejects a second, different summary for the same run. Finalizing the target runs
// later and makes decisions of its own (a reference to a row that is not there is cleared,
// re-pointed, or its row is moved to the archive). The plan of the actual result is the first
// document written after both, so the two lists are joined there and everything that reports
// the upgrade — the receipt, the completion log, `db migration status` — reads that plan.
import type { ConversionResolutions } from '@/platform/persistence/migration/conversion/sink'
import type { FinalizeDisposition } from '@/platform/persistence/migration/run/types'
import type { PlanResolutions } from './documents'

const sortedCounts = (counts: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/**
 * §3.7 (implementation gate G4-3): the task a missing content reference belongs to, so the
 * report says whose content is gone. The conversion names it on the row (`taskId`, taken from
 * the source row that referred to the content); null for content of no task, or when the row
 * does not say.
 */
function missingContentTask(
  row: ConversionResolutions['missingContent']['rows'][number],
): string | null {
  const named: unknown = 'taskId' in row ? row.taskId : null
  return typeof named === 'string' && named.length > 0 ? named : null
}

export function mergePlanResolutions(input: {
  /** Absent for a conversion that made no automatic decision at all. */
  readonly conversion: ConversionResolutions | undefined
  /** The complete list finalizing returned, in its own order (table, key, foreign key). */
  readonly finalize: readonly FinalizeDisposition[]
  /** Names of the ended tasks as the old database has them, by task id. */
  readonly taskNames: ReadonlyMap<string, string | null>
  readonly listLimit: number
  /** The table of the new database that holds every decision. */
  readonly recordsTable: string
}): PlanResolutions {
  const { conversion, finalize, listLimit } = input
  const settled = conversion?.settledTasks ?? []
  return {
    settledTasks: settled.slice(0, listLimit).map((task) => ({
      taskId: task.taskId,
      name: input.taskNames.get(task.taskId) ?? null,
      originalStatus: task.originalStatus,
      cause: task.cause,
      blockCodes: task.blockCodes,
      parentTaskId: task.parentTaskId,
    })),
    missingContent: (conversion?.missingContent.rows ?? []).slice(0, listLimit).map((row) => {
      const taskId = missingContentTask(row)
      return {
        table: row.sourceTable,
        key: row.sourceKey,
        column: row.sourceColumn,
        reference: row.reference,
        state: row.state,
        ...(taskId === null ? {} : { taskId }),
      }
    }),
    setAside: [
      ...(conversion?.setAside.rows ?? []).slice(0, listLimit).map((row) => ({
        stage: 'conversion' as const,
        sourcePhase: row.sourcePhase,
        sourceTable: row.sourceTable,
        sourceKey: row.sourceKey,
        code: row.code,
      })),
      ...finalize.slice(0, listLimit).map((row) => ({
        stage: 'finalize' as const,
        targetTable: row.targetTable,
        targetKey: row.targetKey,
        foreignKey: row.foreignKey,
        references: row.references,
        action: row.action,
        archive: row.archive,
      })),
    ],
    acknowledged: sortedCounts(conversion?.acknowledged.byCode ?? {}),
    kept: (conversion?.kept.rows ?? []).slice(0, listLimit).map((row) => ({
      table: row.sourceTable,
      key: row.sourceKey,
      code: row.code,
    })),
    keptByCode: sortedCounts(conversion?.kept.byCode ?? {}),
    totals: {
      settledTasks: settled.length,
      missingContent: conversion?.missingContent.total ?? 0,
      setAside: conversion?.setAside.total ?? 0,
      finalize: finalize.length,
      acknowledged: conversion?.acknowledged.total ?? 0,
      kept: conversion?.kept.total ?? 0,
    },
    listLimit,
    recordsTable: input.recordsTable,
  }
}
