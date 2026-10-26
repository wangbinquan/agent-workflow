// RFC-395 V1: codec bytes and cursor contracts remain stable across epoch activation.
import { describe, expect, test } from 'bun:test'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { encodeLogicalRow } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import {
  sourceChunk,
  assertSourceChunkRequest,
  sourceFilesDigest,
} from '@/platform/persistence/migration/sourceReader'
import { createSha256DigestBuilder } from '@/util/hash'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import type { LogicalColumnContract } from '@/platform/persistence/schema/contractTypes'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

describe('RFC-395 V1 frozen codec', () => {
  const base = frozenEpoch1Contract.tables.find((table) => table.id === 'maintenance_state')!
  const columns: LogicalColumnContract[] = (
    ['integer', 'opaque-bytes', 'boolean', 'json-text', 'real', 'text'] as const
  ).map((logicalCodec, index) => ({
    ...base.columns[1]!,
    name: `v${index}`,
    logicalCodec,
    nullable: index === 5,
  }))
  const table = { ...base, columns: [base.columns[0]!, ...columns] }
  test('bigint, BLOB, bool, original JSON, real and NULL survive decode and re-encode losslessly', () => {
    const row = {
      key: 'typed',
      v0: 9007199254740993n,
      v1: new Uint8Array([0, 255, 128]),
      v2: true,
      v3: '{ "x" : [1,2] }\n',
      v4: 1.25,
      v5: null,
    }
    const encoded = encodeLogicalRow(table, row)
    const chunk = sourceChunk({
      sourceVersion: 'frozen-codec-fixture',
      table,
      afterKey: null,
      rows: [encoded],
    })
    expect({ ...chunk.decodedRows[0], v1: [...(chunk.decodedRows[0]!.v1 as Uint8Array)] }).toEqual({
      ...row,
      v1: [...row.v1],
    })
    expect(encodeLogicalRow(table, chunk.decodedRows[0]!)).toEqual(encoded)
    expect(chunk.rows[0]!.values[1]).toEqual({ type: 'integer', value: '9007199254740993' })
    expect(chunk.rows[0]!.values[2]).toEqual({ type: 'bytes', value: 'AP+A' })
  })
  test('limits, key arity and non-monotonic row order are rejected with typed errors', () => {
    for (const limit of [0, -1, 1.5, 10001])
      expect(() => assertSourceChunkRequest(table, null, limit)).toThrow(SourceBlockedError)
    expect(() => assertSourceChunkRequest(table, [], 2)).toThrow(SourceBlockedError)
    const row = encodeLogicalRow(base, { key: 'same', value: '', updated_at: 0 })
    expect(() =>
      sourceChunk({ sourceVersion: 'fixture', table: base, afterKey: row.key, rows: [row] }),
    ).toThrow(SourceBlockedError)
  })
})
describeV1Providers('RFC-395 V1 composite reader chunks', (h) => {
  test('composite keys traverse stored chunks with non-aligned limits and unchanged digests', async () => {
    const version = await h.install()
    for (const [index, parts] of [
      ['a', 'a', 'a'],
      ['a', 'a', 'b'],
      ['a', 'b', 'a'],
      ['b', 'a', 'a'],
      ['b', 'b', 'b'],
    ].entries()) {
      const values = [...parts, 'session', index]
      const parameters = h.provider === 'sqlite' ? '?,?,?,?,?' : '$1,$2,$3,$4,$5'
      await h.native.execute(
        `INSERT INTO ${h.table('intent_provenance')} (resource_type,resource_id,commit_id,session_id,created_at) VALUES (${parameters})`,
        values,
      )
    }
    const backup = await h.backup(version)
    const artifact = openEpoch1LogicalArtifactSource({
      artifactRoot: backup.artifactRoot,
      envelopeFileDigest: backup.envelopeFileDigest,
      supportedSources: await h.manifest(),
    })
    const physical = await h.source()
    try {
      await artifact.preflight()
      await physical.preflight()
      for (const source of [physical, artifact]) {
        const one = await source.readChunk('intent_provenance', null, 3)
        const two = await source.readChunk('intent_provenance', one.lastKey, 3)
        expect(one.rows.length).toBe(3)
        expect(two.rows.length).toBe(2)
        expect(one.migrationKey).toEqual(['resource_type', 'resource_id', 'commit_id'])
        expect(
          [...one.rows, ...two.rows].map((row) =>
            row.key.map((part) => (part.type === 'text' ? part.value : null)),
          ),
        ).toEqual([
          ['a', 'a', 'a'],
          ['a', 'a', 'b'],
          ['a', 'b', 'a'],
          ['b', 'a', 'a'],
          ['b', 'b', 'b'],
        ])
        expect((await source.readChunk('intent_provenance', one.lastKey, 3)).sourceDigest).toBe(
          two.sourceDigest,
        )
        await expect(
          source.readChunk('intent_provenance', one.lastKey!.slice(1), 3),
        ).rejects.toBeInstanceOf(SourceBlockedError)
        await expect(source.readChunk('no_such_codec', null, 1)).rejects.toBeInstanceOf(
          SourceBlockedError,
        )
      }
    } finally {
      await physical.close()
      await artifact.close()
      backup.close()
    }
  }, 240_000)
  test('directory hashing retains original sorted order and segment framing', async () => {
    const root = join(h.operationRoot, 'hash-framing')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'z'), 'last')
    writeFileSync(join(root, 'a'), 'first')
    const digest = createSha256DigestBuilder()
    digest.update(JSON.stringify(['/a', 5]))
    digest.update('first')
    digest.update(JSON.stringify(['/z', 4]))
    digest.update('last')
    expect(await sourceFilesDigest(root)).toBe(`sha256:${digest.digestHex()}`)
  })
})
