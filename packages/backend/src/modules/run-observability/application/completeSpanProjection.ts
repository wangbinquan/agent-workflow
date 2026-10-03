import type { ObservationSpanSourceRecord, ObservationSpanSourcePage } from '@agent-workflow/shared'
import {
  immutableSpanEvidence,
  mergeSpanState,
  sameSpanEvidence,
  unknownSpanState,
} from '../domain/spanProjection'
import { completeOrdinalKey } from '../domain/completeOrdinal'
import type {
  CompleteObservationTaskInput,
  CompleteInvocationWorking,
} from '../ports/completeObservationTask'
import type {
  CompleteProjectedSpan,
  CompleteSpanProjection,
} from '../ports/completeObservationSpans'
import type { CompleteSourceReceipt } from '../ports/completeReport'
import { consumeCompleteSource } from './completePageTraversal'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'
import { completeExternalSort } from './completeExternalSort'

/** Same creation/refinement/proof rules as the original projector; population lives in TEMP. */
export async function projectCompleteObservationSpans(
  input: CompleteObservationTaskInput,
): Promise<CompleteSpanProjection & { readonly receipt: CompleteSourceReceipt | null }> {
  const space = (name: string) => input.namespace + '/' + name
  const spansNamespace = space('projected-spans'),
    capturesNamespace = space('span-captures'),
    repairsNamespace = space('span-repairs'),
    recordsNamespace = space('span-records')
  const issues = new Set<string>(),
    owners = completeWorkingCache<CompleteInvocationWorking>(
      input.rows,
      space('invocations'),
      input.signal,
    ),
    spans = completeWorkingCache<CompleteProjectedSpan>(input.rows, spansNamespace, input.signal)
  const owner = async (id: string) => (await owners.get(input.keyOf(id)))?.invocation
  const carrier = async (record: ObservationSpanSourceRecord) => {
    const id =
      record.type === 'fact'
        ? record.fact.invocationId
        : record.type === 'revision'
          ? record.revision.carrierInvocationId
          : record.invocationId
    const accepted = await owner(id)
    return (
      accepted?.authority.kind === 'local' &&
      accepted.spanCaptureContract === 'runtime-span-facts-v1'
    )
  }
  const belongs = async (id: string, nodeRunId: string, source: string) => {
    const accepted = await owner(id)
    return (
      accepted?.taskId === input.task.id &&
      accepted.nodeRunId === nodeRunId &&
      accepted.authority.kind === 'local' &&
      accepted.spanCaptureContract === 'runtime-span-facts-v1' &&
      accepted.spanCaptureSource === source
    )
  }
  const spanKey = (invocationId: string, key: string) =>
    input.keyOf(JSON.stringify([invocationId, key]))
  const poison = (span: CompleteProjectedSpan, code: string) => {
    span.issues = [...new Set([...span.issues, code])]
    span.fact = { ...span.fact, state: unknownSpanState() }
  }
  const reader = input.sources.spans?.(input.task.id)
  let receipt: CompleteSourceReceipt | null = null,
    ordinal = 0n,
    watermark: number | null = null
  if (!reader) issues.add('span-source-unavailable')
  else
    receipt = await consumeCompleteSource<
      Omit<ObservationSpanSourcePage, 'nextCursor' | 'truncated'>
    >({
      source: space('original-spans'),
      snapshotId: input.sources.snapshotId,
      reader,
      signal: input.signal,
      workspace: {
        async claimCursor(_, cursor) {
          await input.rows.insert(space('span-cursors'), [
            { key: input.keyOf(cursor), document: cursor },
          ])
        },
        async append(_, batches) {
          for (const batch of batches) {
            if (watermark !== null && watermark !== batch.watermark)
              throw new Error('Original span source changed watermark')
            watermark = batch.watermark
            for (const code of batch.issues) issues.add(code)
            const retained = []
            for (const record of batch.records)
              if (await carrier(record))
                retained.push({ key: completeOrdinalKey(ordinal++), document: record })
            await input.rows.insert(recordsNamespace, retained)
          }
        },
      },
    })
  const ordered = await completeExternalSort({
    workspace: input.rows,
    namespace: space('span-creation-order'),
    signal: input.signal,
    records: (async function* () {
      for await (const row of completeWorkingTraversal<ObservationSpanSourceRecord>(
        input.rows,
        recordsNamespace,
        input.signal,
      ))
        if (row.document.type === 'fact') yield row.document
    })(),
    compare: (a, b) => a.sourceRowId - b.sourceRowId || a.itemIndex - b.itemIndex,
  })
  for await (const record of ordered.records()) {
    if (record.type !== 'fact') continue
    const fact = record.fact
    if (!(await belongs(fact.invocationId, record.nodeRunId, fact.scope.sourceNamespace))) {
      issues.add('span-owner-scope-conflict')
      continue
    }
    const key = spanKey(fact.invocationId, fact.spanKey),
      original = await spans.get(key)
    if (!original) {
      await spans.put(key, {
        creation: fact,
        fact,
        sourceRowId: record.sourceRowId,
        itemIndex: record.itemIndex,
        nodeRunId: record.nodeRunId,
        issues: [...(fact.issues ?? [])],
      })
      continue
    }
    if (!sameSpanEvidence(immutableSpanEvidence(original.creation), immutableSpanEvidence(fact)))
      poison(original, 'span-immutable-conflict')
    else {
      original.issues = [...new Set([...original.issues, ...(fact.issues ?? [])])]
      if (original.issues.length) poison(original, 'span-native-evidence-partial')
      else {
        const state = mergeSpanState(original.fact.state, fact.state)
        if (state) original.fact = { ...original.fact, state }
        else poison(original, 'span-boundary-conflict')
      }
    }
    await spans.put(key, original)
  }
  let captureOrdinal = 0n
  for await (const row of completeWorkingTraversal<ObservationSpanSourceRecord>(
    input.rows,
    recordsNamespace,
    input.signal,
  )) {
    const record = row.document
    if (record.type === 'capture') {
      if (await belongs(record.invocationId, record.nodeRunId, record.capture.sourceNamespace))
        await input.rows.insert(capturesNamespace, [
          {
            key: completeOrdinalKey(captureOrdinal++),
            document: {
              invocationId: record.invocationId,
              nodeRunId: record.nodeRunId,
              capture: record.capture,
            },
          },
        ])
      else issues.add('span-capture-scope-conflict')
      continue
    }
    if (record.type === 'diagnostic') {
      issues.add(record.code)
      continue
    }
    if (record.type !== 'revision') continue
    const revision = record.revision,
      proof = revision.originalOwnerProof,
      key = spanKey(revision.targetOwnerInvocationId, revision.targetSpanKey),
      target = await spans.get(key),
      accepted = await owner(revision.targetOwnerInvocationId)
    if (
      !target ||
      !accepted ||
      !(await belongs(
        revision.carrierInvocationId,
        record.nodeRunId,
        proof.scope.sourceNamespace,
      )) ||
      revision.carrierInvocationId === revision.targetOwnerInvocationId ||
      !sameSpanEvidence(accepted, proof.accepted) ||
      proof.sourceRowId !== target.sourceRowId ||
      proof.itemIndex !== target.itemIndex ||
      proof.sourceNodeRunId !== target.nodeRunId ||
      !sameSpanEvidence(proof.creation, target.creation) ||
      !sameSpanEvidence(proof.scope, target.creation.scope)
    ) {
      issues.add('span-prior-proof-invalid')
      if (target) {
        poison(target, 'span-prior-proof-invalid')
        await spans.put(key, target)
      }
      continue
    }
    if (target.issues.length) continue
    const before = mergeSpanState(target.creation.state, revision.before),
      state = before && mergeSpanState(target.fact.state, revision.after)
    if (!state) poison(target, 'span-prior-boundary-conflict')
    else {
      target.fact = { ...target.fact, state }
      await input.rows.put(repairsNamespace, {
        key: input.keyOf(
          JSON.stringify([
            revision.carrierInvocationId,
            revision.targetOwnerInvocationId,
            revision.targetSpanKey,
          ]),
        ),
        document: {
          carrierInvocationId: revision.carrierInvocationId,
          targetInvocationId: revision.targetOwnerInvocationId,
          targetSpanKey: revision.targetSpanKey,
        },
      })
    }
    await spans.put(key, target)
  }
  await spans.flush()
  for await (const row of completeWorkingTraversal<CompleteProjectedSpan>(
    input.rows,
    spansNamespace,
    input.signal,
  ))
    if (row.document.issues.length) {
      poison(row.document, 'span-evidence-conflict')
      await spans.put(row.key, row.document)
    }
  await spans.flush()
  return { spansNamespace, capturesNamespace, repairsNamespace, issues: [...issues], receipt }
}
