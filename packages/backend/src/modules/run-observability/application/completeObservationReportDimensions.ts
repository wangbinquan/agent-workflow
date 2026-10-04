import type {
  AcceptedObservationInvocation,
  CompleteObservationAllocation,
  CompleteObservationDimension,
  CompleteObservationMetrics,
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
    addCompleteObservationAllocation(value.fold, contribution, cost, qualified)
    addCompleteObservationAllocation(membership.fold, contribution, cost, qualified)
    await cache.put(key, value)
    await memberships.put(member, membership)
  }
  return {
    namespace,
    membershipsNamespace,
    addInvocation,
    addModel,
    async flush() {
      await cache.flush()
      await memberships.flush()
      await models.flush()
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
