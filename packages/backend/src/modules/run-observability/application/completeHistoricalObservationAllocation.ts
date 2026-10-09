import { isDeepStrictEqual } from 'node:util'
import type {
  AcceptedObservationInvocation,
  CompleteObservationAllocation,
  CompleteHistoricalObservationExecution,
  CompleteHistoricalObservationRecord,
  ObservationDimensionSelection,
  ObservationTaskFacts,
  ObservationTokenUsage,
} from '@agent-workflow/shared'
import {
  historicalObservationDimensionMatch,
  type HistoricalObservationMatch,
} from '../domain/historicalObservationSelection'
import {
  addCompleteObservationAllocation,
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type { CompleteObservationCohortInput } from '../ports/completeObservationReport'
import type { CompleteObservationTaskBuild } from '../ports/completeObservationTask'
import type {
  HistoricalWorkingExecution,
  HistoricalWorkingNativeRecord,
} from '../ports/historicalObservationWorking'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'
import type { HistoricalObservationStage } from './historicalObservationSource'

interface ExecutionState {
  working: HistoricalWorkingExecution
  fold: CompleteObservationFold
  records: string
  covered: string
  matched: string
  unresolved: string
  observed: string
  issues: string[]
}
interface AcceptedRecord {
  nativeSource: string | null
  originalUsage: ObservationTokenUsage
  model: CompleteObservationAllocation['model']
  taskId: string
  invocationId: string
}
export interface HistoricalAllocation {
  record: CompleteHistoricalObservationRecord
  fold: CompleteObservationFold
  task: ObservationTaskFacts | null
  cohortAt: number | null
  dimensions: readonly {
    kind: 'agent' | 'runtime' | 'model' | 'purpose' | 'source'
    selection: ObservationDimensionSelection
    label: string | null
  }[]
}

/** All candidates survive until scope qualification. Only original native identities contribute once. */
export function completeHistoricalObservationAllocation(
  input: CompleteObservationCohortInput,
  stage: HistoricalObservationStage,
  selection: ObservationDimensionSelection | null,
) {
  const space = (name: string) => stage.namespace + '/' + name
  const states = completeWorkingCache<ExecutionState>(
    input.rows,
    space('execution-folds'),
    input.signal,
  )
  async function retainAccepted(build: CompleteObservationTaskBuild) {
    for await (const row of completeWorkingTraversal<AcceptedObservationInvocation>(
      input.rows,
      build.invocationsNamespace,
      input.signal,
    ))
      if (row.document.nodeRunId !== null)
        await input.rows.put(space('accepted-nodes'), {
          key: input.keyOf(row.document.nodeRunId),
          document: true,
        })
    if (build.originalNativeAllocationsNamespace === undefined) return
    for await (const row of completeWorkingTraversal<CompleteObservationAllocation>(
      input.rows,
      build.allocationsNamespace,
      input.signal,
    )) {
      const allocation = row.document
      if (
        allocation.invocation.authority.kind !== 'local' ||
        !allocation.recordId.startsWith('opencode:step:')
      )
        continue
      const original = await input.rows.get<{
        originalUsage: ObservationTokenUsage
        nativeSource: string | null
      }>(build.originalNativeAllocationsNamespace, row.key)
      if (!original) throw new Error('Original accepted native measurement missing')
      const key = input.keyOf(allocation.recordId.slice('opencode:step:'.length))
      await input.rows.put(space('accepted-records/' + key), {
        key: input.keyOf(JSON.stringify([allocation.invocation.invocationId, row.key])),
        document: {
          ...original,
          model: allocation.model,
          taskId: allocation.invocation.taskId,
          invocationId: allocation.invocation.invocationId,
        } satisfies AcceptedRecord,
      })
    }
  }
  async function executionState(referenceId: string) {
    const key = input.keyOf(referenceId)
    let state = await states.get(key)
    if (state === undefined) {
      const working = await input.rows.get<HistoricalWorkingExecution>(
        stage.executionsNamespace,
        key,
      )
      if (!working) throw new Error('Original historical candidate missing')
      state = {
        working,
        fold: emptyCompleteObservationFold(),
        records: '0',
        covered: '0',
        matched: '0',
        unresolved: '0',
        observed: '0',
        issues: [],
      }
      await states.put(key, state)
    }
    return { key, state }
  }
  async function candidates(recordKey: string, native: HistoricalWorkingNativeRecord) {
    const target = space('record-candidates/' + recordKey)
    let exact = false
    for await (const row of completeWorkingTraversal<{ referenceId: string; sessionId: string }>(
      input.rows,
      space('event-refs/' + input.keyOf(native.step.stepId)),
      input.signal,
    )) {
      if (row.document.sessionId !== native.step.id) continue
      exact = true
      await input.rows.put(target, {
        key: input.keyOf(row.document.referenceId),
        document: row.document.referenceId,
      })
    }
    if (!exact)
      for await (const root of completeWorkingTraversal<{ rootKey: string }>(
        input.rows,
        space('record-roots/' + recordKey),
        input.signal,
      ))
        for await (const row of completeWorkingTraversal<{ referenceId: string }>(
          input.rows,
          space('root-refs/' + root.document.rootKey),
          input.signal,
        ))
          await input.rows.put(target, {
            key: input.keyOf(row.document.referenceId),
            document: row.document.referenceId,
          })
    return target
  }
  async function* allocations(): AsyncGenerator<HistoricalAllocation> {
    let dayFormatter: Intl.DateTimeFormat | undefined
    for await (const row of completeWorkingTraversal<HistoricalWorkingNativeRecord>(
      input.rows,
      stage.nativeRecordsNamespace,
      input.signal,
    )) {
      const native = row.document,
        namespace = await candidates(row.key, native),
        issues = new Set<string>()
      let matched = 0n,
        excluded = 0n,
        unresolved = 0n,
        count = 0n
      let commonTask: ObservationTaskFacts | null | undefined,
        commonDay: string | null | undefined,
        cohortAt: number | null = null
      const dimensionValues = new Map<
        string,
        {
          kind: HistoricalAllocation['dimensions'][number]['kind']
          selection: ObservationDimensionSelection
          label: string | null
        } | null
      >()
      for await (const candidate of completeWorkingTraversal<string>(
        input.rows,
        namespace,
        input.signal,
      )) {
        count++
        const { state } = await executionState(candidate.document),
          working = state.working,
          e = working.execution
        const dimensions = historicalObservationDimensionMatch(selection, e, native.step.model)
        const match =
          working.scopeMatch === 'excluded' || dimensions === 'excluded'
            ? 'excluded'
            : working.scopeMatch === 'unresolved' || dimensions === 'unresolved'
              ? 'unresolved'
              : 'matched'
        if (match === 'matched') matched++
        else if (match === 'excluded') excluded++
        else unresolved++
        if (commonTask === undefined) commonTask = working.parentTask
        else if (commonTask?.id !== working.parentTask?.id) commonTask = null
        const day =
          working.cohortAt === null
            ? null
            : (dayFormatter ??= new Intl.DateTimeFormat('en-CA', {
                timeZone: input.query.timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              })).format(working.cohortAt)
        if (commonDay === undefined) {
          commonDay = day
          cohortAt = working.cohortAt
        } else if (commonDay !== day) {
          commonDay = null
          cohortAt = null
        }
        const runtime = {
          authority: 'local' as const,
          sourceId: null,
          registrationId: e.runtime?.registrationId ?? null,
          configurationRevision: e.runtime?.configurationRevision ?? null,
          protocol: e.runtime?.protocol ?? null,
        }
        const values: HistoricalAllocation['dimensions'] = [
          {
            kind: 'agent',
            selection: { agent: { id: e.agentId, revision: e.agentRevision }, purpose: e.purpose },
            label: e.agentName,
          },
          { kind: 'runtime', selection: { runtime }, label: e.runtime?.name ?? null },
          { kind: 'purpose', selection: { purpose: e.purpose }, label: e.purpose },
        ]
        for (const value of values) {
          if (!dimensionValues.has(value.kind)) dimensionValues.set(value.kind, value)
          else if (!isDeepStrictEqual(dimensionValues.get(value.kind)?.selection, value.selection))
            dimensionValues.set(value.kind, null)
        }
      }
      const scopeMatch: HistoricalObservationMatch =
        count === 0n || unresolved > 0n || (matched > 0n && excluded > 0n)
          ? 'unresolved'
          : matched === count
            ? 'matched'
            : 'excluded'
      let covered = false
      for await (const accepted of completeWorkingTraversal<AcceptedRecord>(
        input.rows,
        space('accepted-records/' + input.keyOf(native.step.stepId)),
        input.signal,
      )) {
        if (
          accepted.document.nativeSource !== null &&
          accepted.document.nativeSource !== native.nativeSource
        )
          continue
        covered = true
        if (
          accepted.document.nativeSource === null ||
          !isDeepStrictEqual(accepted.document.originalUsage, native.step.usage) ||
          !isDeepStrictEqual(accepted.document.model, native.step.model)
        )
          issues.add('historical-accepted-record-conflict')
      }
      if (native.conflicting) issues.add('historical-native-record-conflict')
      for await (const root of completeWorkingTraversal<{ rootKey: string }>(
        input.rows,
        space('record-roots/' + row.key),
        input.signal,
      )) {
        const receipt = await input.rows.get<{ issues: readonly string[] }>(
          space('root-results'),
          root.document.rootKey,
        )
        if (!receipt) throw new Error('Original historical root receipt missing')
        for (const issue of receipt.issues) issues.add(issue)
      }
      const fold = emptyCompleteObservationFold()
      if (scopeMatch === 'unresolved') completeObservationGap(fold, 'historical-scope-unresolved')
      if (scopeMatch === 'matched' && !covered && !native.conflicting) {
        fold.historicalReferences = '1'
        fold.observedHistoricalReferences = '1'
        completeObservationGap(fold, 'historical-invocation-unobserved')
        addCompleteObservationAllocation(fold, native.step.usage, {
          amount: null,
          complete: false,
          hidden: false,
        })
      }
      if (scopeMatch !== 'excluded') for (const issue of issues) completeObservationGap(fold, issue)
      const record: CompleteHistoricalObservationRecord = {
        kind: 'historical-observed',
        nativeSource: native.nativeSource,
        recordId: 'opencode:step:' + native.step.stepId,
        sessionId: native.step.id,
        occurredAt: native.step.occurredAt,
        model: native.step.model,
        originalUsage: native.step.usage,
        candidateCount: String(count),
        scopeMatch,
        coveredByAcceptedRecords: covered,
        includedInTotals: fold.records !== '0',
        metrics: completeObservationMetrics(fold),
        issues: [...issues],
      }
      for await (const candidate of completeWorkingTraversal<string>(
        input.rows,
        namespace,
        input.signal,
      )) {
        const { key, state } = await executionState(candidate.document)
        state.records = String(BigInt(state.records) + 1n)
        if (scopeMatch === 'matched') state.matched = String(BigInt(state.matched) + 1n)
        if (scopeMatch === 'unresolved') state.unresolved = String(BigInt(state.unresolved) + 1n)
        if (covered) state.covered = String(BigInt(state.covered) + 1n)
        if (fold.records !== '0') state.observed = String(BigInt(state.observed) + 1n)
        for (const issue of issues) if (!state.issues.includes(issue)) state.issues.push(issue)
        if (scopeMatch === 'unresolved')
          state.issues.push(
            ...(state.issues.includes('historical-scope-unresolved')
              ? []
              : ['historical-scope-unresolved']),
          )
        // Shared owner references do not copy one native number into multiple executions.
        if (count === 1n) mergeCompleteObservationFold(state.fold, fold)
        await states.put(key, state)
      }
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
              provider: native.step.model?.provider ?? null,
              model: native.step.model?.id ?? null,
            },
          },
          label: native.step.model?.id ?? null,
        },
      ]
      yield {
        record,
        fold,
        task: commonTask ?? null,
        cohortAt,
        dimensions: [...dimensionValues.values()]
          .filter((value): value is NonNullable<typeof value> => value !== null)
          .concat(extra),
      }
    }
    await states.flush()
  }
  async function* references(record: CompleteHistoricalObservationRecord) {
    const key = input.keyOf(
      JSON.stringify([record.nativeSource, record.recordId.slice('opencode:step:'.length)]),
    )
    for await (const row of completeWorkingTraversal<string>(
      input.rows,
      space('record-candidates/' + key),
      input.signal,
    )) {
      const { state } = await executionState(row.document)
      const dimension = historicalObservationDimensionMatch(
        selection,
        state.working.execution,
        record.model,
      )
      const scopeMatch =
        state.working.scopeMatch === 'excluded' || dimension === 'excluded'
          ? 'excluded'
          : state.working.scopeMatch === 'unresolved' || dimension === 'unresolved'
            ? 'unresolved'
            : 'matched'
      yield {
        referenceId: row.document,
        execution: state.working.execution,
        scopeMatch,
        timeBasis: state.working.timeBasis,
        cohortAt: state.working.cohortAt,
      }
    }
  }
  async function* versions(record: CompleteHistoricalObservationRecord) {
    const key = input.keyOf(
      JSON.stringify([record.nativeSource, record.recordId.slice('opencode:step:'.length)]),
    )
    for await (const row of completeWorkingTraversal<HistoricalWorkingNativeRecord>(
      input.rows,
      space('native-versions/' + key),
      input.signal,
    ))
      yield {
        ...record,
        versionFingerprint: row.key,
        originalUsage: row.document.step.usage,
        model: row.document.step.model,
        occurredAt: row.document.step.occurredAt,
      }
  }
  async function* executions(): AsyncGenerator<{
    row: CompleteHistoricalObservationExecution
    fold: CompleteObservationFold
    task: ObservationTaskFacts | null
    cohortAt: number | null
  }> {
    for await (const original of completeWorkingTraversal<HistoricalWorkingExecution>(
      input.rows,
      stage.executionsNamespace,
      input.signal,
    )) {
      const { key, state } = await executionState(original.document.execution.referenceId),
        working = state.working,
        e = working.execution
      const ownerOnly = (await input.rows.get<boolean>(space('owner-metadata'), key)) === true
      for await (const root of completeWorkingTraversal<{ rootKey: string }>(
        input.rows,
        space('execution-roots/' + key),
        input.signal,
      )) {
        const receipt = await input.rows.get<{ issues: readonly string[] }>(
          space('root-results'),
          root.document.rootKey,
        )
        if (!receipt) throw new Error('Original historical root receipt missing')
        for (const issue of receipt.issues)
          if (!state.issues.includes(issue)) state.issues.push(issue)
      }
      const dimension = historicalObservationDimensionMatch(selection, e, null)
      const scopeMatch: HistoricalObservationMatch =
        state.records === '0'
          ? working.scopeMatch === 'excluded' || dimension === 'excluded'
            ? 'excluded'
            : working.scopeMatch === 'unresolved' || dimension === 'unresolved'
              ? 'unresolved'
              : 'matched'
          : state.matched !== '0'
            ? 'matched'
            : state.unresolved !== '0'
              ? 'unresolved'
              : 'excluded'
      const selected = scopeMatch !== 'excluded'
      const accepted =
        e.nodeRunId !== null &&
        (await input.rows.get<boolean>(space('accepted-nodes'), input.keyOf(e.nodeRunId))) === true
      const covered = state.records === '0' ? accepted : state.records === state.covered
      if (selected && !ownerOnly && !covered && e.computeKind !== 'non-agent') {
        state.fold.historicalReferences = '1'
        state.fold.observedHistoricalReferences = state.observed === '0' ? '0' : '1'
        completeObservationGap(state.fold, 'historical-invocation-unobserved')
        if (scopeMatch === 'unresolved')
          completeObservationGap(state.fold, 'historical-scope-unresolved')
        if (state.records === '0')
          completeObservationGap(state.fold, 'historical-native-unobserved')
        else if (state.fold.records === '0')
          completeObservationGap(state.fold, 'historical-attribution-unresolved')
      }
      for (const issue of state.issues) if (selected) completeObservationGap(state.fold, issue)
      await states.put(key, state)
      yield {
        row: {
          referenceRole: ownerOnly ? 'owner' : 'execution',
          execution: e,
          parentTaskName: working.parentTask?.name ?? null,
          scopeMatch,
          timeBasis: working.timeBasis,
          cohortAt: working.cohortAt,
          coveredByAcceptedRecords: covered,
          metrics: completeObservationMetrics(state.fold),
          issues: state.fold.gaps,
        },
        fold: state.fold,
        task: working.parentTask,
        cohortAt: working.cohortAt,
      }
    }
    await states.flush()
  }
  return { retainAccepted, allocations, references, versions, executions }
}
