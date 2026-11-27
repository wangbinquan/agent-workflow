// RFC-616 §6.1 — from the facts of one task to the unified model. Workflow and
// workgroup units are both tasks; they differ only in how a node run maps to a
// stage, which the caller supplies.

import { PROCESS_UNATTRIBUTED_STAGE, type ProcessCause } from '@agent-workflow/shared'
import type {
  ProcessNodeRunRow,
  ProcessTaskGateRoundRow,
  ProcessTaskUnitRow,
} from '@/platform/contracts/processFacts'
import {
  classifyExecutions,
  executionInputOfRun,
  judgeCause,
  judgeWrapperInvocations,
} from '../../../domain/process/causes'
import {
  NO_USAGE,
  type ProcessFailureCode,
  type ProcessGateRound,
  type ProcessOperation,
  type ProcessUnit,
  type ProcessUnitFacts,
  type ProcessUsageSlice,
  type ProcessWrapperRun,
} from '../../../domain/process/model'
import { CLARIFY_FOLLOWUP_KIND, addUsage, type ProcessDepth, type TaskBundle } from '../sources'

const LIMIT_SUMMARIES = new Set(['task-time-limit-exceeded', 'task-token-limit-exceeded'])
const SYSTEM_OTHER_STAGE = 'system:other'

export function unitOfTask(row: ProcessTaskUnitRow): ProcessUnit {
  const status =
    row.status === 'done'
      ? 'succeeded'
      : row.status === 'failed'
        ? 'failed'
        : row.status === 'canceled'
          ? 'canceled'
          : 'active'
  return {
    id: row.taskId,
    taskId: row.taskId,
    subjectId: row.subjectId,
    subjectRevision: row.subjectRevision,
    name: row.name,
    status,
    outcome: row.status,
    origin: row.origin,
    ownerUserId: row.ownerUserId,
    startedAt: row.startedAt,
    endedAt: status === 'active' ? null : row.finishedAt,
    autoMs: row.autoMs,
    limitCanceled: row.errorSummary !== null && LIMIT_SUMMARIES.has(row.errorSummary),
  }
}

export interface TaskStageResolvers {
  /** The stage of a node id (aggregated rows, wrappers, call nodes). */
  stageOfNode(nodeId: string): string
  /** The stage of one node run; defaults to its node's stage. */
  stageOfRun?(run: ProcessNodeRunRow): string
  /** The workgroup round of one node run; defaults to none. */
  roundOfRun?(run: ProcessNodeRunRow): number | null
  /** Where an own gate round is held and what it relates to; defaults to its nodes' stages. */
  stageOfGate?(row: ProcessTaskGateRoundRow): {
    readonly stageKey: string
    readonly relatedStageKey: string | null
  }
}

function gateOf(
  row: ProcessTaskGateRoundRow,
  placement: { readonly stageKey: string; readonly relatedStageKey: string | null },
  inherited: boolean,
): ProcessGateRound {
  return {
    stageKey: placement.stageKey,
    relatedStageKey: placement.relatedStageKey,
    kind: row.kind,
    subject: { kind: 'node-run', id: row.gateNodeRunId },
    // Rounds of a called task must never be numbered together with the unit's own.
    instanceKey: inherited ? `${row.taskId}\u0000${row.instanceKey}` : row.instanceKey,
    ordinal: row.ordinal,
    void: row.void,
    ...(inherited ? { inherited: true } : {}),
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    outcome: row.outcome,
    deciderUserId: row.deciderUserId,
    mindmap: row.mindmap,
    measures: row.measures,
    people: row.people,
    ...(row.categories === undefined ? {} : { categories: row.categories }),
  }
}

function mergeSlices(slices: readonly ProcessUsageSlice[]): ProcessUsageSlice[] {
  const merged = new Map<string, ProcessUsageSlice>()
  for (const slice of slices) {
    if (slice.tokens === 0 && slice.costNano === 0) continue
    const key = `${slice.stageKey}\u0000${slice.cause}`
    const previous = merged.get(key)
    merged.set(key, {
      stageKey: slice.stageKey,
      cause: slice.cause,
      tokens: (previous?.tokens ?? 0) + slice.tokens,
      costNano: (previous?.costNano ?? 0) + slice.costNano,
    })
  }
  return [...merged.values()]
}

export interface TaskUnitInput {
  readonly unit: ProcessUnit
  readonly bundle: TaskBundle
  readonly depth: ProcessDepth
  /** Start of the oldest recorded runtime call; null when none was ever recorded. */
  readonly usageSince: number | null
  readonly resolvers: TaskStageResolvers
  /** Gate rounds the subject kind derives itself (workgroup deliveries, confirmations). */
  readonly extraGates?: readonly ProcessGateRound[]
}

/** Everything known about one task-backed unit. */
export function taskUnitFacts(input: TaskUnitInput): ProcessUnitFacts {
  const { unit, bundle, resolvers } = input
  const taskId = unit.id
  const stageOfRun = resolvers.stageOfRun ?? ((run) => resolvers.stageOfNode(run.nodeId))
  const roundOfRun = resolvers.roundOfRun ?? (() => null)
  const stageOfGate =
    resolvers.stageOfGate ??
    ((row) => ({
      stageKey: resolvers.stageOfNode(row.stageNodeId),
      relatedStageKey: row.relatedNodeId === null ? null : resolvers.stageOfNode(row.relatedNodeId),
    }))
  const descendants = bundle.descendants.get(taskId) ?? []
  const runs = bundle.nodeRuns.get(taskId) ?? []
  const wrapperRows = bundle.wrappers.get(taskId) ?? []
  const wrapperJudgement = judgeWrapperInvocations(wrapperRows)
  const runById = new Map(runs.map((run) => [run.nodeRunId, run]))
  const causeOfRun = (run: ProcessNodeRunRow): ProcessCause | null =>
    judgeCause(
      {
        rerunCause: run.rerunCause,
        stageKey: stageOfRun(run),
        containerRunId: run.containerRunId,
      },
      wrapperJudgement,
    ).cause

  const classified =
    input.depth === 'full'
      ? classifyExecutions(
          runs.map((run) =>
            executionInputOfRun({
              stageKey: stageOfRun(run),
              rerunCause: run.rerunCause,
              containerRunId: run.containerRunId,
              round: roundOfRun(run),
              status: run.status,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
            }),
          ),
          wrapperJudgement,
        )
      : classifyExecutions(
          (bundle.executions.get(taskId) ?? []).map((row) => ({
            stageKey: resolvers.stageOfNode(row.nodeId),
            rerunCause: row.rerunCause,
            containerRunId: row.containerRunId,
            round: row.wgRound,
            runs: row.runs,
            endedRuns: row.endedRuns,
            failedRuns: row.failedRuns,
            interruptedRuns: row.interruptedRuns,
            activeMs: row.activeMs,
          })),
          wrapperJudgement,
        )

  const failureCodes = new Map<string, ProcessFailureCode>()
  for (const run of runs) {
    if (run.status !== 'failed' || run.failureCode === null) continue
    if (causeOfRun(run) === null) continue
    const stageKey = stageOfRun(run)
    const key = `${stageKey}\u0000${run.failureCode}`
    const previous = failureCodes.get(key)
    failureCodes.set(key, { stageKey, code: run.failureCode, runs: (previous?.runs ?? 0) + 1 })
  }

  // A placeholder on a wrapper's slot is not an invocation: it has no rounds and no shards of its own.
  const wrappers: ProcessWrapperRun[] = wrapperRows
    .filter((row) => wrapperJudgement.innerCause.has(row.runId))
    .map((row) => ({
      stageKey: resolvers.stageOfNode(row.nodeId),
      status: row.status,
      rounds: row.rounds,
      shards: row.shards,
      durationMs:
        row.startedAt !== null && row.finishedAt !== null
          ? Math.max(0, row.finishedAt - row.startedAt)
          : null,
    }))
  // A retry aimed at a canceled or interrupted wrapper revives it without a placeholder; the
  // recorded operation is then the only trace. Each retry leaves at most one of each, so the
  // larger of the two counts is the number of retries.
  const retryOperations = (bundle.taskOperations.get(taskId) ?? []).filter(
    (operation) => operation.action === 'task.retry-node',
  ).length

  const ownGateRows = bundle.gates.get(taskId) ?? []
  const gates: ProcessGateRound[] = ownGateRows.map((row) => gateOf(row, stageOfGate(row), false))
  for (const descendant of descendants) {
    const stageKey =
      descendant.callNodeId === null
        ? PROCESS_UNATTRIBUTED_STAGE
        : resolvers.stageOfNode(descendant.callNodeId)
    for (const row of bundle.gates.get(descendant.taskId) ?? []) {
      gates.push(gateOf(row, { stageKey, relatedStageKey: null }, true))
    }
  }
  if (input.extraGates) gates.push(...input.extraGates)

  let usageTotals = bundle.usageTotals.get(taskId) ?? NO_USAGE
  for (const descendant of descendants) {
    usageTotals = addUsage(usageTotals, bundle.usageTotals.get(descendant.taskId) ?? NO_USAGE)
  }

  const slices: ProcessUsageSlice[] = []
  if (input.depth === 'full') {
    const followups = bundle.followups.get(taskId) ?? []
    for (const row of bundle.usage.get(taskId) ?? []) {
      const run = row.nodeRunId === null ? undefined : runById.get(row.nodeRunId)
      if (row.purpose === 'system') {
        // Follow-up generation has no node run; it is placed below, call by call, by time.
        if (run === undefined && row.systemKind === CLARIFY_FOLLOWUP_KIND && followups.length > 0)
          continue
        slices.push({
          stageKey: run === undefined ? SYSTEM_OTHER_STAGE : stageOfRun(run),
          cause: 'system',
          tokens: row.tokens,
          costNano: row.costNano,
        })
        continue
      }
      slices.push({
        stageKey: run === undefined ? PROCESS_UNATTRIBUTED_STAGE : stageOfRun(run),
        cause: (run === undefined ? null : causeOfRun(run)) ?? 'first',
        tokens: row.tokens,
        costNano: row.costNano,
      })
    }
    for (const call of followups) {
      const round = gates.find(
        (gate) =>
          gate.kind === 'clarify' &&
          gate.inherited !== true &&
          gate.openedAt <= call.startedAt &&
          (gate.closedAt === null || call.startedAt <= gate.closedAt),
      )
      slices.push({
        stageKey: round?.stageKey ?? SYSTEM_OTHER_STAGE,
        cause: 'system',
        tokens: call.tokens,
        costNano: call.costNano,
      })
    }
    for (const descendant of descendants) {
      const stageKey =
        descendant.callNodeId === null
          ? PROCESS_UNATTRIBUTED_STAGE
          : resolvers.stageOfNode(descendant.callNodeId)
      const callRun =
        descendant.callNodeRunId === null ? undefined : runById.get(descendant.callNodeRunId)
      const callCause = (callRun === undefined ? null : causeOfRun(callRun)) ?? 'first'
      for (const row of bundle.usage.get(descendant.taskId) ?? []) {
        slices.push({
          stageKey,
          cause: row.purpose === 'system' ? 'system' : callCause,
          tokens: row.tokens,
          costNano: row.costNano,
        })
      }
    }
  }

  const operations: ProcessOperation[] = [...(bundle.taskOperations.get(taskId) ?? [])]
  const seenRuns = new Set<string>()
  for (const row of ownGateRows) {
    if (seenRuns.has(row.gateNodeRunId)) continue
    seenRuns.add(row.gateNodeRunId)
    operations.push(...(bundle.runOperations.get(row.gateNodeRunId) ?? []))
  }

  return {
    unit,
    executions: classified.executions,
    failureCodes: [...failureCodes.values()],
    gates,
    usage: mergeSlices(slices),
    usageTotals,
    hasUsageRecord: input.usageSince !== null && unit.startedAt >= input.usageSince,
    operations,
    manualRetries: Math.max(classified.manualRetries, retryOperations),
    failedWrappers: wrappers.filter(
      (wrapper) => wrapper.status === 'failed' || wrapper.status === 'exhausted',
    ).length,
    runsWithoutCause: classified.runsWithoutCause,
    wrappers,
  }
}
