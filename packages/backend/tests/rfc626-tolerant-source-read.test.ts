// RFC-626 §3.3 "转换之前读取来源行的另外三处"
// (design/RFC-626-upgrade-no-refusal-minimal-time/design.md). Three readers run before the
// conversion — the capture of boot-upgrade facts, the count of unfinished tasks in the plan,
// the trace's lookup of a row's group — and they read strictly: one row the frozen codec
// rejects (SQLite does not enforce column types; a JSON column can hold text that is not
// JSON) threw, and the upgrade ended before the conversion could set that row aside. They now
// share the conversion's own way of reading a table (`readSourceTable`): strictly, and when a
// row is rejected, the whole table again through the raw channel with the rejected rows
// marked. With automatic resolution the boot-fact reader leaves such rows out; without it the
// read stays strict, as it always was.
import { describe, expect, test } from 'bun:test'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { readSourceTable } from '@/platform/persistence/migration/conversion/readSource'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { bootSourceRows } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import type { FrozenSourceHandle } from '@/platform/persistence/migration/run/types'
import type {
  DecodedSourceRow,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { frozenRow, memorySource, type MemorySource } from './rfc626-engine-fixtures.test'

const TABLE = 'recovery_events'
const event = (id: string, values: DecodedSourceRow = {}): DecodedSourceRow =>
  frozenRow(TABLE, { id, actor: `actor of ${id}`, ...values })
/** `before_json` is declared JSON text; SQLite stores whatever text it is given. */
const undecodable = (id: string): DecodedSourceRow => event(id, { before_json: '{ not json' })
const sound = ['a', 'b', 'c', 'd', 'e'].map((id) => event(id, { before_json: `{"id":"${id}"}` }))
const ids = (rows: readonly SourceRow[]): string[] => rows.map((row) => String(row.values.id))
const byId = <T extends { readonly id?: unknown }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
/** The rows a strict read gives, chunk by chunk, in the shape the conversion stages them. */
async function strictly(memory: MemorySource, limit: number): Promise<SourceRow[]> {
  const rows: SourceRow[] = []
  let after: Parameters<VersionedSourceReader['readChunk']>[1] = null
  for (;;) {
    const chunk = await memory.source.readChunk(TABLE, after, limit)
    if (!chunk.rows.length || !chunk.lastKey) return rows
    chunk.rows.forEach((canonical, index) =>
      rows.push({
        table: TABLE,
        phase: 'current',
        key: canonical.key,
        encodedKey: encodeMigrationKey(TABLE, canonical.key),
        canonical,
        values: chunk.decodedRows[index]!,
      }),
    )
    after = chunk.lastKey
  }
}
function handle(memory: MemorySource): FrozenSourceHandle {
  return {
    reader: memory.source,
    preflight: memory.preflight,
    preUpgrade: null,
    watermark: memory.preflight.watermark,
    evidenceRoot: null,
    close: async () => {},
  }
}

describe('RFC-626 readSourceTable: the way the conversion reads a table', () => {
  test('when every row decodes it is the strict read, and the raw channel is never asked', async () => {
    const memory = memorySource({ [TABLE]: sound })
    const rows = await readSourceTable({
      source: memory.source,
      preflight: memory.preflight,
      table: TABLE,
      limit: 2,
    })
    expect(memory.reads.raw).toEqual([])
    expect(rows).toEqual(await strictly(memorySource({ [TABLE]: sound }), 2))
    expect(rows.map((row) => row.values)).toEqual(sound)
    for (const row of rows) {
      expect(row).not.toHaveProperty('raw')
      expect(row).not.toHaveProperty('codecFailure')
    }
  })

  // The strict read has already delivered chunks when it meets the row: none of them may stay.
  for (const [position, bad] of [
    ['in the first chunk', 'a'],
    ['after the second chunk', 'e'],
    ['in the middle', 'c'],
  ] as const)
    test(`one row the frozen codec rejects ${position}: the whole table is read raw and only that row is marked`, async () => {
      const stored = sound.map((row) => (row.id === bad ? undecodable(bad) : row))
      const memory = memorySource({ [TABLE]: stored })
      const rows = await readSourceTable({
        source: memory.source,
        preflight: memory.preflight,
        table: TABLE,
        limit: 2,
      })
      expect(memory.reads.raw.length).toBeGreaterThan(0)
      // Every row once, whatever the strict pass had read before it gave up.
      expect(ids(rows).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])

      const rejected = rows.find((row) => row.values.id === bad)!
      expect(rejected.codecFailure).toEqual({
        message: expect.any(String),
        columns: ['before_json'],
      })
      expect(rejected.raw).toBeDefined()
      // What the old database stored is still there to be archived.
      expect(rejected.values.before_json).toBe('{ not json')
      expect(rejected.encodedKey).toBe(encodeMigrationKey(TABLE, rejected.key))

      // The other rows are what a strict read gives: same key, same decoded values.
      const strict = await strictly(memorySource({ [TABLE]: sound }), 2)
      for (const row of rows) {
        if (row === rejected) continue
        const expected = strict.find((entry) => entry.values.id === row.values.id)!
        expect(row).not.toHaveProperty('codecFailure')
        expect(row.values).toEqual(expected.values)
        expect(row.key).toEqual(expected.key)
        expect(row.encodedKey).toBe(expected.encodedKey)
        expect(row.canonical).toEqual(expected.canonical)
        expect(row.raw).toBeDefined()
      }
    })

  test('several rejected rows are each marked', async () => {
    const memory = memorySource({
      [TABLE]: [undecodable('a'), event('b'), undecodable('c'), event('d', { reason: null })],
    })
    const rows = await readSourceTable({
      source: memory.source,
      preflight: memory.preflight,
      table: TABLE,
      limit: 3,
    })
    expect(ids(rows.filter((row) => row.codecFailure)).sort()).toEqual(['a', 'c'])
    expect(ids(rows.filter((row) => !row.codecFailure)).sort()).toEqual(['b', 'd'])
  })

  test('the phase asked for is the phase of the rows; an empty table reads as no rows', async () => {
    const memory = memorySource({ [TABLE]: sound.slice(0, 2), maintenance_state: [] })
    const rows = await readSourceTable({
      source: memory.source,
      preflight: memory.preflight,
      table: TABLE,
      phase: 'pre-upgrade',
    })
    expect(rows.map((row) => row.phase)).toEqual(['pre-upgrade', 'pre-upgrade'])
    expect(
      (await readSourceTable({ source: memory.source, preflight: memory.preflight, table: TABLE }))
        .map((row) => row.phase)
        .sort(),
    ).toEqual(['current', 'current'])
    expect(
      await readSourceTable({
        source: memory.source,
        preflight: memory.preflight,
        table: 'maintenance_state',
      }),
    ).toEqual([])
  })

  test('a failure that is not about decoding a row is not papered over', async () => {
    const memory = memorySource({ [TABLE]: sound })
    const failing: VersionedSourceReader = {
      ...memory.source,
      async readChunk() {
        throw new Error('connection lost')
      },
    }
    await expect(
      readSourceTable({ source: failing, preflight: memory.preflight, table: TABLE }),
    ).rejects.toThrow('connection lost')
    expect(memory.reads.raw).toEqual([])
  })
})

describe('RFC-626 bootSourceRows: the reader of boot-upgrade facts', () => {
  const stored = [event('a'), undecodable('b'), event('c')]

  test('with automatic resolution a row that cannot be decoded is left out', async () => {
    const rows = await bootSourceRows(handle(memorySource({ [TABLE]: stored })), TABLE, {
      resolution: 'automatic',
    })
    expect(byId(rows)).toEqual([stored[0]!, stored[2]!])
  })

  test('without it, and with `operator`, the read is strict and fails on that row', async () => {
    for (const options of [undefined, {}, { resolution: 'operator' }] as const) {
      const source = handle(memorySource({ [TABLE]: stored }))
      const read =
        options === undefined
          ? bootSourceRows(source, TABLE)
          : bootSourceRows(source, TABLE, options)
      await expect(read).rejects.toThrow('logical database codec')
    }
  })

  test('when every row decodes all three give the same rows', async () => {
    const read = (options?: { readonly resolution?: 'operator' | 'automatic' }) =>
      bootSourceRows(handle(memorySource({ [TABLE]: sound })), TABLE, options)
    const strict = await read()
    expect(byId(strict)).toEqual(sound)
    expect(byId(await read({ resolution: 'operator' }))).toEqual(byId(strict))
    expect(byId(await read({ resolution: 'automatic' }))).toEqual(byId(strict))
  })

  test('a table the source admittedly does not have reads as no rows; any other missing table is an error', async () => {
    for (const options of [{}, { resolution: 'operator' }, { resolution: 'automatic' }] as const) {
      const memory = memorySource({ [TABLE]: sound }, { expectedAbsent: ['skill_operations'] })
      expect(await bootSourceRows(handle(memory), 'skill_operations', options)).toEqual([])
      // Not a read at all: nothing was asked of the source.
      expect(memory.reads).toEqual({ strict: [], raw: [] })
      await expect(bootSourceRows(handle(memory), 'runtimes', options)).rejects.toThrow(
        'v2-boot-source-table-unavailable:runtimes',
      )
    }
  })
})
