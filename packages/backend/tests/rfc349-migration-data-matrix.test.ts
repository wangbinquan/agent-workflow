// RFC-349 T10-B — one provider-neutral logical artifact must carry the same
// production-shaped rows from SQLite to PostgreSQL and back across empty,
// minimal, seeded and multi-chunk datasets. The cyclic foreign-key fixture is
// validated only after every chunk has been copied, matching target finalization.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareCanonicalLogicalKeys,
  decodeLogicalRow,
  encodeLogicalRow,
  type CanonicalLogicalRow,
  type LogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  exportLogicalDatabaseArtifact,
  type LogicalDatabaseExportSource,
} from '@/platform/persistence/logicalDatabaseExport'
import {
  restoreLogicalDatabaseBackup,
  type LogicalDatabaseRestoreTarget,
  type LogicalTargetTableVerification,
} from '@/platform/persistence/logicalDatabaseRestore'
import type {
  LogicalCodec,
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const roots: string[] = []
const SCHEMA_DIGEST = `sha256:${'d'.repeat(64)}`

type Provider = 'sqlite' | 'postgresql'
type ScenarioName = 'empty' | 'minimal' | 'full-seed' | 'large'

interface MatrixScenario {
  readonly name: ScenarioName
  readonly rowsPerTable: number
  readonly chunkRows: number
}

const MATRIX: readonly MatrixScenario[] = [
  { name: 'empty', rowsPerTable: 0, chunkRows: 7 },
  { name: 'minimal', rowsPerTable: 1, chunkRows: 1 },
  { name: 'full-seed', rowsPerTable: 53, chunkRows: 17 },
  { name: 'large', rowsPerTable: 2_049, chunkRows: 127 },
]

function column(
  name: string,
  logicalCodec: LogicalCodec,
  input: Partial<Pick<LogicalColumnContract, 'nullable' | 'primary'>> = {},
): LogicalColumnContract {
  const providerType = (() => {
    switch (logicalCodec) {
      case 'boolean':
        return { sqlite: 'integer', postgresql: 'boolean' }
      case 'epoch-milliseconds':
      case 'integer':
        return { sqlite: 'integer', postgresql: 'bigint' }
      case 'opaque-bytes':
        return { sqlite: 'blob', postgresql: 'bytea' }
      case 'real':
        return { sqlite: 'real', postgresql: 'double precision' }
      case 'json-text':
      case 'text':
      case 'text-identity':
        return { sqlite: 'text', postgresql: 'text' }
    }
  })()
  return {
    name,
    logicalCodec,
    nullable: input.nullable ?? false,
    primary: input.primary ?? false,
    hasDefault: false,
    defaultKind: 'none',
    defaultValue: null,
    providerDefault: { sqlite: null, postgresql: null },
    identity: false,
    uniqueName: null,
    enumValues: [],
    providerType,
  }
}

function table(id: 'matrix_left' | 'matrix_right'): LogicalTableContract {
  const foreignTable = id === 'matrix_left' ? 'matrix_right' : 'matrix_left'
  return {
    id,
    schemaSymbol: id,
    ownerContext: 'system-operations',
    disposition: 'KEEP',
    sourceTable: id,
    providerTables: { sqlite: id, postgresql: id },
    migrationKey: ['sort_key', 'id'],
    columns: [
      column('id', 'text-identity', { primary: true }),
      column('peer_id', 'text-identity'),
      column('sort_key', 'text'),
      column('lossless_counter', 'integer'),
      column('enabled', 'boolean'),
      column('payload_json', 'json-text'),
      column('opaque_payload', 'opaque-bytes'),
      column('optional_note', 'text', { nullable: true }),
      column('ratio', 'real'),
      column('occurred_at', 'epoch-milliseconds'),
    ],
    primaryKey: ['id'],
    unique: [],
    foreignKeys: [
      {
        name: `${id}_peer_fk`,
        columns: ['peer_id'],
        foreignTable,
        foreignColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      },
    ],
    checks: [],
    indexes: [],
    retention: {
      class: 'owner-managed-business',
      owner: 'system-operations',
      rule: 'RFC-349 T10-B migration matrix fixture',
    },
    consumers: {
      productionReader: 'owner-required',
      productionWriter: 'owner-required-or-immutable',
      backgroundRecoveryDiagnostic: 'owner-reviewed',
      evidence: 'RFC-349 T10-B migration matrix fixture',
    },
    rationale: 'Exercises lossless codecs and cyclic foreign keys across logical providers.',
  }
}

const LEFT = table('matrix_left')
const RIGHT = table('matrix_right')
const CONTRACT: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 2,
  activeTableCount: 2,
  archiveOnlyTableCount: 0,
  tables: [LEFT, RIGHT],
  digest: SCHEMA_DIGEST,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(scenario: ScenarioName, source: Provider): string {
  const value = mkdtempSync(join(tmpdir(), `rfc349-matrix-${scenario}-${source}-`))
  roots.push(value)
  return value
}

function scalarRow(
  tableId: LogicalTableContract['id'],
  scenario: ScenarioName,
  index: number,
): Readonly<Record<string, unknown>> {
  const left = tableId === LEFT.id
  const padded = String(index).padStart(6, '0')
  const side = left ? 'left' : 'right'
  const peer = left ? 'right' : 'left'
  const collationKeys = ['A', 'z', 'é', '中'] as const
  return {
    id: `${side}-${padded}`,
    peer_id: `${peer}-${padded}`,
    sort_key: collationKeys[index % collationKeys.length],
    lossless_counter: 9_007_199_254_740_993n + BigInt(index),
    enabled: index % 2 === 0,
    payload_json: JSON.stringify({ scenario, index, nested: { side, enabled: index % 2 === 0 } }),
    opaque_payload: new Uint8Array([index % 256, (index * 17) % 256, 0, 255]),
    optional_note: index % 3 === 0 ? null : `${scenario}:${side}:${index}`,
    ratio: index + 0.5,
    occurred_at: 1_700_000_000_000n + BigInt(index),
  }
}

function scenarioRows(
  scenario: MatrixScenario,
): ReadonlyMap<LogicalTableContract['id'], readonly CanonicalLogicalRow[]> {
  return new Map(
    CONTRACT.tables.map((contractTable) => {
      const rows = Array.from({ length: scenario.rowsPerTable }, (_, index) =>
        encodeLogicalRow(contractTable, scalarRow(contractTable.id, scenario.name, index)),
      ).sort((left, right) => compareCanonicalLogicalKeys(left.key, right.key))
      return [contractTable.id, Object.freeze(rows)] as const
    }),
  )
}

function source(
  provider: Provider,
  rows: ReadonlyMap<string, readonly CanonicalLogicalRow[]>,
): LogicalDatabaseExportSource {
  return {
    provider,
    async assertUnchanged() {},
    async readChunk(tableContract, afterKey, limit) {
      const tableRows = rows.get(tableContract.id) ?? []
      const start =
        afterKey === null
          ? 0
          : tableRows.findIndex((row) => compareCanonicalLogicalKeys(row.key, afterKey) > 0)
      return start < 0 ? [] : tableRows.slice(start, start + limit)
    },
  }
}

interface RecordingTarget {
  readonly target: LogicalDatabaseRestoreTarget
  readonly rows: ReadonlyMap<string, readonly CanonicalLogicalRow[]>
  readonly chunks: ReadonlyMap<string, readonly LogicalTableChunk[]>
  finalized(): boolean
}

function recordingTarget(input: {
  readonly provider: Provider
  readonly operationId: string
  readonly expectedRows: ReadonlyMap<string, readonly CanonicalLogicalRow[]>
}): RecordingTarget {
  let prepared = false
  let isFinalized = false
  const restoredRows = new Map<string, CanonicalLogicalRow[]>(
    CONTRACT.tables.map((tableContract) => [tableContract.id, []]),
  )
  const restoredChunks = new Map<string, LogicalTableChunk[]>(
    CONTRACT.tables.map((tableContract) => [tableContract.id, []]),
  )
  const target: LogicalDatabaseRestoreTarget = {
    provider: input.provider,
    operationId: input.operationId,
    async prepare() {
      expect(prepared).toBe(false)
      expect(isFinalized).toBe(false)
      prepared = true
    },
    async copyChunk(tableContract, chunk) {
      expect(prepared).toBe(true)
      expect(isFinalized).toBe(false)
      expect(chunk.payload.operationId).toBe(input.operationId)
      const chunks = restoredChunks.get(tableContract.id) ?? []
      expect(chunk.payload.chunkIndex).toBe(chunks.length)
      chunks.push(chunk)
      restoredChunks.set(tableContract.id, chunks)
      restoredRows.set(tableContract.id, [
        ...(restoredRows.get(tableContract.id) ?? []),
        ...chunk.payload.rows,
      ])
    },
    async finalizeSchema(_now, expectedTables) {
      expect(prepared).toBe(true)
      expect(isFinalized).toBe(false)
      expect(expectedTables).toEqual(expectedTableVerification(input.expectedRows, restoredChunks))
      expectRowsEqual(restoredRows, input.expectedRows)
      assertCyclicReferences(restoredRows)
      isFinalized = true
    },
  }
  return {
    target,
    rows: restoredRows,
    chunks: restoredChunks,
    finalized: () => isFinalized,
  }
}

function expectedTableVerification(
  expectedRows: ReadonlyMap<string, readonly CanonicalLogicalRow[]>,
  chunks: ReadonlyMap<string, readonly LogicalTableChunk[]>,
): readonly LogicalTargetTableVerification[] {
  return CONTRACT.tables.map((tableContract) => ({
    table: tableContract.id,
    disposition: tableContract.disposition,
    rowCount: expectedRows.get(tableContract.id)?.length ?? 0,
    chunkCount: chunks.get(tableContract.id)?.length ?? 0,
  }))
}

function expectRowsEqual(
  actual: ReadonlyMap<string, readonly CanonicalLogicalRow[]>,
  expected: ReadonlyMap<string, readonly CanonicalLogicalRow[]>,
): void {
  expect([...actual.keys()]).toEqual([...expected.keys()])
  for (const tableId of expected.keys()) {
    expect([...(actual.get(tableId) ?? [])]).toEqual([...(expected.get(tableId) ?? [])])
  }
}

function assertCyclicReferences(rows: ReadonlyMap<string, readonly CanonicalLogicalRow[]>): void {
  const ids = new Map(
    CONTRACT.tables.map((tableContract) => [
      tableContract.id,
      new Set(
        (rows.get(tableContract.id) ?? []).map((row) =>
          String(decodeLogicalRow(tableContract, row).id),
        ),
      ),
    ]),
  )
  for (const tableContract of CONTRACT.tables) {
    const foreignTable = tableContract.foreignKeys[0]!.foreignTable
    const foreignIds = ids.get(foreignTable)!
    for (const row of rows.get(tableContract.id) ?? []) {
      expect(foreignIds.has(String(decodeLogicalRow(tableContract, row).peer_id))).toBe(true)
    }
  }
}

function expectedChunks(rowCount: number, chunkRows: number): number {
  return rowCount === 0 ? 0 : Math.ceil(rowCount / chunkRows)
}

async function runDirection(input: {
  readonly scenario: MatrixScenario
  readonly sourceProvider: Provider
  readonly targetProvider: Provider
}): Promise<void> {
  const rows = scenarioRows(input.scenario)
  const artifactRoot = tempRoot(input.scenario.name, input.sourceProvider)
  const sourceOperationId = `dbm_matrix_${input.sourceProvider}_${input.scenario.name}_01`
  const restoreOperationId = `dbm_matrix_${input.targetProvider}_${input.scenario.name}_02`
  const exported = await exportLogicalDatabaseArtifact({
    operationId: sourceOperationId,
    sourceProvider: input.sourceProvider,
    sourceGenerationId: `dbg_matrix_${input.sourceProvider}_${input.scenario.name}_01`,
    source: source(input.sourceProvider, rows),
    expectedTableRows: Object.fromEntries(
      CONTRACT.tables.map((tableContract) => [tableContract.id, input.scenario.rowsPerTable]),
    ),
    contract: CONTRACT,
    artifactRoot,
    chunkRows: input.scenario.chunkRows,
    now: () => 1,
  })
  const chunksPerTable = expectedChunks(input.scenario.rowsPerTable, input.scenario.chunkRows)
  expect(exported).toMatchObject({
    activeRows: input.scenario.rowsPerTable * CONTRACT.activeTableCount,
    archiveRows: 0,
    chunks: chunksPerTable * CONTRACT.activeTableCount,
  })

  const target = recordingTarget({
    provider: input.targetProvider,
    operationId: restoreOperationId,
    expectedRows: rows,
  })
  const receipt = await restoreLogicalDatabaseBackup({
    artifactRoot,
    expectedEnvelopeFileDigest: exported.envelopeFileDigest,
    restoreOperationId,
    contract: CONTRACT,
    target: target.target,
    now: () => 2,
  })

  expect(receipt).toMatchObject({
    sourceProvider: input.sourceProvider,
    targetProvider: input.targetProvider,
    activeTablesRestored: CONTRACT.activeTableCount,
    archiveTablesPreserved: 0,
    rowsRestored: input.scenario.rowsPerTable * CONTRACT.activeTableCount,
    chunksRestored: chunksPerTable * CONTRACT.activeTableCount,
  })
  expect(target.finalized()).toBe(true)
  expectRowsEqual(target.rows, rows)
}

describe('RFC-349 migration data matrix', () => {
  for (const scenario of MATRIX) {
    test(
      `${scenario.name} rows round-trip SQLite to PostgreSQL and PostgreSQL to SQLite`,
      async () => {
        await runDirection({ scenario, sourceProvider: 'sqlite', targetProvider: 'postgresql' })
        await runDirection({ scenario, sourceProvider: 'postgresql', targetProvider: 'sqlite' })
      },
      scenario.name === 'large' ? 15_000 : 5_000,
    )
  }
})
