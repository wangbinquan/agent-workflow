import { and, asc, eq, gt, gte, lte, max } from 'drizzle-orm'
import {
  parseObservationCapturedUsage,
  type ObservationSpanSourceInput,
  type ObservationSpanSourcePage,
  type ObservationSpanSourceRecord,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionObservationSources as sources } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'

/** Retained facts include acknowledged rows. Neither ACK nor logical-session retag deletes them. */
export function createObservationSpanSources(db: ProviderNeutralDatabase) {
  return async (input: ObservationSpanSourceInput): Promise<ObservationSpanSourcePage> => {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200 ||
      (!input.allTaskCarriers && input.carrierInvocationIds.length > 1000) ||
      !input.scopeHash
    )
      throw new RangeError('Invalid observation span page')
    let watermark: number,
      sourceId = 0,
      itemIndex = 0
    if (input.after) {
      let cursor: unknown
      try {
        cursor = JSON.parse(input.after)
      } catch {
        throw new RangeError('Invalid observation span cursor')
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 6 ||
        cursor[0] !== 1 ||
        cursor[1] !== input.taskId ||
        cursor[2] !== input.scopeHash ||
        !cursor.slice(3).every((value) => Number.isSafeInteger(value) && value >= 0) ||
        cursor[4] > cursor[3] ||
        cursor[5] > 1000
      )
        throw new RangeError('Observation span cursor changed scope')
      watermark = cursor[3] as number
      sourceId = cursor[4] as number
      itemIndex = cursor[5] as number
    } else {
      const row = await db
        .select({ id: max(sources.id) })
        .from(sources)
        .innerJoin(
          nodeRuns,
          and(eq(sources.nodeRunId, nodeRuns.id), eq(sources.taskId, nodeRuns.taskId)),
        )
        .where(eq(sources.taskId, input.taskId))
        .get()
      watermark = row?.id == null ? 0 : engineOf(db).numericFromRawRow(row.id, 'spanWatermark')
    }
    const carriers = new Set(input.carrierInvocationIds),
      records: ObservationSpanSourceRecord[] = [],
      issues = new Set<string>()
    const rows =
      watermark === 0
        ? []
        : await db
            .select({
              id: sources.id,
              nodeRunId: sources.nodeRunId,
              document: sources.evidenceJson,
            })
            .from(sources)
            .innerJoin(
              nodeRuns,
              and(eq(sources.nodeRunId, nodeRuns.id), eq(sources.taskId, nodeRuns.taskId)),
            )
            .where(
              and(
                eq(sources.taskId, input.taskId),
                lte(sources.id, watermark),
                input.after && itemIndex !== 1000
                  ? gte(sources.id, sourceId)
                  : gt(sources.id, sourceId),
              ),
            )
            .orderBy(asc(sources.id))
            .limit(200)
            .all()
    let scannedSources = 0,
      nextCursor: string | null = null
    const continuation = (id: number, index: number) =>
      JSON.stringify([1, input.taskId, input.scopeHash, watermark, id, index])
    for (const row of rows) {
      scannedSources++
      const items: ObservationSpanSourceRecord[] = []
      try {
        const frame = parseObservationCapturedUsage(JSON.parse(row.document!))
        if (input.allTaskCarriers || carriers.has(frame.invocationId)) {
          for (const [index, fact] of (frame.spanFacts ?? []).entries())
            if (
              input.sourceNamespace === null ||
              fact.scope.sourceNamespace === input.sourceNamespace
            )
              items.push({
                type: 'fact',
                sourceRowId: row.id,
                nodeRunId: row.nodeRunId,
                itemIndex: index,
                fact,
              })
          for (const [index, revision] of (frame.priorSpanRevisions ?? []).entries())
            if (
              input.sourceNamespace === null ||
              revision.originalOwnerProof.scope.sourceNamespace === input.sourceNamespace
            )
              items.push({
                type: 'revision',
                sourceRowId: row.id,
                nodeRunId: row.nodeRunId,
                itemIndex: (frame.spanFacts?.length ?? 0) + index,
                revision,
              })
          if (
            frame.spanCapture &&
            (input.sourceNamespace === null ||
              frame.spanCapture.sourceNamespace === input.sourceNamespace)
          )
            items.push({
              type: 'capture',
              sourceRowId: row.id,
              nodeRunId: row.nodeRunId,
              itemIndex: 200,
              invocationId: frame.invocationId,
              capture: frame.spanCapture,
            })
          for (const [index, code] of frame.diagnostics
            .filter((code) => /^(native-span-|span-metadata-)/.test(code))
            .entries())
            items.push({
              type: 'diagnostic',
              sourceRowId: row.id,
              nodeRunId: row.nodeRunId,
              itemIndex: 201 + index,
              invocationId: frame.invocationId,
              code,
            })
        }
      } catch {
        issues.add('span-source-malformed')
      }
      // The item index addresses the original row, including filtered-out records.
      const start = row.id === sourceId ? itemIndex : 0
      for (const item of items.filter((item) => item.itemIndex >= start)) {
        if (records.length >= input.limit) {
          nextCursor = continuation(row.id, item.itemIndex)
          break
        }
        records.push(item)
      }
      if (nextCursor !== null) break
      sourceId = row.id
      itemIndex = 0
    }
    if (nextCursor === null && rows.length === 200 && sourceId < watermark)
      nextCursor = continuation(sourceId, 1000)
    return {
      records,
      scannedSources,
      watermark,
      nextCursor,
      truncated: nextCursor !== null,
      issues: [...issues],
    }
  }
}
