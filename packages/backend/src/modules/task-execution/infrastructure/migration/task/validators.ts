import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { RowValidator } from '@/platform/persistence/migration/conversion/rule'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'

export const taskWorkspacePreparationValidator: RowValidator = {
  ref: { id: 'task-execution/unsettled-workspace-preparation', version: 4 },
  table: 'task_workspace_preparations',
  lookups: [TASK_FACTS],
  validate(row, ctx) {
    if (!['preparing', 'prepared', 'compensating'].includes(String(row.values.state))) return []
    const taskId =
      typeof row.values.admitted_task_id === 'string' ? row.values.admitted_task_id : null
    const task = taskId === null ? undefined : ctx.lookup(TASK_FACTS).get(taskId)
    // Admission binds admitted_task_id in the transaction that inserts the Task, so a bound
    // preparation without its Task was left behind by a later Task delete, not in flight.
    if (taskId !== null && (task === undefined || task.execution !== 'executable')) {
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
              payload: { taskId, state, archive },
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
    return [
      {
        ...rowBlock(
          'v2-task-workspace-preparation-in-flight',
          row,
          { state: String(row.values.state) },
          ['state'],
        ),
        taskId:
          typeof row.values.admitted_task_id === 'string' ? row.values.admitted_task_id : null,
      },
    ]
  },
}

export const hostedWorkspaceCommandValidator: RowValidator = {
  ref: { id: 'task-execution/unsettled-hosted-workspace-command', version: 1 },
  table: 'hosted_workspace_commands',
  validate(row) {
    if (!['submitting', 'running'].includes(String(row.values.state))) return []
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
