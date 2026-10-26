import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { PersistedHistoryRestriction } from '@/platform/persistence/migration/run/types'
import type { MigrationMetaReadPort } from '../../application/ports/epochSwitch'
import type { TaskRestrictionView } from '../../public/types'
import { compareMigrationBytes } from './metaStore'

export function historyRestrictionsDigest(
  restrictions: readonly PersistedHistoryRestriction[],
): string {
  return valueDigest(
    [...restrictions].sort((a, b) =>
      compareMigrationBytes(
        JSON.stringify([a.runId, a.sourceTable, a.sourcePhase, a.sourceKey, a.ordinal]),
        JSON.stringify([b.runId, b.sourceTable, b.sourcePhase, b.sourceKey, b.ordinal]),
      ),
    ),
  )
}
export function createTaskRestrictionQuery(meta: MigrationMetaReadPort) {
  return async (input: { operationId: string; taskId: string }): Promise<TaskRestrictionView> => {
    const runs = new Set((await meta.runs(input.operationId)).map((run) => run.runId))
    const restrictions = (await meta.restrictions({ taskId: input.taskId })).filter((row) =>
      runs.has(row.runId),
    )
    return { ...input, restrictions }
  }
}
