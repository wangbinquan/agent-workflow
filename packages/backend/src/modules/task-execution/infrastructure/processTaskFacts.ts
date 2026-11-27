// RFC-616 §5.1 — task facts offered to process metrics through the neutral
// platform contract (`platform/contracts/processFacts.ts`). Task execution owns
// tasks and node runs; process metrics never read these tables.
//
// Nothing here classifies: rows keep their raw rerun cause, status and
// timestamps, and the engine decides what counts as an execution (design §4.1).

import {
  SETTINGS_NUMERIC_BOUNDS,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type ProcessOrigin,
  type TaskStatus,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import {
  PROCESS_FACT_ID_BATCH,
  type ProcessDescendantRow,
  type ProcessExecutionRow,
  type ProcessNodeRunRow,
  type ProcessTaskFacts,
  type ProcessTaskSummaryRow,
  type ProcessTaskUnitRow,
  type ProcessViewer,
  type ProcessWrapperRow,
} from '@/platform/contracts/processFacts'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { chunkedAll } from '@/platform/persistence/sqlChunk'
import { callHumanWaitMs, decodeCallHumanWait } from '../domain/resourceLimitUsage'
import type { TaskWorkgroupLaunchConfig } from '../domain/taskWorkgroupConfig'
import { taskVisibilityCondition } from './taskAuthorization'
import { taskWorkgroupLaunchSelection } from './taskWorkgroupConfig'

/**
 * How far a call chain is followed. A call node cannot nest deeper than the
 * upper bound of the `maxInvocationDepth` setting, so every real descendant is
 * found; the bound only keeps a corrupt parent chain from looping.
 */
const MAX_DESCENDANT_LEVELS = SETTINGS_NUMERIC_BOUNDS.maxInvocationDepth.max

/**
 * The contract's rule for every id list, shared by both fact providers: at most
 * PROCESS_FACT_ID_BATCH ids per call (callers chunk), each id read once.
 */
export function processFactIds(ids: readonly string[]): string[] {
  if (ids.length > PROCESS_FACT_ID_BATCH)
    throw new RangeError(`process fact id batch exceeds ${PROCESS_FACT_ID_BATCH}`)
  return [...new Set(ids)]
}

const tally = (condition: SQL) =>
  sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`.mapWith(Number)

/**
 * Rows that are not a wrapper invocation. A history row whose identity the
 * upgrade could not prove is stored without a role; it is read as a leaf run,
 * or the executions of old tasks would vanish from the facts.
 */
function leafRun(db: object): SQL | undefined {
  const { nodeRuns } = tablesOf(db)
  return or(isNull(nodeRuns.role), ne(nodeRuns.role, 'container'))
}

interface TaskClock {
  readonly status: TaskStatus
  readonly runningMs: number
  readonly runningSince: number | null
}

/**
 * The effective running time of `readTaskResourceUsage` (application/
 * taskResourceUsage.ts), for a task whose call-node human wait is already
 * summed: time accumulated in status `running`, plus the open running stretch,
 * minus the time call nodes waited for people inside child tasks.
 */
function effectiveRunningMs(task: TaskClock, humanWaitMs: number, now: number): number | null {
  const runningMs = Number(task.runningMs)
  const ended = task.status === 'done' || task.status === 'failed' || task.status === 'canceled'
  // An ended task that never accumulated running time was not measured: it
  // predates the running clock or never reached `running`. Zero would read as "instant".
  if (ended && runningMs === 0) return null
  const elapsed =
    runningMs + (task.runningSince === null ? 0 : Math.max(0, now - Number(task.runningSince)))
  return Math.max(0, elapsed - humanWaitMs)
}

interface UnitSource extends TaskClock {
  readonly taskId: string
  readonly name: string
  readonly errorSummary: string | null
  readonly ownerUserId: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly parentTaskId: string | null
  readonly subjectKind: string
  readonly subjectId: string | null
  readonly subjectRevision: number | null
  readonly engineKind: string
  readonly launch: TaskWorkgroupLaunchConfig | null
  readonly launchOrigin: ProcessOrigin | null
  readonly employeeRoundId: string | null
  readonly employeeCaseId: string | null
}

// Built per query: schema columns are provider projections and must not be captured at load time.
function unitFields(db: object) {
  const { tasks, taskDefinitions, taskLaunchContexts } = tablesOf(db)
  return {
    taskId: tasks.id,
    name: tasks.name,
    status: tasks.status,
    errorSummary: tasks.errorSummary,
    ownerUserId: tasks.ownerUserId,
    startedAt: tasks.startedAt,
    finishedAt: tasks.finishedAt,
    runningMs: tasks.runningMs,
    runningSince: tasks.runningSince,
    parentTaskId: tasks.parentTaskId,
    subjectKind: taskDefinitions.subjectKind,
    subjectId: taskDefinitions.sourceId,
    subjectRevision: taskDefinitions.sourceRevision,
    engineKind: taskDefinitions.engineKind,
    launch: taskWorkgroupLaunchSelection(db),
    launchOrigin: taskLaunchContexts.launchOrigin,
    employeeRoundId: taskLaunchContexts.digitalEmployeeRoundId,
    employeeCaseId: taskLaunchContexts.digitalEmployeeCaseId,
  }
}

/**
 * Where a unit came from. A digital employee's host task and a called task both
 * carry a launch origin too (a child inherits its parent's), so the derived
 * origins are decided first. A task without a launch context was started by hand.
 */
function originOf(row: UnitSource): ProcessOrigin {
  if (row.employeeRoundId !== null || row.employeeCaseId !== null) return 'digital-employee'
  if (row.parentTaskId !== null) return 'subtask'
  return row.launchOrigin ?? 'manual'
}

function unitRow(row: UnitSource, humanWaitMs: number, now: number): ProcessTaskUnitRow {
  return {
    taskId: row.taskId,
    name: row.name,
    subjectId: row.subjectId,
    // The launch document is read like the task list reads it: field by field,
    // so one corrupt document cannot fail a whole window of units.
    subjectName: row.subjectKind === 'workgroup' ? (row.launch?.workgroupName ?? null) : null,
    subjectRevision: row.subjectRevision === null ? null : Number(row.subjectRevision),
    engineKind: row.engineKind,
    status: row.status,
    errorSummary: row.errorSummary,
    origin: originOf(row),
    ownerUserId: row.ownerUserId,
    startedAt: Number(row.startedAt),
    finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
    autoMs: effectiveRunningMs(row, humanWaitMs, now),
  }
}

/**
 * Mint order within each task. Rows are sorted here, on the values read: ranking
 * node runs in SQL is reserved to the owner query (the run-selection boundary).
 */
function inMintOrder<T extends { readonly taskId: string; readonly seq: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.seq - b.seq))
}

/** Same reading as the engine's own: schema first, then the upgrade to the current version. */
function decodeDefinition(snapshot: string | undefined): WorkflowDefinition | null {
  if (snapshot === undefined || snapshot.length === 0) return null
  try {
    const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(snapshot))
    return parsed.success ? migrateWorkflowDefinitionToLatest(parsed.data) : null
  } catch {
    return null
  }
}

/** A descendant's place in one unit: the unit and the call node the branch started from. */
interface DescendantBranch {
  readonly unitTaskId: string
  readonly callNodeId: string | null
  readonly callNodeRunId: string | null
}

/**
 * `clock` exists for the open running stretch and open human-wait ledgers,
 * which are measured against the present.
 */
export function createProcessTaskFacts(
  db: PersistenceDb,
  clock: () => number = Date.now,
): ProcessTaskFacts {
  const visible = (viewer: ProcessViewer) =>
    taskVisibilityCondition(db, { userId: viewer.userId, canReadAllTasks: viewer.canReadAll })

  /**
   * The human-wait ledgers of the tasks' call nodes, summed per task. One
   * query per 500 tasks instead of one per task: a subject summary reads
   * thousands of units.
   */
  async function humanWaitByTask(
    taskIds: readonly string[],
    now: number,
  ): Promise<Map<string, number>> {
    const rows = await chunkedAll(taskIds, (chunk) => {
      const { nodeRuns, nodeRunRuntimeStates } = tablesOf(db)
      return db
        .select({ taskId: nodeRuns.taskId, ledger: nodeRunRuntimeStates.wrapperProgressJson })
        .from(nodeRuns)
        .innerJoin(nodeRunRuntimeStates, eq(nodeRunRuntimeStates.nodeRunId, nodeRuns.id))
        .where(
          and(
            inArray(nodeRuns.taskId, chunk),
            isNotNull(nodeRuns.childTaskId),
            isNotNull(nodeRunRuntimeStates.wrapperProgressJson),
          ),
        )
    })
    const waits = new Map<string, number>()
    for (const row of rows)
      waits.set(
        row.taskId,
        (waits.get(row.taskId) ?? 0) + callHumanWaitMs(decodeCallHumanWait(row.ledger), now),
      )
    return waits
  }

  async function unitRows(rows: readonly UnitSource[]): Promise<ProcessTaskUnitRow[]> {
    if (!rows.length) return []
    const now = clock()
    const waits = await humanWaitByTask(
      rows.map((row) => row.taskId),
      now,
    )
    return rows.map((row) => unitRow(row, waits.get(row.taskId) ?? 0, now))
  }

  /** Direct children of the tasks, each with the parent's call node run that launched it. */
  async function calledTasks(parentTaskIds: readonly string[]) {
    const children = await chunkedAll(parentTaskIds, (chunk) => {
      const { tasks, taskLaunchContexts, nodeRuns } = tablesOf(db)
      return db
        .select({
          taskId: tasks.id,
          parentTaskId: tasks.parentTaskId,
          callNodeId: nodeRuns.nodeId,
          callNodeRunId: nodeRuns.id,
        })
        .from(tasks)
        .leftJoin(taskLaunchContexts, eq(taskLaunchContexts.taskId, tasks.id))
        .leftJoin(
          nodeRuns,
          and(
            eq(nodeRuns.id, taskLaunchContexts.parentNodeRunId),
            // A reference to a run of some other task says nothing about this parent's nodes.
            eq(nodeRuns.taskId, tasks.parentTaskId),
          ),
        )
        .where(and(inArray(tasks.parentTaskId, chunk), isNull(tasks.deletedAt)))
        .orderBy(asc(tasks.startedAt), asc(tasks.id))
    })
    // A child whose launch context names no run of the parent is still bound
    // from the other side: the parent's call run records the task it started.
    const unbound = children.filter((child) => child.callNodeRunId === null)
    if (!unbound.length) return children
    const bindings = await chunkedAll(
      unbound.map((child) => child.taskId),
      (chunk) => {
        const { nodeRuns } = tablesOf(db)
        return db
          .select({
            childTaskId: nodeRuns.childTaskId,
            taskId: nodeRuns.taskId,
            callNodeId: nodeRuns.nodeId,
            callNodeRunId: nodeRuns.id,
            seq: nodeRuns.seq,
          })
          .from(nodeRuns)
          .where(inArray(nodeRuns.childTaskId, chunk))
      },
    )
    // The run that recorded the child first is the one that started it.
    const firstBinding = new Map<string, (typeof bindings)[number]>()
    for (const binding of bindings) {
      // Keyed by parent too: only a run of the child's own parent may place it.
      const key = `${binding.taskId}\u0000${binding.childTaskId}`
      const known = firstBinding.get(key)
      if (known === undefined || Number(binding.seq) < Number(known.seq))
        firstBinding.set(key, binding)
    }
    return children.map((child) => {
      const binding = firstBinding.get(`${child.parentTaskId}\u0000${child.taskId}`)
      return binding === undefined || child.callNodeRunId !== null
        ? child
        : { ...child, callNodeId: binding.callNodeId, callNodeRunId: binding.callNodeRunId }
    })
  }

  return {
    async units(viewer, query) {
      const { tasks, taskDefinitions, taskLaunchContexts } = tablesOf(db)
      // Neither `catalog_visibility` nor `parent_task_id` narrows the result:
      // internal host tasks and called tasks are runs of the subject like any other.
      const rows = await db
        .select(unitFields(db))
        .from(tasks)
        .innerJoin(taskDefinitions, eq(taskDefinitions.taskId, tasks.id))
        .leftJoin(taskLaunchContexts, eq(taskLaunchContexts.taskId, tasks.id))
        .where(
          and(
            eq(taskDefinitions.subjectKind, query.kind),
            query.subjectId === undefined
              ? undefined
              : query.subjectId === null
                ? isNull(taskDefinitions.sourceId)
                : eq(taskDefinitions.sourceId, query.subjectId),
            gte(tasks.startedAt, query.from),
            lt(tasks.startedAt, query.to),
            isNull(tasks.deletedAt),
            visible(viewer),
          ),
        )
        .orderBy(desc(tasks.startedAt), desc(tasks.id))
        .limit(query.limit)
      return await unitRows(rows)
    },

    async unit(viewer, taskId) {
      const { tasks, taskDefinitions, taskLaunchContexts } = tablesOf(db)
      const rows = await db
        .select(unitFields(db))
        .from(tasks)
        .innerJoin(taskDefinitions, eq(taskDefinitions.taskId, tasks.id))
        .leftJoin(taskLaunchContexts, eq(taskLaunchContexts.taskId, tasks.id))
        .where(
          and(
            eq(tasks.id, taskId),
            inArray(taskDefinitions.subjectKind, ['workflow', 'workgroup']),
            isNull(tasks.deletedAt),
            visible(viewer),
          ),
        )
        .limit(1)
      return (await unitRows(rows))[0] ?? null
    },

    async taskSummaries(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const { tasks } = tablesOf(db)
      const rows = await db
        .select({
          taskId: tasks.id,
          status: tasks.status,
          errorSummary: tasks.errorSummary,
          startedAt: tasks.startedAt,
          finishedAt: tasks.finishedAt,
          runningMs: tasks.runningMs,
          runningSince: tasks.runningSince,
        })
        .from(tasks)
        .where(and(inArray(tasks.id, ids), isNull(tasks.deletedAt)))
      if (!rows.length) return []
      const now = clock()
      const waits = await humanWaitByTask(
        rows.map((row) => row.taskId),
        now,
      )
      return rows.map(
        (row): ProcessTaskSummaryRow => ({
          taskId: row.taskId,
          status: row.status,
          errorSummary: row.errorSummary,
          startedAt: Number(row.startedAt),
          finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
          autoMs: effectiveRunningMs(row, waits.get(row.taskId) ?? 0, now),
        }),
      )
    },

    async descendants(taskIds) {
      const units = processFactIds(taskIds)
      if (!units.length) return []
      const found: ProcessDescendantRow[] = []
      const placed = new Set<string>()
      /** Record the task under the branch; false when that pair is already known. */
      const place = (taskId: string, branch: DescendantBranch): boolean => {
        const key = `${branch.unitTaskId}\u0000${taskId}`
        if (taskId === branch.unitTaskId || placed.has(key)) return false
        placed.add(key)
        found.push({ ...branch, taskId })
        return true
      }
      // A queried unit may itself be called by another queried unit, so a task
      // can sit on several branches at once: the frontier keeps all of them.
      let frontier = new Map<string, DescendantBranch[]>()
      const reach = (
        next: Map<string, DescendantBranch[]>,
        taskId: string,
        branch: DescendantBranch,
      ) => {
        if (!place(taskId, branch)) return
        const branches = next.get(taskId)
        if (branches) branches.push(branch)
        else next.set(taskId, [branch])
      }
      for (const child of await calledTasks(units)) {
        if (child.parentTaskId === null) continue
        reach(frontier, child.taskId, {
          unitTaskId: child.parentTaskId,
          callNodeId: child.callNodeId,
          callNodeRunId: child.callNodeRunId,
        })
      }
      for (let level = 1; level < MAX_DESCENDANT_LEVELS && frontier.size > 0; level++) {
        const parents = frontier
        const next = new Map<string, DescendantBranch[]>()
        const children = await chunkedAll([...parents.keys()], (chunk) => {
          const { tasks } = tablesOf(db)
          return db
            .select({ taskId: tasks.id, parentTaskId: tasks.parentTaskId })
            .from(tasks)
            .where(and(inArray(tasks.parentTaskId, chunk), isNull(tasks.deletedAt)))
            .orderBy(asc(tasks.startedAt), asc(tasks.id))
        })
        // Below the first level a task belongs to the call node its top-level ancestor hangs under.
        for (const child of children)
          for (const branch of parents.get(child.parentTaskId ?? '') ?? [])
            reach(next, child.taskId, branch)
        frontier = next
      }
      return found
    },

    async executions(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select({
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          rerunCause: nodeRuns.rerunCause,
          containerRunId: nodeRuns.containerRunId,
          wgRound: nodeRuns.wgRound,
          runs: count(),
          endedRuns: tally(
            sql`${nodeRuns.startedAt} is not null and ${nodeRuns.finishedAt} is not null`,
          ),
          failedRuns: tally(sql`${nodeRuns.status} = 'failed'`),
          interruptedRuns: tally(sql`${nodeRuns.status} = 'interrupted'`),
          // A row minted already finished (a manual retry's placeholder) is
          // stamped with a finish time taken before its start time, so each
          // row contributes at least zero.
          activeMs:
            sql<number>`coalesce(sum(case when ${nodeRuns.finishedAt} > ${nodeRuns.startedAt} then ${nodeRuns.finishedAt} - ${nodeRuns.startedAt} else 0 end), 0)`.mapWith(
              Number,
            ),
        })
        .from(nodeRuns)
        .where(and(inArray(nodeRuns.taskId, ids), leafRun(db)))
        .groupBy(
          nodeRuns.taskId,
          nodeRuns.nodeId,
          nodeRuns.rerunCause,
          nodeRuns.containerRunId,
          nodeRuns.wgRound,
        )
      return rows.map(
        (row): ProcessExecutionRow => ({
          ...row,
          wgRound: row.wgRound === null ? null : Number(row.wgRound),
        }),
      )
    },

    async wrappers(taskIds, options) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const counts = options?.counts ?? true
      const { nodeRuns } = tablesOf(db)
      const invocations = await db
        .select({
          taskId: nodeRuns.taskId,
          runId: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          rerunCause: nodeRuns.rerunCause,
          containerRunId: nodeRuns.containerRunId,
          iteration: nodeRuns.iteration,
          seq: nodeRuns.seq,
          status: nodeRuns.status,
          startedAt: nodeRuns.startedAt,
          finishedAt: nodeRuns.finishedAt,
        })
        .from(nodeRuns)
        .where(and(inArray(nodeRuns.taskId, ids), eq(nodeRuns.role, 'container')))
      if (!invocations.length) return []
      // Rounds and shards mean reading every row inside a wrapper: only for a caller that shows them.
      const inner = counts
        ? await db
            .select({
              containerRunId: nodeRuns.containerRunId,
              lastIteration: max(nodeRuns.iteration),
              shards: countDistinct(nodeRuns.shardKey),
            })
            .from(nodeRuns)
            .where(and(inArray(nodeRuns.taskId, ids), isNotNull(nodeRuns.containerRunId)))
            .groupBy(nodeRuns.containerRunId)
        : []
      const insideOf = new Map(inner.map((row) => [row.containerRunId, row]))
      return inMintOrder(
        invocations.map((row): ProcessWrapperRow => {
          const inside = insideOf.get(row.runId)
          const lastIteration = inside?.lastIteration ?? null
          return {
            ...row,
            iteration: Number(row.iteration),
            seq: Number(row.seq),
            startedAt: row.startedAt === null ? null : Number(row.startedAt),
            finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
            rounds: lastIteration === null ? 0 : Number(lastIteration) + 1,
            shards: Number(inside?.shards ?? 0),
          }
        }),
      )
    },

    async nodeRuns(taskIds, filter) {
      const ids = processFactIds(taskIds)
      // A run filter by node id, not wrapper membership (which only the scope index reads).
      const { nodeIds: only } = filter ?? {}
      const nodeIds = only === undefined ? undefined : processFactIds(only)
      if (!ids.length || nodeIds?.length === 0) return []
      const { nodeRuns, nodeRunConfigs } = tablesOf(db)
      const rows = await db
        .select({
          taskId: nodeRuns.taskId,
          nodeRunId: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          rerunCause: nodeRuns.rerunCause,
          containerRunId: nodeRuns.containerRunId,
          wgRound: nodeRuns.wgRound,
          shardKey: nodeRuns.shardKey,
          agentOverrideId: nodeRunConfigs.agentOverrideId,
          status: nodeRuns.status,
          failureCode: nodeRuns.failureCode,
          startedAt: nodeRuns.startedAt,
          finishedAt: nodeRuns.finishedAt,
          seq: nodeRuns.seq,
        })
        .from(nodeRuns)
        // Only runs with a recorded configuration have a config row.
        .leftJoin(nodeRunConfigs, eq(nodeRunConfigs.nodeRunId, nodeRuns.id))
        .where(
          and(
            inArray(nodeRuns.taskId, ids),
            nodeIds === undefined ? undefined : inArray(nodeRuns.nodeId, nodeIds),
            leafRun(db),
          ),
        )
      return inMintOrder(
        rows.map(
          (row): ProcessNodeRunRow => ({
            ...row,
            wgRound: row.wgRound === null ? null : Number(row.wgRound),
            startedAt: row.startedAt === null ? null : Number(row.startedAt),
            finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
            seq: Number(row.seq),
          }),
        ),
      )
    },

    async definition(taskId) {
      const { taskDefinitions } = tablesOf(db)
      const rows = await db
        .select({ snapshot: taskDefinitions.workflowSnapshot })
        .from(taskDefinitions)
        .where(eq(taskDefinitions.taskId, taskId))
        .limit(1)
      return decodeDefinition(rows[0]?.snapshot)
    },

    async reactionHostTasks(roundIds) {
      const ids = processFactIds(roundIds)
      if (!ids.length) return []
      const { tasks, taskLaunchContexts } = tablesOf(db)
      const rows = await db
        .select({ roundId: taskLaunchContexts.digitalEmployeeRoundId, taskId: tasks.id })
        .from(taskLaunchContexts)
        .innerJoin(tasks, eq(tasks.id, taskLaunchContexts.taskId))
        .where(
          and(inArray(taskLaunchContexts.digitalEmployeeRoundId, ids), isNull(tasks.deletedAt)),
        )
        .orderBy(
          // The filter above leaves no NULL round; the explicit form keeps both providers' order equal.
          engineOf(db).ascNullsFirst(taskLaunchContexts.digitalEmployeeRoundId),
          asc(tasks.startedAt),
          asc(tasks.id),
        )
      return rows.flatMap((row) =>
        row.roundId === null ? [] : [{ roundId: row.roundId, taskId: row.taskId }],
      )
    },
  }
}
