import type {
  CompleteHistoricalObservationExecution,
  CompleteObservationDimension,
  CompleteObservationInvocation,
  ObservationDimensionSelection,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import { invocationRuntimeIdentity } from '../domain/analysisDimensions'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'
import type { ProjectionOccurrence } from './incrementalObservationWindow'

type Entry = readonly [
  CompleteObservationDimension['kind'],
  ObservationDimensionSelection,
  string | null,
]
/** Aggregates prequalified atomic contributions. Counts are maintained with
 * identity sets; a call with two models is counted once in each matching model. */
export function incrementalObservationDimensions(input: {
  readonly calls: readonly CompleteObservationInvocation[]
  readonly historical: readonly CompleteHistoricalObservationExecution[]
  readonly atoms: readonly QualifiedObservationContribution[]
  readonly tasks: ReadonlyMap<string, ObservationTaskFacts>
  readonly keyOf: (text: string) => string
  readonly mode?: 'cohort' | 'usage'
}) {
  const groups = new Map<
    string,
    {
      dimension: Omit<CompleteObservationDimension, 'metrics' | 'taskCount'>
      fold: CompleteObservationFold
      tasks: Map<string, CompleteObservationFold>
      calls: Set<string>
      references: Map<string, boolean>
    }
  >()
  function add(
    entry: Entry,
    fold: CompleteObservationFold,
    task: ObservationTaskFacts | null,
    callId?: string,
    referenceId?: string,
  ) {
    const [kind, selection, label] = entry,
      key = input.keyOf(JSON.stringify([kind, selection]))
    const group = groups.get(key) ?? {
      dimension: { key, kind, selection, label },
      fold: emptyCompleteObservationFold(),
      tasks: new Map(),
      calls: new Set(),
      references: new Map(),
    }
    if (referenceId && group.references.has(referenceId)) return
    const numeric = { ...fold }
    if (callId) {
      numeric.invocations = group.calls.has(callId) ? '0' : '1'
      numeric.observedInvocations = numeric.invocations === '0' ? '0' : fold.observedInvocations
      group.calls.add(callId)
    }
    if (referenceId) {
      numeric.historicalReferences = group.references.has(referenceId) ? '0' : '1'
      const observed = BigInt(fold.observedHistoricalReferences ?? '0') > 0n
      numeric.observedHistoricalReferences =
        observed && group.references.get(referenceId) !== true ? '1' : '0'
      group.references.set(referenceId, observed || group.references.get(referenceId) === true)
    }
    mergeCompleteObservationFold(group.fold, numeric)
    if (task) {
      const member = group.tasks.get(task.id) ?? emptyCompleteObservationFold()
      mergeCompleteObservationFold(member, numeric)
      group.tasks.set(task.id, member)
    }
    groups.set(key, group)
  }
  const calls = new Map(input.calls.map((call) => [call.invocationId, call])),
    references = new Map(input.historical.map((row) => [row.execution.referenceId, row]))
  for (const call of input.calls) {
    const a = call.authority,
      runtime = invocationRuntimeIdentity(call),
      fold = completeMetricsFold(call.metrics),
      task = input.tasks.get(call.taskId) ?? null
    for (const entry of [
      [
        'agent',
        { agent: { id: call.agentId, revision: call.agentRevision }, purpose: call.purpose },
        call.agentName ?? null,
      ],
      [
        'runtime',
        { runtime },
        a.kind === 'local' ? (a.runtime?.acceptedName ?? null) : 'CrewStation',
      ],
      ['purpose', { purpose: call.purpose }, call.purpose],
      [
        'source',
        { source: { authority: a.kind, sourceId: a.kind === 'local' ? null : a.sourceId } },
        a.kind,
      ],
    ] as Entry[])
      add(entry, fold, task, call.invocationId)
  }
  for (const atom of input.atoms) {
    const row = atom.detail.document as ProjectionOccurrence,
      call = row.invocation === null ? undefined : calls.get(row.invocation.invocationId)
    const task = row.task,
      value = {
        ...atom.fold,
        invocations: '0',
        observedInvocations: '0',
        historicalReferences: '0',
        observedHistoricalReferences: '0',
      }
    if (row.invocation && call) {
      if (input.mode === 'usage' && row.occurrence.occurredAt === null) continue
      const authority = call.authority,
        original = completeMetricsFold(call.metrics)
      const fold = { ...value, gaps: [...value.gaps], observedInvocations: '1' }
      for (const gap of original.gaps) completeObservationGap(fold, gap)
      add(
        [
          'model',
          {
            model: {
              authority: authority.kind,
              sourceId: authority.kind === 'local' ? null : authority.sourceId,
              provider: row.model?.provider ?? null,
              model: row.model?.id ?? null,
            },
          },
          row.model?.id ?? null,
        ],
        fold,
        task,
        call.invocationId,
      )
      continue
    }
    if (row.invocation) continue
    const qualifiedDimensions =
      input.mode === 'usage' && row.occurrence.occurredAt === null
        ? row.unknownDimensions
        : row.dimensions
    if (qualifiedDimensions !== undefined) {
      for (const qualified of qualifiedDimensions) {
        const { kind, selection, label } = qualified.dimension,
          entry: Entry = [kind, selection, label]
        const fold =
          input.mode === 'usage' && row.occurrence.occurredAt === null
            ? {
                ...qualified.fold,
                invocations: '0',
                observedInvocations: '0',
                historicalReferences: '0',
                observedHistoricalReferences: '0',
              }
            : value
        add(entry, fold, task)
        for (const id of row.referenceIds)
          add(
            entry,
            {
              ...emptyCompleteObservationFold(),
              historicalReferences: '1',
              observedHistoricalReferences: '1',
            },
            task,
            undefined,
            id,
          )
      }
      continue
    }
    const candidateEntries = new Map<string, Entry | null>()
    for (const id of row.referenceIds) {
      const reference = references.get(id)
      if (!reference) continue
      const e = reference.execution
      for (const entry of [
        [
          'agent',
          { agent: { id: e.agentId, revision: e.agentRevision }, purpose: e.purpose },
          e.agentName,
        ],
        [
          'runtime',
          {
            runtime: {
              authority: 'local',
              sourceId: null,
              registrationId: e.runtime?.registrationId ?? null,
              configurationRevision: e.runtime?.configurationRevision ?? null,
              protocol: e.runtime?.protocol ?? null,
            },
          },
          e.runtime?.name ?? null,
        ],
        ['purpose', { purpose: e.purpose }, e.purpose],
      ] as Entry[]) {
        const previous = candidateEntries.get(entry[0])
        if (previous === undefined) candidateEntries.set(entry[0], entry)
        else if (previous === null || JSON.stringify(previous[1]) !== JSON.stringify(entry[1]))
          candidateEntries.set(entry[0], null)
      }
    }
    const entries: Entry[] = [...candidateEntries.values()]
      .filter((entry): entry is Entry => entry !== null)
      .concat([
        ['source', { source: { authority: 'local', sourceId: null } }, 'local'],
        [
          'model',
          {
            model: {
              authority: 'local',
              sourceId: null,
              provider: row.model?.provider ?? null,
              model: row.model?.id ?? null,
            },
          },
          row.model?.id ?? null,
        ],
      ] as Entry[])
    for (const entry of entries) {
      add(entry, value, task)
      for (const id of row.referenceIds)
        add(
          entry,
          {
            ...emptyCompleteObservationFold(),
            historicalReferences: '1',
            observedHistoricalReferences: '1',
          },
          task,
          undefined,
          id,
        )
    }
  }
  for (const row of input.historical) {
    const e = row.execution
    if (
      row.referenceRole === 'owner' ||
      row.coveredByAcceptedRecords ||
      e.computeKind === 'non-agent'
    )
      continue
    const original = completeMetricsFold(row.metrics),
      next = emptyCompleteObservationFold()
    next.historicalReferences = '1'
    next.observedHistoricalReferences = original.observedHistoricalReferences ?? '0'
    next.gaps = [...original.gaps]
    const task = e.parentTaskId === null ? null : (input.tasks.get(e.parentTaskId) ?? null)
    for (const entry of [
      [
        'agent',
        { agent: { id: e.agentId, revision: e.agentRevision }, purpose: e.purpose },
        e.agentName,
      ],
      [
        'runtime',
        {
          runtime: {
            authority: 'local',
            sourceId: null,
            registrationId: e.runtime?.registrationId ?? null,
            configurationRevision: e.runtime?.configurationRevision ?? null,
            protocol: e.runtime?.protocol ?? null,
          },
        },
        e.runtime?.name ?? null,
      ],
      ['purpose', { purpose: e.purpose }, e.purpose],
      ['source', { source: { authority: 'local', sourceId: null } }, 'local'],
    ] as Entry[])
      add(entry, next, task, undefined, e.referenceId)
  }
  return [...groups.values()].map((group) => ({
    dimension: {
      ...group.dimension,
      metrics: completeObservationMetrics(group.fold),
      taskCount: String(group.tasks.size),
    } satisfies CompleteObservationDimension,
    memberships: [...group.tasks].map(([id, fold]) => ({
      task: input.tasks.get(id)!,
      metrics: completeObservationMetrics(fold),
    })),
  }))
}
