import type {
  ObservationSpanSourceRecord,
  ObservationTaskSpans,
  ObservationTaskSpansQuery,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { sha256Hex } from '@/util/hash'
import { projectObservationSpans } from '../domain/spanProjection'
import type { ObservationSnapshot, ObservationSnapshotSources } from '../ports/taskObservations'

/** Actor lookup precedes every accepted invocation, retained source, and valuation query. */
export function createTaskSpanQuery(
  snapshot: ObservationSnapshot,
  loadContributions: (
    sources: ObservationSnapshotSources,
    taskId: string,
  ) => Promise<{
    readonly truncated: boolean
    readonly records: readonly {
      readonly invocationId: string
      readonly recordId: string
      readonly usage: {
        readonly input: string | null
        readonly cacheRead: string | null
        readonly cacheWrite: string | null
        readonly output: string | null
      }
      readonly amountDecimal: string | null
      readonly costComplete: boolean
    }[]
  }>,
) {
  return (
    actor: Actor,
    taskId: string,
    query: ObservationTaskSpansQuery,
  ): Promise<ObservationTaskSpans | null> =>
    snapshot.read(async (sources) => {
      const task = await sources.tasks.get(actor, taskId)
      if (!task) return null
      const limit = query.limit ?? 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !query.nodeRunId)
        throw new RangeError('Invalid task span query')
      const attempts = await sources.tasks.attempts(taskId, 1000)
      if (!attempts.items.some((row) => row.id === query.nodeRunId)) return null
      const accepted = await sources.invocations(taskId)
      const selected = accepted.items.filter(
        (row) =>
          row.nodeRunId === query.nodeRunId &&
          (query.invocationId === undefined || row.invocationId === query.invocationId),
      )
      if (query.invocationId && !selected.length) return null
      const selectedIds = new Set(selected.map((row) => row.invocationId)),
        reasons = new Set<string>()
      if (attempts.truncated || accepted.truncated) reasons.add('span-acceptance-budget')
      if (!selected.length) reasons.add('span-invocation-unobserved')
      if (selected.some((row) => row.authority.kind !== 'local' || !row.spanCaptureContract))
        reasons.add('span-capture-unsupported')
      const carriers = accepted.items.filter(
        (row) =>
          row.authority.kind === 'local' && row.spanCaptureContract === 'runtime-span-facts-v1',
      )
      const scopeHash = sha256Hex(
        JSON.stringify([
          'task-spans',
          taskId,
          query.nodeRunId,
          query.invocationId ?? null,
          carriers,
        ]),
      )
      let watermark = 0,
        after: string | null = null,
        position: [number, number] = [0, 0]
      if (query.after) {
        let cursor: unknown
        try {
          cursor = JSON.parse(query.after)
        } catch {
          throw new RangeError('Invalid task span cursor')
        }
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 6 ||
          cursor[0] !== 1 ||
          cursor[1] !== taskId ||
          cursor[2] !== scopeHash ||
          !cursor.slice(3).every((value) => Number.isSafeInteger(value) && value >= 0) ||
          cursor[4] > cursor[3] ||
          cursor[5] > 1000
        )
          throw new RangeError('Task span cursor changed scope')
        watermark = cursor[3] as number
        position = [cursor[4] as number, cursor[5] as number]
        after = JSON.stringify([1, taskId, scopeHash, watermark, 0, 0])
      }
      const records: ObservationSpanSourceRecord[] = []
      let complete = false
      if (!sources.tasks.spanSources) reasons.add('span-source-unavailable')
      else {
        for (let page = 0; page < 100 && records.length < 20000; page++) {
          const result = await sources.tasks.spanSources({
            taskId,
            carrierInvocationIds: carriers.map((row) => row.invocationId),
            sourceNamespace: null,
            scopeHash,
            after,
            limit: 200,
          })
          watermark = result.watermark
          records.push(...result.records)
          for (const reason of result.issues) reasons.add(reason)
          if (result.nextCursor === null) {
            complete = true
            break
          }
          if (result.nextCursor === after) {
            reasons.add('span-source-cursor-stalled')
            break
          }
          after = result.nextCursor
        }
      }
      if (!complete) reasons.add('span-source-budget')
      const projected = projectObservationSpans({ taskId, accepted: accepted.items, records })
      for (const issue of projected.issues) reasons.add(issue)
      const captures = projected.captures.filter((row) => selectedIds.has(row.invocationId))
      if (
        selected.some(
          (owner) =>
            owner.spanCaptureContract &&
            !captures.some((row) => row.invocationId === owner.invocationId),
        )
      )
        reasons.add('span-capture-pending')
      for (const row of captures)
        if (row.capture.state !== 'complete') {
          reasons.add('span-capture-partial')
          for (const reason of row.capture.issues) reasons.add(reason)
        }
      const all = projected.spans
        .filter((row) => selectedIds.has(row.fact.invocationId))
        .sort((a, b) => a.sourceRowId - b.sourceRowId || a.itemIndex - b.itemIndex)
      const eligible = all.filter(
        (row) =>
          row.sourceRowId > position[0] ||
          (row.sourceRowId === position[0] && row.itemIndex >= position[1]),
      )
      const page = eligible.slice(0, limit),
        next = eligible[limit]
      const numeric = await loadContributions(sources, taskId)
      if (numeric.truncated) reasons.add('span-numeric-association-budget')
      const linked = new Map(
        numeric.records.map((row) => [JSON.stringify([row.invocationId, row.recordId]), row]),
      )
      const spans = page.map((row) => {
        const fact = row.fact,
          state = fact.state,
          issues = new Set(row.issues)
        if (state.startedAt === null || state.endedAt === null) issues.add('span-time-unknown')
        if (state.status === 'open' || state.status === 'unknown')
          issues.add('span-result-incomplete')
        const record = fact.measurementRecordId
          ? linked.get(JSON.stringify([fact.invocationId, fact.measurementRecordId]))
          : undefined
        return {
          fact,
          durationMs:
            issues.size || state.startedAt === null || state.endedAt === null
              ? null
              : state.endedAt - state.startedAt,
          quality: issues.size ? ('partial' as const) : ('complete' as const),
          reasons: [...issues],
          usage: record?.usage ?? null,
          cost: record
            ? {
                currency: 'CNY' as const,
                amountDecimal: record.amountDecimal,
                completeness: record.costComplete
                  ? ('complete' as const)
                  : record.amountDecimal === null
                    ? ('unpriced' as const)
                    : ('partial' as const),
              }
            : null,
        }
      })
      const repairs = new Set<string>()
      for (const [carrier, targets] of projected.repairs)
        for (const target of targets) {
          const owner = (JSON.parse(target) as [string, string])[0]
          if (selectedIds.has(carrier) || selectedIds.has(owner)) repairs.add(target)
        }
      return {
        taskId,
        nodeRunId: query.nodeRunId,
        invocationId: query.invocationId ?? null,
        spans,
        captures,
        priorRepairCount: repairs.size,
        partial: reasons.size > 0 || spans.some((row) => row.quality === 'partial'),
        reasons: [...reasons],
        watermark,
        nextCursor: next
          ? JSON.stringify([1, taskId, scopeHash, watermark, next.sourceRowId, next.itemIndex])
          : null,
      }
    })
}
