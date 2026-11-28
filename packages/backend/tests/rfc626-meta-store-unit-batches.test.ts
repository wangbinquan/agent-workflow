// RFC-626 §4.6 "写新库" (design §7 "PostgreSQL：各多行写入点的批大小不超过参数上限"): a unit's
// metadata (`writeUnit` and the `writeBlocks` it calls) is written per table as multi-row
// statements instead of one INSERT per row. Signature, transaction boundary and content must not
// move: `referenceWriteUnit` below is the row-by-row writer before RFC-626, built on the store's
// single-row `insert`, and for the same unit every meta table must hold byte-identical rows, in
// the same order, as it leaves. Statements stay within the parameter limit of each database
// (SQLite: 900 parameters / 100 rows; PostgreSQL: 30,000 / 1,000) and split where they exceed it.
// Archive conflicts are still detected against earlier units and within the unit.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  createMigrationMetaStore,
  type MigrationMetaStore,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type {
  ConversionBlock,
  RowDisposition,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import type { MigrationUnit } from '@/platform/persistence/migration/run/types'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import {
  sqliteHistoryConnection,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'
import { compileMetaTables, metaTableName } from '@/platform/persistence/schema/history/meta'

interface Statement {
  readonly sql: string
  readonly values: readonly unknown[]
}
const LIMITS = {
  postgresql: { parameters: 30_000, rows: 1_000 },
  sqlite: { parameters: 900, rows: 100 },
} as const
const statementRows = (provider: DatabaseProvider, width: number) =>
  Math.min(LIMITS[provider].rows, Math.max(1, Math.floor(LIMITS[provider].parameters / width)))
const declared = new Map(EPOCH2_META_TABLES.map((table) => [table.name, table]))
const width = (table: string) => Object.keys(declared.get(table)!.columns).length

/** The store's writes before RFC-626: one `insert` per row, in this order. */
async function referenceWriteBlocks(
  store: MigrationMetaStore,
  runId: string,
  origin: 'unit' | 'load',
  unitId: string,
  blocks: readonly ConversionBlock[],
): Promise<void> {
  for (const [ordinal, block] of blocks.entries())
    await store.insert('migration_blocks', {
      runId,
      origin,
      unitId,
      ordinal,
      code: block.code,
      scope: block.scope,
      sourceTable: block.sourceTable,
      sourceKey: block.sourceKey,
      sourcePhase: block.sourcePhase ?? null,
      taskId: block.taskId,
      nodeRunId: block.runId,
      missingFieldsJson: block.missingFields,
      detailJson: block.detail,
      acknowledgeable: block.acknowledgeable ?? false,
    })
}
async function referenceWriteUnit(
  store: MigrationMetaStore,
  runId: string,
  output: UnitOutput,
  outcome: MigrationUnit['outcome'],
  now: number,
  loadBlocks: readonly ConversionBlock[] = [],
): Promise<void> {
  const receipt = output.receipt
  const unitId = receipt.unitId
  await store.insert('migration_units', {
    runId,
    unitId,
    ruleId: receipt.rule.id,
    ruleVersion: receipt.rule.version,
    unitJson: receipt.unit,
    receiptJson: receipt,
    receiptDigest: receipt.digest,
    outcome,
    rowsWritten:
      outcome === 'committed' ? output.rows.reduce((sum, group) => sum + group.rows.length, 0) : 0,
    committedAt: now,
  })
  for (const source of receipt.sources)
    await store.insert('migration_unit_sources', {
      runId,
      sourceTable: source.table,
      sourcePhase: source.phase,
      unitId,
      firstKey: source.firstKey,
      lastKey: source.lastKey,
      rows: source.rows,
      digest: source.digest,
      keyDigest: source.keyDigest,
      countsJson: source.counts,
      exceptions: source.exceptions,
      historyOnly: source.historyOnly,
      unitKind: receipt.unit.kind,
      firstGroup: receipt.unit.kind === 'group' ? receipt.unit.firstGroup : null,
      lastGroup: receipt.unit.kind === 'group' ? receipt.unit.lastGroup : null,
    })
  if (outcome === 'load-blocked') {
    await referenceWriteBlocks(store, runId, 'load', unitId, loadBlocks)
    return
  }
  for (const [ordinal, disposition] of output.dispositions.entries()) {
    const sourcePhase = disposition.sourcePhase ?? 'current'
    await store.insert('migration_row_dispositions', {
      runId,
      sourceTable: disposition.sourceTable,
      sourcePhase,
      sourceKey: disposition.sourceKey,
      ordinal,
      unitId,
      class: disposition.class,
      kind: disposition.kind,
      ruleId: disposition.rule.id,
      ruleVersion: disposition.rule.version,
      targetsJson: disposition.targets,
      archiveRef: disposition.archive,
      decisionJson: disposition.decision,
      historyJson: disposition.history ?? null,
      codecColumnsJson: disposition.codecColumns ?? null,
      allocationJson: disposition.allocation ?? null,
    })
    if (disposition.history) {
      const history = disposition.history
      await store.insert('migration_history_restrictions', {
        taskId: history.taskId,
        sourceTable: disposition.sourceTable,
        sourcePhase,
        sourceKey: disposition.sourceKey,
        runId,
        ordinal,
        nodeRunId: history.runId,
        execution: history.execution,
        executionUse: history.executionUse ?? null,
        reason: history.reason ?? null,
        missingFieldsJson: history.missingFields,
        decisionCode: disposition.decision?.code ?? disposition.kind,
        unitId,
      })
    }
  }
  for (const [ordinal, artifact] of output.artifacts.entries())
    await store.insert('migration_artifact_receipts', {
      runId,
      sourceTable: artifact.sourceTable,
      sourceKey: artifact.sourceKey,
      sourceColumn: artifact.sourceColumn,
      ordinal,
      unitId,
      originalReference: artifact.originalReference,
      targetTable: artifact.target.table,
      targetKey: artifact.target.key,
      contentId: artifact.target.contentId,
      backend: artifact.target.backend,
      sha256: artifact.bytes?.sha256 ?? null,
      size: artifact.bytes?.size ?? null,
      publication: artifact.publication,
      missingState: artifact.missing?.state ?? null,
      missingEvidence: artifact.missing?.evidence ?? null,
    })
  for (const archive of output.archives) {
    const previous = await store.archive({ runId, ref: archive.ref })
    if (previous) {
      if (
        !Buffer.from(previous.bytes).equals(Buffer.from(archive.bytes)) ||
        previous.kind !== archive.kind ||
        previous.sourceTable !== archive.sourceTable ||
        previous.rows !== archive.rows ||
        previous.format !== archive.format
      )
        throw new Error('v3-archive-conflict')
    } else
      await store.insert('migration_archives', {
        runId,
        archiveRef: archive.ref,
        unitId,
        kind: archive.kind,
        sourceTable: archive.sourceTable,
        format: archive.format,
        rows: archive.rows,
        byteSize: archive.bytes.byteLength,
        bytes: archive.bytes,
      })
  }
  for (const [ordinal, record] of output.records.entries())
    await store.insert('migration_records', {
      runId,
      unitId,
      ordinal,
      kind: record.kind,
      tableName: 'table' in record ? record.table : null,
      recordJson: record,
      recordDigest: valueDigest(record),
    })
  await referenceWriteBlocks(store, runId, 'unit', unitId, output.blocks)
}

function sqliteStore() {
  const database = new Database(':memory:')
  for (const statement of compileMetaTables('sqlite', EPOCH2_META_TABLES)) database.run(statement)
  const native = sqliteHistoryConnection(database)
  const statements: Statement[] = []
  const connection: HistoryConnection = {
    provider: 'sqlite',
    async execute(sql, values = []) {
      statements.push({ sql, values: [...values] })
      return native.execute(sql, values)
    },
  }
  return {
    database,
    statements,
    store: createMigrationMetaStore({ target: connection, registry: persistenceSchema }),
  }
}
/** PostgreSQL-shaped statements without a server: every read finds nothing. */
function postgresqlStore() {
  const statements: Statement[] = []
  const connection: HistoryConnection = {
    provider: 'postgresql',
    async execute(sql, values = []) {
      statements.push({ sql, values: [...values] })
      return []
    },
  }
  return {
    statements,
    store: createMigrationMetaStore({ target: connection, registry: persistenceSchema }),
  }
}
function dump(database: Database): Record<string, unknown[]> {
  return Object.fromEntries(
    EPOCH2_META_TABLES.map((table) => [
      table.name,
      database
        .query(
          `SELECT rowid AS aw_rowid, * FROM ${metaTableName('sqlite', table.name)} ORDER BY rowid`,
        )
        .all(),
    ]),
  )
}
/** INSERT statements per meta table, with the table's column list and the values bound. */
function inserts(provider: DatabaseProvider, statements: readonly Statement[]) {
  const byTable = new Map<string, { columns: string; statements: Statement[] }>()
  for (const statement of statements) {
    const match = /^INSERT INTO (\S+) \(([^)]*)\) VALUES /u.exec(statement.sql)
    if (!match) continue
    const table = EPOCH2_META_TABLES.find(
      (entry) => metaTableName(provider, entry.name) === match[1],
    )!.name
    const entry = byTable.get(table) ?? { columns: match[2]!, statements: [] }
    expect(entry.columns).toBe(match[2]!)
    entry.statements.push(statement)
    byTable.set(table, entry)
  }
  return byTable
}

const keyOf = (unitId: string, index: number) =>
  encodeMigrationKey('maintenance_state', [canonicalValue(`${unitId}:${index}`)])
const rule = { id: 'fixture/batches', version: 1 }
function disposition(unitId: string, index: number): RowDisposition {
  const key = keyOf(unitId, index)
  const base = {
    sourceTable: 'maintenance_state',
    sourceKey: key,
    targets: [{ table: 'maintenance_state', key }],
    archive: null,
    rule,
    decision: index % 2 === 0 ? { code: 'fixture-decision', detail: { index } } : null,
    ...(index % 3 === 0
      ? {}
      : ({ sourcePhase: index % 3 === 1 ? 'current' : 'pre-upgrade' } as const)),
    ...(index % 5 === 0 ? { codecColumns: ['value'] } : {}),
    ...(index % 7 === 0
      ? { allocation: { column: 'id', value: String(index), sourceHighWater: '0' } }
      : {}),
  } as const
  if (index % 8 === 0)
    return {
      ...base,
      class: 'preserved',
      kind: 'history-only',
      history: {
        taskId: `task-${index}`,
        runId: `run-${index}`,
        execution: 'retryable-history',
        missingFields: ['checkpoint'],
      },
    }
  if (index % 8 === 4)
    return {
      ...base,
      class: 'preserved',
      kind: 'history-only',
      history: {
        taskId: `task-${index}`,
        runId: null,
        execution: 'executable',
        executionUse: 'none',
        reason: 'null-envelope-nonce-unselected',
        missingFields: [],
      },
    }
  return { ...base, class: 'converted', kind: 'derived-id' }
}
function archive(seed: string, bytes = `archive ${seed}`): UnitOutput['archives'][number] {
  return {
    ref: `archive:sha256:${valueDigest(seed).slice(7)}` as const,
    kind: 'source-journal',
    sourceTable: 'maintenance_state',
    format: 'raw-chunk@1',
    bytes: Buffer.from(bytes),
    rows: 1,
  }
}
function unit(input: {
  readonly id: string
  readonly dispositions: number
  readonly artifacts: number
  readonly records: number
  readonly blocks: number
  readonly archives?: UnitOutput['archives']
}): UnitOutput {
  const counts = { converted: input.dispositions, preserved: 0, archived: 0, blocked: 0 }
  const key = (index: number) => keyOf(input.id, index)
  const block = (index: number): ConversionBlock => ({
    code: `fixture-block-${index % 3}`,
    scope: index % 2 === 0 ? 'row' : 'table',
    sourceTable: 'maintenance_state',
    sourceKey: index % 2 === 0 ? key(index) : null,
    ...(index % 4 === 0 ? { sourcePhase: 'pre-upgrade' as const } : {}),
    taskId: index % 3 === 0 ? `task-${index}` : null,
    runId: null,
    missingFields: index % 5 === 0 ? ['checkpoint'] : [],
    detail: index % 2 === 0 ? { index } : null,
    ...(index % 6 === 0 ? { acknowledgeable: true } : {}),
  })
  return {
    receipt: {
      version: 1,
      unitId: input.id,
      unit: {
        kind: 'source-chunk',
        table: 'maintenance_state',
        phase: 'current',
        afterKey: null,
        limit: 1_000,
      },
      sourceVersion: 'fixture',
      rule,
      lookups: [],
      sources: (['current', 'pre-upgrade'] as const).map((phase) => ({
        table: 'maintenance_state',
        phase,
        rows: input.dispositions,
        digest: valueDigest(`${input.id}-${phase}`),
        keyDigest: valueDigest(`${input.id}-${phase}-keys`),
        firstKey: phase === 'current' ? key(0) : null,
        lastKey: phase === 'current' ? key(input.dispositions) : null,
        counts,
        exceptions: 0,
        historyOnly: 0,
      })),
      targets: [{ table: 'maintenance_state', rows: 1, digest: valueDigest('target') }],
      counts: { ...counts, exceptions: 0, historyOnly: 0 },
      digest: valueDigest(input.id),
    },
    rows: [{ table: 'maintenance_state', rows: [{ key: 'k', value: 'value', updated_at: 123 }] }],
    dispositions: Array.from({ length: input.dispositions }, (_, index) =>
      disposition(input.id, index),
    ),
    artifacts: Array.from({ length: input.artifacts }, (_, index) => ({
      sourceTable: 'maintenance_state',
      sourceKey: key(index),
      sourceColumn: index % 2 === 0 ? 'value' : 'body_path',
      originalReference: index % 3 === 0 ? null : `runs/${index}.md`,
      target: {
        table: 'maintenance_state',
        key: key(index),
        contentId: index % 4 === 0 ? `content-${index}` : null,
        backend: index % 3 === 0 ? ('inline' as const) : ('local-file' as const),
      },
      bytes: index % 5 === 0 ? null : { sha256: valueDigest(`bytes-${index}`), size: index },
      publication: 'not-required' as const,
      missing:
        index % 5 === 0
          ? { state: 'originally-absent' as const, evidence: `absent ${index}` }
          : null,
    })),
    archives: input.archives ?? [archive('a'), archive('b'), archive('a')],
    records: Array.from({ length: input.records }, (_, index) =>
      index % 2 === 0
        ? { kind: 'source-generation' as const, generationId: `g${index}`, evidence: { index } }
        : {
            kind: 'identity-high-water' as const,
            table: 'maintenance_state',
            column: 'id',
            value: String(index),
            basis: 'sequence' as const,
          },
    ),
    blocks: Array.from({ length: input.blocks }, (_, index) => block(index)),
  }
}
const LARGE = { id: 'unit-large', dispositions: 130, artifacts: 75, records: 60, blocks: 70 }

test('SQLite: writeUnit leaves every meta table byte-identical to the row-by-row writer', async () => {
  const reference = sqliteStore()
  const current = sqliteStore()
  const earlier = unit({ id: 'unit-earlier', dispositions: 3, artifacts: 1, records: 1, blocks: 1 })
  const output = unit(LARGE)
  await referenceWriteUnit(reference.store, 'run-r', earlier, 'committed', 100)
  await current.store.writeUnit('run-r', earlier, 'committed', 100)
  await referenceWriteUnit(reference.store, 'run-r', output, 'committed', 123)
  await current.store.writeUnit('run-r', output, 'committed', 123)
  expect(dump(current.database)).toEqual(dump(reference.database))
  const rows = dump(current.database)
  expect(rows.migration_row_dispositions).toHaveLength(133)
  expect(rows.migration_history_restrictions!.length).toBeGreaterThan(30)
  // `archive('a')` came with the earlier unit and twice with this one: stored once.
  expect(rows.migration_archives).toHaveLength(2)
  expect(await current.store.unit('run-r', 'unit-large')).toEqual(
    await reference.store.unit('run-r', 'unit-large'),
  )
})

test('SQLite: a load-blocked unit writes the same unit, sources and load blocks', async () => {
  const reference = sqliteStore()
  const current = sqliteStore()
  const output = unit(LARGE)
  const blocks = output.blocks
  await referenceWriteUnit(reference.store, 'run-r', output, 'load-blocked', 123, blocks)
  await current.store.writeUnit('run-r', output, 'load-blocked', 123, blocks)
  expect(dump(current.database)).toEqual(dump(reference.database))
  const rows = dump(current.database)
  expect(rows.migration_row_dispositions).toEqual([])
  expect(rows.migration_blocks).toHaveLength(blocks.length)
})

for (const provider of ['sqlite', 'postgresql'] as const)
  test(`${provider}: statements stay within the parameter limit and split where a table exceeds it`, async () => {
    const output = unit({
      id: 'unit-wide',
      dispositions: provider === 'postgresql' ? 2_100 : 130,
      artifacts: provider === 'postgresql' ? 1_250 : 75,
      records: provider === 'postgresql' ? 1_001 : 150,
      blocks: provider === 'postgresql' ? 1_000 : 70,
      // Distinct refs: the PostgreSQL stand-in finds no stored archive to deduplicate against.
      archives: [archive('a'), archive('b')],
    })
    const reference = provider === 'sqlite' ? sqliteStore() : postgresqlStore()
    const current = provider === 'sqlite' ? sqliteStore() : postgresqlStore()
    await referenceWriteUnit(reference.store, 'run-r', output, 'committed', 123)
    const before = current.statements.length
    await current.store.writeUnit('run-r', output, 'committed', 123)
    const written = inserts(provider, current.statements.slice(before))
    const expected = inserts(provider, reference.statements)
    const tables = [
      'migration_units',
      'migration_unit_sources',
      'migration_row_dispositions',
      'migration_history_restrictions',
      'migration_artifact_receipts',
      'migration_archives',
      'migration_records',
      'migration_blocks',
    ]
    expect([...written.keys()].sort()).toEqual([...tables].sort())
    for (const table of tables) {
      const multi = written.get(table)!
      const single = expected.get(table)!
      // Same columns, and the same values bound in the same order: the same rows.
      expect(multi.columns).toBe(single.columns)
      expect(multi.statements.flatMap((statement) => statement.values)).toEqual(
        single.statements.flatMap((statement) => statement.values),
      )
      const columns = width(table)
      const perStatement = statementRows(provider, columns)
      const rows = multi.statements.map((statement) => statement.values.length / columns)
      const total = single.statements.length
      expect(rows.reduce((sum, count) => sum + count, 0)).toBe(total)
      expect(multi.statements).toHaveLength(Math.ceil(total / perStatement))
      expect(rows.slice(0, -1).every((count) => count === perStatement)).toBe(true)
      for (const statement of multi.statements) {
        expect(statement.values.length).toBeLessThanOrEqual(LIMITS[provider].parameters)
        expect(statement.values.length / columns).toBeLessThanOrEqual(LIMITS[provider].rows)
        if (provider === 'postgresql')
          expect([...statement.sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]))).toEqual(
            Array.from({ length: statement.values.length }, (_, index) => index + 1),
          )
        else expect(statement.sql.split('?').length - 1).toBe(statement.values.length)
      }
    }
    // Tables large enough to need more than one statement did split.
    expect(written.get('migration_row_dispositions')!.statements.length).toBeGreaterThan(1)
    expect(written.get('migration_records')!.statements.length).toBeGreaterThan(1)
  })

test('an archive that differs from one stored earlier, or earlier in the same unit, still conflicts', async () => {
  const sameUnit = sqliteStore()
  await expect(
    sameUnit.store.writeUnit(
      'run-r',
      unit({ ...LARGE, archives: [archive('a'), archive('a', 'different bytes')] }),
      'committed',
      123,
    ),
  ).rejects.toThrow('v3-archive-conflict')
  const reference = sqliteStore()
  await expect(
    referenceWriteUnit(
      reference.store,
      'run-r',
      unit({ ...LARGE, archives: [archive('a'), archive('a', 'different bytes')] }),
      'committed',
      123,
    ),
  ).rejects.toThrow('v3-archive-conflict')

  const earlier = sqliteStore()
  await earlier.store.writeUnit(
    'run-r',
    unit({ id: 'unit-1', dispositions: 1, artifacts: 0, records: 0, blocks: 0 }),
    'committed',
    1,
  )
  await expect(
    earlier.store.writeUnit(
      'run-r',
      unit({ ...LARGE, id: 'unit-2', archives: [archive('b', 'changed after unit-1')] }),
      'committed',
      2,
    ),
  ).rejects.toThrow('v3-archive-conflict')
  await earlier.store.writeUnit(
    'run-r',
    unit({ ...LARGE, id: 'unit-3', archives: [archive('b'), archive('c')] }),
    'committed',
    3,
  )
  const archives = dump(earlier.database).migration_archives as { archive_ref: string }[]
  expect(archives.map((row) => row.archive_ref)).toEqual(
    [archive('a'), archive('b'), archive('c')].map((entry) => entry.ref),
  )
})

test('an invalid row is refused before any statement for its table, with the earlier error', async () => {
  const current = sqliteStore()
  const output = unit({ ...LARGE, id: 'unit-invalid' })
  const broken: UnitOutput = {
    ...output,
    artifacts: [
      ...output.artifacts.slice(0, 10),
      {
        ...output.artifacts[10]!,
        publication: 'invented' as unknown as UnitOutput['artifacts'][number]['publication'],
      },
    ],
  }
  await expect(current.store.writeUnit('run-r', broken, 'committed', 123)).rejects.toThrow(
    'v3-meta-enum: migration_artifact_receipts.publication',
  )
  expect(dump(current.database).migration_artifact_receipts).toEqual([])
})
