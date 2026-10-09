import type {
  AcceptedObservationInvocation,
  CompleteObservationAllocation,
  CompleteObservationDimension,
  CompleteObservationMetrics,
  CompleteObservationTask,
  CompleteHistoricalObservationExecution,
  ObservationDimensionSelection,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import { invocationRuntimeIdentity } from '../domain/analysisDimensions'
import {
  addCompleteObservationAllocation,
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type { CompleteObservationCohortInput } from '../ports/completeObservationReport'
import type { CompleteObservationUnallocatedQuality } from '../ports/completeObservationTask'
import type { HistoricalAllocation } from './completeHistoricalObservationAllocation'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'

interface DimensionWorking {
  key: string
  kind: CompleteObservationDimension['kind']
  label: string | null
  selection: ObservationDimensionSelection
  fold: CompleteObservationFold
  taskCount: string
}
interface DimensionMembership {
  group: string
  task: ObservationTaskFacts
  fold: CompleteObservationFold
}
export function completeObservationReportDimensions(input: CompleteObservationCohortInput) {
  const namespace = input.namespace + '/dimensions',
    cache = completeWorkingCache<DimensionWorking>(input.rows, namespace, input.signal)
  const membershipsNamespace = namespace + '/memberships'
  const memberships = completeWorkingCache<DimensionMembership>(
    input.rows,
    membershipsNamespace,
    input.signal,
  )
  const models = completeWorkingCache<boolean>(
    input.rows,
    namespace + '/model-invocations',
    input.signal,
  )
  const historicalReferences = completeWorkingCache<boolean>(
    input.rows,
    namespace + '/historical-references',
    input.signal,
  )
  async function group(
    kind: DimensionWorking['kind'],
    selection: ObservationDimensionSelection,
    label: string | null,
    task: ObservationTaskFacts,
  ) {
    const key = input.keyOf(JSON.stringify([kind, selection]))
    const value = (await cache.get(key)) ?? {
      key,
      kind,
      label,
      selection,
      fold: emptyCompleteObservationFold(),
      taskCount: '0',
    }
    const member = input.keyOf(JSON.stringify([key, task.id]))
    let membership = await memberships.get(member)
    if (membership === undefined) {
      membership = { group: key, task, fold: emptyCompleteObservationFold() }
      await memberships.put(member, membership)
      value.taskCount = String(BigInt(value.taskCount) + 1n)
    }
    return { key, value, member, membership }
  }
  async function addInvocation(
    task: ObservationTaskFacts,
    invocation: AcceptedObservationInvocation,
    fold: CompleteObservationFold,
  ) {
    const a = invocation.authority,
      runtime = invocationRuntimeIdentity(invocation)
    const agent = { id: invocation.agentId, revision: invocation.agentRevision }
    const entries: Array<[DimensionWorking['kind'], ObservationDimensionSelection, string | null]> =
      [
        [
          'agent',
          { agent, purpose: invocation.purpose },
          (await input.agentName?.(agent.id)) ?? null,
        ],
        [
          'runtime',
          { runtime },
          a.kind === 'local' ? (a.runtime?.acceptedName ?? null) : 'CrewStation',
        ],
        ['purpose', { purpose: invocation.purpose }, invocation.purpose],
        [
          'source',
          { source: { authority: a.kind, sourceId: a.kind === 'local' ? null : a.sourceId } },
          a.kind,
        ],
      ]
    for (const [kind, selection, label] of entries) {
      const { key, value, member, membership } = await group(kind, selection, label, task)
      mergeCompleteObservationFold(value.fold, fold)
      mergeCompleteObservationFold(membership.fold, fold)
      await cache.put(key, value)
      await memberships.put(member, membership)
    }
  }
  async function addModel(
    task: ObservationTaskFacts,
    allocation: CompleteObservationAllocation | CompleteObservationUnallocatedQuality,
    invocationMetrics: CompleteObservationMetrics,
    contributionFold?: CompleteObservationFold,
  ) {
    const i = allocation.invocation,
      a = i.authority
    const model = {
      authority: a.kind,
      sourceId: a.kind === 'local' ? null : a.sourceId,
      provider: allocation.model?.provider ?? null,
      model: allocation.model?.id ?? null,
    }
    const { key, value, member, membership } = await group('model', { model }, model.model, task)
    const identity = input.keyOf(JSON.stringify([key, i.invocationId]))
    if (!(await models.get(identity))) {
      await models.put(identity, true)
      value.fold.invocations = String(BigInt(value.fold.invocations) + 1n)
      value.fold.observedInvocations = String(BigInt(value.fold.observedInvocations) + 1n)
      membership.fold.invocations = String(BigInt(membership.fold.invocations) + 1n)
      membership.fold.observedInvocations = String(BigInt(membership.fold.observedInvocations) + 1n)
    }
    if (invocationMetrics.state === 'not-ready')
      for (const gap of invocationMetrics.gaps) {
        completeObservationGap(value.fold, gap)
        completeObservationGap(membership.fold, gap)
      }
    const contribution =
      'contribution' in allocation
        ? allocation.contribution
        : { input: null, cacheRead: null, cacheWrite: null, output: null }
    const cost =
      'cost' in allocation
        ? allocation.cost
        : { amount: null, complete: false, hidden: !allocation.visible }
    const qualified = 'contribution' in allocation && allocation.qualified !== false
    if (contributionFold) {
      mergeCompleteObservationFold(value.fold, contributionFold)
      mergeCompleteObservationFold(membership.fold, contributionFold)
    } else {
      addCompleteObservationAllocation(value.fold, contribution, cost, qualified)
      addCompleteObservationAllocation(membership.fold, contribution, cost, qualified)
    }
    await cache.put(key, value)
    await memberships.put(member, membership)
  }
  return {
    namespace,
    membershipsNamespace,
    addInvocation,
    addModel,
    async addHistoricalReference(
      row: CompleteHistoricalObservationExecution,
      fold: CompleteObservationFold,
    ) {
      const e = row.execution
      const entries: Array<
        [DimensionWorking['kind'], ObservationDimensionSelection, string | null]
      > = [
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
      ]
      const task =
        e.parentTaskId === null
          ? null
          : await input.rows.get<CompleteObservationTask>(
              input.namespace + '/task-original-summaries',
              e.parentTaskId,
            )
      for (const [kind, selection, label] of entries) {
        const key = input.keyOf(JSON.stringify([kind, selection])),
          identity = input.keyOf(JSON.stringify([key, e.referenceId]))
        if (await historicalReferences.get(identity)) continue
        await historicalReferences.put(identity, true)
        const value = (await cache.get(key)) ?? {
          key,
          kind,
          label,
          selection,
          fold: emptyCompleteObservationFold(),
          taskCount: '0',
        }
        mergeCompleteObservationFold(value.fold, fold)
        await cache.put(key, value)
        if (!task) continue
        const member = input.keyOf(JSON.stringify([key, task.task.id]))
        let membership = await memberships.get(member)
        if (!membership) {
          membership = { group: key, task: task.task, fold: emptyCompleteObservationFold() }
          value.taskCount = String(BigInt(value.taskCount) + 1n)
          await cache.put(key, value)
        }
        mergeCompleteObservationFold(membership.fold, fold)
        await memberships.put(member, membership)
      }
    },
    async addHistorical(
      allocation: HistoricalAllocation,
      references: () => AsyncIterable<{ referenceId: string }>,
      qualityOnly = false,
    ) {
      if (
        allocation.record.scopeMatch !== 'matched' ||
        allocation.record.coveredByAcceptedRecords ||
        (allocation.fold.records === '0' && !qualityOnly)
      )
        return
      for (const entry of allocation.dimensions) {
        const key = input.keyOf(JSON.stringify([entry.kind, entry.selection]))
        const value = (await cache.get(key)) ?? {
          key,
          kind: entry.kind,
          label: entry.label,
          selection: entry.selection,
          fold: emptyCompleteObservationFold(),
          taskCount: '0',
        }
        const next = {
          ...allocation.fold,
          historicalReferences: '0',
          observedHistoricalReferences: '0',
        }
        const member =
          allocation.task === null ? null : input.keyOf(JSON.stringify([key, allocation.task.id]))
        let membership = member === null ? undefined : await memberships.get(member)
        if (member !== null && allocation.task !== null && membership === undefined) {
          membership = { group: key, task: allocation.task, fold: emptyCompleteObservationFold() }
          value.taskCount = String(BigInt(value.taskCount) + 1n)
        }
        mergeCompleteObservationFold(value.fold, next)
        if (membership) mergeCompleteObservationFold(membership.fold, next)
        for await (const reference of references()) {
          const identity = input.keyOf(JSON.stringify([key, reference.referenceId]))
          if (await historicalReferences.get(identity)) continue
          await historicalReferences.put(identity, true)
          value.fold.historicalReferences = String(
            BigInt(value.fold.historicalReferences ?? '0') + 1n,
          )
          value.fold.observedHistoricalReferences = String(
            BigInt(value.fold.observedHistoricalReferences ?? '0') + 1n,
          )
          if (membership) {
            membership.fold.historicalReferences = String(
              BigInt(membership.fold.historicalReferences ?? '0') + 1n,
            )
            membership.fold.observedHistoricalReferences = String(
              BigInt(membership.fold.observedHistoricalReferences ?? '0') + 1n,
            )
          }
        }
        await cache.put(key, value)
        if (member !== null && membership) await memberships.put(member, membership)
      }
    },
    async flush() {
      await cache.flush()
      await memberships.flush()
      await models.flush()
      await historicalReferences.flush()
    },
    async *entries() {
      await cache.flush()
      for await (const row of completeWorkingTraversal<DimensionWorking>(
        input.rows,
        namespace,
        input.signal,
      )) {
        const { fold, ...dimension } = row.document
        yield { ...dimension, metrics: completeObservationMetrics(fold) }
      }
    },
    async *tasks() {
      await memberships.flush()
      for await (const row of completeWorkingTraversal<DimensionMembership>(
        input.rows,
        membershipsNamespace,
        input.signal,
      ))
        yield {
          key: row.key,
          group: row.document.group,
          task: row.document.task,
          metrics: completeObservationMetrics(row.document.fold),
        }
    },
  }
}
