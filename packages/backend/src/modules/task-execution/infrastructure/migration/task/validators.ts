import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { RowValidator } from '@/platform/persistence/migration/conversion/rule'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'

export const taskWorkspacePreparationValidator: RowValidator = {
  ref: { id: 'task-execution/unsettled-workspace-preparation', version: 3 },
  table: 'task_workspace_preparations',
  lookups: [TASK_FACTS],
  validate(row, ctx) {
    if (!['preparing', 'prepared', 'compensating'].includes(String(row.values.state))) return []
    const taskId =
      typeof row.values.admitted_task_id === 'string' ? row.values.admitted_task_id : null
    const task = taskId === null ? undefined : ctx.lookup(TASK_FACTS).get(taskId)
    if (task && task.execution !== 'executable') {
      const archive = ctx.out.archive({
        kind: 'source-journal',
        sourceTable: row.table,
        format: 'logical-row@1',
        bytes: Buffer.from(canonicalSchemaJson(row.canonical)),
        rows: 1,
      })
      ctx.out.record(
        {
          kind: 'decision',
          code: 'v2-task-workspace-preparation-history',
          payload: { taskId, state: String(row.values.state), execution: task.execution, archive },
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
