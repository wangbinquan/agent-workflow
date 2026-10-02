import type {
  AcceptedObservationInvocation,
  ObservationSpanOwnerProof,
} from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import type {
  ObservationInvocationParticipant,
  ObservationUsageSource,
} from '../public/participants'

/** Original creation proofs survive ACK. Later revisions never become another creation. */
export function createSpanOwnerLookup(input: {
  readonly source: ObservationUsageSource
  readonly get: (id: string) => Promise<AcceptedObservationInvocation | undefined>
  readonly invocations: (taskId: string) => Promise<{
    readonly items: readonly AcceptedObservationInvocation[]
    readonly truncated: boolean
  }>
  readonly clock?: () => number
}): NonNullable<ObservationInvocationParticipant['spanOwners']> {
  return async (query) => {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 5000)
      throw new RangeError('Invalid span owner budget')
    const clock = input.clock ?? (() => performance.now()),
      deadline = clock() + 400
    const current = await input.get(query.invocationId)
    if (
      !current ||
      current.authority.kind !== 'local' ||
      current.spanCaptureContract !== 'runtime-span-facts-v1' ||
      current.spanCaptureSource !== query.sourceNamespace ||
      !input.source.spanSources
    )
      return { owners: [], complete: false, issues: ['native-span-owner-source-unavailable'] }
    const accepted = await input.invocations(current.taskId)
    if (accepted.truncated)
      return { owners: [], complete: false, issues: ['native-span-owner-acceptance-budget'] }
    const carriers = accepted.items.filter(
      (row) =>
        row.authority.kind === 'local' &&
        row.spanCaptureContract === current.spanCaptureContract &&
        row.spanCaptureSource === query.sourceNamespace,
    )
    const byId = new Map(carriers.map((row) => [row.invocationId, row])),
      owners = new Map<string, ObservationSpanOwnerProof>()
    const scopeHash = sha256Hex(
      JSON.stringify([
        'span-owners',
        current.taskId,
        query.sourceNamespace,
        query.rootSessionId,
        carriers.map((row) => row.invocationId),
      ]),
    )
    const issues = new Set<string>()
    let after: string | null = null,
      records = 0,
      complete = false
    for (let page = 0; page < 100 && records < 20000 && clock() < deadline; page++) {
      const result = await input.source.spanSources({
        taskId: current.taskId,
        carrierInvocationIds: [...byId.keys()],
        sourceNamespace: query.sourceNamespace,
        scopeHash,
        after,
        limit: 200,
      })
      for (const issue of result.issues) issues.add(issue)
      records += result.records.length
      for (const record of result.records) {
        if (record.type !== 'fact' || record.fact.scope.rootSessionId !== query.rootSessionId)
          continue
        const original = byId.get(record.fact.invocationId)
        if (
          !original ||
          original.taskId !== current.taskId ||
          original.nodeRunId !== record.nodeRunId
        ) {
          issues.add('native-span-owner-scope-conflict')
          continue
        }
        const key = JSON.stringify([original.invocationId, record.fact.spanKey])
        if (owners.has(key)) continue
        if (owners.size >= query.limit) {
          issues.add('native-span-owner-budget')
          continue
        }
        owners.set(key, {
          sourceRowId: record.sourceRowId,
          sourceNodeRunId: record.nodeRunId,
          itemIndex: record.itemIndex,
          accepted: original,
          spanKey: record.fact.spanKey,
          scope: record.fact.scope,
          creation: record.fact,
        })
      }
      if (result.nextCursor === null) {
        complete = true
        break
      }
      if (result.nextCursor === after) {
        issues.add('native-span-owner-cursor-stalled')
        break
      }
      after = result.nextCursor
    }
    if (!complete) issues.add('native-span-owner-budget')
    return {
      owners: [...owners.values()],
      complete: complete && issues.size === 0,
      issues: [...issues],
    }
  }
}
