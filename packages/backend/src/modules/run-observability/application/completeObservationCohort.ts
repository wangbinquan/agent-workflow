import type {
  AcceptedObservationInvocation,
  CompleteObservationAllocation,
  CompleteObservationMetrics,
  CompleteObservationTask,
  CompleteObservationTrend,
  ObservationTaskFacts,
  ObservationSpanDetail,
} from '@agent-workflow/shared'
import { completeOrdinalKey } from '../domain/completeOrdinal'
import { parseObservationSelection } from '../domain/analysisDimensions'
import { selectCompleteObservationTask } from './completeObservationSelection'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import { TOKEN_BUCKETS } from '../domain/tokenUsage'
import type { PlatformSyncState } from '../domain/platformSync'
import {
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type {
  CompleteObservationCohortBuild,
  CompleteObservationCohortInput,
} from '../ports/completeObservationReport'
import type { CompleteObservationUnallocatedQuality } from '../ports/completeObservationTask'
import { consumeCompleteSource } from './completePageTraversal'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingScope } from './completeWorkingScope'
import { completeWorkingTraversal } from './completeWorkingTraversal'
import { completeExternalSort } from './completeExternalSort'
import { buildCompleteObservationTask } from './completeObservationTask'
import { completeObservationReportRows } from './completeObservationReportRows'
import { completeObservationReportDimensions } from './completeObservationReportDimensions'
import { completeObservationReportDurations } from './completeObservationReportDurations'
import { buildCompleteObservationTiming } from './completeObservationTiming'

type InvocationRow = AcceptedObservationInvocation & {
  readonly metrics: CompleteObservationMetrics
}
interface TrendWorking {
  key: string
  from: number
  to: number
  tasks: string
  fold: CompleteObservationFold
}

/** Every selected original Task is retained first; display pages never choose the statistical population. */
export async function buildCompleteObservationCohort(
  input: CompleteObservationCohortInput,
): Promise<CompleteObservationCohortBuild> {
  const selection = parseObservationSelection(input.query.selection)
  const space = (name: string) => input.namespace + '/' + name
  const output = completeObservationReportRows(input),
    dimensions = completeObservationReportDimensions(input),
    durations = completeObservationReportDurations(input)
  const fold = emptyCompleteObservationFold(),
    statuses: Record<string, string> = {}
  const inventory = {
    tasks: 0n,
    attempts: 0n,
    invocations: 0n,
    numericRecords: 0n,
    nativeCaptures: 0n,
  }
  const usageCoverage = { readyTasks: 0n, missingTasks: 0n, notApplicableTasks: 0n }
  const trends = completeWorkingCache<TrendWorking>(input.rows, space('trends'), input.signal)
  const quality = completeWorkingCache<string>(input.rows, space('quality'), input.signal)
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.query.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const source = input.sources.tasks(input.actor, input.query)
  const taskSource = await consumeCompleteSource({
    source: space('original-tasks'),
    snapshotId: input.sources.snapshotId,
    reader: source,
    signal: input.signal,
    workspace: {
      async claimCursor(_, cursor) {
        await input.rows.insert(space('task-cursors'), [
          { key: input.keyOf(cursor), document: cursor },
        ])
      },
      async append(_, items) {
        await input.rows.insert(
          space('original-tasks'),
          items.map((document) => ({ key: document.id, document })),
        )
      },
    },
  })
  let receiptOrdinal = 0n,
    sourceTasks = 0n
  for await (const row of completeWorkingTraversal<ObservationTaskFacts>(
    input.rows,
    space('original-tasks'),
    input.signal,
  )) {
    const task = row.document,
      taskSpace = space('task-' + input.keyOf(task.id))
    await completeWorkingScope(input.rows, taskSpace).run(async (taskRows) => {
      const taskInput = {
        ...input,
        rows: taskRows,
        task,
        namespace: taskSpace,
        trace: input.task !== undefined,
      }
      const original = await buildCompleteObservationTask(taskInput)
      sourceTasks++
      for (const receipt of original.sourceReceipts)
        await input.rows.insert(space('receipts'), [
          { key: completeOrdinalKey(receiptOrdinal++), document: receipt },
        ])
      if (original.trace?.receipt)
        await input.rows.insert(space('receipts'), [
          { key: completeOrdinalKey(receiptOrdinal++), document: original.trace.receipt },
        ])
      for await (const state of completeWorkingTraversal<PlatformSyncState>(
        input.rows,
        taskSpace + '/platform-states',
        input.signal,
      )) {
        const document = state.document,
          sourceKey = input.keyOf(
            JSON.stringify([
              document.binding.sourceId,
              document.binding.projectId,
              document.binding.taskId,
            ]),
          )
        await input.rows.put(space('receipts'), {
          key: 'visibility/' + sourceKey,
          document: {
            kind: 'cost-visibility',
            sourceKey,
            costVisibility: document.costVisibility,
            visibilityRevision: document.visibilityRevision,
          },
        })
      }
      const build = await selectCompleteObservationTask(taskInput, original, selection)
      if (build === null) return
      inventory.tasks++
      if (build.summary.metrics.state === 'ready') usageCoverage.readyTasks++
      else if (build.summary.metrics.state === 'not-ready') usageCoverage.missingTasks++
      else usageCoverage.notApplicableTasks++
      inventory.attempts += BigInt(build.summary.attemptCount)
      inventory.invocations += BigInt(build.fold.invocations)
      inventory.numericRecords += BigInt(build.originalNumericRecords)
      mergeCompleteObservationFold(fold, build.fold)
      statuses[task.status] = String(BigInt(statuses[task.status] ?? '0') + 1n)
      await input.rows.insert(space('task-summaries'), [{ key: task.id, document: build.summary }])
      await input.rows.insert(space('task-quality'), [
        { key: task.id, document: [...build.fold.gaps] },
      ])
      await durations.add(build.summary)
      const day = date.format(task.startedAt),
        trend = (await trends.get(day)) ?? {
          key: day,
          from: task.startedAt,
          to: task.startedAt + 1,
          tasks: '0',
          fold: emptyCompleteObservationFold(),
        }
      trend.tasks = String(BigInt(trend.tasks) + 1n)
      trend.from = Math.min(trend.from, task.startedAt)
      trend.to = Math.max(trend.to, task.startedAt + 1)
      mergeCompleteObservationFold(trend.fold, build.fold)
      await trends.put(day, trend)
      for (const reason of build.fold.gaps) {
        await quality.put(reason, String(BigInt((await quality.get(reason)) ?? '0') + 1n))
      }
      for await (const item of completeWorkingTraversal<InvocationRow>(
        input.rows,
        build.invocationsNamespace,
        input.signal,
      )) {
        const invocation = {
          ...item.document,
          taskName: task.name,
          agentName: (await input.agentName?.(item.document.agentId)) ?? null,
        }
        await dimensions.addInvocation(task, invocation, completeMetricsFold(invocation.metrics))
        await output.append('invocations', task.id, invocation.invocationId, invocation)
        await output.append('invocations', null, invocation.invocationId, invocation)
        if (invocation.nodeRunId !== null)
          await output.append(
            'invocations',
            JSON.stringify(['invocation', invocation.nodeRunId, invocation.invocationId]),
            invocation.invocationId,
            invocation,
          )
        if (invocation.nodeRunId !== null)
          await output.append(
            'invocations',
            JSON.stringify(['attempt', invocation.nodeRunId]),
            invocation.invocationId,
            invocation,
          )
        if (input.task)
          await output.append(
            'invocations',
            JSON.stringify(['task-tree', input.task.id]),
            invocation.invocationId,
            invocation,
          )
      }
      let allocationPopulation = 0n,
        qualityPopulation = 0n
      for await (const item of completeWorkingTraversal<CompleteObservationAllocation>(
        input.rows,
        build.allocationsNamespace,
        input.signal,
      )) {
        allocationPopulation++
        const invocation = await input.rows.get<InvocationRow>(
          build.invocationsNamespace,
          input.keyOf(item.document.invocation.invocationId),
        )
        if (!invocation) throw new Error('Complete original allocation invocation missing')
        await dimensions.addModel(task, item.document, invocation.metrics)
        await output.append('allocations', task.id, item.key, item.document)
        await output.append(
          'allocations',
          null,
          input.keyOf(JSON.stringify([task.id, item.key])),
          item.document,
        )
        await output.append(
          'allocations',
          JSON.stringify(['invocation', invocation.invocationId]),
          item.key,
          item.document,
        )
        if (input.task)
          await output.append(
            'allocations',
            JSON.stringify(['task-tree', input.task.id]),
            item.key,
            item.document,
          )
      }
      for await (const item of completeWorkingTraversal<CompleteObservationUnallocatedQuality>(
        input.rows,
        build.unallocatedQualityNamespace,
        input.signal,
      )) {
        qualityPopulation++
        const invocation = await input.rows.get<InvocationRow>(
          build.invocationsNamespace,
          input.keyOf(item.document.invocation.invocationId),
        )
        if (!invocation) throw new Error('Complete original quality invocation missing')
        await dimensions.addModel(task, item.document, invocation.metrics)
      }
      if (
        allocationPopulation !== BigInt(build.selectedAllocationCount) ||
        qualityPopulation !== BigInt(build.unallocatedQualityCount)
      )
        throw new Error('Complete original model contribution population changed')
      for (const [section, namespace] of [
        ['attempts', build.attemptsNamespace],
        ['native-captures', build.nativeCapturesNamespace],
        ['platform-captures', build.platformCapturesNamespace],
      ] as const) {
        for await (const item of completeWorkingTraversal(input.rows, namespace, input.signal)) {
          await output.append(section, task.id, item.key, item.document)
          if (section !== 'attempts') {
            inventory.nativeCaptures++
            await output.append(section, null, input.keyOf(JSON.stringify([task.id, item.key])), {
              ...(item.document as object),
              taskId: task.id,
              taskName: task.name,
            })
          } else {
            const attempt = { ...(item.document as object), taskId: task.id, taskName: task.name }
            await input.rows.insert(space('all-attempts'), [{ key: item.key, document: attempt }])
            await output.append('attempts', null, item.key, attempt)
          }
        }
      }
      if (build.trace) {
        for (const [section, namespace] of [
          ['span-facts', build.trace.spansNamespace],
          ['span-captures', build.trace.capturesNamespace],
          ['span-statuses', build.trace.statusesNamespace],
        ] as const)
          for await (const item of completeWorkingTraversal<{
            readonly nodeRunId: string
            readonly detail?: ObservationSpanDetail
          }>(input.rows, namespace, input.signal)) {
            const parent = JSON.stringify(['attempt', item.document.nodeRunId]),
              document = section === 'span-facts' ? item.document.detail : item.document
            await output.append(
              section,
              parent,
              input.keyOf(JSON.stringify([task.id, item.key])),
              document,
            )
            await output.append(
              section,
              null,
              input.keyOf(JSON.stringify([task.id, item.key])),
              document,
            )
            if (section === 'span-facts' && item.document.detail)
              await output.append(
                section,
                JSON.stringify([
                  'invocation',
                  item.document.nodeRunId,
                  item.document.detail.fact.invocationId,
                ]),
                input.keyOf(JSON.stringify([task.id, item.key])),
                document,
              )
          }
      }
      await output.flush()
    })
  }
  if (sourceTasks !== BigInt(taskSource.rows))
    throw new Error('Complete original Task population changed')
  await dimensions.flush()
  await trends.flush()
  await quality.flush()
  const taskOrder = await completeExternalSort({
    workspace: input.rows,
    namespace: space('task-order'),
    records: (async function* () {
      for await (const row of completeWorkingTraversal<CompleteObservationTask>(
        input.rows,
        space('task-summaries'),
        input.signal,
      ))
        yield row.document
    })(),
    compare: (a, b) => b.task.startedAt - a.task.startedAt || b.task.id.localeCompare(a.task.id),
    signal: input.signal,
  })
  for await (const task of taskOrder.records()) {
    await output.append('tasks', null, task.task.id, task)
    const reasons = await input.rows.get<readonly string[]>(space('task-quality'), task.task.id)
    if (!reasons || new Set(reasons).size !== reasons.length)
      throw new Error('Original Task quality membership missing or duplicated')
    for (const reason of reasons) await output.append('quality-tasks', reason, task.task.id, task)
  }
  const sections = {
    agent: 'agents',
    runtime: 'runtimes',
    model: 'models',
    purpose: 'purposes',
    source: 'sources',
  } as const
  for await (const dimension of dimensions.entries())
    await output.append(sections[dimension.kind], null, dimension.key, dimension)
  for await (const membership of dimensions.tasks()) {
    const summary = await input.rows.get<CompleteObservationTask>(
      space('task-summaries'),
      membership.task.id,
    )
    if (!summary) throw new Error('Complete original dimension Task missing')
    await output.append('dimension-tasks', membership.group, membership.key, {
      task: membership.task,
      metrics: membership.metrics,
      timing: summary.timing,
    })
  }
  for await (const row of completeWorkingTraversal<TrendWorking>(
    input.rows,
    space('trends'),
    input.signal,
  )) {
    const { fold: value, ...trend } = row.document
    const metrics = completeObservationMetrics(value)
    await output.append('trends', null, row.key, {
      ...trend,
      metrics,
      ...(metrics.state === 'not-ready' &&
      !value.gaps.includes('usage-incomplete') &&
      TOKEN_BUCKETS.every((bucket) => value.bucketRecords?.[bucket] === value.records) &&
      BigInt(value.records) > 0n
        ? {
            recordedUsage: {
              invocations: value.invocations,
              observedInvocations: value.observedInvocations,
              records: value.records,
              tokens: {
                ...value.tokens,
                total: String(
                  BigInt(value.tokens.input) +
                    BigInt(value.tokens.cacheRead) +
                    BigInt(value.tokens.cacheWrite) +
                    BigInt(value.tokens.output),
                ),
              },
            },
          }
        : {}),
    } satisfies CompleteObservationTrend)
  }
  for await (const row of completeWorkingTraversal<string>(
    input.rows,
    space('quality'),
    input.signal,
  )) {
    if ((await output.count('quality-tasks', row.key)) !== row.document)
      throw new Error('Original quality Task population changed')
    await output.append('quality', null, row.key, {
      key: row.key,
      taskCount: row.document,
      taskIndexVersion: 1,
    })
  }
  await output.flush()
  const metrics = completeObservationMetrics(fold)
  let rootTask: CompleteObservationTask | null = null
  if (input.task) {
    if (!(await input.rows.get(space('original-tasks'), input.task.id)))
      throw new Error('Complete original root Task missing')
    rootTask = {
      task: input.task,
      metrics,
      attemptCount: String(inventory.attempts),
      timing: await buildCompleteObservationTiming({
        task: input.task,
        asOf: input.asOf,
        rows: input.rows,
        attemptsNamespace: space('all-attempts'),
        namespace: space('root-timing'),
        signal: input.signal,
      }),
    }
    for await (const attempt of completeWorkingTraversal(
      input.rows,
      space('all-attempts'),
      input.signal,
    ))
      await output.append(
        'attempts',
        JSON.stringify(['task-tree', input.task.id]),
        attempt.key,
        attempt.document,
      )
    await output.flush()
  }
  const summary = {
    metrics,
    ...(metrics.state === 'not-ready' &&
    !fold.gaps.includes('usage-incomplete') &&
    TOKEN_BUCKETS.every((bucket) => fold.bucketRecords?.[bucket] === fold.records) &&
    BigInt(fold.records) > 0n &&
    fold.records === String(inventory.numericRecords) &&
    fold.invocations === String(inventory.invocations)
      ? {
          recordedUsage: {
            invocations: fold.invocations,
            observedInvocations: fold.observedInvocations,
            records: fold.records,
            tokens: {
              ...fold.tokens,
              total: String(
                BigInt(fold.tokens.input) +
                  BigInt(fold.tokens.cacheRead) +
                  BigInt(fold.tokens.cacheWrite) +
                  BigInt(fold.tokens.output),
              ),
            },
          },
        }
      : {}),
    usageCoverage: {
      readyTasks: String(usageCoverage.readyTasks),
      missingTasks: String(usageCoverage.missingTasks),
      notApplicableTasks: String(usageCoverage.notApplicableTasks),
    },
    inventory: {
      tasks: String(inventory.tasks),
      attempts: String(inventory.attempts),
      invocations: String(inventory.invocations),
      numericRecords: String(inventory.numericRecords),
      nativeCaptures: String(inventory.nativeCaptures),
    },
    statuses,
    timing: await durations.totals(),
    rootTask,
  }
  return {
    summary,
    rowsNamespace: output.namespace,
    countsNamespace: output.countsNamespace,
    receiptsNamespace: space('receipts'),
    taskSource,
  }
}
