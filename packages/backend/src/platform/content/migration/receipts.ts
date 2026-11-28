import {
  columnLookup,
  type LookupKey,
  type LookupResolver,
} from '@/platform/persistence/migration/conversion/lookups'
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
/** RFC-626 §3.4 row 2c: the decision automatic resolution records for content without a provable task. */
export const CONTENT_TASK_UNPROVABLE_KEPT = 'v2-content-task-unprovable-kept'

function taskIdentity(
  row: SourceRow,
  lookup: LookupResolver,
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
  const facts = typeof foreign[1] === 'string' ? lookup(foreign[0]).get(foreign[1]) : undefined
  return { taskId: typeof facts?.task_id === 'string' ? facts.task_id : null, required: true }
}

/**
 * The tasks whose execution needs a content row's bytes: the row's own task when it has one,
 * otherwise every task the frozen resource closure says uses the resource. `unprovable` is a
 * row that must belong to a task the task facts do not know.
 */
export type ContentTaskScope =
  | { readonly provable: false; readonly taskId: string | null }
  | {
      readonly provable: true
      readonly tasks: readonly TaskFacts[]
      readonly uses: readonly { readonly taskId: string; readonly evidence: readonly string[] }[]
    }
export function contentTaskScope(row: SourceRow, lookup: LookupResolver): ContentTaskScope {
  const identity = taskIdentity(row, lookup)
  const known = identity.taskId === null ? undefined : lookup(TASK_FACTS).get(identity.taskId)
  if (identity.required && !known) return { provable: false, taskId: identity.taskId }
  const resource = contentResourceKey(row)
  const uses = (resource === null ? [] : (lookup(CONTENT_RESOURCE_TASKS).get(resource) ?? [])).map(
    ({ taskId, evidence }) => ({ taskId, evidence }),
  )
  const tasks: readonly TaskFacts[] = known
    ? [known]
    : uses.flatMap((use) => {
        const task = lookup(TASK_FACTS).get(use.taskId)
        return task ? [task] : []
      })
  return { provable: true, tasks, uses }
}
/**
 * RFC-626 §3.2.2: the content rules' `settles.tasksOf`. It is the very scope `contentUncertainty`
 * blocks on, so discovery ends exactly the unfinished tasks the conversion would otherwise stop
 * for — one missing shared object can end several of them.
 */
export function contentSettlementTasks(row: SourceRow, lookup: LookupResolver): readonly string[] {
  const scope = contentTaskScope(row, lookup)
  return scope.provable ? scope.tasks.map((task) => task.taskId) : []
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
  const scope = contentTaskScope(row, <V>(key: LookupKey<V>) => ctx.lookup(key))
  if (!scope.provable) {
    if (ctx.resolution !== 'automatic') {
      ctx.out.block({
        ...rowBlock('v2-content-task-unprovable', row, detail, fields),
        taskId: scope.taskId,
      })
      return true
    }
    // RFC-626 §3.4 row 2c: no task can be held back for this content, so the row converts
    // like content no task uses, and the decision says which task could not be proven.
    ctx.out.record(
      {
        kind: 'decision',
        code: CONTENT_TASK_UNPROVABLE_KEPT,
        payload: {
          automatic: 'kept',
          sourceTable: row.table,
          sourceKey: row.encodedKey,
          taskId: scope.taskId,
          code,
          missingFields: fields,
          evidence: detail,
        },
      },
      row,
    )
    return false
  }
  const { tasks, uses } = scope
  const active = tasks.filter((task) => task.execution === 'executable')
  if (active.length) {
    for (const task of active)
      ctx.out.blockExecutable(
        { taskId: task.taskId, status: task.status },
        {
          ...rowBlock(code, row, detail, fields),
          detail: {
            evidence: detail,
            resourceUses: uses.filter((use) => use.taskId === task.taskId),
          },
          taskId: task.taskId,
          runId: typeof row.values.node_run_id === 'string' ? row.values.node_run_id : null,
        },
      )
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
