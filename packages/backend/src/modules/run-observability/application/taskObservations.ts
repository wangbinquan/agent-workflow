import type {
  AcceptedObservationInvocation,
  ObservationAgentSummary,
  ObservationAttemptFacts,
  ObservationMetrics,
  ObservationOverview,
  ObservationOverviewQuery,
  ObservationTaskDetail,
  ObservationTaskFacts,
  ObservationTaskPage,
  ObservationTaskPageQuery,
  ObservationTaskSummary,
  ObservationDimensionSelection,
  ObservationModelIdentity,
} from '@agent-workflow/shared'
import { observationRuntimeKey } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { sumCnyAmounts } from '../domain/cnyPricing'
import { intervalDurations } from '../domain/executionIntervals'
import type { PlatformObservation } from '../domain/platformObservation'
import { platformObservationKey, type PlatformSyncState } from '../domain/platformSync'
import { platformCaptureEvidence } from '../domain/platformCapture'
import { summarizeTokenUsage, TOKEN_BUCKETS } from '../domain/tokenUsage'
import { selectUsageContributions, type UsageContributionEvidence } from '../domain/usageSelection'
import type { ObservationSnapshot, ObservationSnapshotSources } from '../ports/taskObservations'
import { readObservationOverview, type ObservationAnalysisTask } from './observationOverview'
import { readDimensionTasks } from './dimensionTasks'
import { createTaskSpanQuery } from './taskSpans'
import {
  parseObservationSelection,
  invocationRuntimeIdentity,
  invocationDimensionMatch,
  modelDimensionMatch,
} from '../domain/analysisDimensions'

type Invocation = AcceptedObservationInvocation
type PlatformUsage = Extract<PlatformObservation, { kind: 'usage' }>
type PlatformValue = Extract<PlatformObservation, { kind: 'valuation' }>
type Contribution = UsageContributionEvidence & {
  readonly observedAt: number
  readonly localModel: { readonly provider: string | null; readonly id: string } | null
  readonly platformUsage?: PlatformUsage
  readonly platformValue?: PlatformValue
}
interface ValuedContribution {
  readonly record: Contribution
  readonly amount: string | null
  readonly complete: boolean
  readonly price: string | null
  readonly reason: string | null
}
interface InvocationSummary {
  readonly invocation: Invocation
  readonly records: readonly ValuedContribution[]
  readonly complete: boolean
  readonly reasons: readonly string[]
  readonly knownZero?: boolean
  readonly emptyCostVisible?: boolean
}
const RECORD_LIMIT = 10_000
const sourceIdentity = (invocation: Invocation) => {
  const a = invocation.authority
  return a.kind === 'local' || a.sourceId === null
    ? null
    : {
        sourceId: a.sourceId,
        projectId: a.projectId,
        taskId: a.taskId,
      }
}
const sourceKey = (value: NonNullable<ReturnType<typeof sourceIdentity>>) =>
  JSON.stringify([value.sourceId, value.projectId, value.taskId])
function belongsTo(item: PlatformObservation, invocation: Invocation): boolean {
  const a = invocation.authority,
    i = item.identity
  return (
    a.kind === 'crewstation' &&
    i.projectId === a.projectId &&
    i.taskId === a.taskId &&
    i.subtaskId === a.subtaskId &&
    i.executionId === a.executionResourceId &&
    i.executionGeneration === a.executionGeneration
  )
}
function platformContribution(
  item: PlatformUsage,
  invocation: Invocation,
  value?: PlatformValue,
): Contribution {
  return {
    sourceId: item.sourceId,
    observedAt: Date.parse(item.observedAt),
    measurement: {
      invocationId: invocation.invocationId,
      recordId: item.recordId,
      // Opaque equality only, never parsed or exposed as a provider/model name.
      model: item.modelRef === null ? null : { provider: null, id: item.modelRef },
      ...(item.scope === null ? {} : { scope: item.scope }),
      ...(item.coveredThroughTurn === null ? {} : { coveredThroughTurn: item.coveredThroughTurn }),
    },
    contribution: item.projection.contribution,
    complete: item.projection.complete,
    ...(item.projection.coveredThrough === null
      ? {}
      : { coveredThrough: item.projection.coveredThrough }),
    localModel: null,
    platformUsage: item,
    ...(value === undefined ? {} : { platformValue: value }),
  }
}

async function valueRecord(
  record: Contribution,
  invocation: Invocation,
  sources: ObservationSnapshotSources,
): Promise<ValuedContribution> {
  if (invocation.authority.kind === 'local') {
    const result = await sources.value({
      invocationId: invocation.invocationId,
      model: record.localModel,
      condition: null,
      usage: record.contribution,
    })
    return {
      record,
      amount: result.amountDecimal,
      complete: result.completeness === 'complete',
      price: result.priceVersionId,
      reason:
        result.availability === 'priced'
          ? result.completeness === 'complete'
            ? null
            : 'partial-price'
          : result.availability,
    }
  }
  const value = record.platformValue
  // CS amounts value a whole canonical record. A bucket allocation is not a
  // licence to prorate its amount, or to use an AW rate to fill the difference.
  const wholeRecord = TOKEN_BUCKETS.every(
    (bucket) =>
      record.contribution[bucket] === record.platformUsage!.projection.contribution[bucket],
  )
  if (!wholeRecord)
    return { record, amount: null, complete: false, price: null, reason: 'partial-allocation' }
  if (value === undefined)
    return { record, amount: null, complete: false, price: null, reason: 'pending' }
  return {
    record,
    amount: value.amountDecimal,
    complete: value.availability === 'priced' && value.completeness === 'complete',
    price: value.priceVersionRef,
    reason:
      value.availability === 'priced'
        ? value.completeness === 'complete'
          ? null
          : 'partial-price'
        : value.availability,
  }
}

async function loadTask(sources: ObservationSnapshotSources, taskId: string) {
  const accepted = await sources.invocations(taskId)
  const captures = new Map(
    (
      await sources.local.captures(
        accepted.items.filter((i) => i.authority.kind === 'local').map((i) => i.invocationId),
      )
    ).map((row) => [row.invocationId, row]),
  )
  const nativeCaptures: NonNullable<ObservationTaskDetail['nativeCaptures']>[number][] = []
  const platformCaptures: NonNullable<ObservationTaskDetail['platformCaptures']>[number][] = []
  let truncated = accepted.truncated
  const local: Contribution[] = []
  if (accepted.items.some((i) => i.authority.kind === 'local')) {
    const byId = new Map(
      accepted.items.filter((i) => i.authority.kind === 'local').map((i) => [i.invocationId, i]),
    )
    let after: string | undefined,
      scanned = 0
    do {
      const page = await sources.local.records(taskId, {
        limit: Math.min(500, RECORD_LIMIT - scanned),
        ...(after ? { after } : {}),
      })
      scanned += page.items.length
      for (const record of page.items) {
        const m = record.measurement,
          owner = byId.get(m.invocationId)
        if (
          owner &&
          m.taskId === owner.taskId &&
          m.nodeRunId === owner.nodeRunId &&
          m.agentId === owner.agentId
        )
          local.push({
            ...record,
            localModel: m.model,
            observedAt: m.observedAt,
          })
      }
      after = page.nextCursor
    } while (after && scanned < RECORD_LIMIT)
    truncated ||= after !== undefined
  }
  const bindings = new Map<string, NonNullable<ReturnType<typeof sourceIdentity>>>()
  for (const invocation of accepted.items) {
    const binding = sourceIdentity(invocation)
    if (binding) bindings.set(sourceKey(binding), binding)
  }
  const platform = new Map<string, PlatformObservation[]>(),
    states = new Map<string, PlatformSyncState>()
  let scanned = 0
  for (const [key, binding] of bindings) {
    const items: PlatformObservation[] = []
    let after: string | undefined
    do {
      if (scanned >= RECORD_LIMIT) {
        truncated = true
        break
      }
      const page = await sources.platform.records(binding, {
        limit: Math.min(500, RECORD_LIMIT - scanned),
        ...(after ? { after } : {}),
      })
      scanned += page.items.length
      states.set(key, page.state)
      items.push(...page.items)
      after = page.nextCursor
    } while (after)
    platform.set(key, items)
  }
  const invocations: InvocationSummary[] = []
  for (const invocation of accepted.items) {
    const binding = sourceIdentity(invocation),
      reasons: string[] = []
    let knownZero = false,
      emptyCostVisible = false
    let records = local.filter((r) => r.measurement.invocationId === invocation.invocationId)
    // Completeness follows the accepted capability and its durable proof. A
    // runtime name or a root-only adapter cannot prove descendant coverage.
    if (invocation.authority.kind === 'local') {
      const capture = captures.get(invocation.invocationId)
      const currentIssues =
        capture?.capture.issues.filter(
          (issue) =>
            capture.priorRevisionGap ||
            !['native-prior-revision-gap', 'native-prior-revision-budget'].includes(issue),
        ) ?? []
      const state = !invocation.nativeCaptureContract
        ? 'unobserved'
        : !capture
          ? 'pending'
          : capture.priorRevisionGap || currentIssues.length
            ? 'partial'
            : (
                  capture.capture.contract === 'opencode-child-pages-v2' ||
                  capture.capture.contract === 'opencode-child-root-pages-v3'
                    ? capture.capture.state === 'complete'
                    : capture.capture.snapshotFingerprint !== null
                )
              ? 'complete'
              : 'partial'
      nativeCaptures.push({
        invocationId: invocation.invocationId,
        nodeRunId: invocation.nodeRunId,
        state,
        priorRevisionGap: capture?.priorRevisionGap ?? false,
        proof: capture?.capture ?? null,
        issues: currentIssues,
        revisions: capture?.resolutions ?? [],
      })
      if (state !== 'complete') reasons.push('native-capture-' + state)
      if (capture?.priorRevisionGap) reasons.push('native-prior-revision-gap')
      if (capture) reasons.push(...currentIssues)
    }
    if (invocation.authority.kind === 'crewstation') {
      records = []
      if (!binding) reasons.push('legacy-unbound')
      else {
        const key = sourceKey(binding),
          items = (platform.get(key) ?? []).filter((item) => belongsTo(item, invocation))
        const values = new Map(
          items
            .filter((item): item is PlatformValue => item.kind === 'valuation')
            .map((item) => [platformObservationKey(item, 'usage'), item]),
        )
        records = items
          .filter((item): item is PlatformUsage => item.kind === 'usage')
          .map((item) =>
            platformContribution(item, invocation, values.get(platformObservationKey(item))),
          )
        const state = states.get(key)
        const evidence = platformCaptureEvidence(items, state)
        reasons.push(...evidence.reasons)
        knownZero = evidence.knownZero && !truncated
        emptyCostVisible = knownZero && evidence.emptyCostVisible
        if (knownZero && !emptyCostVisible)
          reasons.push(state?.costVisibility === 'hidden' ? 'not-authorized' : 'pending')
        for (const capture of evidence.captures.length ? evidence.captures : [null])
          platformCaptures.push({
            invocationId: invocation.invocationId,
            nodeRunId: invocation.nodeRunId,
            sourceId: binding.sourceId,
            schemaVersion: state?.schemaVersion ?? 1,
            capture,
            issues: evidence.reasons,
          })
      }
    }
    let selected: Contribution[] = [],
      complete = false
    try {
      const selection = selectUsageContributions(records)
      selected = selection.records
      complete = selection.allSelectedComplete
      if (selection.ambiguousOverlaps || selection.unavailableSummaries)
        reasons.push('coverage-partial')
    } catch {
      // Conflicting native ancestry has no defensible disjoint sum.
      reasons.push('coverage-conflict')
    }
    const valued: ValuedContribution[] = []
    for (const record of selected) valued.push(await valueRecord(record, invocation, sources))
    invocations.push({
      invocation,
      records: valued,
      complete: complete || knownZero,
      reasons,
      knownZero,
      emptyCostVisible,
    })
  }
  const sourceStates: ObservationTaskDetail['sources'][number][] = [...states.values()].map(
    (s) => ({
      sourceId: s.binding.sourceId,
      platformProjectId: s.binding.projectId,
      platformTaskId: s.binding.taskId,
      status: s.status,
      asOf: s.asOf,
      error: s.error,
      costsVisible: s.costVisibility !== 'hidden' && s.costsReady,
      hasGaps: s.gaps.length > 0,
    }),
  )
  if (
    accepted.items.some((i) => i.authority.kind === 'crewstation' && i.authority.sourceId === null)
  )
    sourceStates.push({
      sourceId: '',
      platformProjectId: null,
      platformTaskId: null,
      status: 'legacy-unbound',
      asOf: null,
      error: null,
      costsVisible: false,
      hasGaps: false,
    })
  return { invocations, truncated, sources: sourceStates, nativeCaptures, platformCaptures }
}

/** Reuse the original contribution selection and CNY valuation; never price a span twice. */
export async function loadTaskSpanContributions(
  sources: ObservationSnapshotSources,
  taskId: string,
) {
  const loaded = await loadTask(sources, taskId)
  return {
    truncated: loaded.truncated,
    records: loaded.invocations.flatMap((row) =>
      row.records.map((record) => ({
        invocationId: row.invocation.invocationId,
        recordId: record.record.measurement.recordId,
        usage: record.record.contribution,
        amountDecimal: record.amount,
        costComplete: record.complete,
      })),
    ),
  }
}

/** Token coverage is independent of a proven-empty tree's CNY visibility/readiness. */
function invocationCoverageComplete(row: InvocationSummary): boolean {
  return (
    row.complete &&
    row.reasons.every((reason) => row.knownZero && ['not-authorized', 'pending'].includes(reason))
  )
}

function metrics(
  invocations: readonly InvocationSummary[],
  truncated: boolean,
): ObservationMetrics {
  const rows = invocations.flatMap((i) => i.records),
    tokens = summarizeTokenUsage(rows.map((r) => r.record.contribution))
  const observedInvocations = invocations.filter((i) => i.records.length > 0 || i.knownZero).length
  const complete =
    invocations.length > 0 &&
    observedInvocations === invocations.length &&
    !truncated &&
    invocations.every(invocationCoverageComplete)
  const amounts = rows.flatMap((r) => (r.amount === null ? [] : [r.amount]))
  return {
    invocations: invocations.length,
    observedInvocations,
    records: rows.length,
    tokens: {
      known: tokens.known,
      totalKnown: tokens.totalKnown,
      hasKnown:
        invocations.some((i) => i.knownZero) ||
        rows.some((r) => TOKEN_BUCKETS.some((b) => r.record.contribution[b] !== null)),
      complete,
      hasKnownBuckets: {
        input:
          invocations.some((i) => i.knownZero) ||
          rows.some((r) => r.record.contribution.input !== null),
        cacheRead:
          invocations.some((i) => i.knownZero) ||
          rows.some((r) => r.record.contribution.cacheRead !== null),
        cacheWrite:
          invocations.some((i) => i.knownZero) ||
          rows.some((r) => r.record.contribution.cacheWrite !== null),
        output:
          invocations.some((i) => i.knownZero) ||
          rows.some((r) => r.record.contribution.output !== null),
      },
      unknownBuckets: tokens.unknownBuckets,
    },
    cost: {
      currency: 'CNY',
      knownAmount: amounts.length
        ? sumCnyAmounts(amounts)
        : invocations.some((i) => i.emptyCostVisible)
          ? '0'
          : null,
      complete:
        complete &&
        rows.every((r) => r.complete) &&
        invocations.every((i) => !i.knownZero || i.emptyCostVisible),
      pricedRecords: amounts.length,
      priceVersionIds: [...new Set(rows.flatMap((r) => (r.price === null ? [] : [r.price])))],
      reasons: [
        ...new Set([
          ...invocations.flatMap((i) => i.reasons),
          ...rows.flatMap((r) => (r.reason === null ? [] : [r.reason])),
          ...(invocations.some((i) => i.records.length > 0 && !i.complete)
            ? ['usage-partial']
            : []),
          ...(observedInvocations < invocations.length || invocations.length === 0
            ? ['not-observed']
            : []),
          ...(truncated ? ['truncated'] : []),
        ]),
      ],
    },
    authorities: [...new Set(invocations.map((i) => i.invocation.authority.kind))],
    truncated,
  }
}
function taskSummary(
  task: ObservationTaskFacts,
  loaded: Pick<Awaited<ReturnType<typeof loadTask>>, 'invocations' | 'truncated'>,
  asOf: number,
): ObservationTaskSummary {
  const end = Math.min(asOf, task.finishedAt ?? asOf)
  return {
    task,
    metrics: metrics(loaded.invocations, loaded.truncated),
    wallMs: Math.max(0, end - task.startedAt),
    runningMs:
      task.runningMs === null
        ? null
        : task.runningMs + (task.runningSince === null ? 0 : Math.max(0, end - task.runningSince)),
  }
}
function attemptInterval(
  attempt: ObservationAttemptFacts,
  task: ObservationTaskFacts,
  asOf: number,
) {
  const start = attempt.startedAt
  const open =
    attempt.finishedAt === null && attempt.status === 'running' && task.finishedAt === null
  const end = attempt.finishedAt ?? (open ? asOf : null)
  if (start === null || end === null || end < start || start > asOf) return null
  return { start, end: Math.min(end, asOf), open }
}

function agentSummaries(loaded: Awaited<ReturnType<typeof loadTask>>): ObservationAgentSummary[] {
  const groups = new Map<string, InvocationSummary[]>()
  for (const value of loaded.invocations) {
    const i = value.invocation,
      key = JSON.stringify([i.agentId, i.agentRevision, i.purpose])
    const group = groups.get(key) ?? []
    group.push(value)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    agentId: group[0]!.invocation.agentId,
    agentRevision: group[0]!.invocation.agentRevision,
    purpose: group[0]!.invocation.purpose,
    metrics: metrics(group, loaded.truncated),
  }))
}

function usageDimensions(loaded: Awaited<ReturnType<typeof loadTask>>) {
  type Model = Omit<ObservationOverview['models'][number], 'metrics'>
  type Runtime = Omit<
    ObservationOverview['runtimes'][number],
    'metrics' | 'acceptedNames' | 'unnamedInvocations' | 'tasks'
  >
  const models = new Map<string, { value: Model; rows: InvocationSummary[] }>()
  const runtimes = new Map<string, { value: Runtime; rows: InvocationSummary[] }>()
  for (const row of loaded.invocations) {
    const authority = row.invocation.authority
    const value: Runtime = invocationRuntimeIdentity(row.invocation)
    const key = observationRuntimeKey(value),
      group = runtimes.get(key) ?? { value, rows: [] }
    group.rows.push(row)
    runtimes.set(key, group)
    const perModel = new Map<string, { value: Model; records: ValuedContribution[] }>()
    for (const record of row.records) {
      const model: Model = contributionModel(row, record)
      const modelKey = JSON.stringify(model),
        entry = perModel.get(modelKey) ?? { value: model, records: [] }
      entry.records.push(record)
      perModel.set(modelKey, entry)
    }
    if (perModel.size === 0) {
      const value: Model = {
        authority: authority.kind,
        sourceId: authority.kind === 'crewstation' ? authority.sourceId : null,
        provider: null,
        model: null,
      }
      perModel.set(JSON.stringify(value), { value, records: [] })
    }
    for (const [key, entry] of perModel) {
      const group = models.get(key) ?? { value: entry.value, rows: [] }
      group.rows.push({ ...row, records: entry.records })
      models.set(key, group)
    }
  }
  return {
    models: [...models.values()].map(({ value, rows }) => ({
      ...value,
      metrics: metrics(rows, loaded.truncated),
    })),
    runtimes: [...runtimes.values()].map(({ value, rows }) => ({
      ...value,
      acceptedNames: [
        ...new Set(
          rows.flatMap(({ invocation }) => {
            const runtime =
              invocation.authority.kind === 'local' ? invocation.authority.runtime : null
            return runtime?.acceptedName === undefined ? [] : [runtime.acceptedName]
          }),
        ),
      ].sort(),
      ...(value.authority === 'local' && value.registrationId !== null
        ? {
            unnamedInvocations: rows.filter(
              ({ invocation }) =>
                invocation.authority.kind === 'local' &&
                invocation.authority.runtime?.acceptedName === undefined,
            ).length,
          }
        : {}),
      metrics: metrics(rows, loaded.truncated),
    })),
  }
}

function contributionModel(
  row: InvocationSummary,
  record: ValuedContribution,
): ObservationModelIdentity {
  const authority = row.invocation.authority
  return {
    authority: authority.kind,
    sourceId: authority.kind === 'crewstation' ? authority.sourceId : null,
    provider: authority.kind === 'local' ? (record.record.localModel?.provider ?? null) : null,
    model:
      authority.kind === 'local'
        ? (record.record.localModel?.id ?? null)
        : (record.record.platformUsage?.modelRef ?? null),
  }
}

/** Filter only after the complete parent/child contribution selection and original valuation. */
function selectTaskDimensions(
  loaded: Awaited<ReturnType<typeof loadTask>>,
  selection: ObservationDimensionSelection | null,
) {
  if (selection === null) return { loaded, matches: true, unresolved: false }
  const invocations: InvocationSummary[] = []
  let unresolved = loaded.truncated || loaded.invocations.length === 0
  for (const row of loaded.invocations) {
    const identity = invocationDimensionMatch(selection, row.invocation)
    if (identity === 'excluded') continue
    if (identity === 'unresolved') {
      unresolved = true
      invocations.push({
        ...row,
        records: [],
        knownZero: false,
        emptyCostVisible: false,
        complete: false,
        reasons: [...row.reasons, 'dimension-unresolved'],
      })
      continue
    }
    if (selection.model === undefined) {
      invocations.push(row)
      unresolved ||= !invocationCoverageComplete(row)
      continue
    }
    const records = row.records.filter(
      (record) => modelDimensionMatch(selection, contributionModel(row, record)) === 'matched',
    )
    // Complete numeric records do not close durable native/turn/revision capture gaps.
    const uncertain =
      !invocationCoverageComplete(row) ||
      row.records.length === 0 ||
      row.records.some(
        (record) => modelDimensionMatch(selection, contributionModel(row, record)) === 'unresolved',
      )
    if (!records.length && !uncertain) continue
    unresolved ||= uncertain
    // An invocation-wide empty proof does not prove a particular actual model used zero.
    invocations.push({
      ...row,
      records,
      knownZero: false,
      emptyCostVisible: false,
      complete: row.complete && !uncertain,
      reasons: uncertain ? [...row.reasons, 'dimension-unresolved'] : row.reasons,
    })
  }
  return {
    loaded: { ...loaded, invocations },
    matches: invocations.length > 0 || unresolved,
    unresolved,
  }
}

function unresolvedAnalysisTask(task: ObservationTaskFacts, asOf: number): ObservationAnalysisTask {
  return {
    summary: {
      ...taskSummary(task, { invocations: [], truncated: true }, asOf),
      dimensionMatch: 'unresolved',
    },
    agents: [],
    models: [],
    runtimes: [],
    purposes: [],
    sources: [],
    collection: { firstObservedAt: null, lastObservedAt: null, platforms: [] },
  }
}

async function analysisTask(
  sources: ObservationSnapshotSources,
  task: ObservationTaskFacts,
  asOf: number,
  selection: ObservationDimensionSelection | null,
): Promise<ObservationAnalysisTask | null> {
  const original = await loadTask(sources, task.id),
    selected = selectTaskDimensions(original, selection)
  if (!selected.matches) return null
  const loaded = selected.loaded,
    observed = original.invocations
      .flatMap((i) => i.records.map((r) => r.record.observedAt))
      .filter((at) => Number.isSafeInteger(at) && at >= 0 && at <= asOf),
    agents = agentSummaries(loaded),
    purposeGroups = new Map<ObservationAgentSummary['purpose'], InvocationSummary[]>(),
    sourceGroups = new Map<
      string,
      { authority: 'local' | 'crewstation'; sourceId: string | null; rows: InvocationSummary[] }
    >()
  for (const row of loaded.invocations) {
    const purpose = row.invocation.purpose,
      group = purposeGroups.get(purpose) ?? []
    group.push(row)
    purposeGroups.set(purpose, group)
    const authority = row.invocation.authority,
      sourceId = authority.kind === 'crewstation' ? authority.sourceId : null,
      key = JSON.stringify([authority.kind, sourceId]),
      source = sourceGroups.get(key) ?? { authority: authority.kind, sourceId, rows: [] }
    source.rows.push(row)
    sourceGroups.set(key, source)
  }
  return {
    summary: {
      ...taskSummary(task, loaded, asOf),
      ...(selection === null
        ? {}
        : {
            dimensionMatch: selected.unresolved ? ('unresolved' as const) : ('matched' as const),
          }),
    },
    agents,
    purposes: [...purposeGroups].map(([purpose, rows]) => ({
      purpose,
      metrics: metrics(rows, loaded.truncated),
      tasks: [],
    })),
    sources: [...sourceGroups.values()].map(({ authority, sourceId, rows }) => ({
      authority,
      sourceId,
      metrics: metrics(rows, loaded.truncated),
      tasks: [],
    })),
    collection: {
      firstObservedAt: observed.length ? Math.min(...observed) : null,
      lastObservedAt: observed.length ? Math.max(...observed) : null,
      platforms: original.sources,
    },
    ...usageDimensions(loaded),
  }
}

export function createTaskObservationQueries(input: {
  readonly snapshot: ObservationSnapshot
  readonly now: () => number
}) {
  return {
    spans: createTaskSpanQuery(input.snapshot, loadTaskSpanContributions),
    overview: (actor: Actor, query: ObservationOverviewQuery): Promise<ObservationOverview> =>
      input.snapshot.read(async (sources) => {
        const asOf = input.now()
        return readObservationOverview({
          actor,
          query,
          asOf,
          sources,
          summarize: (sources, task) =>
            analysisTask(sources, task, asOf, parseObservationSelection(query.selection)),
          unresolved: (task) => unresolvedAnalysisTask(task, asOf),
        })
      }),
    list: (actor: Actor, query: ObservationTaskPageQuery): Promise<ObservationTaskPage> =>
      input.snapshot.read(async (sources) => {
        const asOf = input.now()
        if (query.selection !== undefined) {
          const selection = parseObservationSelection(query.selection)
          const selected = await readDimensionTasks({
            actor,
            query,
            sources,
            summarize: (sources, task) => analysisTask(sources, task, asOf, selection),
            unresolved: (task) => unresolvedAnalysisTask(task, asOf),
          })
          return {
            items: selected.rows.map((row) => row.summary),
            nextCursor: selected.nextCursor,
            asOf,
            projectionVersion: 1,
            cohort: 'started',
            taskScope: 'direct',
            filtersEcho: query,
            partial: selected.partial,
            scannedTasks: selected.scannedTasks,
            unresolvedTasks: selected.unresolvedTasks,
          }
        }
        const page = await sources.tasks.list({ actor, query })
        const items: ObservationTaskSummary[] = []
        for (const task of page.items)
          items.push(taskSummary(task, await loadTask(sources, task.id), asOf))
        return {
          items,
          nextCursor: page.nextCursor,
          asOf,
          projectionVersion: 1,
          cohort: 'started',
          taskScope: 'direct',
          filtersEcho: query,
        }
      }),
    detail: (actor: Actor, taskId: string): Promise<ObservationTaskDetail | null> =>
      input.snapshot.read(async (sources) => {
        const asOf = input.now(),
          task = await sources.tasks.get(actor, taskId)
        if (!task) return null
        const loaded = await loadTask(sources, taskId),
          facts = await sources.tasks.attempts(taskId, 1000)
        const agents = agentSummaries(loaded)
        const attempts = facts.items.map((attempt) => {
          const group = loaded.invocations.filter((i) => i.invocation.nodeRunId === attempt.id)
          const agents = [
            ...new Map(
              group.map(({ invocation: i }) => [
                JSON.stringify([i.agentId, i.agentRevision]),
                { id: i.agentId, revision: i.agentRevision },
              ]),
            ).values(),
          ]
          return {
            attempt,
            agents,
            metrics: metrics(group, loaded.truncated),
            interval: attemptInterval(attempt, task, asOf),
          }
        })
        const measuredAttempts = attempts.filter((a) => a.metrics.invocations > 0)
        const intervals = measuredAttempts.flatMap((a) => (a.interval === null ? [] : [a.interval]))
        const attemptIds = new Set(attempts.map((a) => a.attempt.id))
        return {
          ...taskSummary(task, loaded, asOf),
          asOf,
          projectionVersion: 1,
          taskScope: 'direct',
          agents,
          runtimes: usageDimensions(loaded).runtimes,
          attempts,
          attemptsTruncated: facts.truncated,
          intervals: {
            ...intervalDurations(intervals, { from: 0, to: asOf, asOf }),
            knownAttempts: intervals.length,
            unknownAttempts: measuredAttempts.filter((a) => a.interval === null).length,
            unlinkedInvocations: loaded.invocations.filter(
              (i) => i.invocation.nodeRunId === null || !attemptIds.has(i.invocation.nodeRunId),
            ).length,
          },
          sources: loaded.sources,
          nativeCaptures: loaded.nativeCaptures,
          platformCaptures: loaded.platformCaptures,
        }
      }),
  }
}
