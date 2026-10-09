import { isDeepStrictEqual } from 'node:util'
import type {
  HistoricalObservationExecution,
  HistoricalObservationEvent,
  HistoricalObservationOwnerQuery,
  HistoricalNativeObservationReader,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import type { CompleteObservationCohortInput } from '../ports/completeObservationReport'
import type {
  HistoricalWorkingExecution,
  HistoricalWorkingNativeRecord,
} from '../ports/historicalObservationWorking'
import type { CompleteSourceReader } from '../ports/completeReport'
import { consumeCompleteSource } from './completePageTraversal'
import { completeWorkingTraversal } from './completeWorkingTraversal'

const PAGE = 100
export interface HistoricalObservationStage {
  readonly namespace: string
  readonly executionsNamespace: string
  readonly nativeRecordsNamespace: string
  readonly receiptsNamespace: string
  readonly sourceRows: string
}
function ownerReader<T>(
  snapshotId: string,
  read: (after: string | undefined) => Promise<{ items: readonly T[]; nextCursor: string | null }>,
): CompleteSourceReader<T> {
  return {
    async next(cursor) {
      const page = await read(cursor ?? undefined)
      return { ...page, snapshotId }
    },
  }
}
function membership(
  input: CompleteObservationCohortInput,
  execution: HistoricalObservationExecution,
  parentTask: ObservationTaskFacts | null,
  taskSelected: boolean,
): HistoricalWorkingExecution {
  let cohortAt = execution.startedAt ?? execution.createdAt,
    timeBasis: HistoricalWorkingExecution['timeBasis'] =
      execution.startedAt !== null
        ? 'execution-start'
        : execution.createdAt !== null
          ? 'owner-created'
          : 'unknown-time'
  if (execution.sourceKind === 'task') {
    cohortAt = parentTask?.startedAt ?? null
    timeBasis = cohortAt === null ? 'unknown-time' : 'task-cohort'
  } else if (taskSelected && parentTask !== null) {
    cohortAt = parentTask.startedAt
    timeBasis = 'task-cohort'
  }
  let scopeMatch: HistoricalWorkingExecution['scopeMatch'] = 'matched'
  if (input.task)
    scopeMatch =
      execution.parentTaskId === null
        ? 'excluded'
        : parentTask === null
          ? 'unresolved'
          : taskSelected
            ? 'matched'
            : 'excluded'
  else if (execution.sourceKind === 'task')
    scopeMatch =
      parentTask === null || (cohortAt === null && input.query.cohort !== 'usage')
        ? 'unresolved'
        : taskSelected
          ? 'matched'
          : 'excluded'
  else if (taskSelected) scopeMatch = 'matched'
  else if (input.query.cohort === 'usage') scopeMatch = 'matched'
  else if (cohortAt === null) scopeMatch = 'unresolved'
  else if (cohortAt < input.query.from || cohortAt >= input.query.to) scopeMatch = 'excluded'
  if (scopeMatch !== 'excluded' && !input.task) {
    if (
      !taskSelected &&
      input.query.status !== undefined &&
      execution.status !== input.query.status
    )
      scopeMatch = 'excluded'
    if (
      (input.query.repository !== undefined || input.query.workflow !== undefined) &&
      !taskSelected
    )
      scopeMatch =
        parentTask === null && execution.parentTaskId !== null ? 'unresolved' : 'excluded'
    if (
      input.query.q !== undefined &&
      !taskSelected &&
      ![execution.ownerId, execution.name].some((value) =>
        value.toLocaleLowerCase().includes(input.query.q!.toLocaleLowerCase()),
      )
    )
      scopeMatch = 'excluded'
  }
  // A missing real clock stays unresolved even if an unknown dimension was explicitly selected.
  if (input.query.cohort !== 'usage' && cohortAt === null && scopeMatch !== 'excluded')
    scopeMatch = 'unresolved'
  return { execution, parentTask, scopeMatch, timeBasis, cohortAt }
}

/** All visible owner/attempt/root references are staged before any numeric or selected-range allocation. */
export async function stageHistoricalObservationSources(
  input: CompleteObservationCohortInput,
): Promise<HistoricalObservationStage | null> {
  const sources = input.sources.historical
  if (!sources) return null
  const namespace = input.namespace + '/historical',
    executionsNamespace = namespace + '/executions',
    nativeRecordsNamespace = namespace + '/native-records',
    receiptsNamespace = namespace + '/receipts'
  const stage = {
    namespace,
    executionsNamespace,
    nativeRecordsNamespace,
    receiptsNamespace,
    sourceRows: '0',
  }
  let sourceRows = 0n
  const putExecution = async (execution: HistoricalObservationExecution) => {
    const existing = await input.rows.get<HistoricalWorkingExecution>(
      executionsNamespace,
      input.keyOf(execution.referenceId),
    )
    if (existing) {
      if (!isDeepStrictEqual(existing.execution, execution))
        throw new Error('Original historical execution identity changed')
      return existing
    }
    const parentTask =
      execution.parentTaskId === null ? null : await sources.task(execution.parentTaskId)
    const privileged = input.actor.permissions.has('tasks:read:all')
    const visible =
      privileged || parentTask !== null || execution.ownerUserId === input.actor.user.id
    if (!visible) return null
    const selected =
      execution.parentTaskId !== null &&
      (await input.rows.get(input.namespace + '/original-tasks', execution.parentTaskId)) !==
        undefined
    const value = membership(input, execution, parentTask, selected)
    await input.rows.insert(executionsNamespace, [
      { key: input.keyOf(execution.referenceId), document: value },
    ])
    return value
  }
  const root = async (referenceId: string, sessionId: string) => {
    const key = input.keyOf(sessionId)
    await input.rows.put(namespace + '/roots', { key, document: { sessionId } })
    await input.rows.put(namespace + '/root-refs/' + key, {
      key: input.keyOf(referenceId),
      document: { referenceId },
    })
    await input.rows.put(namespace + '/execution-roots/' + input.keyOf(referenceId), {
      key,
      document: { rootKey: key },
    })
  }
  const events = async (
    query: HistoricalObservationOwnerQuery,
    original: HistoricalObservationExecution,
  ) => {
    let attemptReferences = false,
      terminalRootObserved = false
    const receipt = await consumeCompleteSource({
      source: namespace + '/events/' + input.keyOf(original.referenceId),
      snapshotId: input.sources.snapshotId,
      reader: ownerReader(input.sources.snapshotId, (after) =>
        query.events(original.ownerId, { limit: PAGE, ...(after === undefined ? {} : { after }) }),
      ),
      signal: input.signal,
      workspace: {
        claimCursor: async (source, cursor) =>
          input.rows.insert(source + '/cursors', [{ key: input.keyOf(cursor), document: cursor }]),
        append: async (_, items: readonly HistoricalObservationEvent[]) => {
          for (const event of items) {
            if (original.sourceKind === 'memory-distill' && event.attemptId !== null) {
              attemptReferences = true
              if (original.rootSessionId !== null && event.sessionId === original.rootSessionId)
                terminalRootObserved = true
            }
            const execution =
              original.sourceKind === 'memory-distill' && event.attemptId !== null
                ? {
                    ...original,
                    referenceId: JSON.stringify([
                      'historical-observed',
                      original.sourceKind,
                      original.ownerId,
                      event.attemptId,
                    ]),
                    attemptId: event.attemptId,
                    startedAt: null,
                    finishedAt: null,
                    rootSessionId: null,
                  }
                : original
            if (!(await putExecution(execution))) continue
            if (event.sessionId !== null) await root(execution.referenceId, event.sessionId)
            if (event.stepId !== null && event.sessionId !== null)
              await input.rows.put(namespace + '/event-refs/' + input.keyOf(event.stepId), {
                key: input.keyOf(JSON.stringify([execution.referenceId, event.sessionId])),
                document: {
                  referenceId: execution.referenceId,
                  sessionId: event.sessionId,
                  eventId: event.id,
                  occurredAt: event.occurredAt,
                },
              })
          }
        },
      },
    })
    await input.rows.put(receiptsNamespace, { key: input.keyOf(receipt.source), document: receipt })
    return { attemptReferences, terminalRootObserved }
  }
  for (const owner of sources.owners) {
    const receipt = await consumeCompleteSource({
      source: namespace + '/owners/' + owner.kind,
      snapshotId: input.sources.snapshotId,
      reader: ownerReader(input.sources.snapshotId, (after) =>
        owner.query.owners({ limit: PAGE, ...(after === undefined ? {} : { after }) }),
      ),
      signal: input.signal,
      workspace: {
        claimCursor: async (source, cursor) =>
          input.rows.insert(source + '/cursors', [{ key: input.keyOf(cursor), document: cursor }]),
        append: async (_, items: readonly HistoricalObservationExecution[]) => {
          for (const execution of items) {
            if (execution.kind !== 'historical-observed' || execution.sourceKind !== owner.kind)
              throw new Error('Original historical owner source changed')
            sourceRows++
            if (!(await putExecution(execution))) continue
            const history = await events(owner.query, execution)
            const ownerOnly =
              execution.sourceKind === 'memory-distill' &&
              history.attemptReferences &&
              (execution.rootSessionId === null || history.terminalRootObserved)
            if (ownerOnly) {
              await input.rows.put(namespace + '/owner-metadata', {
                key: input.keyOf(execution.referenceId),
                document: true,
              })
              await input.rows.put(receiptsNamespace, {
                key: 'memory-owner/' + input.keyOf(execution.referenceId),
                document: {
                  kind: 'historical-owner-metadata',
                  referenceId: execution.referenceId,
                  rootSessionId: execution.rootSessionId,
                  ...history,
                  originalEventsEOF: true,
                },
              })
            } else if (execution.rootSessionId !== null)
              await root(execution.referenceId, execution.rootSessionId)
          }
        },
      },
    })
    await input.rows.put(receiptsNamespace, { key: input.keyOf(receipt.source), document: receipt })
  }
  for await (const row of completeWorkingTraversal<{ sessionId: string }>(
    input.rows,
    namespace + '/roots',
    input.signal,
  ))
    await retainHistoricalNativeRoot(input, stage, row.key, row.document.sessionId)
  return { ...stage, sourceRows: String(sourceRows) }
}

async function retainHistoricalNativeRoot(
  input: CompleteObservationCohortInput,
  stage: HistoricalObservationStage,
  key: string,
  sessionId: string,
) {
  const sources = input.sources.historical!,
    issues = new Set<string>()
  let reader: HistoricalNativeObservationReader | null = null,
    final: ReturnType<HistoricalNativeObservationReader['next']>['eof'] = null,
    pages = 0n
  try {
    // This is a report reference for the original root, never an accepted invocation.
    reader = await sources.native.open({
      referenceId: JSON.stringify(['historical-native-root', sessionId]),
      rootSessionId: sessionId,
    })
    if (reader === null) throw new Error('Original historical native store unavailable')
    let cursor = reader.initialCursor
    while (true) {
      input.signal?.throwIfAborted()
      const page = reader.next(cursor)
      if (
        page.cursor !== cursor ||
        page.identity.rootSessionId !== sessionId ||
        !isDeepStrictEqual(page.identity, reader.identity)
      )
        throw new Error('Original historical native page changed its root')
      for (const issue of page.issues) issues.add(issue)
      for (const step of page.steps) {
        const recordKey = input.keyOf(JSON.stringify([page.identity.nativeSource, step.stepId])),
          fingerprint = input.keyOf(
            JSON.stringify([step.id, step.stepId, step.occurredAt, step.usage, step.model]),
          )
        const previous = await input.rows.get<HistoricalWorkingNativeRecord>(
          stage.nativeRecordsNamespace,
          recordKey,
        )
        const value = {
          nativeSource: page.identity.nativeSource,
          sourceGeneration: page.identity.sourceGeneration,
          step,
          fingerprint,
          conflicting:
            previous?.conflicting === true ||
            (previous !== undefined && previous.fingerprint !== fingerprint),
        }
        if (previous === undefined)
          await input.rows.insert(stage.nativeRecordsNamespace, [
            { key: recordKey, document: value },
          ])
        else if (value.conflicting)
          await input.rows.put(stage.nativeRecordsNamespace, {
            key: recordKey,
            document: { ...previous, conflicting: true },
          })
        await input.rows.put(stage.namespace + '/native-versions/' + recordKey, {
          key: fingerprint,
          document: value,
        })
        await input.rows.put(stage.namespace + '/record-roots/' + recordKey, {
          key,
          document: { rootKey: key },
        })
      }
      await input.rows.put(stage.receiptsNamespace, {
        key: 'native-page/' + key + '/' + page.ordinal,
        document: {
          kind: 'historical-native-page',
          identity: page.identity,
          ordinal: page.ordinal,
          payloadDigest: page.payloadDigest,
          cumulativeDigest: page.cumulativeDigest,
          counts: page.counts,
          scanPositionBefore: page.scanPositionBefore,
          scanPositionAfter: page.scanPositionAfter,
          eof: page.eof,
        },
      })
      pages++
      if (page.nextCursor === null) {
        if (page.eof === null) throw new Error('Original historical native EOF receipt missing')
        final = page.eof
      }
      reader.acknowledge(page.ordinal, page.payloadDigest)
      if (page.nextCursor === null) break
      if (page.nextCursor === cursor)
        throw new Error('Original historical native cursor did not advance')
      cursor = page.nextCursor
    }
    if ((await sources.native.generation()) !== reader.identity.sourceGeneration)
      issues.add('historical-native-generation-changed')
  } catch (error) {
    if (input.signal?.aborted) throw error
    issues.add('historical-native-unavailable')
  } finally {
    reader?.close()
  }
  const receipt = {
    kind: 'historical-native-root',
    rootSessionId: sessionId,
    pages: String(pages),
    identity: reader?.identity ?? null,
    eof: final,
    issues: [...issues],
  }
  await input.rows.put(stage.namespace + '/root-results', { key, document: receipt })
  await input.rows.put(stage.receiptsNamespace, { key: 'native-root/' + key, document: receipt })
}
