import { tablesOf, engineForHandle } from '@/platform/persistence/sessionTables'
import { ulid } from 'ulid'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
export async function seedCapabilityCell(
  db: PersistenceDb,
  input: {
    readonly repoId: string
    readonly capability: string
    readonly templateId: string | null
    readonly enabled: boolean
    readonly triggerConfig?: Readonly<Record<string, unknown>>
    readonly readiness?: 'ready' | 'misconfigured' | 'disabled'
    readonly readinessIssues?: readonly unknown[]
    readonly dependencyRevision?: number
    readonly now?: number
  },
): Promise<void> {
  const now = input.now ?? Date.now()
  const values = {
    id: ulid(),
    repoId: input.repoId,
    capability: input.capability,
    templateId: input.templateId,
    enabled: input.enabled,
    triggerConfigJson: JSON.stringify(input.triggerConfig ?? {}),
    readiness: input.readiness ?? (input.enabled ? 'ready' : 'disabled'),
    readinessIssuesJson: JSON.stringify(input.readinessIssues ?? []),
    dependencyRevision: input.dependencyRevision ?? 1,
    lastValidatedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  const { repoCapabilityConfig } = tablesOf(db)
  await db
    .insert(repoCapabilityConfig)
    .values(values)
    .onConflictDoUpdate({
      target: [repoCapabilityConfig.repoId, repoCapabilityConfig.capability],
      set: {
        templateId: values.templateId,
        enabled: values.enabled,
        triggerConfigJson: values.triggerConfigJson,
        readiness: values.readiness,
        readinessIssuesJson: values.readinessIssuesJson,
        dependencyRevision: values.dependencyRevision,
        lastValidatedAt: now,
        updatedAt: now,
      },
    })
}

export async function seedDelivery(
  db: PersistenceDb,
  input: {
    readonly correlationId: string
    readonly codeHostEndpointId?: string | null
    readonly stableProjectId?: string | null
    readonly anchorKind?: string | null
    readonly anchorId?: string | null
    readonly step: string
    readonly outcome: string
    readonly reason?: string | null
    readonly capability?: string | null
    readonly roundId?: string | null
    readonly isProbe?: boolean
    readonly now?: number
  },
): Promise<string> {
  const id = ulid()
  const now = input.now ?? Date.now()
  await seedCodeHistoryRows(db, 'code_trigger_deliveries', {
    id,
    correlationId: input.correlationId,
    codeHostEndpointId: input.codeHostEndpointId ?? null,
    stableProjectId: input.stableProjectId ?? null,
    anchorKind: input.anchorKind ?? null,
    anchorId: input.anchorId ?? null,
    capability: input.capability ?? null,
    step: input.step,
    outcome: input.outcome,
    reason: input.reason ?? null,
    roundId: input.roundId ?? null,
    isProbe: input.isProbe ?? false,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

// RFC-395: frozen source facts are encoded only in this test fixture, then written to target packages.
import { and, count, desc, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { encodeHistoryPackage } from '@/platform/persistence/migration/archives/package'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { ContentRef } from '@/platform/content/contentRef'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import { contentRefColumns } from '@/platform/content/contentStore'
import { sha256Hex } from '@/util/hash'
import { createCodeHistoryPackageReader } from '@/modules/code-capability/infrastructure/history/packageReader'
import {
  CODE_HISTORY_TABLES,
  codeHistoryOriginalId,
  decodeCodeHistoryPackage,
  type CodeHistorySource,
  type CodeHistoryTable,
  type CodeHistoryQueryTable,
  type CodeHistoryQueryRow,
  type CodeHistoryValue,
} from '@/modules/code-capability/domain/codeHistoryPackage'
import { sourceRow } from './rfc395V2/runFixtures'
import { frozenValues } from './rfc395V2/contentFixtures'

type Camel<S extends string> = S extends `${infer A}_${infer B}` ? `${A}${Capitalize<Camel<B>>}` : S
export type HistoryFixtureInsert<K extends CodeHistoryQueryTable> = Partial<{
  [P in keyof CodeHistoryQueryRow<K> as P extends string
    ? Camel<P>
    : never]: CodeHistoryQueryRow<K>[P]
}> &
  Readonly<Record<string, CodeHistoryValue | undefined>>
export const historyFixtureSource: CodeHistorySource = {
  sourceGeneration: 'dbg_code_history_fixture',
  contract: frozenEpoch1Contract,
}
export const historyFixtureContent = {
  async read(ref: ContentRef) {
    if (ref.kind !== 'inline') throw new Error('fixture expects inline content')
    return ref.bytes
  },
}
export function historyFixtureReader(db: PersistenceDb, source = historyFixtureSource) {
  return createCodeHistoryPackageReader({
    db,
    content: historyFixtureContent,
    installation: { kind: 'converted', source },
  })
}
export function historyFixtureArchive(
  table: CodeHistoryTable,
  rows: readonly SourceRow[],
  source = historyFixtureSource,
) {
  const bytes = encodeHistoryPackage({
    sourceGeneration: source.sourceGeneration,
    sourceContract: source.contract.digest,
    table,
    rows,
  })
  const sha256 = sha256Hex(bytes)
  const content = contentRefColumns.encode({
    version: 1,
    kind: 'inline',
    location: { codec: 'code-history@1', value: { table } },
    contentId: null,
    contentVersion: null,
    sha256,
    size: bytes.length,
    mediaType: null,
    bytes,
  })
  return {
    id: `history:${source.sourceGeneration}:${source.contract.digest}:${table}`,
    formatVersion: 1,
    sourceGeneration: source.sourceGeneration,
    sourceContract: source.contract.digest,
    sourceTable: table,
    rowCount: rows.length,
    rootDigest: `sha256:${sha256}`,
    createdAt: 1700000000000,
    contentRefJson: content.json,
    contentInlineBytes: content.inlineBytes === null ? null : Buffer.from(content.inlineBytes),
  }
}
export async function seedEmptyCodeHistory(
  db: PersistenceDb,
  source = historyFixtureSource,
): Promise<void> {
  const { codeHistoryArchives } = tablesOf(db)
  for (const table of CODE_HISTORY_TABLES) {
    await db
      .insert(codeHistoryArchives)
      .values(historyFixtureArchive(table, [], source))
      .onConflictDoNothing()
  }
}
export async function seedCodeHistoryRows<K extends CodeHistoryQueryTable>(
  db: PersistenceDb,
  table: K,
  input: HistoryFixtureInsert<K> | readonly HistoryFixtureInsert<K>[],
  source = historyFixtureSource,
): Promise<void> {
  await seedEmptyCodeHistory(db, source)
  const { codeHistoryArchives, codeHistoryIdIndex } = tablesOf(db)
  const id = historyFixtureArchive(table, [], source).id
  const [archive] = await db
    .select()
    .from(codeHistoryArchives)
    .where(eq(codeHistoryArchives.id, id))
  if (!archive) throw new Error('fixture archive missing')
  const old = decodeCodeHistoryPackage(archive.contentInlineBytes!, archive, source).map((record) =>
    sourceRow(table, record.row),
  )
  const added = (Array.isArray(input) ? input : [input]).map((row) =>
    sourceRow(
      table,
      frozenValues(
        table,
        Object.fromEntries(
          Object.entries(row)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [
              key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
              value as CodeHistoryValue,
            ]),
        ),
      ),
    ),
  )
  const rows = [...old, ...added].sort((a, b) =>
    a.encodedKey < b.encodedKey ? -1 : a.encodedKey > b.encodedKey ? 1 : 0,
  )
  const next = historyFixtureArchive(table, rows, source)
  await db.update(codeHistoryArchives).set(next).where(eq(codeHistoryArchives.id, id))
  await db
    .delete(codeHistoryIdIndex)
    .where(
      and(
        eq(codeHistoryIdIndex.archiveId, id),
        eq(codeHistoryIdIndex.sourceContract, source.contract.digest),
      ),
    )
  if (rows.length)
    await db.insert(codeHistoryIdIndex).values(
      rows.map((row, recordOrdinal) => ({
        archiveId: id,
        sourceTable: table,
        sourceContract: source.contract.digest,
        originalId: codeHistoryOriginalId(table, row.key),
        originalKeyJson: canonicalSchemaJson(row.key),
        recordOrdinal,
      })),
    )
}

// H-F1 oracle: epoch-1 adapters frozen from a8e62bd7152dc993f6a6b91a57a9d69bdcdf6719.
// Only names/imports/table binding differ; keep their SQL independent of the history reader.
import { frozenTableSets, type FrozenPersistenceTables } from '../migration-freeze'
import {
  decodeCursor,
  deriveRoundStatus,
  encodeCursor,
  ROUNDS_PER_ITEM,
  WORK_ITEM_PAGE_LIMIT,
  createCodeWorkItemProjectionQuery,
  createCodeRoundAttemptsQuery,
  createCodeDeliveryChainQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import { ROUND_WINDOW, roundWindow } from '@/modules/code-capability/domain/stateViewScale'
import type { WorkItemProjectionReadPort } from '@/modules/code-capability/application/ports/workItemProjectionRead'
import type { RoundAttemptsReadPort } from '@/modules/code-capability/application/ports/roundAttemptsRead'
import type {
  DeliveryChainReadPort,
  DeliveryRow,
} from '@/modules/code-capability/application/ports/deliveryChainRead'
import type { DeliveryOutcome, DeliveryStep } from '@/modules/code-capability/domain/deliveryChain'
import type { CodeMetricsReadPort } from '@/modules/code-capability/application/ports/codeMetricsRead'
import type {
  CodeRoundProjection,
  CodeStageProjection,
  CodeWorkItemProjection,
} from '@/modules/code-capability/public/queries'
import { rawExec } from '@/platform/persistence/queryHelpers'

function epoch1HistoryTables(db: object): FrozenPersistenceTables {
  return frozenTableSets[engineForHandle(db).provider] as FrozenPersistenceTables
}

function epoch1WorkItemFields(db: object) {
  const { codeWorkItems } = epoch1HistoryTables(db)
  return {
    id: codeWorkItems.id,
    capability: codeWorkItems.capability,
    anchorKind: codeWorkItems.anchorKind,
    anchorId: codeWorkItems.anchorId,
    status: codeWorkItems.status,
    epoch: codeWorkItems.epoch,
    createdAt: codeWorkItems.createdAt,
  }
}

function epoch1RoundFields(db: object) {
  const { codeWorkRounds } = epoch1HistoryTables(db)
  return {
    id: codeWorkRounds.id,
    roundSeq: codeWorkRounds.roundSeq,
    outcome: codeWorkRounds.outcome,
    stageContractVer: codeWorkRounds.stageContractVer,
    baselineSha: codeWorkRounds.baselineSha,
    startedAt: codeWorkRounds.startedAt,
    endedAt: codeWorkRounds.endedAt,
  }
}

function epoch1StageFields(db: object) {
  const { codeRoundStages } = epoch1HistoryTables(db)
  return {
    stageName: codeRoundStages.stageName,
    stageSeq: codeRoundStages.stageSeq,
    stageKind: codeRoundStages.stageKind,
    status: codeRoundStages.status,
    error: codeRoundStages.error,
    startedAt: codeRoundStages.startedAt,
    endedAt: codeRoundStages.endedAt,
  }
}

async function epoch1ProjectRounds(
  db: PersistenceDb,
  workItemId: string,
  limit: number,
): Promise<{ rounds: CodeRoundProjection[]; hidden: number }> {
  const { codeWorkRounds, codeRoundStages } = epoch1HistoryTables(db)
  const [counted] = await db
    .select({ n: count() })
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.workItemId, workItemId))
  const total = counted?.n ?? 0

  const rounds = await db
    .select(epoch1RoundFields(db))
    .from(codeWorkRounds)
    .where(eq(codeWorkRounds.workItemId, workItemId))
    .orderBy(desc(codeWorkRounds.roundSeq))
    .limit(limit)

  const projected: CodeRoundProjection[] = []
  for (const round of rounds) {
    const stages = await db
      .select(epoch1StageFields(db))
      .from(codeRoundStages)
      .orderBy(codeRoundStages.stageSeq)
      .where(eq(codeRoundStages.roundId, round.id))

    projected.push({
      roundId: round.id,
      roundSeq: round.roundSeq,
      status: deriveRoundStatus(round.outcome, round.endedAt),
      outcome: round.outcome,
      stageContractVer: round.stageContractVer,
      baselineSha: round.baselineSha,
      startedAt: round.startedAt,
      endedAt: round.endedAt,
      stages: stages.map(
        (stage): CodeStageProjection => ({
          stageName: stage.stageName,
          stageSeq: stage.stageSeq,
          kind: stage.stageKind,
          status: stage.status,
          error: stage.error,
          startedAt: stage.startedAt,
          endedAt: stage.endedAt,
        }),
      ),
    })
  }

  return { rounds: projected, hidden: roundWindow({ total, limit }).hidden }
}

function createEpoch1WorkItemRead(db: PersistenceDb): WorkItemProjectionReadPort {
  return {
    async readPage(input) {
      const limit = Math.max(1, Math.min(input.limit ?? WORK_ITEM_PAGE_LIMIT, 100))
      const filters: SQL[] = []
      if (input.codeHostEndpointId !== undefined) {
        const { codeWorkItems } = epoch1HistoryTables(db)
        filters.push(eq(codeWorkItems.codeHostEndpointId, input.codeHostEndpointId))
      }
      if (input.stableProjectId !== undefined) {
        const { codeWorkItems } = epoch1HistoryTables(db)
        filters.push(eq(codeWorkItems.stableProjectId, input.stableProjectId))
      }
      if (input.capability !== undefined) {
        const { codeWorkItems } = epoch1HistoryTables(db)
        filters.push(eq(codeWorkItems.capability, input.capability))
      }

      const cursor = input.cursor == null ? null : decodeCursor(input.cursor)
      const { codeWorkItems } = epoch1HistoryTables(db)
      if (cursor !== null) filters.push(lt(codeWorkItems.createdAt, cursor.createdAt))

      const rows = await db
        .select(epoch1WorkItemFields(db))
        .from(codeWorkItems)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(codeWorkItems.createdAt), desc(codeWorkItems.id))
        .limit(limit + 1)
      const roundLimit = Math.max(1, Math.min(input.roundLimit ?? ROUNDS_PER_ITEM, ROUND_WINDOW))

      const page = rows.slice(0, limit)
      const items: CodeWorkItemProjection[] = []
      for (const row of page) {
        const rounds = await epoch1ProjectRounds(db, row.id, roundLimit)
        items.push({
          workItemId: row.id,
          capability: row.capability,
          anchorKind: row.anchorKind,
          anchorId: row.anchorId,
          status: row.status,
          epoch: row.epoch,
          rounds: rounds.rounds,
          roundsHidden: rounds.hidden,
        })
      }

      const last = page.at(-1)
      return {
        items,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
      }
    },
  }
}

function createEpoch1AttemptRead(db: PersistenceDb): RoundAttemptsReadPort {
  return {
    async load(roundId, limit) {
      const { codeAiAttempts } = epoch1HistoryTables(db)
      return await db
        .select({
          attemptId: codeAiAttempts.id,
          stageName: codeAiAttempts.stageName,
          shardKey: codeAiAttempts.shardKey,
          rerunSeq: codeAiAttempts.rerunSeq,
          attemptSeq: codeAiAttempts.attemptSeq,
          status: codeAiAttempts.status,
          validationOutcome: codeAiAttempts.validationOutcome,
          sessionRef: codeAiAttempts.sessionRef,
          nodeRunId: codeAiAttempts.nodeRunId,
          startedAt: codeAiAttempts.startedAt,
          endedAt: codeAiAttempts.endedAt,
        })
        .from(codeAiAttempts)
        .where(eq(codeAiAttempts.roundId, roundId))
        .orderBy(codeAiAttempts.startedAt, codeAiAttempts.rerunSeq, codeAiAttempts.attemptSeq)
        .limit(limit)
    },
  }
}

function epoch1DeliveryFields(db: object) {
  const { codeTriggerDeliveries } = epoch1HistoryTables(db)
  return {
    id: codeTriggerDeliveries.id,
    correlationId: codeTriggerDeliveries.correlationId,
    capability: codeTriggerDeliveries.capability,
    step: codeTriggerDeliveries.step,
    outcome: codeTriggerDeliveries.outcome,
    reason: codeTriggerDeliveries.reason,
    queuedAt: codeTriggerDeliveries.queuedAt,
    queuePosition: codeTriggerDeliveries.queuePosition,
    waitingOn: codeTriggerDeliveries.waitingOn,
    roundId: codeTriggerDeliveries.roundId,
    isProbe: codeTriggerDeliveries.isProbe,
    createdAt: codeTriggerDeliveries.createdAt,
    updatedAt: codeTriggerDeliveries.updatedAt,
  }
}

interface Epoch1DeliveryProjection {
  readonly id: string
  readonly correlationId: string
  readonly capability: string | null
  readonly step: string
  readonly outcome: string
  readonly reason: string | null
  readonly queuedAt: number | null
  readonly queuePosition: number | null
  readonly waitingOn: string | null
  readonly roundId: string | null
  readonly isProbe: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

function epoch1DeliveryRow(row: Epoch1DeliveryProjection): DeliveryRow {
  return {
    ...row,
    step: row.step as DeliveryStep,
    outcome: row.outcome as DeliveryOutcome['kind'],
  }
}

function createEpoch1DeliveryRead(db: PersistenceDb): DeliveryChainReadPort {
  return {
    /** Recent deliveries for one project, newest first. */
    async recent(input) {
      const { codeTriggerDeliveries } = epoch1HistoryTables(db)
      const rows = await db
        .select(epoch1DeliveryFields(db))
        .from(codeTriggerDeliveries)
        .where(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
        .limit(input.limit ?? 50)
      return rows.map(epoch1DeliveryRow)
    },
    /** One delivery's whole story, by the id that ties the tables together. */
    async byCorrelation(correlationId) {
      const { codeTriggerDeliveries } = epoch1HistoryTables(db)
      const rows = await db
        .select(epoch1DeliveryFields(db))
        .from(codeTriggerDeliveries)
        .where(eq(codeTriggerDeliveries.correlationId, correlationId))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
      return rows.map(epoch1DeliveryRow)
    },
    /** Deliveries that need somebody — failures only, never drops. */
    async failures(input) {
      const { codeTriggerDeliveries } = epoch1HistoryTables(db)
      const filters = [eq(codeTriggerDeliveries.outcome, 'failed')]
      if (input.stableProjectId !== undefined) {
        filters.push(eq(codeTriggerDeliveries.stableProjectId, input.stableProjectId))
      }
      const rows = await db
        .select(epoch1DeliveryFields(db))
        .from(codeTriggerDeliveries)
        .where(and(...filters))
        .orderBy(desc(codeTriggerDeliveries.createdAt))
        .limit(input.limit ?? 50)
      return rows.map(epoch1DeliveryRow)
    },
  }
}

function createEpoch1MetricsRead(db: PersistenceDb): CodeMetricsReadPort {
  return {
    async loadSince(since) {
      const { codeFindings, codeWorkItems, codeWorkRounds } = epoch1HistoryTables(db)
      // Only findings that were actually published count. An unpublished one
      // was never shown to anyone and cannot be outstanding adoption work.
      const findings = await db
        .select({
          capability: codeFindings.capability,
          resolvedAt: codeFindings.resolvedAt,
          codeChangedAt: codeFindings.codeChangedAt,
        })
        .from(codeFindings)
        .where(and(isNotNull(codeFindings.externalId), gte(codeFindings.createdAt, since)))

      const rounds = await db
        .select({
          capability: codeWorkItems.capability,
          outcome: codeWorkRounds.outcome,
          endedAt: codeWorkRounds.endedAt,
          // RFC-359 W8 — drizzle's `count()` carries `.mapWith(Number)`; the
          // bare ``sql<number>`count(*)` `` this replaces carried only the TYPE.
          // SQLite's driver happens to hand back a JS number so the lie was
          // invisible here, but PostgreSQL returns `count(*)` as bigint, i.e. a
          // STRING — and the projection adds these (`counts.rounds += row.n`),
          // so the /code metrics panel rendered `rounds: "021"` instead of 3.
          n: count(),
        })
        .from(codeWorkRounds)
        .innerJoin(codeWorkItems, eq(codeWorkRounds.workItemId, codeWorkItems.id))
        .where(gte(codeWorkRounds.startedAt, since))
        .groupBy(codeWorkItems.capability, codeWorkRounds.outcome, codeWorkRounds.endedAt)

      return { findings, rounds }
    },
  }
}

export function createEpoch1HistoryQueries(db: PersistenceDb) {
  return {
    workItems: createCodeWorkItemProjectionQuery(createEpoch1WorkItemRead(db)),
    attempts: createCodeRoundAttemptsQuery(createEpoch1AttemptRead(db)),
    deliveries: createCodeDeliveryChainQuery(createEpoch1DeliveryRead(db)),
    metrics: createCodeMetricsQuery(createEpoch1MetricsRead(db)),
  }
}

/** Store the converter's exact columns and bytes, never re-encode packages or reconstruct index keys. */
export async function installConvertedCodeHistory(
  db: PersistenceDb,
  sink: { rows(table: string): readonly TargetRow[] },
): Promise<void> {
  const { codeHistoryArchives, codeHistoryIdIndex } = tablesOf(db)
  for (const [name, table] of [
    ['code_history_archives', codeHistoryArchives],
    ['code_history_id_index', codeHistoryIdIndex],
  ] as const) {
    for (const row of sink.rows(name)) {
      const columns = Object.keys(row).map((column) => sql.identifier(column))
      const values = Object.values(row).map(
        (value) => sql`${value instanceof Uint8Array ? Buffer.from(value) : value}`,
      )
      await rawExec(
        db,
        sql`INSERT INTO ${table} (${sql.join(columns, sql`, `)}) VALUES (${sql.join(values, sql`, `)})`,
      )
    }
  }
}
