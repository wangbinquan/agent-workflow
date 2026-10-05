import {
  completeObservationGap,
  emptyCompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type {
  CompleteObservationTaskInput,
  CompleteInvocationWorking,
  CompleteObservationContribution,
} from '../ports/completeObservationTask'
import type { CompleteSourceReader } from '../ports/completeReport'
import { consumeCompleteSource } from './completePageTraversal'
import { completeWorkingCache } from './completeWorkingCache'

export function completeObservationEvidenceContext(input: CompleteObservationTaskInput) {
  const space = (name: string) => input.namespace + '/' + name
  const invocations = completeWorkingCache<CompleteInvocationWorking>(
    input.rows,
    space('invocations'),
    input.signal,
  )
  const usage = input.usageWorkspace({
    rows: input.rows,
    namespace: space('usage'),
    keyOf: input.keyOf,
    identity: (record: CompleteObservationContribution) =>
      JSON.stringify([record.sourceId, record.invocationId, record.measurement.recordId]),
    signal: input.signal,
    nativeScopes: input.sources.nativeScopes,
  })
  const fold = emptyCompleteObservationFold()
  const traverse = <T>(
    source: string,
    reader: CompleteSourceReader<T>,
    append: (items: readonly T[]) => Promise<void>,
  ) =>
    consumeCompleteSource({
      source: space(source),
      snapshotId: input.sources.snapshotId,
      reader,
      signal: input.signal,
      workspace: {
        claimCursor: async (_, cursor) =>
          input.rows.insert(space('cursors'), [
            { key: input.keyOf(JSON.stringify([source, cursor])), document: cursor },
          ]),
        append: async (_, items) => append(items),
      },
    })
  const invocationFor = async (id: string) => {
    const key = input.keyOf(id),
      entry = await invocations.get(key)
    if (!entry || entry.invocation.taskId !== input.task.id)
      throw new Error('Original accepted invocation identity missing')
    return { key, entry }
  }
  return { input, space, invocations, usage, fold, traverse, invocationFor }
}
export type CompleteObservationEvidenceContext = ReturnType<
  typeof completeObservationEvidenceContext
>

export function retainCompleteObservationAttempts(context: CompleteObservationEvidenceContext) {
  const { input, space } = context
  return context.traverse('attempts', input.sources.attempts(input.task.id), async (items) => {
    await input.rows.insert(
      space('attempts'),
      items.map((document) => ({ key: document.id, document })),
    )
  })
}
export function retainCompleteObservationInvocations(context: CompleteObservationEvidenceContext) {
  const { input, space } = context
  return context.traverse(
    'invocations',
    input.sources.invocations(input.task.id),
    async (items) => {
      for (const invocation of items) {
        if (invocation.taskId !== input.task.id) throw new Error('Original invocation changed Task')
        if (
          invocation.nodeRunId !== null &&
          !(await input.rows.get(space('attempts'), invocation.nodeRunId))
        )
          throw new Error('Original invocation attempt missing')
      }
      await input.rows.insert(
        space('invocations'),
        items.map((invocation) => ({
          key: input.keyOf(invocation.invocationId),
          document: {
            invocation,
            fold: emptyCompleteObservationFold('1'),
            rawRecords: '0',
            nativeComplete: false,
            nativeCaptureCount: '0',
            knownZero: false,
            emptyCostVisible: false,
          } satisfies CompleteInvocationWorking,
        })),
      )
    },
  )
}
export function retainCompleteObservationCaptures(context: CompleteObservationEvidenceContext) {
  const { input, space } = context
  return context.traverse('captures', input.sources.captures(input.task.id), async (items) => {
    await input.rows.insert(
      space('captures'),
      items.map((document) => ({ key: input.keyOf(document.invocationId), document })),
    )
    for (const capture of items) {
      const { key, entry } = await context.invocationFor(capture.invocationId),
        invocation = entry.invocation,
        proof = capture.capture
      if (
        capture.taskId !== input.task.id ||
        invocation.authority.kind !== 'local' ||
        invocation.nativeCaptureSource !== proof.nativeSource
      )
        throw new Error('Original native capture admission mismatch')
      if (proof.contract === 'opencode-child-pages-v2') {
        if (!input.sources.nativeScopes)
          throw new Error('Original native completion source is not installed')
        const qualified = await input.sources.nativeScopes.qualify(capture)
        entry.nativeComplete =
          invocation.nativeCaptureContract === proof.contract &&
          qualified.complete &&
          !capture.priorRevisionGap
        entry.expectedNativeRecords = qualified.records
        entry.knownZero = entry.nativeComplete && qualified.records === '0'
        entry.nativeCaptureCount = '1'
        entry.emptyCostVisible = entry.knownZero
        if (!entry.nativeComplete) completeObservationGap(entry.fold, 'native-capture-incomplete')
        await context.invocations.put(key, entry)
        continue
      }
      const repairedIssues = ['native-prior-revision-gap', 'native-prior-revision-budget']
      const currentIssues = proof.issues.filter(
        (issue) => capture.priorRevisionGap || !repairedIssues.includes(issue),
      )
      const repaired =
        proof.state === 'partial' &&
        proof.issues.some((issue) => repairedIssues.includes(issue)) &&
        !capture.priorRevisionGap &&
        !currentIssues.length &&
        proof.priorRevisions.every((revision) =>
          capture.resolutions.some(
            (resolution) =>
              resolution.sessionId === revision.sessionId &&
              resolution.stepId === revision.stepId &&
              resolution.status === 'resolved',
          ),
        )
      entry.nativeComplete =
        invocation.nativeCaptureContract === proof.contract &&
        (proof.state === 'complete' || repaired) &&
        !!proof.rootSessionId &&
        !!proof.snapshotFingerprint &&
        !currentIssues.length &&
        !capture.priorRevisionGap &&
        (proof.baseline.kind === 'fresh' || proof.baseline.fingerprint !== null)
      if (!entry.nativeComplete) completeObservationGap(entry.fold, 'native-capture-incomplete')
      entry.knownZero =
        entry.nativeComplete && proof.scannedSteps === (proof.baselineSteps?.length ?? 0)
      entry.expectedNativeRecords = String(proof.scannedSteps - (proof.baselineSteps?.length ?? 0))
      entry.nativeCaptureCount = '1'
      entry.emptyCostVisible = entry.knownZero
      await context.invocations.put(key, entry)
    }
  })
}
export function retainCompleteObservationUsage(context: CompleteObservationEvidenceContext) {
  return context.traverse(
    'local-records',
    context.input.sources.usage(context.input.task.id),
    async (items) => {
      const records: CompleteObservationContribution[] = []
      for (const record of items) {
        const m = record.measurement,
          { key, entry } = await context.invocationFor(m.invocationId),
          i = entry.invocation
        if (
          i.authority.kind !== 'local' ||
          m.taskId !== i.taskId ||
          m.nodeRunId !== i.nodeRunId ||
          m.agentId !== i.agentId
        )
          throw new Error('Original numeric usage admission mismatch')
        if (m.scope && 'ancestry' in m.scope) {
          if (!context.input.sources.nativeScopes)
            throw new Error('Original native numeric source is not installed')
          const facts = await context.input.sources.nativeScopes.resolve(m, m.scope)
          if (JSON.stringify(facts) !== JSON.stringify(record.nativeScopeFacts))
            throw new Error('Original native numeric ancestry changed after projection')
        }
        entry.rawRecords = String(BigInt(entry.rawRecords) + 1n)
        records.push({
          ...record,
          invocationId: i.invocationId,
          localModel: m.model,
          observedAt: m.observedAt,
        })
        await context.invocations.put(key, entry)
      }
      await context.usage.append(records)
    },
  )
}
