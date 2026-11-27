// RFC-616 §6.1 — workflows. A unit is a task; a stage is a canvas node.

import {
  PROCESS_ORIGINS,
  type ProcessMetricId,
  type ProcessOrigin,
  type ProcessSubjectRow,
  type ProcessUnitStageRow,
  type ProcessWorkflowSummary,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { ProcessTaskUnitRow } from '@/platform/contracts/processFacts'
import {
  clarifySummaryOf,
  mindmapSummaryOf,
  reviewSummaryOf,
} from '../../../domain/process/gateSummary'
import { hintsOf } from '../../../domain/process/hints'
import { unitEnded, type ProcessStage, type ProcessUnitFacts } from '../../../domain/process/model'
import {
  completeStages,
  workflowStageCatalog,
  type WorkflowStageCatalog,
} from '../../../domain/process/stages'
import { stageRowsOf, stageTotalsOf } from '../../../domain/process/stageSummary'
import { gateSpan, unionLength } from '../../../domain/process/timeline'
import {
  anyUnpriced,
  commonMetrics,
  timeSplitOf,
  waitShareOf,
  type ProcessUnitNumbers,
} from '../../../domain/process/unitSummary'
import { loadTaskBundle, type ProcessDepth, type ProcessSources } from '../sources'
import {
  baseSummary,
  clarifyHintFacts,
  firstPassUnitsOf,
  gateHintFacts,
  reworkTokensOf,
  stageHintFacts,
  topWaitOf,
  type SummaryFrame,
} from '../summaryBase'
import { taskUnitFacts, unitOfTask } from './taskUnits'

export interface WorkflowLoad {
  readonly facts: readonly ProcessUnitFacts[]
  /** null at list depth: stages are the raw node ids there. */
  readonly catalog: WorkflowStageCatalog | null
  readonly definition: WorkflowDefinition | null
  /** Follow-up generation calls, by the unit that made them. */
  readonly followups: ReadonlyMap<
    string,
    readonly { readonly durationMs: number | null; readonly tokens: number }[]
  >
}

/** Stage keys anything of the units refers to. */
export function referencedStages(facts: readonly ProcessUnitFacts[]): Set<string> {
  const keys = new Set<string>()
  for (const unit of facts) {
    for (const execution of unit.executions) keys.add(execution.stageKey)
    for (const slice of unit.usage) keys.add(slice.stageKey)
    for (const gate of unit.gates) keys.add(gate.stageKey)
    for (const wrapper of unit.wrappers) keys.add(wrapper.stageKey)
  }
  return keys
}

export async function loadWorkflowUnits(
  sources: ProcessSources,
  rows: readonly ProcessTaskUnitRow[],
  depth: ProcessDepth,
): Promise<WorkflowLoad> {
  const taskIds = rows.map((row) => row.taskId)
  const [bundle, usageSince] = await Promise.all([
    loadTaskBundle(sources, taskIds, depth),
    sources.calls.usageSince(),
  ])
  let catalog: WorkflowStageCatalog | null = null
  let definition: WorkflowDefinition | null = null
  if (depth === 'full') {
    // Rows are newest first: the catalogue and the canvas follow the newest unit's frozen definition.
    definition = rows[0] ? await sources.tasks.definition(rows[0].taskId) : null
    const executed = new Set<string>()
    for (const runs of bundle.nodeRuns.values()) for (const run of runs) executed.add(run.nodeId)
    for (const wrappers of bundle.wrappers.values())
      for (const wrapper of wrappers) executed.add(wrapper.nodeId)
    for (const taskId of taskIds) {
      for (const gate of bundle.gates.get(taskId) ?? []) {
        executed.add(gate.stageNodeId)
        if (gate.relatedNodeId !== null) executed.add(gate.relatedNodeId)
      }
      for (const descendant of bundle.descendants.get(taskId) ?? []) {
        if (descendant.callNodeId !== null) executed.add(descendant.callNodeId)
      }
    }
    catalog = workflowStageCatalog(definition, executed)
  }
  const stageOfNode = catalog?.stageOf ?? ((nodeId: string) => nodeId)
  const facts = rows.map((row) =>
    taskUnitFacts({
      unit: unitOfTask(row),
      bundle,
      depth,
      usageSince,
      resolvers: { stageOfNode },
    }),
  )
  const followups = new Map(
    taskIds.map((taskId) => [
      taskId,
      (bundle.followups.get(taskId) ?? []).map((call) => ({
        durationMs: call.endedAt === null ? null : Math.max(0, call.endedAt - call.startedAt),
        tokens: call.tokens,
      })),
    ]),
  )
  return { facts, catalog, definition, followups }
}

function stagesOf(load: WorkflowLoad, facts: readonly ProcessUnitFacts[]): ProcessStage[] {
  return completeStages(
    load.catalog?.stages ?? [],
    referencedStages(facts),
    load.definition !== null,
  )
}

export function workflowSummary(input: {
  readonly frame: SummaryFrame
  readonly load: WorkflowLoad
  readonly current: readonly ProcessUnitNumbers[]
  readonly baseline: readonly ProcessUnitNumbers[] | null
  /** Units of the window before the origin filter, for the origin counts. */
  readonly originRows: readonly { readonly origin: ProcessOrigin }[]
  readonly people: boolean
  readonly now: number
}): ProcessWorkflowSummary {
  const { load, current, baseline, now } = input
  const facts = current.map((item) => item.facts)
  const stages = stagesOf(load, [...facts, ...(baseline ?? []).map((item) => item.facts)])
  const rows = stageRowsOf({
    stages,
    numbers: current,
    loops: load.catalog?.loops,
    baseline,
    now,
  })
  const review = reviewSummaryOf(facts, { people: input.people })
  const clarify = clarifySummaryOf(facts, { people: input.people })
  const mindmap = mindmapSummaryOf(facts, {
    // Of the units being described: under a revision split the load holds both groups.
    followups: facts.flatMap((unit) => load.followups.get(unit.unit.id) ?? []),
    categories: load.catalog?.mindmapCategories ?? new Map(),
  })
  const time = timeSplitOf(current)
  const topWait = topWaitOf(time)
  const rework = reworkTokensOf(current)
  const metrics = commonMetrics(current)
  const loopRows = new Map(rows.filter((row) => row.loop !== null).map((row) => [row.key, row]))
  // The invocations the cap rate is a share of: those of ended units (stageSummary's loop facts).
  const loopRuns = new Map<string, number>()
  for (const unit of facts) {
    if (!unitEnded(unit.unit)) continue
    for (const wrapper of unit.wrappers) {
      loopRuns.set(wrapper.stageKey, (loopRuns.get(wrapper.stageKey) ?? 0) + 1)
    }
  }
  const hints = hintsOf({
    kind: 'workflow',
    units: current.length,
    succeededUnits: current.filter((item) => item.facts.unit.status === 'succeeded').length,
    waitShare: waitShareOf(current),
    topWaitKind: topWait.kind,
    topWaitShare: topWait.share,
    gates: gateHintFacts(facts, ['review', 'clarify']),
    stages: stageHintFacts(stageTotalsOf(current, now).totals, (key) => {
      const loop = loopRows.get(key)?.loop
      return loop
        ? {
            loopRuns: loopRuns.get(key) ?? 0,
            loopCapRate: loop.capRate,
            loopRoundsMean: loop.roundsMean,
          }
        : {}
    }),
    reworkTokenShare: rework.share,
    reworkTokens: rework.tokens,
    reworkCostNano: rework.costNano,
    clarify: clarifyHintFacts(clarify),
    firstPassRate: metrics.firstPassRate ?? null,
    firstPassUnits: firstPassUnitsOf(current),
    coordinationShare: null,
    completion: null,
    delivery: null,
    blocked: null,
  })
  const originCounts = new Map<ProcessOrigin, number>()
  for (const row of input.originRows) {
    originCounts.set(row.origin, (originCounts.get(row.origin) ?? 0) + 1)
  }
  return {
    ...baseSummary(input.frame, current, baseline, {
      metrics: {},
      baselineMetrics: baseline === null ? null : {},
      hints,
      // A revision split divides the range's own units, so the picker lists both groups;
      // a period comparison's baseline belongs to another range and stays out of it.
      revisionUnits:
        input.frame.compare.mode === 'version' ? [...current, ...(baseline ?? [])] : current,
    }),
    kind: 'workflow',
    origins: PROCESS_ORIGINS.filter((origin) => originCounts.has(origin)).map((origin) => ({
      origin,
      units: originCounts.get(origin)!,
    })),
    stages: rows,
    definition: load.definition,
    review,
    clarify,
    mindmap,
  }
}

const perUnitMetric = (
  metrics: Partial<Record<ProcessMetricId, number | null>>,
  id: ProcessMetricId,
): number | null => metrics[id] ?? null

/** One listing row per workflow among the units. */
export function workflowSubjectRows(
  numbers: readonly ProcessUnitNumbers[],
  names: ReadonlyMap<string, string>,
): ProcessSubjectRow[] {
  const bySubject = new Map<string, ProcessUnitNumbers[]>()
  for (const item of numbers) {
    const key = item.facts.unit.subjectId ?? ''
    const list = bySubject.get(key)
    if (list) list.push(item)
    else bySubject.set(key, [item])
  }
  return [...bySubject].map(([key, items]): ProcessSubjectRow => {
    const metrics = commonMetrics(items)
    return {
      subjectId: key === '' ? null : key,
      name: key === '' ? null : (names.get(key) ?? null),
      units: items.length,
      successRate: perUnitMetric(metrics, 'successRate'),
      leadP50: perUnitMetric(metrics, 'leadP50'),
      waitShare: waitShareOf(items),
      tokensPerUnit: perUnitMetric(metrics, 'tokensPerUnit'),
      costNanoPerUnit: perUnitMetric(metrics, 'costNanoPerUnit'),
      unpriced: anyUnpriced(items),
      interventionsPerUnit: perUnitMetric(metrics, 'interventionsPerUnit'),
      firstPassRate: perUnitMetric(metrics, 'firstPassRate'),
      mode: null,
      roundsPerUnit: null,
      assignmentsPerUnit: null,
      coordinationShare: null,
      mergeRate: null,
      blockedRate: null,
    }
  })
}

/** The stages of one unit, for its expanded row. */
export function unitStageRows(
  stages: readonly ProcessStage[],
  facts: ProcessUnitFacts,
  now: number,
): ProcessUnitStageRow[] {
  const end = Math.max(facts.unit.startedAt, facts.unit.endedAt ?? now)
  return [...stages]
    .sort((a, b) => a.order - b.order)
    .map((stage): ProcessUnitStageRow => {
      const executions = facts.executions.filter((item) => item.stageKey === stage.key)
      const gates = facts.gates.filter((gate) => gate.stageKey === stage.key)
      const wrapperMs = facts.wrappers
        .filter((wrapper) => wrapper.stageKey === stage.key && wrapper.durationMs !== null)
        .reduce((total, wrapper) => total + (wrapper.durationMs ?? 0), 0)
      return {
        key: stage.key,
        label: stage.label,
        kind: stage.kind,
        parentKey: stage.parentKey,
        removed: stage.removed,
        runs: executions.reduce((total, item) => total + item.runs, 0),
        failedRuns: executions.reduce((total, item) => total + item.failedRuns, 0),
        autoRetries: executions
          .filter((item) => item.cause === 'auto-retry')
          .reduce((total, item) => total + item.runs, 0),
        durationMs:
          wrapperMs > 0 ? wrapperMs : executions.reduce((total, item) => total + item.activeMs, 0),
        tokens: facts.usage
          .filter((slice) => slice.stageKey === stage.key)
          .reduce((total, slice) => total + slice.tokens, 0),
        gateRounds: gates.filter((gate) => !gate.void && gate.closedAt !== null).length,
        // The time the unit waited here, as in the summary: two rounds open at once are waited
        // for once, not twice.
        gateWaitMs: unionLength(
          gates.flatMap((gate) => {
            const span = gateSpan(gate, facts.unit.startedAt, end)
            return span === null ? [] : [span]
          }),
        ),
        comments: gates.reduce((total, gate) => total + (gate.measures.comments ?? 0), 0),
        questions: gates.reduce((total, gate) => total + (gate.measures.questions ?? 0), 0),
      }
    })
    .filter(
      (row) =>
        row.runs > 0 ||
        // A wrapper has no runs of its own, only the span of its invocations.
        row.durationMs > 0 ||
        row.gateRounds > 0 ||
        row.gateWaitMs > 0 ||
        row.tokens > 0,
    )
}

export { stagesOf as workflowStagesOf }
