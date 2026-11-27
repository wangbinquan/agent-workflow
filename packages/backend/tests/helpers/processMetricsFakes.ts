// RFC-616 — in-memory fact sources for the process metrics use cases.
//
// The use cases only ever talk to ports. These fakes implement every port over
// plain arrays, so the assemblers of the three subject kinds can be tested
// without a database and with numbers small enough to check by hand. The real
// implementations have their own dual-provider tests.
import type { ProcessIdentity, ProcessTextSource, WorkflowDefinition } from '@agent-workflow/shared'
import { buildActor, type Actor } from '@/auth/actor'
import type {
  CallAggregate,
  CallStore,
  NodeRunUsage,
  SystemCallSlice,
} from '@/modules/run-observability/application/ports/callStore'
import type { ProcessSources } from '@/modules/run-observability/application/process/sources'
import type { ProcessOperation } from '@/modules/run-observability/domain/process/model'
import {
  PROCESS_FACT_ID_BATCH,
  type ProcessDescendantRow,
  type ProcessEmployeeApprovalRow,
  type ProcessEmployeeCaseRow,
  type ProcessEmployeeManifest,
  type ProcessEmployeeMeteringRow,
  type ProcessEmployeeRoundRow,
  type ProcessExecutionRow,
  type ProcessNodeRunRow,
  type ProcessSubjectEventRow,
  type ProcessTaskGateRoundRow,
  type ProcessTaskUnitRow,
  type ProcessTextItem,
  type ProcessViewer,
  type ProcessWorkgroupAssignmentRow,
  type ProcessWorkgroupGateDecisionRow,
  type ProcessWorkgroupGateRunRow,
  type ProcessWorkgroupRosterRow,
  type ProcessWrapperRow,
} from '@/platform/contracts/processFacts'

export interface FakeTask {
  readonly kind: 'workflow' | 'workgroup'
  readonly row: ProcessTaskUnitRow
  /** Users who take part in the task besides its owner. */
  readonly collaborators?: readonly string[]
}

export interface FakeCase {
  readonly row: ProcessEmployeeCaseRow
  readonly members?: readonly string[]
}

export interface FakeProcessData {
  tasks: FakeTask[]
  descendants: ProcessDescendantRow[]
  nodeRuns: ProcessNodeRunRow[]
  wrappers: ProcessWrapperRow[]
  definitions: Map<string, WorkflowDefinition>
  hostTasks: { roundId: string; taskId: string }[]
  gateRounds: ProcessTaskGateRoundRow[]
  gateTexts: ProcessTextItem[]
  usage: NodeRunUsage[]
  followups: SystemCallSlice[]
  usageSince: number | null
  rosters: ProcessWorkgroupRosterRow[]
  assignments: ProcessWorkgroupAssignmentRow[]
  gateRuns: ProcessWorkgroupGateRunRow[]
  gateDecisions: ProcessWorkgroupGateDecisionRow[]
  humanMessages: Map<string, number>
  workgroupTexts: ProcessTextItem[]
  cases: FakeCase[]
  rounds: ProcessEmployeeRoundRow[]
  metering: ProcessEmployeeMeteringRow[]
  approvals: ProcessEmployeeApprovalRow[]
  events: ProcessSubjectEventRow[]
  feedback: Map<string, number | null>
  manifests: Map<string, ProcessEmployeeManifest>
  employeeTexts: ProcessTextItem[]
  operations: ProcessOperation[]
  identities: ProcessIdentity[]
  workflowNames: Map<string, string>
}

/** Every id-list method of a real port refuses more than 500 ids; the fakes do too. */
function bounded(ids: readonly string[]): Set<string> {
  if (ids.length > PROCESS_FACT_ID_BATCH) throw new RangeError('id batch exceeds 500')
  return new Set(ids)
}

function sees(viewer: ProcessViewer, owner: string | null, others: readonly string[] = []) {
  return viewer.canReadAll || owner === viewer.userId || others.includes(viewer.userId)
}

export function fakeProcessSources(seed: Partial<FakeProcessData> = {}): {
  readonly sources: ProcessSources
  readonly data: FakeProcessData
} {
  const data: FakeProcessData = {
    tasks: [],
    descendants: [],
    nodeRuns: [],
    wrappers: [],
    definitions: new Map(),
    hostTasks: [],
    gateRounds: [],
    gateTexts: [],
    usage: [],
    followups: [],
    usageSince: 0,
    rosters: [],
    assignments: [],
    gateRuns: [],
    gateDecisions: [],
    humanMessages: new Map(),
    workgroupTexts: [],
    cases: [],
    rounds: [],
    metering: [],
    approvals: [],
    events: [],
    feedback: new Map(),
    manifests: new Map(),
    employeeTexts: [],
    operations: [],
    identities: [],
    workflowNames: new Map(),
    ...seed,
  }
  const newestFirst = (
    a: { startedAt: number; id: string },
    b: { startedAt: number; id: string },
  ) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)

  const calls = {
    async usageByNodeRun(taskIds: readonly string[]) {
      const ids = bounded(taskIds)
      return data.usage.filter((row) => ids.has(row.taskId))
    },
    async systemCalls(taskIds: readonly string[], kind: string) {
      const ids = bounded(taskIds)
      return kind === 'clarify-followup' ? data.followups.filter((row) => ids.has(row.taskId)) : []
    },
    async usageSince() {
      return data.usageSince
    },
    async aggregate(
      filter: { scope: { kind: string; taskIds?: readonly string[] } },
      group: string,
    ) {
      if (filter.scope.kind !== 'tasks' || group !== 'task') throw new Error('unexpected aggregate')
      const ids = bounded(filter.scope.taskIds ?? [])
      const totals = new Map<string, CallAggregate>()
      for (const row of data.usage) {
        if (!ids.has(row.taskId)) continue
        const previous = totals.get(row.taskId)
        totals.set(row.taskId, {
          key: row.taskId,
          label: null,
          calls: (previous?.calls ?? 0) + row.calls,
          incompleteCalls: (previous?.incompleteCalls ?? 0) + row.incompleteCalls,
          failedCalls: 0,
          // The fakes keep one token number per row; the buckets only ever get summed.
          input: (previous?.input ?? 0) + row.tokens,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          costNano: (previous?.costNano ?? 0) + row.costNano,
          unpricedCalls: (previous?.unpricedCalls ?? 0) + row.unpricedCalls,
          durationMs: 0,
          tasks: 1,
          agents: 1,
        })
      }
      return [...totals.values()]
    },
  } as unknown as CallStore

  const sources: ProcessSources = {
    tasks: {
      async units(viewer, query) {
        return data.tasks
          .filter(
            (task) =>
              task.kind === query.kind &&
              (query.subjectId === undefined || task.row.subjectId === query.subjectId) &&
              task.row.startedAt >= query.from &&
              task.row.startedAt < query.to &&
              sees(viewer, task.row.ownerUserId, task.collaborators),
          )
          .map((task) => task.row)
          .sort((a, b) =>
            newestFirst(
              { startedAt: a.startedAt, id: a.taskId },
              { startedAt: b.startedAt, id: b.taskId },
            ),
          )
          .slice(0, query.limit)
      },
      async unit(viewer, taskId) {
        const task = data.tasks.find((item) => item.row.taskId === taskId)
        return task && sees(viewer, task.row.ownerUserId, task.collaborators) ? task.row : null
      },
      async taskSummaries(taskIds) {
        const ids = bounded(taskIds)
        return data.tasks.filter((task) => ids.has(task.row.taskId)).map((task) => task.row)
      },
      async descendants(taskIds) {
        const ids = bounded(taskIds)
        return data.descendants.filter((row) => ids.has(row.unitTaskId))
      },
      async executions(taskIds) {
        const ids = bounded(taskIds)
        const grouped = new Map<string, ProcessExecutionRow>()
        for (const run of data.nodeRuns) {
          if (!ids.has(run.taskId)) continue
          const key = [
            run.taskId,
            run.nodeId,
            run.rerunCause,
            run.containerRunId,
            run.wgRound,
          ].join('|')
          const previous = grouped.get(key)
          const ended = run.startedAt !== null && run.finishedAt !== null
          grouped.set(key, {
            taskId: run.taskId,
            nodeId: run.nodeId,
            rerunCause: run.rerunCause,
            containerRunId: run.containerRunId,
            wgRound: run.wgRound,
            runs: (previous?.runs ?? 0) + 1,
            endedRuns: (previous?.endedRuns ?? 0) + (ended ? 1 : 0),
            failedRuns: (previous?.failedRuns ?? 0) + (run.status === 'failed' ? 1 : 0),
            interruptedRuns:
              (previous?.interruptedRuns ?? 0) + (run.status === 'interrupted' ? 1 : 0),
            activeMs: (previous?.activeMs ?? 0) + (ended ? run.finishedAt! - run.startedAt! : 0),
          })
        }
        return [...grouped.values()]
      },
      async wrappers(taskIds, options) {
        const ids = bounded(taskIds)
        const rows = data.wrappers.filter((row) => ids.has(row.taskId))
        // Like the real reader: without counts nothing inside a wrapper is read.
        return options?.counts === false
          ? rows.map((row) => ({ ...row, rounds: 0, shards: 0 }))
          : rows
      },
      async nodeRuns(taskIds, filter) {
        const ids = bounded(taskIds)
        return data.nodeRuns.filter(
          (run) =>
            ids.has(run.taskId) &&
            (filter?.nodeIds === undefined || filter.nodeIds.includes(run.nodeId)),
        )
      },
      async definition(taskId) {
        return data.definitions.get(taskId) ?? null
      },
      async reactionHostTasks(roundIds) {
        const ids = bounded(roundIds)
        return data.hostTasks.filter((row) => ids.has(row.roundId))
      },
    },
    workgroups: {
      async rosters(taskIds) {
        const ids = bounded(taskIds)
        return data.rosters.filter((row) => ids.has(row.taskId))
      },
      async assignments(taskIds) {
        const ids = bounded(taskIds)
        return data.assignments.filter((row) => ids.has(row.taskId))
      },
      async gateRuns(taskIds) {
        const ids = bounded(taskIds)
        return data.gateRuns.filter((row) => ids.has(row.taskId))
      },
      async gateDecisions(taskIds) {
        const ids = bounded(taskIds)
        return data.gateDecisions.filter((row) => ids.has(row.taskId))
      },
      async activity(taskIds) {
        return [...bounded(taskIds)].map((taskId) => ({
          taskId,
          humanMessages: data.humanMessages.get(taskId) ?? 0,
        }))
      },
      async texts(taskIds) {
        const ids = bounded(taskIds)
        return data.workgroupTexts.filter((item) => item.taskId !== null && ids.has(item.taskId))
      },
    },
    gates: {
      async rounds(taskIds, options) {
        const ids = bounded(taskIds)
        return data.gateRounds
          .filter((row) => ids.has(row.taskId))
          .map((row) => (options.measures ? row : { ...row, measures: {}, people: [] }))
      },
      async texts(taskIds, wanted) {
        const ids = bounded(taskIds)
        const kinds: readonly ProcessTextSource[] = wanted
        return data.gateTexts.filter(
          (item) => item.taskId !== null && ids.has(item.taskId) && kinds.includes(item.source),
        )
      },
    },
    employees: {
      async cases(viewer, query) {
        return data.cases
          .filter(
            (item) =>
              (query.employeeId === undefined || item.row.employeeId === query.employeeId) &&
              item.row.createdAt >= query.from &&
              item.row.createdAt < query.to &&
              sees(viewer, item.row.ownerUserId, item.members),
          )
          .map((item) => item.row)
          .sort((a, b) =>
            newestFirst(
              { startedAt: a.createdAt, id: a.caseId },
              { startedAt: b.createdAt, id: b.caseId },
            ),
          )
          .slice(0, query.limit)
      },
      async case(viewer, caseId) {
        const item = data.cases.find((entry) => entry.row.caseId === caseId)
        return item && sees(viewer, item.row.ownerUserId, item.members) ? item.row : null
      },
      async rounds(caseIds) {
        const ids = bounded(caseIds)
        return data.rounds.filter((row) => ids.has(row.caseId))
      },
      async metering(caseIds) {
        const ids = bounded(caseIds)
        return data.metering.filter((row) => ids.has(row.caseId))
      },
      transitions(events) {
        return [...events]
          .sort((a, b) => a.occurredAt - b.occurredAt)
          .map((event) => {
            const facts = JSON.parse(event.summaryJson) as {
              previousState: 'active' | 'waiting' | 'blocked' | 'terminal' | null
              state: 'active' | 'waiting' | 'blocked' | 'terminal'
            }
            return {
              caseId: event.subjectRef,
              at: event.occurredAt,
              from: facts.previousState,
              to: facts.state,
            }
          })
      },
      async approvals(caseIds) {
        const ids = bounded(caseIds)
        return data.approvals.filter((row) => ids.has(row.caseId))
      },
      async humanFeedbackCounts(caseIds) {
        return [...bounded(caseIds)].map((caseId) => ({
          caseId,
          items: data.feedback.get(caseId) ?? null,
        }))
      },
      async manifest(typeId, typeRevision) {
        return data.manifests.get(`${typeId}@${typeRevision}`) ?? null
      },
      async texts(caseIds) {
        const ids = bounded(caseIds)
        return data.employeeTexts.filter((item) => item.caseId !== null && ids.has(item.caseId))
      },
    },
    events: {
      async history(subjectType, subjectRefs) {
        const ids = bounded(subjectRefs)
        return subjectType === 'digital-employee.case'
          ? data.events.filter((event) => ids.has(event.subjectRef))
          : []
      },
    },
    calls,
    operations: {
      async latest() {
        return null
      },
      async insert() {},
      async touch() {},
      async bySubjects(subjectKind, subjectIds, actions) {
        const ids = bounded(subjectIds)
        return data.operations.filter(
          (operation) =>
            operation.subjectKind === subjectKind &&
            ids.has(operation.subjectId) &&
            (actions === undefined || actions.includes(operation.action)),
        )
      },
    },
    identities: {
      async identities(userIds) {
        return data.identities.filter((identity) => userIds.includes(identity.id))
      },
    },
    workflowNames: {
      async names(workflowIds) {
        if (workflowIds.length > PROCESS_FACT_ID_BATCH) throw new RangeError('id batch exceeds 500')
        return new Map(
          workflowIds.flatMap((id) => {
            const name = data.workflowNames.get(id)
            return name === undefined ? [] : [[id, name] as const]
          }),
        )
      },
    },
  }
  return { sources, data }
}

export function taskUnit(
  over: Partial<ProcessTaskUnitRow> & { taskId: string },
): ProcessTaskUnitRow {
  return {
    name: `task ${over.taskId}`,
    subjectId: 'wf-1',
    subjectName: null,
    subjectRevision: 1,
    engineKind: 'dag',
    status: 'done',
    errorSummary: null,
    origin: 'manual',
    ownerUserId: 'alice',
    startedAt: 0,
    finishedAt: 0,
    autoMs: 0,
    ...over,
  }
}

export function nodeRun(
  over: Partial<ProcessNodeRunRow> & { taskId: string; nodeRunId: string; nodeId: string },
): ProcessNodeRunRow {
  return {
    rerunCause: 'initial',
    containerRunId: null,
    wgRound: null,
    shardKey: null,
    agentOverrideId: null,
    status: 'done',
    failureCode: null,
    startedAt: 0,
    finishedAt: 0,
    seq: 0,
    ...over,
  }
}

/** A row on a wrapper's slot; an ordinary first invocation unless said otherwise. */
export function wrapperRun(
  over: Partial<ProcessWrapperRow> & { taskId: string; runId: string; nodeId: string },
): ProcessWrapperRow {
  return {
    rerunCause: 'wrapper-init',
    containerRunId: null,
    iteration: 0,
    seq: 0,
    status: 'done',
    startedAt: 0,
    finishedAt: 0,
    rounds: 1,
    shards: 0,
    ...over,
  }
}

export function gateRound(
  over: Partial<ProcessTaskGateRoundRow> & { taskId: string; gateNodeRunId: string },
): ProcessTaskGateRoundRow {
  return {
    kind: 'review',
    stageNodeId: 'review',
    relatedNodeId: 'design',
    askingShardKey: null,
    instanceKey: over.gateNodeRunId,
    ordinal: 1,
    void: false,
    openedAt: 0,
    closedAt: 0,
    outcome: 'approved',
    deciderUserId: null,
    mindmap: false,
    measures: {},
    people: [],
    ...over,
  }
}

export function usageRow(
  over: Partial<NodeRunUsage> & { taskId: string; tokens: number },
): NodeRunUsage {
  return {
    nodeRunId: null,
    purpose: 'task',
    systemKind: null,
    calls: 1,
    incompleteCalls: 0,
    unpricedCalls: 0,
    costNano: over.tokens * 10,
    ...over,
  }
}

export function person(id: string, role: 'admin' | 'user', permissions?: readonly string[]): Actor {
  const actor = buildActor({
    user: { id, username: id, displayName: id.toUpperCase(), role, status: 'active' },
    source: 'session',
  })
  return permissions === undefined
    ? actor
    : ({ ...actor, permissions: new Set(permissions) } as Actor)
}
