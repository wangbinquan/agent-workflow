import { columnLookup } from '@/platform/persistence/migration/conversion/lookups'
import {
  TASK_FACTS,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type {
  SourceRow,
  JsonValue,
  TargetRef,
} from '@/platform/persistence/migration/conversion/types'
import { CONTENT_RESOURCE_TASKS, contentResourceKey } from './resourceClosure'

export const NODE_CONTENT_TASK = columnLookup('node_runs', ['id'], ['task_id']).key
export const REVIEW_CONTENT_TASK = columnLookup('doc_versions', ['id'], ['task_id']).key
export const GATE_CONTENT_TASK = columnLookup(
  'collaboration_gate_operations',
  ['id'],
  ['task_id'],
).key
export const contentTaskLookups = [
  TASK_FACTS,
  NODE_CONTENT_TASK,
  REVIEW_CONTENT_TASK,
  GATE_CONTENT_TASK,
  CONTENT_RESOURCE_TASKS,
]

function taskIdentity(
  row: SourceRow,
  ctx: RuleContext,
): { taskId: string | null; required: boolean } {
  if (typeof row.values.task_id === 'string') return { taskId: row.values.task_id, required: true }
  if (row.table === 'hosted_object_publications' && typeof row.values.scope === 'string')
    return { taskId: row.values.scope, required: true }
  const foreign =
    row.table === 'node_run_outputs'
      ? ([NODE_CONTENT_TASK, row.values.node_run_id] as const)
      : row.table === 'review_comments'
        ? ([REVIEW_CONTENT_TASK, row.values.doc_version_id] as const)
        : row.table === 'collaboration_gate_artifacts'
          ? ([GATE_CONTENT_TASK, row.values.operation_id] as const)
          : null
  if (!foreign) return { taskId: null, required: false }
  const facts = typeof foreign[1] === 'string' ? ctx.lookup(foreign[0]).get(foreign[1]) : undefined
  return { taskId: typeof facts?.task_id === 'string' ? facts.task_id : null, required: true }
}

export function contentUncertainty(input: {
  readonly row: SourceRow
  readonly ctx: RuleContext
  readonly code: string
  readonly fields: readonly string[]
  readonly detail: JsonValue
  readonly targets: readonly TargetRef[]
}): boolean {
  const { row, ctx, code, fields, detail, targets } = input
  const identity = taskIdentity(row, ctx)
  const known = identity.taskId === null ? undefined : ctx.lookup(TASK_FACTS).get(identity.taskId)
  if (identity.required && !known) {
    ctx.out.block({
      ...rowBlock('v2-content-task-unprovable', row, detail, fields),
      taskId: identity.taskId,
    })
    return true
  }
  const resource = contentResourceKey(row)
  const uses = (
    resource === null ? [] : (ctx.lookup(CONTENT_RESOURCE_TASKS).get(resource) ?? [])
  ).map(({ taskId, evidence }) => ({ taskId, evidence }))
  const tasks: readonly TaskFacts[] = known
    ? [known]
    : uses.flatMap((use) => {
        const task = ctx.lookup(TASK_FACTS).get(use.taskId)
        return task ? [task] : []
      })
  const active = tasks.filter((task) => task.execution === 'executable')
  if (active.length) {
    for (const task of active)
      ctx.out.block({
        ...rowBlock(code, row, detail, fields),
        detail: {
          evidence: detail,
          resourceUses: uses.filter((use) => use.taskId === task.taskId),
        },
        taskId: task.taskId,
        runId: typeof row.values.node_run_id === 'string' ? row.values.node_run_id : null,
      })
    return true
  }
  if (!tasks.length)
    ctx.out.record(
      {
        kind: 'decision',
        code,
        payload: {
          sourceKey: row.encodedKey,
          missingFields: fields,
          evidence: detail,
          resourceUses: uses,
        },
      },
      row,
    )
  for (const task of tasks) {
    if (task.execution === 'executable') continue
    ctx.out.exception({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      class: 'converted',
      kind: 'history-only',
      targets,
      archive: null,
      history: {
        taskId: task.taskId,
        runId: typeof row.values.node_run_id === 'string' ? row.values.node_run_id : null,
        execution: task.execution,
        missingFields: fields,
      },
      decision: { code, detail },
    })
  }
  return false
}
