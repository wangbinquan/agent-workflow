import { isDeepStrictEqual } from 'node:util'
import type {
  CompleteObservationAllocation,
  CompleteObservationTask,
  CompleteObservationInvocation,
  CompleteObservationOccurrence,
  CompleteObservationTimePartition,
  CompleteHistoricalObservationRecord,
  CompleteHistoricalObservationReference,
  CompleteHistoricalObservationExecution,
  CompleteObservationAttempt,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  addCompleteObservationAllocation,
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import { TOKEN_BUCKETS } from '../domain/tokenUsage'
import type {
  CompleteObservationCohortBuild,
  CompleteObservationCohortInput,
  CompleteObservationReportRow,
} from '../ports/completeObservationReport'
import type { CompleteObservationUnallocatedQuality } from '../ports/completeObservationTask'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'
import { completeObservationReportRows } from './completeObservationReportRows'
import { completeObservationReportDimensions } from './completeObservationReportDimensions'
import { completeObservationReportDurations } from './completeObservationReportDurations'
import type { HistoricalAllocation } from './completeHistoricalObservationAllocation'
import { completeExternalSort } from './completeExternalSort'

type Partition = CompleteObservationTimePartition['partition']
type WindowInvocation = {
  original: CompleteObservationInvocation
  fold: CompleteObservationFold
  partitions: Record<Partition, string>
}
type WindowTask = {
  original: CompleteObservationTask
  fold: CompleteObservationFold
  invocations: string
}
type WindowTrend = {
  key: string
  from: number
  to: number
  tasks: string
  fold: CompleteObservationFold
}
const PARTITIONS: readonly Partition[] = ['in-window', 'outside-window', 'unassigned-time']
const unknownTime: CompleteObservationOccurrence = {
  occurredAt: null,
  basis: null,
  reason: 'time-evidence-missing',
}
function counters(fold: CompleteObservationFold) {
  return {
    ...fold,
    invocations: '0',
    observedInvocations: '0',
    historicalReferences: '0',
    observedHistoricalReferences: '0',
  }
}
function partition(at: number | null, input: CompleteObservationCohortInput): Partition {
  return at === null
    ? 'unassigned-time'
    : at >= input.query.from && at < input.query.to
      ? 'in-window'
      : 'outside-window'
}

/** Partition the original selected, valued snapshot. No receipt time, reread, reprice or second token selection. */
export async function buildCompleteObservationUsageWindow(
  input: CompleteObservationCohortInput,
  original: CompleteObservationCohortBuild,
): Promise<CompleteObservationCohortBuild> {
  const space = (name: string) => input.namespace + '/usage-window/' + name
  const outputInput = { ...input, namespace: input.namespace + '/usage-window' }
  const output = completeObservationReportRows(outputInput),
    dimensions = completeObservationReportDimensions(outputInput),
    durations = completeObservationReportDurations(outputInput)
  const invocations = completeWorkingCache<WindowInvocation>(
    input.rows,
    space('invocations'),
    input.signal,
  )
  const tasks = completeWorkingCache<WindowTask>(input.rows, space('tasks'), input.signal)
  const trends = completeWorkingCache<WindowTrend>(input.rows, space('trends'), input.signal)
  const historicalFolds = completeWorkingCache<CompleteObservationFold>(
    input.rows,
    space('historical-folds'),
    input.signal,
  )
  const totals = Object.fromEntries(
    PARTITIONS.map((p) => [p, emptyCompleteObservationFold()]),
  ) as Record<Partition, CompleteObservationFold>
  const fold = emptyCompleteObservationFold()
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.query.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // Retain identities and original membership before touching any numbers. All passes reach real EOF.
  for await (const item of completeWorkingTraversal<CompleteObservationReportRow>(
    input.rows,
    original.rowsNamespace,
    input.signal,
  )) {
    const row = item.document
    if (row.section === 'tasks' && row.parent === null) {
      const task = row.document as CompleteObservationTask
      await tasks.put(task.task.id, {
        original: task,
        fold: emptyCompleteObservationFold(),
        invocations: '0',
      })
      await input.rows.put(outputInput.namespace + '/task-original-summaries', {
        key: task.task.id,
        document: task,
      })
    } else if (row.section === 'invocations' && row.parent === null) {
      const invocation = row.document as CompleteObservationInvocation
      await invocations.put(invocation.invocationId, {
        original: invocation,
        fold: emptyCompleteObservationFold(),
        partitions: { 'in-window': '0', 'outside-window': '0', 'unassigned-time': '0' },
      })
    } else if (row.section === 'historical-record-references') {
      if (row.parent === null)
        throw new Error('Original historical record reference parent missing')
      await input.rows.put(space('references/' + input.keyOf(row.parent)), {
        key: row.key,
        document: row.document,
      })
    }
  }
  await tasks.flush()
  await invocations.flush()
  async function addTask(id: string, next: CompleteObservationFold) {
    const task = await tasks.get(id)
    if (!task) throw new Error('Window contribution original Task missing')
    mergeCompleteObservationFold(task.fold, next)
    await tasks.put(id, task)
  }
  async function membership(name: string, identity: string) {
    const key = input.keyOf(identity)
    if (await input.rows.get<boolean>(space(name), key)) return false
    await input.rows.put(space(name), { key, document: true })
    return true
  }
  async function addTrend(
    at: number,
    next: CompleteObservationFold,
    taskId: string | null,
    invocationId: string | null,
    referenceId: string | null,
  ) {
    const key = date.format(at),
      trend = (await trends.get(key)) ?? {
        key,
        from: at,
        to: at + 1,
        tasks: '0',
        fold: emptyCompleteObservationFold(),
      }
    mergeCompleteObservationFold(trend.fold, counters(next))
    trend.from = Math.min(trend.from, at)
    trend.to = Math.max(trend.to, at + 1)
    if (taskId !== null && (await membership('trend-tasks/' + key, taskId)))
      trend.tasks = String(BigInt(trend.tasks) + 1n)
    if (invocationId !== null && (await membership('trend-invocations/' + key, invocationId))) {
      trend.fold.invocations = String(BigInt(trend.fold.invocations) + 1n)
      trend.fold.observedInvocations = String(BigInt(trend.fold.observedInvocations) + 1n)
    }
    if (referenceId !== null && (await membership('trend-references/' + key, referenceId))) {
      trend.fold.historicalReferences = String(BigInt(trend.fold.historicalReferences ?? '0') + 1n)
      trend.fold.observedHistoricalReferences = String(
        BigInt(trend.fold.observedHistoricalReferences ?? '0') + 1n,
      )
    }
    await trends.put(key, trend)
  }
  async function retainTime(
    row: Omit<CompleteObservationTimePartition, 'partition'>,
    value: CompleteObservationFold,
  ) {
    const p = partition(row.occurrence.occurredAt, input)
    await input.rows.insert(space('partition-identities'), [{ key: row.identity, document: p }])
    mergeCompleteObservationFold(totals[p], counters(value))
    const document = { ...row, partition: p }
    await output.append('time-partitions', null, row.identity, document)
    if (p === 'unassigned-time')
      await output.append('time-unassigned', null, row.identity, document)
    if (row.invocation !== null) {
      const invocation = await invocations.get(row.invocation.invocationId)
      if (!invocation) throw new Error('Window allocation original invocation missing')
      invocation.partitions[p] = String(BigInt(invocation.partitions[p]) + 1n)
      if (await membership('partition-invocations/' + p, row.invocation.invocationId)) {
        totals[p].invocations = String(BigInt(totals[p].invocations) + 1n)
        totals[p].observedInvocations = String(BigInt(totals[p].observedInvocations) + 1n)
      }
      if (p === 'in-window') mergeCompleteObservationFold(invocation.fold, counters(value))
      else if (
        p === 'unassigned-time' &&
        value.records !== '0' &&
        (TOKEN_BUCKETS.some(
          (b) => value.tokens[b] !== '0' || value.bucketRecords?.[b] !== value.records,
        ) ||
          value.picos !== '0' ||
          !value.priced ||
          !value.visible)
      )
        completeObservationGap(invocation.fold, 'usage-time-unassigned')
      await invocations.put(row.invocation.invocationId, invocation)
    }
    return p
  }
  for await (const item of completeWorkingTraversal<CompleteObservationReportRow>(
    input.rows,
    original.rowsNamespace,
    input.signal,
  )) {
    const row = item.document
    if (row.parent !== null) continue
    if (row.section === 'allocations') {
      const allocation = row.document as CompleteObservationAllocation,
        occurrence = allocation.occurrence ?? unknownTime
      const task = await tasks.get(allocation.invocation.taskId)
      if (!task) throw new Error('Window allocation Task missing')
      const next = emptyCompleteObservationFold('1')
      next.observedInvocations = '1'
      addCompleteObservationAllocation(
        next,
        allocation.contribution,
        allocation.cost,
        allocation.qualified !== false,
      )
      const p = await retainTime(
        {
          identity: 'accepted/' + row.key,
          kind: 'accepted',
          recordId: allocation.recordId,
          sourceId: allocation.sourceId,
          task: task.original.task,
          invocation: allocation.invocation,
          occurrence,
          metrics: completeObservationMetrics(next),
        },
        next,
      )
      if (p === 'in-window') {
        await input.rows.put(space('window-allocations'), { key: row.key, document: allocation })
        await addTrend(
          occurrence.occurredAt!,
          next,
          task.original.task.id,
          allocation.invocation.invocationId,
          null,
        )
      }
    } else if (row.section === 'historical-records') {
      const record = row.document as CompleteHistoricalObservationRecord
      if (!record.includedInTotals) continue
      const next = completeMetricsFold(record.metrics),
        occurrence: CompleteObservationOccurrence =
          record.occurredAt === null
            ? { occurredAt: null, basis: null, reason: 'time-unobserved' }
            : { occurredAt: record.occurredAt, basis: 'native-step' }
      const refsNamespace = space(
        'references/' + input.keyOf(JSON.stringify([record.nativeSource, record.recordId])),
      )
      let taskId: string | null | undefined
      const values = new Map<string, HistoricalAllocation['dimensions'][number] | null>()
      for await (const ref of completeWorkingTraversal<CompleteHistoricalObservationReference>(
        input.rows,
        refsNamespace,
        input.signal,
      )) {
        const e = ref.document.execution
        if (taskId === undefined) taskId = e.parentTaskId
        else if (taskId !== e.parentTaskId) taskId = null
        const runtime = {
          authority: 'local' as const,
          sourceId: null,
          registrationId: e.runtime?.registrationId ?? null,
          configurationRevision: e.runtime?.configurationRevision ?? null,
          protocol: e.runtime?.protocol ?? null,
        }
        const entries: HistoricalAllocation['dimensions'] = [
          {
            kind: 'agent',
            selection: { agent: { id: e.agentId, revision: e.agentRevision }, purpose: e.purpose },
            label: e.agentName,
          },
          { kind: 'runtime', selection: { runtime }, label: e.runtime?.name ?? null },
          { kind: 'purpose', selection: { purpose: e.purpose }, label: e.purpose },
        ]
        for (const entry of entries) {
          if (!values.has(entry.kind)) values.set(entry.kind, entry)
          else if (!isDeepStrictEqual(values.get(entry.kind)?.selection, entry.selection))
            values.set(entry.kind, null)
        }
      }
      const task = taskId == null ? null : ((await tasks.get(taskId))?.original.task ?? null)
      const p = await retainTime(
        {
          identity: 'historical/' + row.key,
          kind: 'historical',
          recordId: record.recordId,
          sourceId: record.nativeSource,
          task,
          invocation: null,
          occurrence,
          metrics: record.metrics,
        },
        next,
      )
      const windowValue = counters(next)
      for await (const ref of completeWorkingTraversal<CompleteHistoricalObservationReference>(
        input.rows,
        refsNamespace,
        input.signal,
      )) {
        const id = ref.document.referenceId
        if (await membership('partition-references/' + p, id)) {
          totals[p].historicalReferences = String(
            BigInt(totals[p].historicalReferences ?? '0') + 1n,
          )
          totals[p].observedHistoricalReferences = String(
            BigInt(totals[p].observedHistoricalReferences ?? '0') + 1n,
          )
        }
        if (p !== 'outside-window') await membership('window-history', id)
        if (p === 'in-window' && record.candidateCount === '1') {
          // Keep the original unique attribution; a shared native record is never copied.
          const executionFold = (await historicalFolds.get(id)) ?? emptyCompleteObservationFold()
          mergeCompleteObservationFold(executionFold, windowValue)
          await historicalFolds.put(id, executionFold)
        } else if (p === 'unassigned-time') {
          const executionFold = (await historicalFolds.get(id)) ?? emptyCompleteObservationFold()
          completeObservationGap(executionFold, 'usage-time-unassigned')
          await historicalFolds.put(id, executionFold)
        }
        if (p === 'in-window')
          await addTrend(
            occurrence.occurredAt!,
            emptyCompleteObservationFold(),
            task?.id ?? null,
            null,
            id,
          )
      }
      if (p === 'in-window') {
        if (task) await addTask(task.id, windowValue)
        else mergeCompleteObservationFold(fold, windowValue)
        await addTrend(occurrence.occurredAt!, next, task?.id ?? null, null, null)
        const extra: HistoricalAllocation['dimensions'] = [
          {
            kind: 'source',
            selection: { source: { authority: 'local', sourceId: null } },
            label: 'local',
          },
          {
            kind: 'model',
            selection: {
              model: {
                authority: 'local',
                sourceId: null,
                provider: record.model?.provider ?? null,
                model: record.model?.id ?? null,
              },
            },
            label: record.model?.id ?? null,
          },
        ]
        await dimensions.addHistorical(
          {
            record,
            fold: next,
            task,
            cohortAt: occurrence.occurredAt,
            dimensions: [...values.values()]
              .filter((v): v is NonNullable<typeof v> => v !== null)
              .concat(extra),
          },
          async function* () {
            for await (const r of completeWorkingTraversal<CompleteHistoricalObservationReference>(
              input.rows,
              refsNamespace,
              input.signal,
            ))
              yield r.document
          },
        )
        await input.rows.put(space('window-historical-records'), { key: row.key, document: true })
      } else if (p === 'unassigned-time') {
        const gap = emptyCompleteObservationFold()
        completeObservationGap(gap, 'usage-time-unassigned')
        if (task) await addTask(task.id, gap)
        else mergeCompleteObservationFold(fold, gap)
        const extra: HistoricalAllocation['dimensions'] = [
          {
            kind: 'source',
            selection: { source: { authority: 'local', sourceId: null } },
            label: 'local',
          },
          {
            kind: 'model',
            selection: {
              model: {
                authority: 'local',
                sourceId: null,
                provider: record.model?.provider ?? null,
                model: record.model?.id ?? null,
              },
            },
            label: record.model?.id ?? null,
          },
        ]
        await dimensions.addHistorical(
          {
            record,
            fold: gap,
            task,
            cohortAt: null,
            dimensions: [...values.values()]
              .filter((v): v is NonNullable<typeof v> => v !== null)
              .concat(extra),
          },
          async function* () {
            for await (const r of completeWorkingTraversal<CompleteHistoricalObservationReference>(
              input.rows,
              refsNamespace,
              input.signal,
            ))
              yield r.document
          },
          true,
        )
      }
    }
  }
  for await (const row of completeWorkingTraversal<
    CompleteObservationUnallocatedQuality & { task: ObservationTaskFacts }
  >(input.rows, input.namespace + '/time-quality', input.signal)) {
    const quality = row.document,
      next = emptyCompleteObservationFold('1')
    next.observedInvocations = '1'
    addCompleteObservationAllocation(
      next,
      { input: null, cacheRead: null, cacheWrite: null, output: null },
      { amount: null, complete: false, hidden: !quality.visible },
      false,
    )
    await retainTime(
      {
        identity: 'quality/' + row.key,
        kind: 'quality',
        recordId: quality.recordId,
        sourceId: quality.sourceId,
        task: quality.task,
        invocation: quality.invocation,
        occurrence: unknownTime,
        metrics: completeObservationMetrics(next),
      },
      next,
    )
  }
  await invocations.flush()
  for await (const row of completeWorkingTraversal<WindowInvocation>(
    input.rows,
    space('invocations'),
    input.signal,
  )) {
    const state = row.document,
      originalFold = completeMetricsFold(state.original.metrics)
    const records = PARTITIONS.reduce((sum, p) => sum + BigInt(state.partitions[p]), 0n)
    if (records !== BigInt(originalFold.records))
      throw new Error('Usage-window original invocation contribution population changed')
    for (const gap of originalFold.gaps) completeObservationGap(state.fold, gap)
    if (
      state.fold.records === '0' &&
      state.fold.gaps.length === 0 &&
      state.partitions['unassigned-time'] === '0'
    )
      continue
    state.fold.invocations = '1'
    state.fold.observedInvocations = originalFold.observedInvocations
    const task = await tasks.get(state.original.taskId)
    if (!task) throw new Error('Usage-window original invocation Task missing')
    mergeCompleteObservationFold(task.fold, state.fold)
    task.invocations = String(BigInt(task.invocations) + 1n)
    await tasks.put(task.original.task.id, task)
    const document = { ...state.original, metrics: completeObservationMetrics(state.fold) }
    await input.rows.put(space('selected-invocations'), {
      key: state.original.invocationId,
      document,
    })
    await dimensions.addInvocation(task.original.task, document, state.fold)
    await output.append('invocations', null, document.invocationId, document)
    await output.append('invocations', document.taskId, document.invocationId, document)
    if (document.nodeRunId !== null) {
      await output.append(
        'invocations',
        JSON.stringify(['attempt', document.nodeRunId]),
        document.invocationId,
        document,
      )
      const key = input.keyOf(document.nodeRunId),
        previous =
          (await input.rows.get<CompleteObservationFold>(space('attempt-folds'), key)) ??
          emptyCompleteObservationFold()
      mergeCompleteObservationFold(previous, state.fold)
      await input.rows.put(space('attempt-folds'), { key, document: previous })
    }
  }
  await tasks.flush()
  for await (const row of completeWorkingTraversal<CompleteObservationAllocation>(
    input.rows,
    space('window-allocations'),
    input.signal,
  )) {
    const a = row.document,
      task = await tasks.get(a.invocation.taskId),
      invocation = await input.rows.get<CompleteObservationInvocation>(
        space('selected-invocations'),
        a.invocation.invocationId,
      )
    if (!task || !invocation) throw new Error('Window model contribution original member missing')
    await dimensions.addModel(task.original.task, a, invocation.metrics)
    await output.append('allocations', null, row.key, a)
    await output.append('allocations', a.invocation.taskId, row.key, a)
    await output.append(
      'allocations',
      JSON.stringify(['invocation', a.invocation.invocationId]),
      row.key,
      a,
    )
  }
  for await (const item of completeWorkingTraversal<CompleteObservationReportRow>(
    input.rows,
    original.rowsNamespace,
    input.signal,
  )) {
    const row = item.document
    if (row.section !== 'allocations' || row.parent !== null) continue
    const a = row.document as CompleteObservationAllocation
    if (a.occurrence?.occurredAt !== null && a.occurrence !== undefined) continue
    const invocation = await input.rows.get<CompleteObservationInvocation>(
        space('selected-invocations'),
        a.invocation.invocationId,
      ),
      task = await tasks.get(a.invocation.taskId)
    if (!invocation || !task) throw new Error('Unassigned-time original member missing')
    await dimensions.addModel(
      task.original.task,
      a,
      invocation.metrics,
      emptyCompleteObservationFold(),
    )
  }
  for await (const item of completeWorkingTraversal<
    CompleteObservationUnallocatedQuality & { task: ObservationTaskFacts }
  >(input.rows, input.namespace + '/time-quality', input.signal)) {
    const invocation = await input.rows.get<CompleteObservationInvocation>(
      space('selected-invocations'),
      item.document.invocation.invocationId,
    )
    if (!invocation) throw new Error('Window quality original invocation missing')
    await dimensions.addModel(
      item.document.task,
      item.document,
      invocation.metrics,
      emptyCompleteObservationFold(),
    )
  }
  await historicalFolds.flush()
  // Source gaps without a known instant remain explicit. Outside-only, fully observed values are absent.
  for await (const item of completeWorkingTraversal<CompleteObservationReportRow>(
    input.rows,
    original.rowsNamespace,
    input.signal,
  )) {
    const row = item.document
    if (row.section === 'historical-executions' && row.parent === null) {
      const e = row.document as CompleteHistoricalObservationExecution
      const relevant = await input.rows.get(
        space('window-history'),
        input.keyOf(e.execution.referenceId),
      )
      const missing =
        e.metrics.state === 'not-ready' &&
        e.metrics.gaps.some(
          (g) => g !== 'historical-invocation-unobserved' && g !== 'usage-incomplete',
        )
      if (!relevant && !missing) continue
      await input.rows.put(space('selected-history'), {
        key: input.keyOf(e.execution.referenceId),
        document: true,
      })
      const next = emptyCompleteObservationFold()
      if (
        e.referenceRole !== 'owner' &&
        !e.coveredByAcceptedRecords &&
        e.execution.computeKind !== 'non-agent'
      ) {
        next.historicalReferences = '1'
        next.observedHistoricalReferences = relevant ? '1' : '0'
      }
      if (e.metrics.state === 'not-ready')
        for (const gap of e.metrics.gaps) completeObservationGap(next, gap)
      const taskId = e.execution.parentTaskId,
        task = taskId === null ? null : await tasks.get(taskId)
      if (task) await addTask(taskId!, next)
      else mergeCompleteObservationFold(fold, next)
      await dimensions.addHistoricalReference(e, next)
      // The record pass already counted numeric values in every aggregate. Only this
      // execution row receives its own uniquely attributed in-window numeric fold.
      const executionFold =
        (await historicalFolds.get(e.execution.referenceId)) ?? emptyCompleteObservationFold()
      mergeCompleteObservationFold(executionFold, next)
      const windowMetrics = completeObservationMetrics(executionFold)
      await output.append('historical-executions', null, row.key, { ...e, metrics: windowMetrics })
      if (task)
        await output.append('historical-executions', taskId, row.key, {
          ...e,
          metrics: windowMetrics,
        })
    }
  }
  await tasks.flush()
  const statuses: Record<string, string> = {},
    coverage = { readyTasks: 0n, missingTasks: 0n, notApplicableTasks: 0n }
  let taskCount = 0n,
    attempts = 0n,
    invocationCount = 0n,
    captures = 0n
  const qualityCounts = completeWorkingCache<string>(input.rows, space('quality'), input.signal)
  const taskOrder = await completeExternalSort({
    workspace: input.rows,
    namespace: space('task-order'),
    signal: input.signal,
    records: (async function* () {
      for await (const row of completeWorkingTraversal<WindowTask>(
        input.rows,
        space('tasks'),
        input.signal,
      ))
        yield row.document
    })(),
    compare: (a, b) =>
      b.original.task.startedAt - a.original.task.startedAt ||
      b.original.task.id.localeCompare(a.original.task.id),
  })
  for await (const state of taskOrder.records()) {
    // Task source/attempt gaps do not have a clock proving they are outside this
    // window. Preserve their qualification independently of known window values.
    if (state.original.metrics.state === 'not-ready')
      for (const gap of state.original.metrics.gaps) completeObservationGap(state.fold, gap)
    if (state.invocations === '0' && state.fold.records === '0' && state.fold.gaps.length === 0)
      continue
    const metrics = completeObservationMetrics(state.fold),
      task = { ...state.original, metrics }
    await input.rows.put(space('selected-tasks'), { key: task.task.id, document: task })
    taskCount++
    invocationCount += BigInt(state.fold.invocations)
    if (metrics.state === 'ready') coverage.readyTasks++
    else if (metrics.state === 'not-ready') coverage.missingTasks++
    else coverage.notApplicableTasks++
    mergeCompleteObservationFold(fold, state.fold)
    await durations.add(task)
    statuses[task.task.status] = String(BigInt(statuses[task.task.status] ?? '0') + 1n)
    await output.append('tasks', null, task.task.id, task)
    for (const gap of state.fold.gaps) {
      await output.append('quality-tasks', gap, task.task.id, task)
      await qualityCounts.put(gap, String(BigInt((await qualityCounts.get(gap)) ?? '0') + 1n))
    }
  }
  for await (const item of completeWorkingTraversal<CompleteObservationReportRow>(
    input.rows,
    original.rowsNamespace,
    input.signal,
  )) {
    const row = item.document
    if (row.section === 'attempts' && row.parent === null) {
      const attempt = row.document as CompleteObservationAttempt & { taskId: string }
      if (!(await input.rows.get(space('selected-tasks'), attempt.taskId))) continue
      const next = await input.rows.get<CompleteObservationFold>(
        space('attempt-folds'),
        input.keyOf(attempt.id),
      )
      const document = {
        ...attempt,
        metrics: next ? completeObservationMetrics(next) : { state: 'not-applicable' as const },
      }
      await output.append('attempts', null, row.key, document)
      await output.append('attempts', attempt.taskId, row.key, document)
      attempts++
    } else if (row.section === 'native-captures' || row.section === 'platform-captures') {
      const capture = row.document as { invocationId: string }
      if (await input.rows.get(space('selected-invocations'), capture.invocationId)) {
        await output.append(row.section, row.parent, row.key, row.document)
        if (row.parent === null) captures++
      }
    } else if (row.section.startsWith('historical-') && row.section !== 'historical-executions') {
      if (row.section === 'historical-record-references') {
        const ref = row.document as CompleteHistoricalObservationReference
        if (await input.rows.get(space('selected-history'), input.keyOf(ref.referenceId)))
          await output.append(row.section, row.parent, row.key, row.document)
      } else if (row.section === 'historical-record-versions') {
        await output.append(row.section, row.parent, row.key, row.document)
      } else if (row.section === 'historical-records' && row.parent !== 'original-source') {
        if (await input.rows.get(space('window-historical-records'), row.key))
          await output.append(row.section, row.parent, row.key, row.document)
      } else if (row.parent === 'original-source')
        await output.append(row.section, row.parent, row.key, row.document)
    }
  }
  await dimensions.flush()
  await trends.flush()
  await qualityCounts.flush()
  const sections = {
    agent: 'agents',
    runtime: 'runtimes',
    model: 'models',
    purpose: 'purposes',
    source: 'sources',
  } as const
  for await (const d of dimensions.entries()) await output.append(sections[d.kind], null, d.key, d)
  for await (const d of dimensions.tasks()) {
    const task = await input.rows.get<CompleteObservationTask>(space('selected-tasks'), d.task.id)
    if (!task) throw new Error('Window dimension original Task missing')
    await output.append('dimension-tasks', d.group, d.key, {
      task: d.task,
      metrics: d.metrics,
      timing: task.timing,
    })
  }
  for await (const row of completeWorkingTraversal<WindowTrend>(
    input.rows,
    space('trends'),
    input.signal,
  )) {
    const { fold: value, ...trend } = row.document
    await output.append('trends', null, row.key, {
      ...trend,
      metrics: completeObservationMetrics(value),
    })
  }
  for await (const row of completeWorkingTraversal<string>(
    input.rows,
    space('quality'),
    input.signal,
  ))
    await output.append('quality', null, row.key, {
      key: row.key,
      taskCount: row.document,
      taskIndexVersion: 1,
    })
  const combined = emptyCompleteObservationFold()
  for (const p of PARTITIONS) mergeCompleteObservationFold(combined, totals[p])
  const originalFold = completeMetricsFold(original.summary.metrics)
  if (
    combined.records !== originalFold.records ||
    combined.picos !== originalFold.picos ||
    TOKEN_BUCKETS.some(
      (b) =>
        combined.tokens[b] !== originalFold.tokens[b] ||
        combined.bucketRecords?.[b] !== originalFold.bucketRecords?.[b],
    )
  )
    throw new Error(
      'Usage-window partitions differ from original selected four buckets or frozen CNY',
    )
  await output.flush()
  return {
    ...original,
    rowsNamespace: output.namespace,
    countsNamespace: output.countsNamespace,
    summary: {
      metrics: completeObservationMetrics(fold),
      usageWindow: {
        candidateTasks: original.summary.inventory.tasks,
        timingBasis: 'task-lifecycle',
        partitions: Object.fromEntries(
          PARTITIONS.map((p) => [
            p,
            { records: totals[p].records, metrics: completeObservationMetrics(totals[p]) },
          ]),
        ) as NonNullable<CompleteObservationCohortBuild['summary']['usageWindow']>['partitions'],
      },
      usageCoverage: {
        readyTasks: String(coverage.readyTasks),
        missingTasks: String(coverage.missingTasks),
        notApplicableTasks: String(coverage.notApplicableTasks),
      },
      inventory: {
        tasks: String(taskCount),
        attempts: String(attempts),
        invocations: String(invocationCount),
        numericRecords: fold.records,
        nativeCaptures: String(captures),
        ...(BigInt(fold.historicalReferences ?? '0') > 0n
          ? { historicalReferences: fold.historicalReferences }
          : {}),
      },
      statuses,
      timing: await durations.totals(),
      rootTask: null,
    },
  }
}
