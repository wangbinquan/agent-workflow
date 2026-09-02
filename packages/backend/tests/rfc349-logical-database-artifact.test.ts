import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  compareCanonicalLogicalKeys,
  decodeLogicalValue,
  createLogicalTableChunkSummary,
  encodeLogicalRow,
  encodeLogicalValue,
  readLogicalArtifactManifest,
  readLogicalTableChunk,
  summarizeLogicalTableChunks,
  verifyLogicalTableChunk,
  writeDurableLogicalArtifact,
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
  test('opens durable temporary files write-capable before syncing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-artifact-sync-'))
    roots.push(root)
    const calls: string[] = []
    const output = join(root, 'artifact.json')
    let openedPath: string | undefined
    let openedFlags: string | undefined

    writeDurableLogicalArtifact(
      output,
      { version: 1 },
      {
        open: (path, flags) => {
          openedPath = path
          openedFlags = flags
          calls.push('open')
          return 349
        },
        fsync: (handle) => calls.push(`fsync:${handle}`),
        close: (handle) => calls.push(`close:${handle}`),
      },
    )

    expect(openedPath?.startsWith(`${output}.tmp-`)).toBe(true)
    expect(openedFlags).toBe('r+')
    expect(calls).toEqual(['open', 'fsync:349', 'close:349'])
  })

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
    expect(
      compareCanonicalLogicalKeys(
        [{ type: 'integer', value: '9007199254740992' }],
        [{ type: 'integer', value: '9007199254740993' }],
      ),
    ).toBe(-1)
    expect(
      compareCanonicalLogicalKeys([{ type: 'text', value: 'z' }], [{ type: 'text', value: 'é' }]),
    ).toBe(-1)
    expect(() =>
      compareCanonicalLogicalKeys(
        [{ type: 'text', value: '1' }],
        [{ type: 'integer', value: '1' }],
      ),
    ).toThrow('incompatible scalar types')
  })

  // RFC-349 —— 表级 artifact entry 必须能**逐块折叠**出来，不许把整张表攒在内存里。
  //
  // 由来：托管取证跑（full 种子，`node_run_events` 1000 万行）的 daemon 在拷贝阶段被
  // 运行环境按内存杀掉（exit 143，种子完成后静默 30 分钟）。本机同参数复跑，拷到 947 万
  // 行时 daemon RSS **7.1GB**——`summarizeLogicalTableChunks` 的 `chunks.flatMap(c =>
  // c.payload.rows)` 把整张表物化了一遍，而调用方还为它攒了整份 chunk 数组。
  // entry 的每个字段都是可折叠的累计量，所以两条路必须逐字等价。
  test('the streaming summary is byte-identical to the one-shot one, and keeps no rows', () => {
    const chunkOf = (chunkIndex: number, ids: readonly string[]) =>
      createLogicalTableChunk({
        operationId: 'dbm_operation_01',
        contract: CONTRACT,
        table: TABLE,
        chunkIndex,
        rows: ids.map((id) =>
          encodeLogicalRow(TABLE, {
            id,
            counter: 7n,
            enabled: 1,
            payload: '{"a":1}',
            bytes: new Uint8Array([1, 2, 3, 4]),
            optional: null,
          }),
        ),
      })

    for (const chunks of [
      [],
      [chunkOf(0, ['a-1'])],
      [chunkOf(0, ['a-1', 'a-2']), chunkOf(1, ['b-1', 'b-2']), chunkOf(2, ['c-1'])],
    ]) {
      const streaming = createLogicalTableChunkSummary(TABLE)
      for (const chunk of chunks) streaming.add(chunk)
      expect(streaming.finish()).toEqual(summarizeLogicalTableChunks({ table: TABLE, chunks }))
    }

    // A gap in the chunk sequence is still corruption, not a silent hole.
    const gapped = createLogicalTableChunkSummary(TABLE)
    gapped.add(chunkOf(0, ['a-1']))
    expect(() => gapped.add(chunkOf(2, ['c-1']))).toThrow('not contiguous')

    // The accumulator must not grow with the number of rows it has seen: 200
    // chunks × 200 rows = 40k rows through it, and what it retains is one digest
    // per chunk plus two keys.
    const summary = createLogicalTableChunkSummary(TABLE)
    for (let index = 0; index < 200; index += 1) {
      summary.add(
        chunkOf(
          index,
          Array.from({ length: 200 }, (_, row) => `row-${index}-${row}`),
        ),
      )
    }
    const entry = summary.finish()
    expect(entry.rowCount).toBe(40_000)
    expect(entry.chunkCount).toBe(200)
    expect(JSON.stringify(entry).length).toBeLessThan(30_000)

    // The copy loop must fold as it goes; accumulating chunks is the regression.
    const runner = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'system-operations',
        'application',
        'databaseMigrationRunner.ts',
      ),
      'utf8',
    )
    expect(runner).toContain('summary.add(persisted.chunk)')
    expect(runner).toContain('createLogicalTableChunkSummary(table)')
    // 折叠是逐块进行的：copy 循环里不许再出现「把 chunk 攒起来最后一次性汇总」的形状。
    const copyLoop = runner.slice(runner.indexOf('const summary = createLogicalTableChunkSummary'))
    expect(copyLoop).not.toMatch(/chunks\.push\(/)
    expect(copyLoop).not.toMatch(/summarizeLogicalTableChunks\(/)
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
