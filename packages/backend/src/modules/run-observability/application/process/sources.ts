// RFC-616 §5 — the four channels process metrics read, and the loaders that
// turn their rows into per-task bundles.
//
// Every fact port takes at most 500 ids; `chunked` splits and yields to the
// event loop between chunks, because the daemon's SQLite connection is
// synchronous and a long read would otherwise stall every other request.

import type {
  ProcessOperationAction,
  ProcessOperationSubjectKind,
  ProcessTextSource,
} from '@agent-workflow/shared'
import {
  PROCESS_FACT_ID_BATCH,
  type ProcessDescendantRow,
  type ProcessEmployeeFacts,
  type ProcessExecutionRow,
  type ProcessGateFacts,
  type ProcessNodeRunRow,
  type ProcessSubjectEvents,
  type ProcessTaskFacts,
  type ProcessTaskGateRoundRow,
  type ProcessViewer,
  type ProcessWorkgroupFacts,
  type ProcessWrapperRow,
} from '@/platform/contracts/processFacts'
import type { CallStore, NodeRunUsage, SystemCallSlice } from '../ports/callStore'
import {
  NO_USAGE,
  type ProcessOperation,
  type ProcessUsageTotals,
} from '../../domain/process/model'
import type { ProcessIdentityDirectory, ProcessWorkflowNames } from './ports/directories'
import type { OperationStore } from './ports/operationStore'

export interface ProcessSources {
  readonly tasks: ProcessTaskFacts
  readonly workgroups: ProcessWorkgroupFacts
  readonly gates: ProcessGateFacts
  readonly employees: ProcessEmployeeFacts
  readonly events: ProcessSubjectEvents
  readonly calls: CallStore
  readonly operations: OperationStore
  readonly identities: ProcessIdentityDirectory
  readonly workflowNames: ProcessWorkflowNames
}

export type { ProcessViewer }

/** `list`: cheap facts for one row per subject. `full`: everything a subject page shows. */
export type ProcessDepth = 'list' | 'full'

/** The system kind follow-up question generation records its calls under. */
export const CLARIFY_FOLLOWUP_KIND = 'clarify-followup'

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Run `read` over the ids in batches of 500 and concatenate the results. */
export async function chunked<T>(
  ids: readonly string[],
  read: (chunk: readonly string[]) => Promise<readonly T[]>,
): Promise<T[]> {
  const unique = [...new Set(ids)]
  const result: T[] = []
  for (let index = 0; index < unique.length; index += PROCESS_FACT_ID_BATCH) {
    if (index > 0) await yieldToEventLoop()
    result.push(...(await read(unique.slice(index, index + PROCESS_FACT_ID_BATCH))))
  }
  return result
}

/** Current names of workflows, read in batches; a deleted workflow has no entry. */
export async function workflowNamesOf(
  sources: Pick<ProcessSources, 'workflowNames'>,
  workflowIds: Iterable<string | null>,
): Promise<Map<string, string>> {
  const ids = [...workflowIds].filter((id): id is string => id !== null)
  return new Map(
    await chunked(ids, async (chunk) => [...(await sources.workflowNames.names(chunk))]),
  )
}

export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const list = grouped.get(id)
    if (list) list.push(row)
    else grouped.set(id, [row])
  }
  return grouped
}

export function usageTotalsOf(rows: readonly NodeRunUsage[]): ProcessUsageTotals {
  let totals = NO_USAGE
  for (const row of rows) {
    totals = {
      calls: totals.calls + row.calls,
      tokens: totals.tokens + row.tokens,
      costNano: totals.costNano + row.costNano,
      incompleteCalls: totals.incompleteCalls + row.incompleteCalls,
      unpricedCalls: totals.unpricedCalls + row.unpricedCalls,
    }
  }
  return totals
}

export function addUsage(a: ProcessUsageTotals, b: ProcessUsageTotals): ProcessUsageTotals {
  return {
    calls: a.calls + b.calls,
    tokens: a.tokens + b.tokens,
    costNano: a.costNano + b.costNano,
    incompleteCalls: a.incompleteCalls + b.incompleteCalls,
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  }
}

/** Facts of a set of tasks, keyed by task. */
export interface TaskBundle {
  /** Descendants of each queried task (through call nodes, any depth). */
  readonly descendants: ReadonlyMap<string, readonly ProcessDescendantRow[]>
  /** `list` depth: grouped executions of the queried tasks. */
  readonly executions: ReadonlyMap<string, readonly ProcessExecutionRow[]>
  /** `full` depth: node runs of the queried tasks. */
  readonly nodeRuns: ReadonlyMap<string, readonly ProcessNodeRunRow[]>
  /** Both depths: the rows on wrapper slots of the queried tasks. */
  readonly wrappers: ReadonlyMap<string, readonly ProcessWrapperRow[]>
  /** Gate rounds of the queried tasks and of their descendants. */
  readonly gates: ReadonlyMap<string, readonly ProcessTaskGateRoundRow[]>
  /** `full` depth: calls of the queried tasks and of their descendants, by node run. */
  readonly usage: ReadonlyMap<string, readonly NodeRunUsage[]>
  /** Both depths: call totals per task. */
  readonly usageTotals: ReadonlyMap<string, ProcessUsageTotals>
  /** `full` depth: follow-up generation calls of the queried tasks. */
  readonly followups: ReadonlyMap<string, readonly SystemCallSlice[]>
  /** Operations recorded against the tasks, and (`full` depth) against their gate node runs. */
  readonly taskOperations: ReadonlyMap<string, readonly ProcessOperation[]>
  readonly runOperations: ReadonlyMap<string, readonly ProcessOperation[]>
}

const TASK_ACTIONS: readonly ProcessOperationAction[] = [
  'task.cancel',
  'task.resume',
  'task.retry-node',
  'task.repair',
  'task.sync-workflow',
  'workgroup.message',
  'workgroup.deliver',
  'workgroup.confirm',
  'workgroup.plan-confirm',
  'workgroup.cancel-assignment',
  'workgroup.config',
]

/** The views that say when a person first opened a gate. */
const GATE_VIEW_ACTIONS: readonly ProcessOperationAction[] = ['review.view', 'clarify.view']

export async function loadOperations(
  store: OperationStore,
  subjectKind: ProcessOperationSubjectKind,
  ids: readonly string[],
  actions?: readonly ProcessOperationAction[],
): Promise<Map<string, ProcessOperation[]>> {
  const rows = await chunked(ids, (chunk) => store.bySubjects(subjectKind, chunk, actions))
  return groupBy(rows, (row) => row.subjectId)
}

/**
 * Load everything known about the tasks. `withNodeRuns: false` skips node runs
 * and wrappers at every depth (digital-employee host tasks are measured by
 * round, not by node run).
 */
export async function loadTaskBundle(
  sources: ProcessSources,
  taskIds: readonly string[],
  depth: ProcessDepth,
  options: { readonly withNodeRuns?: boolean } = {},
): Promise<TaskBundle> {
  const withNodeRuns = options.withNodeRuns ?? true
  const descendantRows = await chunked(taskIds, (chunk) => sources.tasks.descendants(chunk))
  const allTaskIds = [...new Set([...taskIds, ...descendantRows.map((row) => row.taskId)])]
  const full = depth === 'full'

  const [executions, nodeRuns, wrappers] = await Promise.all([
    !full && withNodeRuns
      ? chunked(taskIds, (chunk) => sources.tasks.executions(chunk))
      : Promise.resolve([]),
    full && withNodeRuns
      ? chunked(taskIds, (chunk) => sources.tasks.nodeRuns(chunk))
      : Promise.resolve([]),
    // Both depths: what a run inside a wrapper is depends on why the wrapper was invoked.
    // The listing needs why each was minted and how it ended, not its rounds and shards.
    withNodeRuns
      ? chunked(taskIds, (chunk) => sources.tasks.wrappers(chunk, { counts: full }))
      : Promise.resolve([]),
  ])
  const gates = await chunked(allTaskIds, (chunk) =>
    sources.gates.rounds(chunk, { measures: full }),
  )

  const usage = new Map<string, NodeRunUsage[]>()
  const usageTotals = new Map<string, ProcessUsageTotals>()
  if (full) {
    const rows = await chunked(allTaskIds, (chunk) => sources.calls.usageByNodeRun(chunk))
    for (const [taskId, taskRows] of groupBy(rows, (row) => row.taskId)) {
      usage.set(taskId, taskRows)
      usageTotals.set(taskId, usageTotalsOf(taskRows))
    }
  } else {
    const rows = await chunked(allTaskIds, (chunk) =>
      sources.calls.aggregate({ scope: { kind: 'tasks', taskIds: chunk } }, 'task'),
    )
    for (const row of rows) {
      if (row.key === null) continue
      usageTotals.set(row.key, {
        calls: row.calls,
        tokens: row.input + row.cacheRead + row.cacheWrite + row.output,
        costNano: row.costNano,
        incompleteCalls: row.incompleteCalls,
        unpricedCalls: row.unpricedCalls,
      })
    }
  }

  const followups = full
    ? groupBy(
        await chunked(taskIds, (chunk) => sources.calls.systemCalls(chunk, CLARIFY_FOLLOWUP_KIND)),
        (row) => row.taskId,
      )
    : new Map<string, SystemCallSlice[]>()

  const taskOperations = await loadOperations(sources.operations, 'task', taskIds, TASK_ACTIONS)
  const runOperations = full
    ? await loadOperations(
        sources.operations,
        'node-run',
        gates.map((gate) => gate.gateNodeRunId),
        GATE_VIEW_ACTIONS,
      )
    : new Map<string, ProcessOperation[]>()

  return {
    descendants: groupBy(descendantRows, (row) => row.unitTaskId),
    executions: groupBy(executions, (row) => row.taskId),
    nodeRuns: groupBy(nodeRuns, (row) => row.taskId),
    wrappers: groupBy(wrappers, (row) => row.taskId),
    gates: groupBy(gates, (row) => row.taskId),
    usage,
    usageTotals,
    followups,
    taskOperations,
    runOperations,
  }
}

/** One piece of text with the unit and stage it belongs to resolved. */
export interface ResolvedText {
  readonly source: ProcessTextSource
  readonly unitId: string
  readonly stageKey: string | null
  readonly at: number
  readonly text: string
}
