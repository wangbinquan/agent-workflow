import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'
import type {
  ExecutableValidatorBlock,
  RowValidator,
} from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionBlock,
  JsonValue,
  SourceRow,
  TargetValue,
} from '@/platform/persistence/migration/conversion/types'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { TASK_ROW_UNUSABLE, unusableTaskSourceValue } from './usability'

/** RFC-626: the task a preparation journal row was admitted for; it is not in a `task_id` column. */
export function preparationTasks(row: SourceRow): readonly string[] {
  return typeof row.values.admitted_task_id === 'string' && row.values.admitted_task_id.length > 0
    ? [row.values.admitted_task_id]
    : []
}

export const taskWorkspacePreparationValidator: RowValidator = {
  ref: { id: 'task-execution/unsettled-workspace-preparation', version: 4 },
  table: 'task_workspace_preparations',
  lookups: [TASK_FACTS],
  settles: { tasksOf: preparationTasks },
  validate(row, ctx) {
    if (!['preparing', 'prepared', 'compensating'].includes(String(row.values.state))) return []
    const taskId =
      typeof row.values.admitted_task_id === 'string' ? row.values.admitted_task_id : null
    const task = taskId === null ? undefined : ctx.lookup(TASK_FACTS).get(taskId)
    // RFC-626 §3.4 row 18: with automatic resolution an in-flight preparation that never got
    // as far as naming a Task takes the "no Task" path below; nothing can continue it.
    const unbound = taskId === null && ctx.resolution === 'automatic'
    // Admission binds admitted_task_id in the transaction that inserts the Task, so a bound
    // preparation without its Task was left behind by a later Task delete, not in flight.
    if (unbound || (taskId !== null && (task === undefined || task.execution !== 'executable'))) {
      const archive = ctx.out.archive({
        kind: 'source-journal',
        sourceTable: row.table,
        format: 'logical-row@1',
        bytes: Buffer.from(canonicalSchemaJson(row.canonical)),
        rows: 1,
      })
      const state = String(row.values.state)
      ctx.out.record(
        task === undefined
          ? {
              kind: 'decision',
              code: 'v2-task-workspace-preparation-orphan',
              payload: unbound
                ? {
                    automatic: 'kept',
                    sourceTable: row.table,
                    sourceKey: row.encodedKey,
                    taskId,
                    state,
                    archive,
                  }
                : { taskId, state, archive },
            }
          : {
              kind: 'decision',
              code: 'v2-task-workspace-preparation-history',
              payload: { taskId, state, execution: task.execution, archive },
            },
        row,
      )
      return []
    }
    const block: ConversionBlock = {
      ...rowBlock(
        'v2-task-workspace-preparation-in-flight',
        row,
        { state: String(row.values.state) },
        ['state'],
      ),
      taskId: typeof row.values.admitted_task_id === 'string' ? row.values.admitted_task_id : null,
    }
    // RFC-626 §3.2.1: the preparation points at a Task that could continue; ending that Task is
    // the automatic resolution. Operator resolution blocks exactly as before.
    if (task !== undefined)
      return [
        {
          executable: { taskId: task.taskId, status: task.status },
          block,
        } satisfies ExecutableValidatorBlock,
      ]
    return [block]
  },
}

export const hostedWorkspaceCommandValidator: RowValidator = {
  ref: { id: 'task-execution/unsettled-hosted-workspace-command', version: 1 },
  table: 'hosted_workspace_commands',
  validate(row) {
    if (!['submitting', 'running'].includes(String(row.values.state))) return []
    // RFC-626 §3.4 row 18: with automatic resolution this row-level block sets the row aside.
    return [
      rowBlock(
        'v2-task-hosted-workspace-command-in-flight',
        row,
        { state: String(row.values.state) },
        ['state'],
      ),
    ]
  },
}

/** Block detail for a value the frozen codec accepted; a non-finite number has no canonical form. */
function reportedValue(value: TargetValue): JsonValue {
  return typeof value === 'number' && !Number.isFinite(value)
    ? { type: 'real', value: String(value) }
    : (canonicalValue(value) as unknown as JsonValue)
}

/**
 * RFC-626 (task book F1 item 8): a decoded task or task repository row whose values the task
 * lookups cannot use. The lookups skip it through the same predicate; blocking it here keeps the
 * whole task group out of the conversion instead of the lookups ending it (with automatic
 * resolution the row is set aside, with operator resolution it is a row block).
 */
function createUnusableTaskRowValidator(table: 'tasks' | 'task_repos', id: string): RowValidator {
  return {
    ref: { id, version: 1 },
    table,
    validate(row) {
      const unusable = unusableTaskSourceValue(row)
      if (!unusable) return []
      return [
        rowBlock(
          TASK_ROW_UNUSABLE,
          row,
          {
            table: unusable.table,
            column: unusable.column,
            value: reportedValue(unusable.value),
          },
          [unusable.column],
        ),
      ]
    },
  }
}

export const unusableTaskRowValidator = createUnusableTaskRowValidator(
  'tasks',
  'task-execution/unusable-task-row',
)
export const unusableTaskRepoRowValidator = createUnusableTaskRowValidator(
  'task_repos',
  'task-execution/unusable-task-repo-row',
)
