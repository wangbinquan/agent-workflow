import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  decodeLogicalValue,
  encodeLogicalRow,
  encodeLogicalValue,
  readLogicalArtifactManifest,
  readLogicalTableChunk,
  summarizeLogicalTableChunks,
  verifyLogicalTableChunk,
  writeLogicalArtifactManifest,
  writeLogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const roots: string[] = []
const DIGEST = `sha256:${'a'.repeat(64)}`

function column(
  name: string,
  logicalCodec: LogicalColumnContract['logicalCodec'],
  nullable = false,
): LogicalColumnContract {
  return {
    name,
    logicalCodec,
    nullable,
    primary: name === 'id',
    hasDefault: false,
    defaultKind: 'none',
    defaultValue: null,
    providerDefault: { sqlite: null, postgresql: null },
    identity: false,
    uniqueName: null,
    enumValues: [],
    providerType: {
      sqlite: logicalCodec === 'opaque-bytes' ? 'blob' : 'text',
      postgresql: logicalCodec === 'opaque-bytes' ? 'bytea' : 'text',
    },
  }
}

const TABLE: LogicalTableContract = {
  id: 'fixture_rows',
  schemaSymbol: 'fixtureRows',
  ownerContext: 'system-operations',
  disposition: 'KEEP',
  sourceTable: 'fixture_rows',
  providerTables: { sqlite: 'fixture_rows', postgresql: 'fixture_rows' },
  migrationKey: ['id'],
  columns: [
    column('id', 'text-identity'),
    column('counter', 'integer'),
    column('enabled', 'boolean'),
    column('payload', 'json-text'),
    column('bytes', 'opaque-bytes'),
    column('optional', 'text', true),
  ],
  primaryKey: ['id'],
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  retention: {
    class: 'owner-managed-business',
    owner: 'system-operations',
    rule: 'fixture',
  },
  consumers: {
    productionReader: 'owner-required',
    productionWriter: 'owner-required-or-immutable',
    backgroundRecoveryDiagnostic: 'owner-reviewed',
    evidence: 'fixture',
  },
  rationale: 'fixture',
}

const CONTRACT: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 1,
  activeTableCount: 1,
  archiveOnlyTableCount: 0,
  tables: [TABLE],
  digest: DIGEST,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 provider-neutral logical artifact', () => {
  test('round-trips lossless scalar tags without JS integer coercion', () => {
    const integer = encodeLogicalValue(
      'fixture_rows',
      column('counter', 'integer'),
      9_007_199_254_740_993n,
    )
    expect(integer).toEqual({ type: 'integer', value: '9007199254740993' })
    expect(decodeLogicalValue(integer)).toBe(9_007_199_254_740_993n)
    expect(encodeLogicalValue('fixture_rows', column('enabled', 'boolean'), 1n)).toEqual({
      type: 'boolean',
      value: true,
    })
    expect(
      encodeLogicalValue(
        'fixture_rows',
        column('bytes', 'opaque-bytes'),
        new Uint8Array([0, 127, 255]),
      ),
    ).toEqual({ type: 'bytes', value: 'AH//' })
    expect(() =>
      encodeLogicalValue('fixture_rows', column('counter', 'integer'), Number.MAX_SAFE_INTEGER + 1),
    ).toThrow('lossless integer')
    expect(() => encodeLogicalValue('fixture_rows', column('enabled', 'boolean'), 2)).toThrow('0/1')
    expect(() =>
      encodeLogicalValue('fixture_rows', column('payload', 'json-text'), '{broken'),
    ).toThrow('invalid JSON')
  })

  test('binds chunk and manifest digests to exact row order and bytes', () => {
    const row = encodeLogicalRow(TABLE, {
      id: 'row-1',
      counter: 9_007_199_254_740_993n,
      enabled: 1,
      payload: '{"b":2,"a":1}',
      bytes: new Uint8Array([1, 2, 3]),
      optional: null,
    })
    const chunk = createLogicalTableChunk({
      operationId: 'dbm_operation_01',
      contract: CONTRACT,
      table: TABLE,
      chunkIndex: 0,
      rows: [row],
    })
    expect(() =>
      verifyLogicalTableChunk({
        ...chunk,
        payload: { ...chunk.payload, rows: [{ ...row, values: [...row.values].reverse() }] },
      }),
    ).toThrow('digest')

    const root = mkdtempSync(join(tmpdir(), 'rfc349-artifact-'))
    roots.push(root)
    const chunkPath = writeLogicalTableChunk(root, chunk)
    expect(readLogicalTableChunk(chunkPath)).toEqual(chunk)
    expect(writeLogicalTableChunk(root, chunk)).toBe(chunkPath)

    const entry = summarizeLogicalTableChunks({ table: TABLE, chunks: [chunk] })
    expect(entry).toMatchObject({ rowCount: 1, chunkCount: 1, blobBytes: 3 })
    const manifest = createLogicalArtifactManifest({
      operationId: 'dbm_operation_01',
      sourceProvider: 'sqlite',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      createdAt: 1,
      tables: [entry],
    })
    const manifestPath = writeLogicalArtifactManifest(root, manifest)
    expect(readLogicalArtifactManifest(manifestPath)).toEqual(manifest)
  })
})
