import { and, asc, desc, eq, gt, inArray, lt, sql, type SQL } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { CodeHistoryQueryReader } from '../../application/ports/historyQueryIndex'
import type { DeliveryRow } from '../../application/ports/deliveryChainRead'
import type {
  CodeMetricFindingRow,
  CodeMetricRoundRow,
} from '../../application/ports/codeMetricsRead'
import {
  decodeCursor,
  deriveRoundStatus,
  encodeCursor,
  ROUNDS_PER_ITEM,
  WORK_ITEM_PAGE_LIMIT,
} from '../../application/codeMatrixQuery'
import { ROUND_WINDOW, roundWindow } from '../../domain/stateViewScale'
import {
  CodeHistoryReadError,
  codeHistoryOriginalId,
  decodeStoredCodeHistoryRecord,
  projectCodeHistoryRow,
} from '../../domain/codeHistoryPackage'
import {
  METRIC_COUNTERS,
  emptyHistoryMetricCounts,
  historyIdOrderKey,
} from '../../domain/historyQueryProjection'
import type { CodeHistoryInstallation } from './packageReader'
import { requireCodeHistoryBuild } from './queryIndexManifest'

const QUERY_BATCH = 200

/** Purely read-only, including its first call in a new process. */
export function createCodeHistoryQueryReader(input: {
  readonly db: PersistenceDb
  readonly installation: CodeHistoryInstallation
}): CodeHistoryQueryReader {
  const { db, installation } = input
  const t = tablesOf(db)
  const ready = () =>
    installation.kind === 'fresh-install'
      ? Promise.resolve(null)
      : requireCodeHistoryBuild(db, installation.source)

  async function deliveries(selection: {
    project?: string
    correlation?: string
    failed?: boolean
    limit?: number
    all?: boolean
  }): Promise<DeliveryRow[]> {
    const binding = await ready()
    if (binding === null) return []
    const table = t.codeHistoryQueryDeliveries
    const limit = selection.all === true ? -1 : (selection.limit ?? 50)
    if (limit >= 0 && !Number.isInteger(limit))
      throw new RangeError('code-history-limit-not-integer')
    if (limit === 0) return []
    const predicates: SQL[] = [eq(table.buildId, binding.buildId)]
    if (selection.project !== undefined)
      predicates.push(eq(table.stableProjectId, selection.project))
    if (selection.correlation !== undefined)
      predicates.push(eq(table.correlationId, selection.correlation))
    if (selection.failed === true) predicates.push(eq(table.outcome, 'failed'))
    const result: DeliveryRow[] = []
    let cursor: { at: number; ordinal: number } | undefined
    while (true) {
      const count = limit >= 0 ? Math.min(QUERY_BATCH, limit - result.length) : QUERY_BATCH
      if (count === 0) break
      // Mixed DESC/ASC order cannot use a same-direction row-value cursor.
      // Two disjoint index ranges skip the consumed tie prefix as well as all
      // newer timestamps, instead of filtering an ever-growing OR prefix.
      const rows =
        cursor === undefined
          ? await db
              .select()
              .from(table)
              .where(and(...predicates))
              .orderBy(desc(table.createdAt), asc(table.sourceOrdinal))
              .limit(count)
          : await db
              .select()
              .from(table)
              .where(
                and(
                  ...predicates,
                  eq(table.createdAt, cursor.at),
                  gt(table.sourceOrdinal, cursor.ordinal),
                ),
              )
              .orderBy(desc(table.createdAt), asc(table.sourceOrdinal))
              .limit(count)
      if (cursor !== undefined && rows.length < count)
        rows.push(
          ...(await db
            .select()
            .from(table)
            .where(and(...predicates, lt(table.createdAt, cursor.at)))
            .orderBy(desc(table.createdAt), asc(table.sourceOrdinal))
            .limit(count - rows.length)),
        )
      for (const row of rows)
        result.push({
          id: row.id,
          correlationId: row.correlationId,
          capability: row.capability,
          step: row.step as DeliveryRow['step'],
          outcome: row.outcome as DeliveryRow['outcome'],
          reason: row.reason,
          queuedAt: row.queuedAt,
          queuePosition: row.queuePosition,
          waitingOn: row.waitingOn,
          roundId: row.roundId,
          isProbe: row.isProbe,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
      const last = rows.at(-1)
      if (rows.length < count || last === undefined) break
      cursor = { at: last.createdAt, ordinal: last.sourceOrdinal }
    }
    return result
  }

  return Object.freeze({
    // Explicit diagnostic compatibility only. Online adapters use the narrow
    // members below; even this diagnostic read never loads an original package.
    async rows(table) {
      const binding = await ready()
      if (binding === null || installation.kind === 'fresh-install') return []
      const records = t.codeHistoryQueryRecords
      const rows = await db
        .select({ payload: records.recordPayloadJson })
        .from(records)
        .where(and(eq(records.buildId, binding.buildId), eq(records.sourceTable, table)))
        .orderBy(asc(records.recordOrdinal))
      return rows.map((row) =>
        projectCodeHistoryRow(
          table,
          decodeStoredCodeHistoryRecord(row.payload, table, installation.source).row,
        ),
      )
    },
    async find(table, originalId) {
      const binding = await ready()
      if (binding === null || installation.kind === 'fresh-install') return null
      const records = t.codeHistoryQueryRecords
      const [record] = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.buildId, binding.buildId),
            eq(records.sourceTable, table),
            eq(records.originalId, originalId),
          ),
        )
        .limit(1)
      const entries = await db
        .select()
        .from(t.codeHistoryIdIndex)
        .where(
          and(
            eq(t.codeHistoryIdIndex.sourceTable, table),
            eq(t.codeHistoryIdIndex.originalId, originalId),
            eq(t.codeHistoryIdIndex.sourceContract, installation.source.contract.digest),
          ),
        )
        .limit(2)
      if (record === undefined && entries.length === 0) return null
      const fail = (): never => {
        throw new CodeHistoryReadError('code-history-index-invalid', `${table}/${originalId}`)
      }
      if (record === undefined || entries.length !== 1) return fail()
      const entry = entries[0]!
      const archive = binding.manifest.archives.find((row) => row.sourceTable === table)
      if (
        entry.archiveId !== archive?.id ||
        entry.archiveId !== record.archiveId ||
        entry.recordOrdinal !== record.recordOrdinal ||
        entry.originalKeyJson !== record.originalKeyJson
      )
        return fail()
      const decoded = decodeStoredCodeHistoryRecord(
        record.recordPayloadJson,
        table,
        installation.source,
      )
      if (
        codeHistoryOriginalId(table, decoded.key) !== originalId ||
        canonicalSchemaJson(decoded.key) !== record.originalKeyJson
      )
        return fail()
      return decoded
    },
    workItems: {
      async readPage(request) {
        const limit = Math.max(1, Math.min(request.limit ?? WORK_ITEM_PAGE_LIMIT, 100))
        const roundLimit = Math.max(
          1,
          Math.min(request.roundLimit ?? ROUNDS_PER_ITEM, ROUND_WINDOW),
        )
        if (limit >= 0 && !Number.isInteger(limit))
          throw new RangeError('code-history-limit-not-integer')
        const binding = await ready()
        if (binding === null) return { items: [], nextCursor: null }
        if (Number.isNaN(limit)) return { items: [], nextCursor: null }
        const itemsTable = t.codeHistoryQueryWorkItems
        const predicates: SQL[] = [eq(itemsTable.buildId, binding.buildId)]
        if (request.codeHostEndpointId !== undefined)
          predicates.push(eq(itemsTable.codeHostEndpointId, request.codeHostEndpointId))
        if (request.stableProjectId !== undefined)
          predicates.push(eq(itemsTable.stableProjectId, request.stableProjectId))
        if (request.capability !== undefined)
          predicates.push(eq(itemsTable.capability, request.capability))
        const cursor = request.cursor == null ? null : decodeCursor(request.cursor)
        if (cursor !== null)
          predicates.push(
            sql`(${itemsTable.createdAt}, ${itemsTable.idOrderKey}) < (${cursor.createdAt}, ${historyIdOrderKey(cursor.id)})`,
          )
        const candidates = await db
          .select()
          .from(itemsTable)
          .where(and(...predicates))
          .orderBy(desc(itemsTable.createdAt), desc(itemsTable.idOrderKey))
          .limit(limit + 1)
        const page = candidates.slice(0, limit)
        if (page.length === 0) return { items: [], nextCursor: null }
        if (roundLimit >= 0 && !Number.isInteger(roundLimit))
          throw new RangeError('code-history-limit-not-integer')
        const roundTable = t.codeHistoryQueryRounds
        const rounds = await db
          .select()
          .from(roundTable)
          .where(
            and(
              eq(roundTable.buildId, binding.buildId),
              inArray(
                roundTable.workItemId,
                page.map((row) => row.id),
              ),
              lt(roundTable.rank, Number.isNaN(roundLimit) ? 0 : roundLimit),
            ),
          )
          .orderBy(asc(roundTable.rank))
        const stageTable = t.codeHistoryQueryStages
        const stages: Array<typeof stageTable.$inferSelect> = []
        for (let offset = 0; offset < rounds.length; offset += QUERY_BATCH) {
          const ids = rounds.slice(offset, offset + QUERY_BATCH).map((row) => row.id)
          stages.push(
            ...(await db
              .select()
              .from(stageTable)
              .where(and(eq(stageTable.buildId, binding.buildId), inArray(stageTable.roundId, ids)))
              .orderBy(asc(stageTable.stageSeq), asc(stageTable.sourceOrdinal))),
          )
        }
        const byItem = new Map<string, typeof rounds>()
        for (const round of rounds) {
          const group = byItem.get(round.workItemId) ?? []
          group.push(round)
          byItem.set(round.workItemId, group)
        }
        const byRound = new Map<string, typeof stages>()
        for (const stage of stages) {
          const group = byRound.get(stage.roundId) ?? []
          group.push(stage)
          byRound.set(stage.roundId, group)
        }
        const items = page.map((row) => ({
          workItemId: row.id,
          capability: row.capability,
          anchorKind: row.anchorKind,
          anchorId: row.anchorId,
          status: row.status,
          epoch: row.epoch,
          roundsHidden: roundWindow({ total: row.roundCount, limit: roundLimit }).hidden,
          rounds: (byItem.get(row.id) ?? []).map((round) => ({
            roundId: round.id,
            roundSeq: round.roundSeq,
            status: deriveRoundStatus(round.outcome, round.endedAt),
            outcome: round.outcome,
            stageContractVer: round.stageContractVer,
            baselineSha: round.baselineSha,
            startedAt: round.startedAt,
            endedAt: round.endedAt,
            stages: (byRound.get(round.id) ?? []).map((stage) => ({
              stageName: stage.stageName,
              stageSeq: stage.stageSeq,
              kind: stage.stageKind,
              status: stage.status,
              error: stage.error,
              startedAt: stage.startedAt,
              endedAt: stage.endedAt,
            })),
          })),
        }))
        const last = page.at(-1)!
        return {
          items,
          nextCursor: candidates.length > limit ? encodeCursor(last.createdAt, last.id) : null,
        }
      },
    },
    attempts: {
      async load(roundId, limit) {
        const binding = await ready()
        if (binding === null) return []
        const table = t.codeHistoryQueryAttempts
        const rows = await db
          .select()
          .from(table)
          .where(and(eq(table.buildId, binding.buildId), eq(table.roundId, roundId)))
          .orderBy(
            asc(table.startedAt),
            asc(table.rerunSeq),
            asc(table.attemptSeq),
            asc(table.sourceOrdinal),
          )
          .limit(Math.min(limit, 200))
        return rows.map((row) => ({
          attemptId: row.id,
          stageName: row.stageName,
          shardKey: row.shardKey,
          rerunSeq: row.rerunSeq,
          attemptSeq: row.attemptSeq,
          status: row.status,
          validationOutcome: row.validationOutcome,
          sessionRef: row.sessionRef,
          nodeRunId: row.nodeRunId,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
        }))
      },
    },
    deliveries: {
      recent: (request) => deliveries({ project: request.stableProjectId, limit: request.limit }),
      byCorrelation: (correlation) => deliveries({ correlation, all: true }),
      failures: (request) =>
        deliveries({ project: request.stableProjectId, failed: true, limit: request.limit }),
    },
    metrics: {
      async loadSince(since) {
        const binding = await ready()
        const findings: CodeMetricFindingRow[] = []
        const rounds: CodeMetricRoundRow[] = []
        if (binding === null) return { findings, rounds }
        // Source query rows admit safe integer timestamps. Comparing them with
        // a fractional cutoff is exactly equivalent to >= ceil(cutoff), while
        // binding fractions or arbitrarily large finite windows to a bigint
        // timestamp column would fail on PostgreSQL. Domain-external cutoffs
        // select either every event or none without an out-of-range SQL bind.
        if (Number.isNaN(since) || since > Number.MAX_SAFE_INTEGER) return { findings, rounds }
        const cutoff = since <= Number.MIN_SAFE_INTEGER ? null : Math.ceil(since)
        const totals = await db
          .select()
          .from(t.codeHistoryMetricTotals)
          .where(eq(t.codeHistoryMetricTotals.buildId, binding.buildId))
        const table = t.codeHistoryMetricPrefixes
        for (const total of totals) {
          const [prefix] =
            cutoff === null
              ? []
              : await db
                  .select()
                  .from(table)
                  .where(
                    and(
                      eq(table.buildId, binding.buildId),
                      eq(table.capability, total.capability),
                      lt(table.occurredAt, cutoff),
                    ),
                  )
                  .orderBy(desc(table.occurredAt))
                  .limit(1)
          const counts = emptyHistoryMetricCounts()
          for (const key of METRIC_COUNTERS) counts[key] = total[key] - (prefix?.[key] ?? 0)
          const capability = total.capability
          for (const bucket of [
            { n: counts.adopted, resolvedAt: 0, codeChangedAt: 0 },
            { n: counts.quietFix, resolvedAt: null, codeChangedAt: 0 },
            { n: counts.disagreed, resolvedAt: 0, codeChangedAt: null },
            { n: counts.outstanding, resolvedAt: null, codeChangedAt: null },
          ])
            if (bucket.n > 0) findings.push({ capability, ...bucket })
          for (const bucket of [
            { n: counts.runPublished, outcome: 'published', endedAt: null },
            { n: counts.runFailed, outcome: 'failed', endedAt: null },
            { n: counts.runAwaiting, outcome: 'awaiting', endedAt: null },
            { n: counts.incomplete, outcome: null, endedAt: 0 },
            {
              n:
                counts.rounds -
                counts.runPublished -
                counts.runFailed -
                counts.runAwaiting -
                counts.incomplete,
              outcome: null,
              endedAt: null,
            },
          ])
            if (bucket.n > 0) rounds.push({ capability, ...bucket })
        }
        return { findings, rounds }
      },
    },
  } satisfies CodeHistoryQueryReader)
}
