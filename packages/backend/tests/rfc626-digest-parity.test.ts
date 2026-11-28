// RFC-626 §4.3 "约束与验收口径" (design/RFC-626-upgrade-no-refusal-minimal-time/design.md):
// the conversion engine's bookkeeping was made cheaper — every element of a unit output is
// serialised once and the same text orders it and feeds its digest; table receipts read a
// digest column of the scratch store instead of decoding every staged row; a sink trusts the
// digest of an output this process has just collected. None of that may change a digest:
// "对同一份绑定与同一份输出，新旧实现算出的值逐字节相同".
//
// The definitions as they were before the change are written out below (from
// conversion/digest.ts, staging.ts `encodeStagedValue`, receipts.ts `finish` and the table
// receipt loop of engine.ts at the commit before RFC-626) and compared with what the engine
// produces for generated rows: keys that share prefixes, keys and values from the
// supplementary planes, big integers, byte strings, negative zero. The staging digest is
// deliberately not compared — its definition changed on purpose (rfc626-staging-store).
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { column as c, defineContribution, retention } from '@/platform/persistence/schema/dsl'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { lookupKey, type LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { readSourceTable } from '@/platform/persistence/migration/conversion/readSource'
import {
  createUnitCollector,
  isCollectedUnitOutput,
} from '@/platform/persistence/migration/conversion/receipts'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import { targetTopology } from '@/platform/persistence/migration/conversion/topology'
import type { DecodedSourceRow, RawSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type {
  MigrationRecord,
  SourceRow,
  TargetRow,
  TargetValue,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import { assertMigrationUnitDigest } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import {
  RecordingSink,
  engineInput,
  frozenRow,
  memorySource,
  scratchRoots,
} from './rfc626-engine-fixtures.test'

const scratch = scratchRoots()

// ---- the definitions before RFC-626; do not "simplify" them into the new code -------------

function referenceCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(referenceCanonicalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, referenceCanonicalize(entry)]),
    )
  return value
}
const referenceJson = (value: unknown): string =>
  `${JSON.stringify(referenceCanonicalize(value), null, 2)}\n`
const referenceBytesDigest = (bytes: string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const referenceValueDigest = (value: unknown): string => referenceBytesDigest(referenceJson(value))
/** Sorted, length-framed multiset. */
function referenceOrderedDigest(values: readonly string[]): string {
  const hash = createHash('sha256')
  for (const value of values) {
    hash.update(`${Buffer.byteLength(value)}:`)
    hash.update(value)
  }
  return `sha256:${hash.digest('hex')}`
}
const referenceUnorderedDigest = (values: readonly string[]): string =>
  referenceOrderedDigest([...values].sort())
function referenceCanonicalValue(value: TargetValue): unknown {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'text', value }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) }
  if (value instanceof Uint8Array)
    return { type: 'bytes', value: Buffer.from(value).toString('base64') }
  if (Object.is(value, -0)) return { type: 'real', value: '-0' }
  return Number.isSafeInteger(value)
    ? { type: 'integer', value: String(value) }
    : { type: 'real', value: String(value) }
}
const referenceTargetRowJson = (row: TargetRow): string =>
  referenceJson(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, referenceCanonicalValue(value)]),
    ),
  )
const referenceTargetRowsDigest = (rows: readonly TargetRow[]): string =>
  referenceUnorderedDigest(rows.map(referenceTargetRowJson))
function referenceEncodeStaged(value: unknown): string {
  const encode = (node: unknown): unknown => {
    if (typeof node === 'bigint') return ['bigint', String(node)]
    if (
      node === null ||
      typeof node === 'string' ||
      typeof node === 'boolean' ||
      typeof node === 'number' ||
      node instanceof Uint8Array
    )
      return ['scalar', referenceCanonicalValue(node)]
    if (Array.isArray(node)) return ['array', node.map(encode)]
    return [
      'object',
      Object.entries(node as Record<string, unknown>)
        .filter(([, cell]) => cell !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, cell]) => [key, encode(cell)]),
    ]
  }
  return referenceJson(encode(value))
}
/** `[...values].sort(by encodeStagedValue)`, as receipts.ts ordered every list of an output. */
function referenceOrdered<T>(values: readonly T[]): T[] {
  return [...values].sort((a, b) =>
    referenceEncodeStaged(a) < referenceEncodeStaged(b)
      ? -1
      : referenceEncodeStaged(a) > referenceEncodeStaged(b)
        ? 1
        : 0,
  )
}
const referenceSourceText = (row: SourceRow): string =>
  referenceJson({ canonical: row.canonical, raw: row.raw ?? null })
function referenceReceiptDigest(output: UnitOutput): string {
  const { digest: _digest, ...receipt } = output.receipt
  const { receipt: _receipt, ...payload } = output
  return referenceValueDigest({ receipt, output: referenceEncodeStaged(payload) })
}
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

// ---- generated rows ------------------------------------------------------------------------

/** mulberry32: small, seeded, and the same sequence on every run. */
function generator(seed: number) {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  const int = (bound: number): number => Math.floor(next() * bound)
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!
  // ASCII, Latin-1, CJK, a private-use code point and three supplementary-plane ones: byte
  // order and UTF-16 order disagree between the last two groups.
  const symbols = [
    'a',
    'b',
    '0',
    '1',
    '10',
    'é',
    '中',
    '\u{e000}',
    '\u{ffff}',
    '😀',
    '\u{10000}',
    '𝒳',
  ]
  const noise = [...symbols, '"', '\\', '\n', ' ', '/', ':', '{', ']']
  const text = (alphabet: readonly string[] = noise): string =>
    Array.from({ length: int(6) }, () => pick(alphabet)).join('')
  const used = new Set<string>()
  /** Distinct keys that share the prefix `k`, many of them prefixes of one another. */
  const key = (): string => {
    for (;;) {
      const candidate = `k${text(symbols)}`
      if (!used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }
  }
  const big = (): bigint => {
    const magnitude = BigInt(int(2 ** 31)) * BigInt(int(2 ** 31)) + BigInt(int(2 ** 20))
    return next() < 0.5 ? -magnitude : magnitude
  }
  const bytes = (): Uint8Array => Uint8Array.from({ length: int(6) }, () => int(256))
  const real = (): number => pick([-0, 0, 1.5, -2.25, 1e21, 5e-324, (next() - 0.5) * 1e6])
  const scalar = (): TargetValue =>
    pick<() => TargetValue>([
      () => text(),
      () => big(),
      () => bytes(),
      () => null,
      () => int(1_000_000) - 500_000,
      () => real(),
      () => next() < 0.5,
    ])()
  return { next, int, pick, text, key, big, bytes, real, scalar }
}

const owner = defineContribution('rfc626-parity')
const labels = owner.table({
  id: 'p_labels',
  schemaSymbol: 'pLabels',
  retention: retention.business,
  columns: { id: c.id('id', { primary: true }), label: c.text('label') },
})
const things = owner.table({
  id: 'p_things',
  schemaSymbol: 'pThings',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    big: c.bigint('big'),
    payload: c.bytes('payload', { nullable: true }),
    ratio: c.real('ratio', { nullable: true }),
    flag: c.bool('flag'),
    note: c.text('note', { nullable: true }),
  },
})
const parityTarget = createSchemaRegistry([owner.contribution([labels, things])], {
  schemaEpoch: 2,
})

describe('RFC-626 unit receipts keep the digests of the old definitions', () => {
  const rule: ConversionRule = {
    ref: { id: 'fixture/parity', version: 3 },
    owner: 'fixture',
    claims: ['fixture'],
    produces: [{ table: 'p_things' }, { table: 'p_labels' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'fixture' },
    convert() {},
  }
  for (const seed of [1, 7, 626, 20261127, 4294967295])
    test(`generated unit, seed ${seed}`, () => {
      const random = generator(seed)
      for (let round = 0; round < 12; round++) {
        const sources = Array.from({ length: 1 + random.int(12) }, (): SourceRow => {
          const id = random.key()
          const key = [canonicalValue(id)]
          const cells = Array.from({ length: random.int(5) }, () => canonicalValue(random.scalar()))
          const row: SourceRow = {
            table: 'fixture',
            phase: 'current',
            key,
            encodedKey: encodeMigrationKey('fixture', key),
            canonical: { key, values: [canonicalValue(id), ...cells] },
            values: { id },
          }
          if (random.next() < 0.5) return row
          const raw: RawSourceRow = {
            key: [{ type: 'integer', value: String(random.int(100_000)) }],
            cells: {
              [`cell-${random.text()}`]: {
                storageClass: random.pick(['text', 'integer', 'blob', 'null', 'real']),
                value: canonicalValue(random.scalar()),
              },
            },
          }
          return { ...row, raw }
        })
        const emitted = new Map<string, TargetRow[]>([
          ['p_labels', []],
          ['p_things', []],
        ])
        const records: MigrationRecord[] = []
        const collector = createUnitCollector({
          rule,
          sourceRows: sources,
          sourceVersion: 'fixture/v1',
          sourceContract: 'fixture-contract',
          target: targetRegistryView(parityTarget),
          topology: targetTopology(parityTarget).order,
        })
        const emit = (table: string, values: TargetRow, origin: SourceRow | null): void => {
          collector.out.row(table, values, origin)
          emitted.get(table)!.push(values)
        }
        for (const source of sources) {
          const count = random.int(3)
          for (let index = 0; index < count; index++)
            emit(
              'p_things',
              {
                id: `${String(source.values.id)}#${index}`,
                big: random.big(),
                payload: random.next() < 0.3 ? null : random.bytes(),
                ratio: random.next() < 0.3 ? null : random.real(),
                flag: random.next() < 0.5,
                note: random.next() < 0.3 ? null : random.text(),
              },
              source,
            )
          if (random.next() < 0.4)
            emit(
              'p_labels',
              { id: `${String(source.values.id)}#label`, label: random.text() },
              source,
            )
          if (count === 0 || random.next() < 0.3) {
            const record: MigrationRecord = {
              kind: 'decision',
              code: `fixture-${random.text(['a', 'b', '1'])}`,
              payload: { note: random.text(), n: random.int(10), nested: [random.text(), null] },
            }
            collector.out.record(record, source)
            records.push(record)
          }
        }
        if (random.next() < 0.5)
          emit('p_labels', { id: `detached#${round}`, label: random.text() }, null)

        const unitId = `unit-${seed}-${round}`
        const output = collector.finish({
          unit: {
            kind: 'source-chunk',
            table: 'fixture',
            phase: 'current',
            afterKey: null,
            limit: 12,
          },
          unitId,
          lookups: [],
        })
        const context = `seed ${seed}, round ${round}`
        const source = output.receipt.sources[0]!
        expect(source.digest, context).toBe(
          referenceUnorderedDigest(sources.map(referenceSourceText)),
        )
        expect(source.keyDigest, context).toBe(
          referenceUnorderedDigest(sources.map((row) => row.encodedKey)),
        )
        const keys = sources.map((row) => row.encodedKey).sort(byBytes)
        expect([source.firstKey, source.lastKey], context).toEqual([keys[0]!, keys.at(-1)!])
        const expectedTargets = ['p_labels', 'p_things']
          .map((table) => ({ table, rows: emitted.get(table)! }))
          .filter((entry) => entry.rows.length > 0)
        expect(output.receipt.targets, context).toEqual(
          expectedTargets.map((entry) => ({
            table: entry.table,
            rows: entry.rows.length,
            digest: referenceTargetRowsDigest(entry.rows),
          })),
        )
        // Rows of a table are ordered by their own serialisation, lists by `encodeStagedValue`.
        expect(
          output.rows.map((group) => [group.table, group.rows.map(referenceTargetRowJson)]),
          context,
        ).toEqual(
          expectedTargets.map((entry) => [
            entry.table,
            entry.rows.map(referenceTargetRowJson).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          ]),
        )
        expect(output.records.map(referenceEncodeStaged), context).toEqual(
          referenceOrdered(records).map(referenceEncodeStaged),
        )
        expect(output.receipt.digest, context).toBe(referenceReceiptDigest(output))
      }
    })
})

describe('RFC-626 table receipts, unit sources and lookups through the engine keep them too', () => {
  const state = owner.table({
    id: 'p_state',
    schemaSymbol: 'pState',
    retention: retention.operational,
    columns: {
      key: c.id('key', { primary: true }),
      value: c.text('value'),
      updatedAt: c.epochMs('updated_at'),
    },
  })
  const target = createSchemaRegistry([owner.contribution([state])], { schemaEpoch: 2 })
  const facts = lookupKey<DecodedSourceRow>('fixture/parity-rows', 1)
  const lookupValue = (row: SourceRow): DecodedSourceRow => ({
    text: String(row.values[row.table === 'maintenance_state' ? 'value' : 'actor']),
    big: 9007199254740993n,
    bytes: new Uint8Array([0, 255, String(row.encodedKey).length % 256]),
    nothing: null,
  })
  const keyColumn = (table: string): string => (table === 'maintenance_state' ? 'key' : 'id')
  function contribution(table: string) {
    const builder: LookupBuilder<DecodedSourceRow> = {
      key: facts,
      sources: [table],
      build(staged, put) {
        for (const row of staged.rows(table))
          put(String(row.values[keyColumn(table)]), lookupValue(row))
      },
    }
    const rule: ConversionRule = {
      ref: { id: 'fixture/parity-copy', version: 1 },
      owner: 'fixture',
      claims: [table],
      produces: [{ table: 'p_state' }],
      lookups: [facts],
      unit: { kind: 'source-chunk', table },
      convert(unit, ctx) {
        for (const row of unit.rows.get(table)!) {
          if (row.values.kind === 'refuse') {
            ctx.out.block(rowBlock('fixture-refused', row, null))
            continue
          }
          ctx.out.row('p_state', targetOf(table, row), row)
        }
      },
    }
    return { rules: [rule], lookups: [builder], validators: [] }
  }
  function targetOf(table: string, row: SourceRow): TargetRow {
    return table === 'maintenance_state'
      ? { key: row.values.key!, value: row.values.value!, updated_at: row.values.updated_at! }
      : { key: row.values.id!, value: String(row.values.actor), updated_at: 1 }
  }
  async function compare(table: string, rows: readonly DecodedSourceRow[]): Promise<void> {
    const memory = memorySource({ [table]: rows })
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(memory, [contribution(table)], {
        scratchRoot: scratch(),
        target,
        chunkLimit: 4,
      }),
      sink,
    )
    // The staged rows, read the way the conversion read them.
    const staged = await readSourceTable({
      source: memory.source,
      preflight: memory.preflight,
      table,
    })
    expect(staged).toHaveLength(rows.length)
    const receipt = summary.tableReceipts.find((entry) => entry.sourceTable === table)!
    expect(receipt.rowsRead).toBe(rows.length)
    expect(receipt.keyDigest).toBe(referenceUnorderedDigest(staged.map((row) => row.encodedKey)))
    expect(receipt.contentDigest).toBe(
      referenceUnorderedDigest(staged.map((row) => referenceBytesDigest(referenceSourceText(row)))),
    )
    const lookupDigest = referenceUnorderedDigest(
      staged.map((row) =>
        referenceBytesDigest(
          referenceEncodeStaged([
            String(row.values[keyColumn(table)]),
            { value: lookupValue(row) },
          ]),
        ),
      ),
    )
    expect(sink.units.size).toBe(Math.ceil(rows.length / 4))
    let seen = 0
    for (const unit of sink.units.values()) {
      const source = unit.receipt.sources[0]!
      const members = staged.filter(
        (row) =>
          byBytes(row.encodedKey, source.firstKey!) >= 0 &&
          byBytes(row.encodedKey, source.lastKey!) <= 0,
      )
      seen += members.length
      expect(source.rows).toBe(members.length)
      expect(source.digest).toBe(referenceUnorderedDigest(members.map(referenceSourceText)))
      expect(source.keyDigest).toBe(referenceUnorderedDigest(members.map((row) => row.encodedKey)))
      expect(unit.receipt.lookups).toEqual([{ id: facts.id, version: 1, digest: lookupDigest }])
      const converted = members.filter((row) => row.values.kind !== 'refuse' && !row.codecFailure)
      expect(unit.receipt.targets).toEqual(
        converted.length
          ? [
              {
                table: 'p_state',
                rows: converted.length,
                digest: referenceTargetRowsDigest(converted.map((row) => targetOf(table, row))),
              },
            ]
          : [],
      )
      expect(unit.receipt.digest).toBe(referenceReceiptDigest(unit))
      expect(unit.blocks).toEqual(referenceOrdered(unit.blocks))
      expect(unit.dispositions).toEqual(referenceOrdered(unit.dispositions))
    }
    expect(seen).toBe(rows.length)
  }

  test('rows read strictly: keys from every plane, text that needs escaping', async () => {
    const random = generator(31)
    await compare(
      'maintenance_state',
      Array.from({ length: 27 }, (_, index) =>
        frozenRow('maintenance_state', {
          key: random.key(),
          value: random.text(),
          updated_at: index % 5 === 0 ? 9007199254740991 : random.int(1_000_000),
        }),
      ),
    )
  })

  test('rows read through the raw channel: the raw cells are part of the evidence', async () => {
    const random = generator(97)
    const rows = Array.from({ length: 18 }, (_, index) =>
      frozenRow('recovery_events', {
        id: random.key(),
        actor: random.text(),
        kind: index % 6 === 2 ? 'refuse' : 'plain',
        reason: index % 4 === 0 ? null : random.text(),
        before_json: index === 9 ? '{ not json' : index % 3 === 0 ? ' { "😀": [1, -0.0] }\n' : null,
        created_at: random.int(1_000_000),
      }),
    )
    await compare('recovery_events', rows)
  })
})

describe('RFC-626 a sink trusts only what this process collected', () => {
  const output = (): UnitOutput => {
    const key = [canonicalValue('row')]
    const source: SourceRow = {
      table: 'fixture',
      phase: 'current',
      key,
      encodedKey: encodeMigrationKey('fixture', key),
      canonical: { key, values: [canonicalValue('row')] },
      values: { id: 'row' },
    }
    const collector = createUnitCollector({
      rule: {
        ref: { id: 'fixture/collected', version: 1 },
        owner: 'fixture',
        claims: ['fixture'],
        produces: [{ table: 'p_labels' }],
        lookups: [],
        unit: { kind: 'source-chunk', table: 'fixture' },
        convert() {},
      },
      sourceRows: [source],
      sourceVersion: 'fixture/v1',
      sourceContract: 'fixture-contract',
      target: targetRegistryView(parityTarget),
      topology: targetTopology(parityTarget).order,
    })
    collector.out.row('p_labels', { id: 'row', label: 'collected' }, source)
    return collector.finish({
      unit: { kind: 'source-chunk', table: 'fixture', phase: 'current', afterKey: null, limit: 1 },
      unitId: 'unit',
      lookups: [],
    })
  }

  test('a collected output is recognised by identity, and its digest is the one a sink would compute', () => {
    const collected = output()
    expect(isCollectedUnitOutput(collected)).toBe(true)
    expect(() => assertMigrationUnitDigest(collected)).not.toThrow()
    // Equal content from anywhere else is not "collected".
    expect(isCollectedUnitOutput({ ...collected })).toBe(false)
    expect(isCollectedUnitOutput(structuredClone(collected))).toBe(false)
    expect(isCollectedUnitOutput(output())).toBe(true)
  })

  test('an output from elsewhere is verified, and a changed one is refused', () => {
    const copy = structuredClone(output())
    expect(() => assertMigrationUnitDigest(copy)).not.toThrow()
    const tampered: UnitOutput = {
      ...copy,
      rows: [{ table: 'p_labels', rows: [{ id: 'row', label: 'tampered' }] }],
    }
    expect(isCollectedUnitOutput(tampered)).toBe(false)
    expect(() => assertMigrationUnitDigest(tampered)).toThrow('v3-sink-invalid-unit-digest')
    const moreRecords: UnitOutput = {
      ...copy,
      records: [{ kind: 'decision', code: 'added-later', payload: null }],
    }
    expect(() => assertMigrationUnitDigest(moreRecords)).toThrow('v3-sink-invalid-unit-digest')
  })

  test('the target sink skips the second serialisation only for collected outputs (source)', () => {
    const sink = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/system-operations/infrastructure/epochSwitch/conversionSink.ts',
      ),
      'utf8',
    )
    expect(sink).toMatch(
      /if\s*\(\s*!isCollectedUnitOutput\(output\)\s*\)\s*assertMigrationUnitDigest\(output\)/,
    )
    // The only call: no path commits an uncollected output unverified.
    expect(sink.match(/assertMigrationUnitDigest\(/g)).toHaveLength(2)
  })
})
