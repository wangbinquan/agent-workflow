import type { AcceptedObservationInvocation } from '@agent-workflow/shared'
import type { PlatformObservation } from '../domain/platformObservation'
import { platformObservationKey, type PlatformObservationBinding } from '../domain/platformSync'
import { completeObservationGap } from '../domain/completeObservationMetrics'
import { completeOrdinalKey } from '../domain/completeOrdinal'
import type {
  CompleteInvocationWorking,
  CompleteObservationContribution,
} from '../ports/completeObservationTask'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'
import type { CompleteObservationEvidenceContext } from './completeObservationEvidence'

type Native = Extract<PlatformObservation, { kind: 'capture' }>
const identity = (i: PlatformObservation['identity']) =>
  JSON.stringify([i.projectId, i.taskId, i.subtaskId, i.executionId, i.executionGeneration])
function acceptedIdentity(invocation: AcceptedObservationInvocation) {
  const a = invocation.authority
  return a.kind === 'crewstation'
    ? JSON.stringify([
        a.projectId,
        a.taskId,
        a.subtaskId,
        a.executionResourceId,
        a.executionGeneration,
      ])
    : null
}
const captureKey = (
  invocation: string,
  source: string,
  root: string | null,
  turn: string | null,
  index: number | null,
) => JSON.stringify([invocation, source, root, turn, index])

/** One complete imported population per original binding; every selected record retains its full admission identity. */
export async function retainCompleteObservationPlatform(
  context: CompleteObservationEvidenceContext,
) {
  const { input, space } = context,
    receipts = [],
    mappings = completeWorkingCache<string>(input.rows, space('platform-admissions'), input.signal)
  for await (const row of completeWorkingTraversal<CompleteInvocationWorking>(
    input.rows,
    space('invocations'),
    input.signal,
  )) {
    const invocation = row.document.invocation,
      a = invocation.authority
    if (a.kind !== 'crewstation') continue
    if (a.sourceId === null) {
      completeObservationGap(row.document.fold, 'legacy-unbound')
      await context.invocations.put(row.key, row.document)
      continue
    }
    const key = input.keyOf(JSON.stringify([a.sourceId, acceptedIdentity(invocation)]))
    if ((await mappings.get(key)) !== undefined)
      throw new Error('Original platform execution bound to multiple invocations')
    await mappings.put(key, invocation.invocationId)
    await input.rows.put(space('platform-bindings'), {
      key: input.keyOf(JSON.stringify([a.sourceId, a.projectId, a.taskId])),
      document: { sourceId: a.sourceId, projectId: a.projectId, taskId: a.taskId },
    })
  }
  await mappings.flush()
  let usageCount = 0n
  for await (const row of completeWorkingTraversal<PlatformObservationBinding>(
    input.rows,
    space('platform-bindings'),
    input.signal,
  )) {
    const binding = row.document,
      state = await input.sources.platformState(binding)
    await input.rows.insert(space('platform-states'), [{ key: row.key, document: state }])
    const receipt = await context.traverse(
      'platform/' + row.key,
      input.sources.platform(binding),
      async (items) => {
        const retained: CompleteObservationContribution[] = []
        for (const item of items) {
          if (
            item.identity.projectId !== binding.projectId ||
            item.identity.taskId !== binding.taskId
          )
            throw new Error('Original platform row changed source binding')
          const invocationId = await mappings.get(
            input.keyOf(JSON.stringify([binding.sourceId, identity(item.identity)])),
          )
          // The imported business Task also contains executions admitted to other consumers.
          if (invocationId === undefined) continue
          const { key, entry } = await context.invocationFor(invocationId)
          if (state.status !== 'ready' || state.schemaVersion !== 2 || state.gaps.length)
            completeObservationGap(entry.fold, 'platform-capture-incomplete')
          entry.fold.visible &&= state.costVisibility !== 'hidden'
          entry.emptyCostVisible = state.costVisibility !== 'hidden' && state.costsReady
          await input.rows.insert(space('platform-record-identities'), [
            {
              key: input.keyOf(JSON.stringify([row.key, platformObservationKey(item)])),
              document: true,
            },
          ])
          if (item.kind === 'valuation')
            await input.rows.insert(space('platform-valuations'), [
              {
                key: input.keyOf(
                  JSON.stringify([invocationId, platformObservationKey(item, 'usage')]),
                ),
                document: item,
              },
            ])
          else if (item.kind === 'capture') await retainPlatformCapture(context, entry, item)
          else {
            entry.rawRecords = String(BigInt(entry.rawRecords) + 1n)
            const record: CompleteObservationContribution = {
              sourceId: item.sourceId,
              invocationId,
              observedAt: Date.parse(item.observedAt),
              localModel: null,
              platformUsage: item,
              measurement: {
                invocationId,
                recordId: item.recordId,
                model: item.modelRef === null ? null : { provider: null, id: item.modelRef },
                ...(item.scope === null ? {} : { scope: item.scope }),
                ...(item.coveredThroughTurn === null
                  ? {}
                  : { coveredThroughTurn: item.coveredThroughTurn }),
              },
              contribution: item.projection.contribution,
              complete: item.projection.complete,
              ...(item.projection.coveredThrough === null
                ? {}
                : { coveredThrough: item.projection.coveredThrough }),
            }
            retained.push(record)
            await input.rows.insert(space('platform-raw-usage'), [
              {
                key: input.keyOf(JSON.stringify([invocationId, platformObservationKey(item)])),
                document: record,
              },
            ])
          }
          await context.invocations.put(key, entry)
        }
        usageCount += BigInt(retained.length)
        await context.usage.append(retained)
      },
    )
    receipts.push(receipt)
  }
  return { receipts, usageCount: String(usageCount) }
}
async function retainPlatformCapture(
  context: CompleteObservationEvidenceContext,
  entry: CompleteInvocationWorking,
  item: Native,
) {
  const { input, space } = context,
    capture = item.capture,
    p = capture.proof
  if (identity(item.identity) !== acceptedIdentity(entry.invocation))
    throw new Error('Original platform capture admission mismatch')
  await input.rows.insert(space('platform-captures'), [
    {
      key: input.keyOf(JSON.stringify([entry.invocation.invocationId, capture.id])),
      document: {
        invocationId: entry.invocation.invocationId,
        nodeRunId: entry.invocation.nodeRunId,
        sourceId: item.sourceId,
        schemaVersion: 2,
        capture,
      },
    },
  ])
  const complete =
    capture.state === 'complete' &&
    p.state === 'complete' &&
    !!p.root &&
    !!p.fingerprint &&
    !p.priorRevisionGap &&
    !p.issues.length &&
    !capture.issues.length &&
    !capture.historicalRevisionGap &&
    !capture.revisedBaselineSteps &&
    !capture.unresolvedBaselineSteps &&
    capture.receivedSteps === p.emitted &&
    capture.receivedBaselineSteps === p.baselineSteps &&
    p.steps === p.emitted + p.baselineSteps
  if (!complete) completeObservationGap(entry.fold, 'native-capture-incomplete')
  const zero =
    complete && capture.receivedSteps === 0 && p.emitted === 0 && p.steps === p.baselineSteps
  entry.nativeComplete =
    entry.nativeCaptureCount === '0' ? complete : entry.nativeComplete && complete
  entry.knownZero = entry.nativeCaptureCount === '0' ? zero : entry.knownZero && zero
  entry.nativeCaptureCount = String(BigInt(entry.nativeCaptureCount) + 1n)
  await input.rows.insert(space('platform-capture-turns'), [
    {
      key: input.keyOf(
        captureKey(entry.invocation.invocationId, item.sourceId, p.root, p.turn, p.turnIndex),
      ),
      document: capture,
    },
  ])
  await input.rows.insert(space('platform-capture-owners'), [
    {
      key: input.keyOf(
        captureKey(entry.invocation.invocationId, item.sourceId, p.root, p.turn, p.turnIndex),
      ),
      document: { invocationId: entry.invocation.invocationId },
    },
  ])
  const lineage = input.keyOf(
    JSON.stringify([entry.invocation.invocationId, item.sourceId, p.lineageKey]),
  )
  await input.rows.put(space('platform-lineages'), {
    key: lineage,
    document: entry.invocation.invocationId,
  })
  await input.rows.insert(space('platform-turn-indices/' + lineage), [
    { key: completeOrdinalKey(BigInt(p.turnIndex)), document: p.turnIndex },
  ])
}
export async function validateCompletePlatformTurns(context: CompleteObservationEvidenceContext) {
  for await (const lineage of completeWorkingTraversal<string>(
    context.input.rows,
    context.space('platform-lineages'),
    context.input.signal,
  )) {
    let index = 0n
    for await (const turn of completeWorkingTraversal<number>(
      context.input.rows,
      context.space('platform-turn-indices/' + lineage.key),
      context.input.signal,
    )) {
      if (turn.key !== completeOrdinalKey(index++)) {
        const { key, entry } = await context.invocationFor(lineage.document)
        completeObservationGap(entry.fold, 'native-turn-gap')
        await context.invocations.put(key, entry)
      }
    }
  }
}
export const completePlatformCaptureKey = captureKey
