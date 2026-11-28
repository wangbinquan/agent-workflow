import { SPACE_KINDS } from '@agent-workflow/shared'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import {
  executionClass,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type { SourceRow, TargetValue } from '@/platform/persistence/migration/conversion/types'

/** RFC-626 §3.6: the row-level block for a decoded task row the converter cannot use. */
export const TASK_ROW_UNUSABLE = 'v2-task-row-unusable'

export interface UnusableTaskValue {
  readonly table: string
  readonly column: string
  readonly value: TargetValue
}

/**
 * A task status the converter classifies. The classification itself is the single definition;
 * anything it refuses is not a status a release wrote.
 */
export function taskExecutionOf(value: TargetValue | undefined): TaskFacts['execution'] | null {
  if (typeof value !== 'string') return null
  try {
    return executionClass(value)
  } catch (error) {
    if (error instanceof ConversionContractError) return null
    throw error
  }
}

function safeInteger(value: TargetValue | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * RFC-626 (task book F1 item 8): a value of a decoded `tasks` or `task_repos` row that the task
 * facts, the mount assignment and the task rule cannot use. The frozen codec accepts these (enum
 * columns carry no value check; integers above 2^53 decode as bigint), and the lookups used to
 * throw on them before any unit ran, ending the whole conversion. The lookups now skip such a
 * row and the validators block it as `v2-task-row-unusable`, both through this one predicate,
 * so a row the lookups dropped can never reach the rule without its facts. A primary key that is
 * not text is a damaged database and still throws where it is read.
 */
export function unusableTaskSourceValue(row: SourceRow): UnusableTaskValue | null {
  const unusable = (column: string): UnusableTaskValue => ({
    table: row.table,
    column,
    value: row.values[column] ?? null,
  })
  if (row.table === 'task_repos')
    return safeInteger(row.values.repo_index) ? null : unusable('repo_index')
  if (row.table !== 'tasks') return null
  if (taskExecutionOf(row.values.status) === null) return unusable('status')
  if (!(SPACE_KINDS as readonly unknown[]).includes(row.values.space_kind))
    return unusable('space_kind')
  if (!safeInteger(row.values.started_at)) return unusable('started_at')
  if (row.values.workflow_version !== null && !safeInteger(row.values.workflow_version))
    return unusable('workflow_version')
  if (!safeInteger(row.values.repo_count)) return unusable('repo_count')
  return null
}

/** Whether the task lookups can derive facts from this row at all. */
export function taskRowUsable(row: SourceRow): boolean {
  return !row.codecFailure && unusableTaskSourceValue(row) === null
}
