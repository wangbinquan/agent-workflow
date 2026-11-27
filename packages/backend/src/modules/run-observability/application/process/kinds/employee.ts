// RFC-616 §6.3 — digital employees. A unit is one case (an assignment); stages
// are the work items of the employee type's responsibility map. Rounds come
// from the employee ledger; tokens and human gates come from the host tasks the
// rounds ran in. Everything type-specific (which work items are rework, what
// counts as human feedback) is declared by the type itself.

import {
  PROCESS_UNATTRIBUTED_STAGE,
  classifyTerminalKind,
  processSystemWorkOfCall,
  type ProcessEmployeeCycle,
  type ProcessEmployeeOutcomes,
  type ProcessEmployeeSummary,
  type ProcessMetricId,
  type ProcessStageKind,
  type ProcessSubjectRow,
  type ProcessUnitStatus,
  type ProcessWorkItemRow,
} from '@agent-workflow/shared'
import {
  PROCESS_EMPLOYEE_CASE_SUBJECT,
  type ProcessEmployeeCaseRow,
  type ProcessEmployeeManifest,
  type ProcessEmployeeTransitionRow,
} from '@/platform/contracts/processFacts'
import { gateDurationsOf, reviewSummaryOf } from '../../../domain/process/gateSummary'
import { hintsOf } from '../../../domain/process/hints'
import {
  NO_USAGE,
  usageRecorded,
  type ProcessExecution,
  type ProcessGateRound,
  type ProcessStage,
  type ProcessUnit,
  type ProcessUnitFacts,
  type ProcessUsageSlice,
} from '../../../domain/process/model'
import { stageRowsOf, stageTotalsOf } from '../../../domain/process/stageSummary'
import { mean, median, ratio, statOf, sum } from '../../../domain/process/stats'
import {
  anyUnpriced,
  commonMetrics,
  timeSplitOf,
  waitShareOf,
  type ProcessUnitNumbers,
  type ProcessUnitRowExtras,
} from '../../../domain/process/unitSummary'
import {
  addUsage,
  chunked,
  groupBy,
  loadOperations,
  loadTaskBundle,
  type ProcessDepth,
  type ProcessSources,
} from '../sources'
import {
  baseSummary,
  gateHintFacts,
  firstPassUnitsOf,
  stageHintFacts,
  topWaitOf,
  type SummaryFrame,
} from '../summaryBase'

export interface EmployeeUnitExtras extends ProcessUnitRowExtras {
  readonly typeKey: string
  readonly bucket: keyof ProcessEmployeeOutcomes | null
  readonly blockedSpans: number
  /** When the first region's spine finished; null when it never did. */
  readonly boundaryAt: number | null
  /** Human feedback items; null when the type provides none. */
  readonly feedback: number | null
  readonly blockReason: string | null
  /** Settled round durations by work item. */
  readonly roundMs: ReadonlyMap<string, readonly number[]>
}

export interface EmployeeLoad {
  readonly facts: readonly ProcessUnitFacts[]
  readonly extras: ReadonlyMap<string, EmployeeUnitExtras>
  readonly manifests: ReadonlyMap<string, ProcessEmployeeManifest | null>
  /** Names of the employees the cases belong to. */
  readonly names: ReadonlyMap<string, string | null>
}

const typeKeyOf = (row: { readonly typeId: string; readonly typeRevision: number }) =>
  `${row.typeId}@${row.typeRevision}`

export function employeeUnitStatus(row: ProcessEmployeeCaseRow): ProcessUnitStatus {
  if (row.state !== 'terminal') return 'active'
  const kind = classifyTerminalKind(row.terminalKind)
  return !kind.failed ? 'succeeded' : kind.catalog === 'canceled' ? 'canceled' : 'failed'
}

function unitOfCase(row: ProcessEmployeeCaseRow, autoMs: number): ProcessUnit {
  const status = employeeUnitStatus(row)
  return {
    id: row.caseId,
    taskId: null,
    subjectId: row.employeeId,
    subjectRevision: row.employeeRevision,
    name: row.name,
    status,
    outcome: row.terminalKind ?? row.state,
    origin: row.origin,
    ownerUserId: row.ownerUserId,
    startedAt: row.createdAt,
    endedAt: status === 'active' ? null : (row.terminalAt ?? row.createdAt),
    autoMs,
    limitCanceled: false,
  }
}

/** The work item that ends the first region's main lane; delivery is split there. */
export function boundaryWorkItemOf(manifest: ProcessEmployeeManifest | null): string | null {
  if (manifest === null) return null
  const region = [...manifest.regions].sort((a, b) => a.order - b.order)[0]
  if (!region) return null
  const spine = [...region.lanes]
    .filter((lane) => lane.kind === 'spine')
    .sort((a, b) => a.order - b.order)[0]
  if (!spine) return null
  const items = manifest.workItems
    .filter((item) => item.regionId === region.regionId && item.laneId === spine.laneId)
    .sort((a, b) => a.order - b.order)
  return items.at(-1)?.workItemRef ?? null
}

function blockedGates(
  transitions: readonly ProcessEmployeeTransitionRow[],
  endedAt: number | null,
): ProcessGateRound[] {
  const gates: ProcessGateRound[] = []
  let openedAt: number | null = null
  // A round is "blocked until resumed". A block that lasts until the case ends was never
  // handled: the case was ended instead, and ending it is counted on its own. Such a span is
  // void — it still is time the case spent waiting, and still one block of the case.
  const close = (closedAt: number | null, resumed: boolean) => {
    if (openedAt === null) return
    gates.push({
      stageKey: PROCESS_UNATTRIBUTED_STAGE,
      relatedStageKey: null,
      kind: 'blocked',
      subject: null,
      instanceKey: `blocked:${gates.length}`,
      ordinal: 1,
      void: closedAt !== null && !resumed,
      openedAt,
      closedAt,
      outcome: closedAt === null ? null : resumed ? 'unblocked' : 'terminated',
      deciderUserId: null,
      mindmap: false,
      measures: {},
      people: [],
    })
    openedAt = null
  }
  for (const transition of [...transitions].sort((a, b) => a.at - b.at)) {
    if (transition.to === 'blocked') {
      if (openedAt === null) openedAt = transition.at
    } else {
      close(transition.at, transition.to !== 'terminal')
    }
  }
  // Still blocked: the span runs until the case ends, or is still open.
  close(endedAt, false)
  return gates
}

function manifestStages(manifest: ProcessEmployeeManifest | null): ProcessStage[] {
  if (manifest === null) return []
  const regionOrder = new Map(manifest.regions.map((region) => [region.regionId, region.order]))
  const laneOrder = new Map(
    manifest.regions.flatMap((region) =>
      region.lanes.map((lane) => [`${region.regionId}\u0000${lane.laneId}`, lane.order] as const),
    ),
  )
  const kindOf: Record<string, ProcessStageKind> = {
    'business-tool': 'work-item-tool',
    system: 'work-item-system',
    collaboration: 'work-item-collaboration',
  }
  return manifest.workItems.map((item) => ({
    key: item.workItemRef,
    label: item.label,
    kind: kindOf[item.nodeKind] ?? 'work-item-system',
    parentKey: null,
    order:
      (regionOrder.get(item.regionId) ?? 0) * 1_000_000 +
      (laneOrder.get(`${item.regionId}\u0000${item.laneId}`) ?? 0) * 1_000 +
      item.order,
    removed: false,
  }))
}

export async function loadEmployeeUnits(
  sources: ProcessSources,
  rows: readonly ProcessEmployeeCaseRow[],
  depth: ProcessDepth,
): Promise<EmployeeLoad> {
  const caseIds = rows.map((row) => row.caseId)
  const full = depth === 'full'
  const [roundRows, meteringRows, approvalRows, eventRows, feedbackRows, usageSince, operations] =
    await Promise.all([
      chunked(caseIds, (chunk) => sources.employees.rounds(chunk)),
      chunked(caseIds, (chunk) => sources.employees.metering(chunk)),
      chunked(caseIds, (chunk) => sources.employees.approvals(chunk)),
      chunked(caseIds, (chunk) => sources.events.history(PROCESS_EMPLOYEE_CASE_SUBJECT, chunk)),
      full
        ? chunked(caseIds, (chunk) => sources.employees.humanFeedbackCounts(chunk))
        : Promise.resolve([]),
      sources.calls.usageSince(),
      loadOperations(sources.operations, 'employee-case', caseIds),
    ])
  const rounds = groupBy(roundRows, (row) => row.caseId)
  const metering = groupBy(meteringRows, (row) => row.caseId)
  const approvals = groupBy(approvalRows, (row) => row.caseId)
  const transitions = groupBy(sources.employees.transitions(eventRows), (row) => row.caseId)
  const feedback = new Map(feedbackRows.map((row) => [row.caseId, row.items]))

  const hostRows = await chunked(
    roundRows.map((round) => round.roundId),
    (chunk) => sources.tasks.reactionHostTasks(chunk),
  )
  const hostTasks = groupBy(hostRows, (row) => row.roundId)
  // Host tasks are measured by round, never by node run.
  const bundle = await loadTaskBundle(
    sources,
    hostRows.map((row) => row.taskId),
    depth,
    { withNodeRuns: false },
  )

  const manifests = new Map<string, ProcessEmployeeManifest | null>()
  for (const row of rows) {
    const key = typeKeyOf(row)
    if (manifests.has(key)) continue
    manifests.set(key, await sources.employees.manifest(row.typeId, row.typeRevision))
  }

  const extras = new Map<string, EmployeeUnitExtras>()
  const names = new Map<string, string | null>()
  const facts = rows.map((row): ProcessUnitFacts => {
    names.set(row.employeeId, row.employeeName)
    const manifest = manifests.get(typeKeyOf(row)) ?? null
    const caseRounds = (rounds.get(row.caseId) ?? []).filter((round) => round.state !== 'obsolete')
    const unit = unitOfCase(
      row,
      sum((metering.get(row.caseId) ?? []).map((receipt) => receipt.durationMs)),
    )

    const executions: ProcessExecution[] = []
    const roundMs = new Map<string, number[]>()
    const slices: ProcessUsageSlice[] = []
    const gates: ProcessGateRound[] = []
    // Runs that hold a gate of the case's own tool runs: who opened them, and when, is recorded per run.
    const gateRuns = new Set<string>()
    let usageTotals = NO_USAGE
    const roundCount = new Map<string, number>()
    for (const round of caseRounds) {
      const settled = round.settledAt !== null
      const duration = settled ? Math.max(0, round.settledAt! - round.createdAt) : 0
      executions.push({
        stageKey: round.workItemRef,
        cause: 'first',
        round: null,
        runs: 1,
        endedRuns: settled ? 1 : 0,
        failedRuns: round.state === 'failed' ? 1 : 0,
        interruptedRuns: 0,
        activeMs: duration,
      })
      // Attempts beyond the first are the platform retrying the same round.
      if (round.attemptOrdinal > 0) {
        executions.push({
          stageKey: round.workItemRef,
          cause: 'auto-retry',
          round: null,
          runs: round.attemptOrdinal,
          endedRuns: 0,
          failedRuns: 0,
          interruptedRuns: 0,
          activeMs: 0,
        })
      }
      roundCount.set(round.workItemRef, (roundCount.get(round.workItemRef) ?? 0) + 1)
      if (settled) {
        const list = roundMs.get(round.workItemRef)
        if (list) list.push(duration)
        else roundMs.set(round.workItemRef, [duration])
      }
      ;(hostTasks.get(round.roundId) ?? []).forEach((host, attempt) => {
        const cause = attempt === 0 ? 'first' : 'auto-retry'
        const descendants = bundle.descendants.get(host.taskId) ?? []
        for (const taskId of [host.taskId, ...descendants.map((item) => item.taskId)]) {
          const totals = bundle.usageTotals.get(taskId) ?? NO_USAGE
          usageTotals = addUsage(usageTotals, totals)
          // Platform work done for the tool run (memory extraction, change narration, …) is
          // system work of the work item, as it is for a workflow task. Only the full depth
          // reads calls by purpose; the listing shows no split by cause.
          const system = (bundle.usage.get(taskId) ?? []).filter((row) => row.purpose === 'system')
          const systemTokens = sum(system.map((row) => row.tokens))
          const systemCostNano = sum(system.map((row) => row.costNano))
          slices.push({
            stageKey: round.workItemRef,
            cause,
            tokens: totals.tokens - systemTokens,
            costNano: totals.costNano - systemCostNano,
          })
          for (const row of system) {
            slices.push({
              stageKey: round.workItemRef,
              cause: 'system',
              systemKind: processSystemWorkOfCall(row.systemKind),
              tokens: row.tokens,
              costNano: row.costNano,
            })
          }
          const inherited = taskId !== host.taskId
          for (const gate of bundle.gates.get(taskId) ?? []) {
            if (!inherited) gateRuns.add(gate.gateNodeRunId)
            gates.push({
              stageKey: round.workItemRef,
              relatedStageKey: inherited ? null : round.workItemRef,
              kind: gate.kind,
              subject: { kind: 'node-run', id: gate.gateNodeRunId },
              instanceKey: `${gate.taskId}\u0000${gate.instanceKey}`,
              ordinal: gate.ordinal,
              void: gate.void,
              ...(inherited ? { inherited: true } : {}),
              openedAt: gate.openedAt,
              closedAt: gate.closedAt,
              outcome: gate.outcome,
              deciderUserId: gate.deciderUserId,
              mindmap: gate.mindmap,
              measures: gate.measures,
              people: gate.people,
              ...(gate.categories === undefined ? {} : { categories: gate.categories }),
            })
          }
        }
      })
    }
    ;(approvals.get(row.caseId) ?? []).forEach((approval, index) => {
      gates.push({
        stageKey: PROCESS_UNATTRIBUTED_STAGE,
        relatedStageKey: null,
        kind: 'approval',
        subject: null,
        instanceKey: `approval:${index}`,
        ordinal: 1,
        void: false,
        openedAt: approval.submittedAt,
        closedAt: approval.settledAt,
        outcome: approval.settledAt === null ? null : approval.status,
        deciderUserId: null,
        mindmap: false,
        measures: {},
        people: [],
      })
    })
    const blocked = blockedGates(transitions.get(row.caseId) ?? [], unit.endedAt)
    gates.push(...blocked)

    const reworkRefs = manifest?.reworkWorkItemRefs ?? null
    const rework = (reworkRefs ?? [])
      .map((key) => ({ key, rounds: roundCount.get(key) ?? 0 }))
      .filter((item) => item.rounds > 0)
    const bucket = row.state === 'terminal' ? classifyTerminalKind(row.terminalKind).bucket : null
    const boundary = boundaryWorkItemOf(manifest)
    const boundaryAt =
      boundary === null
        ? null
        : (caseRounds
            .filter(
              (round) =>
                round.workItemRef === boundary &&
                round.state === 'completed' &&
                round.settledAt !== null,
            )
            .map((round) => round.settledAt!)
            .sort((a, b) => a - b)[0] ?? null)
    extras.set(row.caseId, {
      rounds: null,
      assignments: null,
      completionRejections: null,
      capped: false,
      rework,
      typeKey: typeKeyOf(row),
      bucket,
      blockedSpans: blocked.length,
      boundaryAt,
      feedback: feedback.get(row.caseId) ?? null,
      blockReason: row.state === 'blocked' ? row.blockReason : null,
      roundMs,
    })

    return {
      unit,
      executions,
      failureCodes: [],
      gates,
      usage: slices.filter((slice) => slice.tokens > 0 || slice.costNano > 0),
      usageTotals,
      hasUsageRecord: usageRecorded(unit.startedAt, usageTotals, usageSince),
      operations: [
        ...(operations.get(row.caseId) ?? []),
        ...[...gateRuns].flatMap((runId) => bundle.runOperations.get(runId) ?? []),
      ],
      manualRetries: 0,
      failedWrappers: 0,
      runsWithoutCause: 0,
      wrappers: [],
      // Only a merged case can be a first pass, and only when the type says what rework is.
      firstPassOverride:
        reworkRefs === null || bucket !== 'merged'
          ? null
          : rework.length === 0 && blocked.length === 0,
    }
  })
  return { facts, extras, manifests, names }
}

function employeeMetrics(
  numbers: readonly ProcessUnitNumbers[],
  extras: ReadonlyMap<string, EmployeeUnitExtras>,
): Partial<Record<ProcessMetricId, number | null>> {
  const terminal = numbers.filter((item) => item.facts.unit.status !== 'active')
  const extra = (item: ProcessUnitNumbers) => extras.get(item.facts.unit.id)
  return {
    mergeRate: ratio(
      terminal.filter((item) => extra(item)?.bucket === 'merged').length,
      terminal.length,
    ),
    blockedRate: ratio(
      numbers.filter((item) => (extra(item)?.blockedSpans ?? 0) > 0).length,
      numbers.length,
    ),
  }
}

function outcomesOf(
  numbers: readonly ProcessUnitNumbers[],
  extras: ReadonlyMap<string, EmployeeUnitExtras>,
): ProcessEmployeeOutcomes {
  const outcomes = { merged: 0, noChange: 0, otherFinished: 0, failed: 0 }
  for (const item of numbers) {
    const bucket = extras.get(item.facts.unit.id)?.bucket
    if (bucket != null) outcomes[bucket]++
  }
  return outcomes
}

function cycleOf(
  numbers: readonly ProcessUnitNumbers[],
  extras: ReadonlyMap<string, EmployeeUnitExtras>,
  boundaryKey: string | null,
): ProcessEmployeeCycle | null {
  const merged = numbers.filter(
    (item) =>
      extras.get(item.facts.unit.id)?.bucket === 'merged' && item.facts.unit.endedAt !== null,
  )
  if (merged.length === 0) return null
  const split = merged.flatMap((item) => {
    const at = extras.get(item.facts.unit.id)?.boundaryAt ?? null
    return at === null ? [] : [{ item, at }]
  })
  return {
    sampleUnits: merged.length,
    beforeBoundaryMs: median(
      split.map(({ item, at }) => Math.max(0, at - item.facts.unit.startedAt)),
    ),
    afterBoundaryMs: median(
      split.map(({ item, at }) => Math.max(0, item.facts.unit.endedAt! - at)),
    ),
    waitMs: median(merged.map((item) => item.time.waitMs)),
    boundaryKey: split.length > 0 ? boundaryKey : null,
  }
}

export function employeeSummary(input: {
  readonly frame: SummaryFrame
  readonly load: EmployeeLoad
  readonly current: readonly ProcessUnitNumbers[]
  readonly baseline: readonly ProcessUnitNumbers[] | null
  readonly baselineExtras: ReadonlyMap<string, EmployeeUnitExtras> | null
  readonly people: boolean
  readonly now: number
}): ProcessEmployeeSummary {
  const { load, current, baseline, now } = input
  const facts = current.map((item) => item.facts)
  const extra = (item: ProcessUnitNumbers) => load.extras.get(item.facts.unit.id)
  // The responsibility map follows the newest case's type revision.
  const typeKey = current.map(extra).find((value) => value !== undefined)?.typeKey ?? null
  const manifest = typeKey === null ? null : (load.manifests.get(typeKey) ?? null)
  const reworkRefs = new Set(manifest?.reworkWorkItemRefs ?? [])
  const stages = manifestStages(manifest)
  const known = new Set(stages.map((stage) => stage.key))
  let order = stages.length
  for (const unit of facts) {
    for (const execution of unit.executions) {
      if (known.has(execution.stageKey)) continue
      known.add(execution.stageKey)
      // A work item the newest manifest no longer lists: keep it, by its reference. Without a
      // manifest every work item comes this way, and none of them was removed from anything.
      stages.push({
        key: execution.stageKey,
        label: execution.stageKey,
        kind: 'work-item-system',
        parentKey: null,
        order: 1e9 + order++,
        removed: manifest !== null,
      })
    }
  }
  const rows = stageRowsOf({ stages, numbers: current, now })
  const itemById = new Map((manifest?.workItems ?? []).map((item) => [item.workItemRef, item]))
  const roundMs = new Map<string, number[]>()
  const roundsByItem = new Map<string, { rounds: number; attempts: number }>()
  for (const item of current) {
    for (const [key, values] of extra(item)?.roundMs ?? []) {
      const list = roundMs.get(key)
      if (list) list.push(...values)
      else roundMs.set(key, [...values])
    }
    for (const execution of item.facts.executions) {
      const entry = roundsByItem.get(execution.stageKey) ?? { rounds: 0, attempts: 0 }
      if (execution.cause === 'first') entry.rounds += execution.runs
      else entry.attempts += execution.runs
      roundsByItem.set(execution.stageKey, entry)
    }
  }
  const workItems: ProcessWorkItemRow[] = rows.map((row) => {
    const counts = roundsByItem.get(row.key) ?? { rounds: 0, attempts: 0 }
    return {
      key: row.key,
      label: row.label,
      kind: row.kind,
      regionId: itemById.get(row.key)?.regionId ?? null,
      // A region that declares no lanes gives its work items the empty lane id.
      laneId: itemById.get(row.key)?.laneId || null,
      order: row.order,
      rework: reworkRefs.has(row.key),
      units: row.units,
      roundsPerUnit: ratio(counts.rounds, row.units),
      roundMs: statOf(roundMs.get(row.key) ?? []),
      attemptsPerRound: ratio(counts.rounds + counts.attempts, counts.rounds),
      tokensPerUnit: row.tokensPerUnit,
      failureRate: row.failureRate,
      autoRetryRate: row.autoRetryRate,
      gateRoundsPerUnit: row.gateRoundsPerUnit,
      gateWaitMsPerUnit: row.gateWaitMsPerUnit,
    }
  })

  const time = timeSplitOf(current)
  const topWait = topWaitOf(time)
  const metrics = { ...commonMetrics(current), ...employeeMetrics(current, load.extras) }
  const blockedDurations = gateDurationsOf(facts, 'blocked')
  const blockedUnits = current.filter((item) => (extra(item)?.blockedSpans ?? 0) > 0)
  const reasons = new Map<string, number>()
  for (const item of current) {
    const reason = extra(item)?.blockReason
    if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const ended = current.filter((item) => item.facts.unit.status !== 'active')
  const feedback = ended.flatMap((item) => {
    const value = extra(item)?.feedback
    return value == null ? [] : [value]
  })
  const approvalWaits = gateDurationsOf(facts, 'approval')
  const operations = facts.flatMap((unit) => unit.operations)
  const totals = stageTotalsOf(current, now).totals
  const hints = hintsOf({
    kind: 'digital-employee',
    units: current.length,
    succeededUnits: current.filter((item) => item.facts.unit.status === 'succeeded').length,
    waitShare: waitShareOf(current),
    topWaitKind: topWait.kind,
    topWaitShare: topWait.share,
    gates: gateHintFacts(facts, ['review', 'clarify', 'approval', 'blocked']),
    stages: stageHintFacts(totals, (key) => ({
      roundsPerUnit: workItems.find((item) => item.key === key)?.roundsPerUnit ?? null,
    })),
    reworkTokenShare: null,
    reworkTokens: 0,
    reworkCostNano: 0,
    clarify: null,
    firstPassRate: metrics.firstPassRate ?? null,
    firstPassUnits: firstPassUnitsOf(current),
    coordinationShare: null,
    completion: null,
    delivery: null,
    blocked: {
      rate: metrics.blockedRate ?? null,
      p50: statOf(blockedDurations).p50,
      current: [...reasons.values()].reduce((count, value) => count + value, 0),
    },
  })
  return {
    ...baseSummary(input.frame, current, baseline, {
      metrics: employeeMetrics(current, load.extras),
      baselineMetrics:
        baseline === null ? null : employeeMetrics(baseline, input.baselineExtras ?? load.extras),
      hints,
      // A revision split divides the range's own units, so the picker lists both groups;
      // a period comparison's baseline belongs to another range and stays out of it.
      revisionUnits:
        input.frame.compare.mode === 'version' ? [...current, ...(baseline ?? [])] : current,
    }),
    kind: 'digital-employee',
    typeId: manifest?.typeId ?? null,
    typeRevision: manifest?.typeRevision ?? null,
    outcomes: outcomesOf(current, load.extras),
    cycle: cycleOf(current, load.extras, boundaryWorkItemOf(manifest)),
    firstPassApplicable: (manifest?.reworkWorkItemRefs ?? null) !== null,
    regions: manifest?.regions ?? [],
    workItems,
    review: reviewSummaryOf(facts, { people: input.people }),
    feedbackPerUnit: mean(feedback),
    approvals: {
      perUnit: ratio(sum(ended.map((item) => item.gateRounds.get('approval') ?? 0)), ended.length),
      waitMs: statOf(approvalWaits),
    },
    blocked: {
      units: blockedUnits.length,
      perUnit: ratio(sum(current.map((item) => extra(item)?.blockedSpans ?? 0)), current.length),
      durationMs: statOf(blockedDurations),
      resumes: operations.filter((operation) => operation.action === 'employee-case.resume').length,
      terminations: operations.filter((operation) => operation.action === 'employee-case.terminate')
        .length,
      current: [...reasons]
        .map(([reason, units]) => ({ reason, units }))
        .sort((a, b) => b.units - a.units || a.reason.localeCompare(b.reason)),
    },
  }
}

/** One listing row per digital employee among the units. */
export function employeeSubjectRows(
  numbers: readonly ProcessUnitNumbers[],
  load: EmployeeLoad,
): ProcessSubjectRow[] {
  const bySubject = groupBy(numbers, (item) => item.facts.unit.subjectId ?? '')
  return [...bySubject].map(([key, items]): ProcessSubjectRow => {
    const metrics = { ...commonMetrics(items), ...employeeMetrics(items, load.extras) }
    return {
      subjectId: key === '' ? null : key,
      name: load.names.get(key) ?? null,
      units: items.length,
      successRate: metrics.successRate ?? null,
      leadP50: metrics.leadP50 ?? null,
      waitShare: waitShareOf(items),
      tokensPerUnit: metrics.tokensPerUnit ?? null,
      costNanoPerUnit: metrics.costNanoPerUnit ?? null,
      unpriced: anyUnpriced(items),
      interventionsPerUnit: metrics.interventionsPerUnit ?? null,
      firstPassRate: metrics.firstPassRate ?? null,
      mode: null,
      roundsPerUnit: null,
      assignmentsPerUnit: null,
      coordinationShare: null,
      mergeRate: metrics.mergeRate ?? null,
      blockedRate: metrics.blockedRate ?? null,
    }
  })
}

export { manifestStages as employeeStagesOf }
