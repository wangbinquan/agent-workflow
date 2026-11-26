import { and, eq, inArray, sql, type InferInsertModel, type Table } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { CodeHistoryIndexBuildReceipt } from '../../application/ports/historyQueryIndex'
import {
  CodeHistoryReadError,
  codeHistoryOriginalId,
  decodeCodeHistoryPackage,
  encodeStoredCodeHistoryRecord,
  projectCodeHistoryRow,
  type CodeHistoryRecord,
  type CodeHistoryQueryTable,
} from '../../domain/codeHistoryPackage'
import {
  CODE_HISTORY_QUERY_VERSION,
  historyIdOrderKey,
  historyMetricPrefixes,
} from '../../domain/historyQueryProjection'
import type { CodeHistoryInstallation } from './packageReader'
import { historyQueryStateWhere, readCodeHistoryManifest } from './queryIndexManifest'

const BATCH_ROWS = 200
const BATCH_BYTES = 256 * 1024

async function insertBatches<T extends Table>(
  db: PersistenceDb,
  table: T,
  rows: readonly InferInsertModel<T>[],
) {
  let batch: InferInsertModel<T>[] = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8')
    if (batch.length > 0 && (batch.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) {
      await db.insert(table).values(batch)
      batch = []
      bytes = 0
    }
    batch.push(row)
    bytes += size
  }
  if (batch.length > 0) await db.insert(table).values(batch)
}

/** Explicit initialization/maintenance only. This never runs from an HTTP read. */
export function createCodeHistoryIndexCommands(input: {
  readonly db: PersistenceDb
  readonly content: Pick<ContentStore, 'read'>
  readonly installation: CodeHistoryInstallation
}) {
  let pending: Promise<CodeHistoryIndexBuildReceipt> | undefined
  async function build(force: boolean): Promise<CodeHistoryIndexBuildReceipt> {
    const { db, content, installation } = input
    if (installation.kind === 'fresh-install')
      return {
        kind: 'fresh-install',
        buildId: null,
        previousBuildId: null,
        reused: false,
        records: 0,
      }
    const { source } = installation
    const t = tablesOf(db)
    const states = t.codeHistoryQueryStates
    const builds = t.codeHistoryQueryBuilds
    const stateWhere = historyQueryStateWhere(db, source)
    const [previous] = await db.select().from(states).where(stateWhere).limit(1)
    const previousBuildId = previous?.activeBuildId ?? null
    const buildId = ulid()
    const now = Date.now()
    const identity = {
      sourceGeneration: source.sourceGeneration,
      sourceContract: source.contract.digest,
      projectionVersion: CODE_HISTORY_QUERY_VERSION,
    }
    const stateTarget = [states.sourceGeneration, states.sourceContract, states.projectionVersion]
    const derivedTables = [
      t.codeHistoryQueryRecords,
      t.codeHistoryQueryWorkItems,
      t.codeHistoryQueryRounds,
      t.codeHistoryQueryStages,
      t.codeHistoryQueryAttempts,
      t.codeHistoryQueryDeliveries,
      t.codeHistoryMetricTotals,
      t.codeHistoryMetricPrefixes,
    ] as const
    async function clearDerived(id: string) {
      for (const table of derivedTables) await db.delete(table).where(eq(table.buildId, id))
    }
    let created = false
    try {
      const manifest = await readCodeHistoryManifest(db, source)
      // An offline initialization starts after all earlier readers have exited.
      // Keep the immediately previous build through publication, then reclaim
      // superseded payloads here, including a restart that reuses the ready build.
      const superseded = await db
        .select({ id: builds.id })
        .from(builds)
        .where(
          and(
            eq(builds.sourceGeneration, source.sourceGeneration),
            eq(builds.sourceContract, source.contract.digest),
            eq(builds.state, 'superseded'),
          ),
        )
      for (const old of superseded) if (old.id !== previousBuildId) await clearDerived(old.id)
      if (!force && previous?.state === 'ready' && previousBuildId !== null) {
        const [ready] = await db
          .select()
          .from(builds)
          .where(eq(builds.id, previousBuildId))
          .limit(1)
        if (
          ready?.state === 'ready' &&
          ready.manifestDigest === manifest.digest &&
          ready.archiveManifestJson === manifest.json &&
          ready.sourceGeneration === identity.sourceGeneration &&
          ready.sourceContract === identity.sourceContract &&
          ready.projectionVersion === CODE_HISTORY_QUERY_VERSION
        ) {
          return {
            kind: 'ready',
            buildId: ready.id,
            previousBuildId,
            reused: true,
            records: manifest.archives.reduce((sum, archive) => sum + archive.rowCount, 0),
          }
        }
      }
      await db.insert(builds).values({
        id: buildId,
        ...identity,
        manifestDigest: manifest.digest,
        archiveManifestJson: manifest.json,
        state: 'building',
        countsJson: '{}',
        errorCode: null,
        errorDetail: null,
        createdAt: now,
        completedAt: null,
      })
      created = true
      await db
        .insert(states)
        .values({
          ...identity,
          activeBuildId: previousBuildId,
          lastAttemptId: buildId,
          state: 'unavailable',
          failureCode: null,
          failureDetail: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: stateTarget,
          set: {
            lastAttemptId: buildId,
            state: 'unavailable',
            failureCode: null,
            failureDetail: null,
            updatedAt: now,
          },
        })
      // Startup and the explicit command own the installation's existing offline
      // lock. An interrupted attempt is rebuilt, never treated as partial success.
      const abandoned = await db
        .select({ id: builds.id })
        .from(builds)
        .where(
          and(
            eq(builds.sourceGeneration, source.sourceGeneration),
            eq(builds.sourceContract, source.contract.digest),
            inArray(builds.state, ['building', 'failed']),
          ),
        )
      for (const attempt of abandoned)
        if (attempt.id !== buildId) {
          await clearDerived(attempt.id)
          await db
            .update(builds)
            .set({
              state: 'failed',
              errorCode: 'code-history-query-build-interrupted',
              errorDetail: 'Replaced by an explicit initialization attempt',
              completedAt: now,
            })
            .where(eq(builds.id, attempt.id))
        }
      const records = new Map<string, readonly CodeHistoryRecord[]>()
      let totalRecords = 0
      for (const archive of manifest.archives) {
        const [stored] = await db
          .select({
            contentRefJson: t.codeHistoryArchives.contentRefJson,
            contentInlineBytes: t.codeHistoryArchives.contentInlineBytes,
          })
          .from(t.codeHistoryArchives)
          .where(eq(t.codeHistoryArchives.id, archive.id))
          .limit(1)
        if (stored === undefined)
          throw new CodeHistoryReadError('code-history-package-missing', archive.sourceTable)
        let decoded: readonly CodeHistoryRecord[]
        try {
          const ref = contentRefColumns.decode(stored.contentRefJson, stored.contentInlineBytes)
          if (ref === null)
            throw new CodeHistoryReadError('code-history-content-missing', archive.sourceTable)
          decoded = decodeCodeHistoryPackage(await content.read(ref), archive, source)
        } catch (error) {
          if (error instanceof CodeHistoryReadError) throw error
          throw new CodeHistoryReadError(
            'code-history-content-invalid',
            `${archive.sourceTable}: ${String(error)}`,
          )
        }
        const entries = await db
          .select()
          .from(t.codeHistoryIdIndex)
          .where(
            and(
              eq(t.codeHistoryIdIndex.sourceContract, source.contract.digest),
              eq(t.codeHistoryIdIndex.sourceTable, archive.sourceTable),
              eq(t.codeHistoryIdIndex.archiveId, archive.id),
            ),
          )
        const byId = new Map(entries.map((entry) => [entry.originalId, entry]))
        if (entries.length !== decoded.length || byId.size !== entries.length)
          throw new CodeHistoryReadError('code-history-index-invalid', archive.sourceTable)
        const projectedRecords = decoded.map((record, ordinal) => {
          const originalId = codeHistoryOriginalId(archive.sourceTable, record.key)
          const entry = byId.get(originalId)
          if (
            entry?.archiveId !== archive.id ||
            entry.recordOrdinal !== ordinal ||
            entry.originalKeyJson !== canonicalSchemaJson(record.key)
          )
            throw new CodeHistoryReadError(
              'code-history-index-invalid',
              `${archive.sourceTable}/${originalId}`,
            )
          return {
            buildId,
            sourceTable: archive.sourceTable,
            originalId,
            archiveId: archive.id,
            recordOrdinal: ordinal,
            originalKeyJson: canonicalSchemaJson(record.key),
            recordPayloadJson: encodeStoredCodeHistoryRecord(record),
          }
        })
        await insertBatches(db, t.codeHistoryQueryRecords, projectedRecords)
        records.set(archive.sourceTable, decoded)
        totalRecords += decoded.length
      }
      const rows = <K extends CodeHistoryQueryTable>(table: K) =>
        (records.get(table) ?? []).map((record, sourceOrdinal) => ({
          ...projectCodeHistoryRow(table, record.row),
          sourceOrdinal,
        }))
      const items = rows('code_work_items')
      const rounds = rows('code_work_rounds')
      const grouped = new Map<string, typeof rounds>()
      for (const round of rounds) {
        const group = grouped.get(round.work_item_id) ?? []
        group.push(round)
        grouped.set(round.work_item_id, group)
      }
      for (const group of grouped.values())
        group.sort((a, b) => b.round_seq - a.round_seq || a.sourceOrdinal - b.sourceOrdinal)
      const rankedRounds = [...grouped.values()].flatMap((group) =>
        group.map((row, rank) => ({
          buildId,
          id: row.id,
          workItemId: row.work_item_id,
          rank,
          roundSeq: row.round_seq,
          outcome: row.outcome,
          stageContractVer: row.stage_contract_ver,
          baselineSha: row.baseline_sha,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          sourceOrdinal: row.sourceOrdinal,
        })),
      )
      await insertBatches(
        db,
        t.codeHistoryQueryWorkItems,
        items.map((row) => ({
          buildId,
          id: row.id,
          codeHostEndpointId: row.code_host_endpoint_id,
          stableProjectId: row.stable_project_id,
          capability: row.capability,
          anchorKind: row.anchor_kind,
          anchorId: row.anchor_id,
          status: row.status,
          epoch: row.epoch,
          createdAt: row.created_at,
          roundCount: grouped.get(row.id)?.length ?? 0,
          idOrderKey: historyIdOrderKey(row.id),
        })),
      )
      await insertBatches(db, t.codeHistoryQueryRounds, rankedRounds)
      const stages = rows('code_round_stages')
      await insertBatches(
        db,
        t.codeHistoryQueryStages,
        stages.map((row) => ({
          buildId,
          id: row.id,
          roundId: row.round_id,
          stageName: row.stage_name,
          stageSeq: row.stage_seq,
          stageKind: row.stage_kind,
          status: row.status,
          error: row.error,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          sourceOrdinal: row.sourceOrdinal,
        })),
      )
      const attempts = rows('code_ai_attempts')
      await insertBatches(
        db,
        t.codeHistoryQueryAttempts,
        attempts.map((row) => ({
          buildId,
          id: row.id,
          roundId: row.round_id,
          stageName: row.stage_name,
          shardKey: row.shard_key,
          rerunSeq: row.rerun_seq,
          attemptSeq: row.attempt_seq,
          status: row.status,
          validationOutcome: row.validation_outcome,
          sessionRef: row.session_ref,
          nodeRunId: row.node_run_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          sourceOrdinal: row.sourceOrdinal,
        })),
      )
      const deliveries = rows('code_trigger_deliveries')
      await insertBatches(
        db,
        t.codeHistoryQueryDeliveries,
        deliveries.map((row) => ({
          buildId,
          id: row.id,
          correlationId: row.correlation_id,
          stableProjectId: row.stable_project_id,
          capability: row.capability,
          step: row.step,
          outcome: row.outcome,
          reason: row.reason,
          queuedAt: row.queued_at,
          queuePosition: row.queue_position,
          waitingOn: row.waiting_on,
          roundId: row.round_id,
          isProbe: row.is_probe,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          sourceOrdinal: row.sourceOrdinal,
        })),
      )
      const metrics = historyMetricPrefixes({ items, rounds, findings: rows('code_findings') })
      await insertBatches(
        db,
        t.codeHistoryMetricTotals,
        metrics.totals.map((row) => ({ buildId, ...row })),
      )
      await insertBatches(
        db,
        t.codeHistoryMetricPrefixes,
        metrics.prefixes.map((row) => ({ buildId, ...row })),
      )
      const expected = [
        totalRecords,
        items.length,
        rankedRounds.length,
        stages.length,
        attempts.length,
        deliveries.length,
        metrics.totals.length,
        metrics.prefixes.length,
      ]
      for (const [index, table] of derivedTables.entries()) {
        const [count] = await db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(table)
          .where(eq(table.buildId, buildId))
        if (Number(count?.n) !== expected[index])
          throw new CodeHistoryReadError(
            'code-history-query-index-invalid',
            'incomplete derived projection',
          )
      }
      const current = await readCodeHistoryManifest(db, source)
      if (current.json !== manifest.json)
        throw new CodeHistoryReadError('code-history-query-source-changed', source.sourceGeneration)
      await databaseSessionFor(db).transaction(async (tx) => {
        const currentManifest = await readCodeHistoryManifest(tx, source)
        if (currentManifest.json !== manifest.json)
          throw new CodeHistoryReadError(
            'code-history-query-source-changed',
            source.sourceGeneration,
          )
        await tx
          .update(builds)
          .set({ state: 'ready', countsJson: JSON.stringify(expected), completedAt: Date.now() })
          .where(eq(builds.id, buildId))
        await tx
          .update(states)
          .set({
            state: 'ready',
            activeBuildId: buildId,
            lastAttemptId: buildId,
            failureCode: null,
            failureDetail: null,
            updatedAt: Date.now(),
          })
          .where(stateWhere)
        if (previousBuildId !== null && previousBuildId !== buildId)
          await tx
            .update(builds)
            .set({ state: 'superseded' })
            .where(and(eq(builds.id, previousBuildId), eq(builds.state, 'ready')))
      })
      // Previous ready rows remain readable for an already-started reader. The
      // next offline initialization may reclaim superseded builds.
      return { kind: 'ready', buildId, previousBuildId, reused: false, records: totalRecords }
    } catch (error) {
      const code =
        error instanceof CodeHistoryReadError ? error.code : 'code-history-query-build-failed'
      const detail = error instanceof Error ? error.message : String(error)
      try {
        if (created) {
          await clearDerived(buildId)
          await db
            .update(builds)
            .set({ state: 'failed', errorCode: code, errorDetail: detail, completedAt: Date.now() })
            .where(eq(builds.id, buildId))
        }
        await db
          .insert(states)
          .values({
            ...identity,
            activeBuildId: previousBuildId,
            lastAttemptId: created ? buildId : (previous?.lastAttemptId ?? null),
            state: 'unavailable',
            failureCode: code,
            failureDetail: detail,
            updatedAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: stateTarget,
            set: {
              state: 'unavailable',
              failureCode: code,
              failureDetail: detail,
              lastAttemptId: created ? buildId : (previous?.lastAttemptId ?? null),
              updatedAt: Date.now(),
            },
          })
      } catch (recoveryError) {
        // A disconnected provider can also refuse diagnostic writes. Retain the
        // original category; the next startup treats a building state as interrupted.
        throw new CodeHistoryReadError(
          code,
          `${detail}; recovery metadata unavailable: ${String(recoveryError)}`,
        )
      }
      throw error
    }
  }
  return Object.freeze({
    initialize() {
      return (pending ??= build(false).finally(() => {
        pending = undefined
      }))
    },
    async rebuild() {
      if (pending !== undefined) await pending
      return (pending ??= build(true).finally(() => {
        pending = undefined
      }))
    },
  })
}
