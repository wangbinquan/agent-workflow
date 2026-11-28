// RFC-626 §4.3 and §4.7 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md): what the
// conversion's scratch store became. Staged rows are stored in a compact form that only has
// to give the same row back; the evidence digest of a row is computed once when it is staged
// and kept beside it, so table receipts and the staging digest scan two columns instead of
// decoding every row again; rows of a task the upgrade ends are rewritten in place (decoded
// values and a note, never the evidence); and the distinct target rows a source table links
// to are counted in the store rather than held in memory. This file locks each of those: the
// round trip of every value a decoded row can carry, what the digests are computed from, and
// what a rewrite may and may not change.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import {
  createStagingStore,
  packStagedRow,
  stagedRowDigest,
  unpackStagedRow,
  type StagingStore,
} from '@/platform/persistence/migration/conversion/staging'
import type { DecodedSourceRow, RawSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type {
  SettlementRewrite,
  SourcePhase,
  SourceRow,
} from '@/platform/persistence/migration/conversion/types'

const roots: string[] = []
const stores: StagingStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function open(): StagingStore {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc626-staging-'))
  roots.push(root)
  const store = createStagingStore(root)
  stores.push(store)
  return store
}
function row(
  table: string,
  id: string,
  values: DecodedSourceRow = {},
  extra: Partial<SourceRow> = {},
): SourceRow {
  const key = [canonicalValue(id)]
  return {
    table,
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey(table, key),
    canonical: { key, values: [canonicalValue(id), canonicalValue(JSON.stringify(values))] },
    values: { id, ...values },
    ...extra,
  }
}
function rawOf(id: string): RawSourceRow {
  return {
    key: [{ type: 'integer', value: '1' }],
    cells: { id: { storageClass: 'text', value: canonicalValue(id) } },
  }
}
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`
const keyOf = (table: string, id: string) => encodeMigrationKey(table, [canonicalValue(id)])
const idsOf = (rows: Iterable<SourceRow>): string[] =>
  [...rows].map((entry) => String(entry.values.id))
const note = (taskId: string, before: string, after: string): SettlementRewrite => ({
  taskId,
  cause: 'unprovable-records',
  columns: { status: { before: canonicalValue(before), after: canonicalValue(after) } },
})

describe('RFC-626 compact storage of staged rows', () => {
  const full: SourceRow = {
    table: 'runs',
    phase: 'pre-upgrade',
    key: [canonicalValue('k😀'), canonicalValue(7)],
    encodedKey: encodeMigrationKey('runs', [canonicalValue('k😀'), canonicalValue(7)]),
    canonical: {
      key: [canonicalValue('k😀'), canonicalValue(7)],
      values: [
        canonicalValue(9007199254740993n),
        canonicalValue(new Uint8Array([0, 255, 128])),
        canonicalValue(null),
        canonicalValue(-0),
        canonicalValue('\u{10000}'),
      ],
    },
    values: {
      text: 'plain',
      empty: '',
      supplementary: 'a😀b\u{10000}c\u{e000}',
      '键😀\u{10000}': 'a key from a supplementary plane',
      big: 9223372036854775807n,
      negativeBig: -9223372036854775808n,
      smallBig: 0n,
      bytes: new Uint8Array([0, 255, 128, 1]),
      noBytes: new Uint8Array(),
      negativeZero: -0,
      zero: 0,
      notANumber: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      negativeInfinite: Number.NEGATIVE_INFINITY,
      real: 1.5,
      largeInteger: 9007199254740991,
      nothing: null,
      yes: true,
      no: false,
      nestedJson: '{ "z": [1, {"y": null, "x": ["😀", -0.0, 1e21]}], "a": {} }\n',
      // Text that looks like the tags of the storage form stays text.
      taggedLookalike: '["b","1"]',
      arrayLookalike: '["x","AP+A"]',
    },
    raw: {
      key: [{ type: 'integer', value: '42' }],
      cells: {
        text: { storageClass: 'text', value: canonicalValue('plain') },
        bytes: { storageClass: 'blob', value: canonicalValue(new Uint8Array([0, 255])) },
        '键😀': { storageClass: 'null', value: canonicalValue(null) },
      },
    },
    codecFailure: { message: 'Frozen source codec rejected big, 键😀', columns: ['big', '键😀'] },
    codecTakeovers: [
      {
        column: 'nestedJson',
        raw: { storageClass: 'text', value: canonicalValue('{ not json') },
        message: 'invalid JSON at runs.nestedJson',
      },
    ],
    settlement: note('task-😀', 'awaiting_human', 'canceled'),
  }

  test('every value a decoded row can carry comes back as it went in', () => {
    const back = unpackStagedRow(packStagedRow(full))
    expect(back).toEqual(full)
    expect(Object.keys(back.values)).toEqual(Object.keys(full.values))
    expect(back.values.big).toBe(9223372036854775807n)
    expect(back.values.negativeBig).toBe(-9223372036854775808n)
    expect(back.values.smallBig).toBe(0n)
    expect(back.values.bytes).toBeInstanceOf(Uint8Array)
    expect([...(back.values.bytes as Uint8Array)]).toEqual([0, 255, 128, 1])
    expect((back.values.noBytes as Uint8Array).byteLength).toBe(0)
    expect(Object.is(back.values.negativeZero, -0)).toBe(true)
    expect(Object.is(back.values.zero, 0)).toBe(true)
    expect(Number.isNaN(back.values.notANumber)).toBe(true)
    expect(back.values.infinite).toBe(Number.POSITIVE_INFINITY)
    expect(back.values.negativeInfinite).toBe(Number.NEGATIVE_INFINITY)
    expect(back.values.nothing).toBeNull()
    expect(back.values.nestedJson).toBe(full.values.nestedJson!)
    expect(back.values.taggedLookalike).toBe('["b","1"]')
    expect(back.values.arrayLookalike).toBe('["x","AP+A"]')
    expect(back.values['键😀\u{10000}']).toBe('a key from a supplementary plane')
    // A second trip changes nothing: the storage form is stable.
    expect(packStagedRow(back)).toBe(packStagedRow(full))
  })

  test('a row without the optional parts keeps them absent', () => {
    const plain = row('runs', 'plain', { status: 'done' })
    const back = unpackStagedRow(packStagedRow(plain))
    expect(back).toEqual(plain)
    for (const part of ['raw', 'codecFailure', 'codecTakeovers', 'settlement'])
      expect(back).not.toHaveProperty(part)
  })

  test('the store hands back what was staged, by key, by scan and by group', () => {
    const staged = open()
    const plain = row('runs', 'plain', { status: 'done', task_id: 'task-1' })
    const second = { ...full, table: 'runs', phase: 'current' as const }
    staged.putMany([second, plain])
    expect(staged.get('runs', full.encodedKey)).toEqual(second)
    expect(staged.get('runs', plain.encodedKey)).toEqual(plain)
    expect(staged.get('runs', full.encodedKey, 'pre-upgrade')).toBeUndefined()
    expect([...staged.rows('runs')]).toHaveLength(2)
    expect(staged.read('runs', { limit: 1 })).toHaveLength(1)
    expect(staged.group('runs', 'task_id', 'task-1')).toEqual([plain])
    expect(staged.group('runs', 'big', 9223372036854775807n)).toEqual([second])
    expect(staged.count('runs')).toBe(2)
  })
})

describe('RFC-626 the evidence digest of a staged row', () => {
  test('it is the digest of the canonical form of { canonical, raw }, with null for no raw cells', () => {
    const withoutRaw = row('runs', 'a', { status: 'running' })
    const withRaw = row('runs', 'b', { status: 'running' }, { raw: rawOf('b') })
    expect(stagedRowDigest(withoutRaw)).toBe(
      sha256(canonicalSchemaJson({ canonical: withoutRaw.canonical, raw: null })),
    )
    expect(stagedRowDigest(withRaw)).toBe(
      sha256(canonicalSchemaJson({ canonical: withRaw.canonical, raw: withRaw.raw })),
    )
    // Nothing else of the row takes part.
    const rewritten: SourceRow = {
      ...withRaw,
      values: { id: 'b', status: 'canceled' },
      settlement: note('t', 'running', 'canceled'),
      codecFailure: { message: 'm', columns: ['status'] },
    }
    expect(stagedRowDigest(rewritten)).toBe(stagedRowDigest(withRaw))
    expect(stagedRowDigest({ ...withRaw, raw: rawOf('other') })).not.toBe(stagedRowDigest(withRaw))
  })

  test('the store keeps it per row: digests come back sorted, keys in byte order, without decoding rows', () => {
    const staged = open()
    // Byte order and UTF-16 order disagree on these: U+E000 sorts before U+10000 in bytes only.
    const ids = ['\u{10000}', 'a', '\u{e000}', 'ab', 'a\u{10000}']
    const rows = ids.map((id, index) =>
      row('runs', id, { n: index }, index % 2 ? { raw: rawOf(id) } : {}),
    )
    staged.putMany(rows)
    staged.put(row('other', 'x'))
    expect([...staged.rowDigests('runs')]).toEqual(rows.map(stagedRowDigest).sort())
    const byBytes = [...rows]
      .map((entry) => entry.encodedKey)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    expect([...staged.keys('runs')]).toEqual(byBytes)
    expect(byBytes).not.toEqual([...byBytes].sort())
    expect([...staged.keys('runs', 'pre-upgrade')]).toEqual([])
    expect([...staged.rowDigests('missing')]).toEqual([])
  })
})

describe('RFC-626 the staging digest', () => {
  const rows = (): SourceRow[] => [
    row('runs', 'a', { status: 'running' }),
    row('runs', 'b', { status: 'done' }, { raw: rawOf('b') }),
    row('tasks', 'a', { status: 'running' }),
    { ...row('tasks', 'b'), phase: 'pre-upgrade' },
  ]
  const digestOf = (staged: readonly SourceRow[]): string => {
    const store = open()
    store.putMany(staged)
    return store.digest()
  }

  test('it does not depend on the order rows were written in', () => {
    const forward = open()
    for (const entry of rows()) forward.put(entry)
    const backward = open()
    backward.putMany(rows().reverse())
    expect(backward.digest()).toBe(forward.digest())
    expect(open().digest()).toBe(open().digest())
    expect(forward.digest()).not.toBe(open().digest())
  })

  test('it changes with the phase, the table, the key or the evidence of any row', () => {
    const base = digestOf(rows())
    const changed = (index: number, change: (entry: SourceRow) => SourceRow): string => {
      const next = rows()
      next[index] = change(next[index]!)
      return digestOf(next)
    }
    const variants = [
      // evidence: a canonical cell
      changed(0, (entry) => ({
        ...entry,
        canonical: { ...entry.canonical, values: [canonicalValue('a'), canonicalValue('other')] },
      })),
      // evidence: the raw cells
      changed(1, (entry) => ({ ...entry, raw: rawOf('changed') })),
      changed(1, ({ raw: _raw, ...entry }) => entry),
      // the key
      changed(0, (entry) => ({ ...entry, encodedKey: keyOf('runs', 'renamed') })),
      // the table
      changed(2, (entry) => ({ ...entry, table: 'other' })),
      // the phase
      changed(3, (entry) => ({ ...entry, phase: 'current' })),
      // one row fewer
      digestOf(rows().slice(1)),
    ]
    for (const variant of variants) expect(variant).not.toBe(base)
    expect(new Set(variants).size).toBe(variants.length)
  })

  test('decoded values are not evidence: a rewrite leaves it as it was', () => {
    const staged = open()
    staged.putMany(rows())
    const before = staged.digest()
    const target = staged.get('tasks', keyOf('tasks', 'a'))!
    staged.rewrite([
      {
        table: 'tasks',
        phase: 'current',
        key: target.encodedKey,
        values: { ...target.values, status: 'canceled' },
        settlement: note('a', 'running', 'canceled'),
      },
    ])
    expect(staged.digest()).toBe(before)
    expect(digestOf(rows().map((entry) => ({ ...entry, values: { id: 'different' } })))).toBe(
      before,
    )
  })
})

describe('RFC-626 rewriting staged rows of a task the upgrade ends', () => {
  const seed = (staged: StagingStore): void => {
    staged.putMany([
      row('tasks', 'a', { status: 'running', owner: 'x' }, { raw: rawOf('a') }),
      row('tasks', 'b', { status: 'running', owner: 'y' }),
      row('tasks', 'c', { status: 'done', owner: 'x' }),
    ])
  }
  const cancel = (staged: StagingStore, id: string, phase: SourcePhase = 'current') => {
    const stored = staged.get('tasks', keyOf('tasks', id), phase)!
    return {
      table: 'tasks',
      phase,
      key: stored.encodedKey,
      values: { ...stored.values, status: 'canceled', finished_at: 99 },
      settlement: note(id, String(stored.values.status), 'canceled'),
    }
  }

  test('only the decoded values change, and the row carries a note of what was rewritten', () => {
    const staged = open()
    seed(staged)
    const before = staged.get('tasks', keyOf('tasks', 'a'))!
    const digests = [...staged.rowDigests('tasks')]
    const keys = [...staged.keys('tasks')]
    staged.rewrite([cancel(staged, 'a')])
    const after = staged.get('tasks', keyOf('tasks', 'a'))!
    expect(after.values).toEqual({ ...before.values, status: 'canceled', finished_at: 99 })
    expect(after.settlement).toEqual(note('a', 'running', 'canceled'))
    expect(after.canonical).toEqual(before.canonical)
    expect(after.raw).toEqual(before.raw!)
    expect(after.key).toEqual(before.key)
    expect(after.encodedKey).toBe(before.encodedKey)
    expect([...staged.rowDigests('tasks')]).toEqual(digests)
    expect([...staged.keys('tasks')]).toEqual(keys)
    expect(staged.count('tasks')).toBe(3)
    // Every way of reading the row gives the rewritten one.
    expect([...staged.rows('tasks')].find((entry) => entry.values.id === 'a')).toEqual(after)
    expect(staged.read('tasks', { limit: 1 })).toEqual([after])
    // The other rows are untouched.
    expect(staged.get('tasks', keyOf('tasks', 'b'))!.settlement).toBeUndefined()
    expect(staged.get('tasks', keyOf('tasks', 'b'))!.values.status).toBe('running')
  })

  test('group lookups follow the rewritten values, whether the column was grouped before or after', () => {
    const staged = open()
    seed(staged)
    expect(idsOf(staged.group('tasks', 'status', 'running'))).toEqual(['a', 'b'])
    staged.rewrite([cancel(staged, 'a')])
    expect(idsOf(staged.group('tasks', 'status', 'running'))).toEqual(['b'])
    expect(idsOf(staged.group('tasks', 'status', 'canceled'))).toEqual(['a'])
    expect(staged.groupKeys('tasks', 'status')).toEqual(['canceled', 'done', 'running'])
    // First grouped after the rewrite: a column the rewrite added, and one it left alone.
    expect(idsOf(staged.group('tasks', 'finished_at', 99))).toEqual(['a'])
    expect(idsOf(staged.group('tasks', 'owner', 'x'))).toEqual(['a', 'c'])
  })

  test('the tables with rewritten rows are listed once each, by phase and table', () => {
    const staged = open()
    seed(staged)
    staged.put(row('alerts', 'z', { status: 'open' }))
    staged.put({ ...row('tasks', 'a', { status: 'running' }), phase: 'pre-upgrade' })
    expect(staged.rewrittenTables()).toEqual([])
    staged.rewrite([cancel(staged, 'a'), cancel(staged, 'b')])
    expect(staged.rewrittenTables()).toEqual([['current', 'tasks']])
    const alert = staged.get('alerts', keyOf('alerts', 'z'))!
    staged.rewrite([
      cancel(staged, 'a', 'pre-upgrade'),
      {
        table: 'alerts',
        phase: 'current',
        key: alert.encodedKey,
        values: { ...alert.values, status: 'resolved' },
        settlement: note('a', 'open', 'resolved'),
      },
    ])
    expect(staged.rewrittenTables()).toEqual([
      ['current', 'alerts'],
      ['current', 'tasks'],
      ['pre-upgrade', 'tasks'],
    ])
    // The same key in the other phase is another row.
    expect(staged.get('tasks', keyOf('tasks', 'a'), 'pre-upgrade')!.values.status).toBe('canceled')
    expect(staged.get('tasks', keyOf('tasks', 'c'))!.values.status).toBe('done')
  })

  test('a row that is not staged cannot be rewritten', () => {
    const staged = open()
    seed(staged)
    expect(() =>
      staged.rewrite([
        {
          table: 'tasks',
          phase: 'current',
          key: keyOf('tasks', 'missing'),
          values: { id: 'missing' },
          settlement: note('missing', 'running', 'canceled'),
        },
      ]),
    ).toThrow()
    expect(staged.rewrittenTables()).toEqual([])
  })
})

describe('RFC-626 what the store counts and forgets', () => {
  test('distinct target rows linked from a source table are counted per target table', () => {
    const staged = open()
    staged.noteTargets('node_runs', 'current', [
      { table: 'fx_runs', key: 'run-1' },
      { table: 'fx_run_inputs', key: 'run-1/in' },
      { table: 'fx_runs', key: 'run-1' },
    ])
    staged.noteTargets('node_runs', 'current', [
      { table: 'fx_runs', key: 'run-2' },
      { table: 'fx_runs', key: 'run-1' },
    ])
    staged.noteTargets('node_runs', 'current', [])
    staged.noteTargets('node_runs', 'pre-upgrade', [{ table: 'fx_runs', key: 'run-9' }])
    staged.noteTargets('tasks', 'current', [{ table: 'fx_tasks', key: 'run-1' }])
    expect(staged.targetCounts('node_runs', 'current')).toEqual([
      { table: 'fx_run_inputs', rows: 1 },
      { table: 'fx_runs', rows: 2 },
    ])
    expect(staged.targetCounts('node_runs', 'pre-upgrade')).toEqual([{ table: 'fx_runs', rows: 1 }])
    expect(staged.targetCounts('tasks', 'current')).toEqual([{ table: 'fx_tasks', rows: 1 }])
    expect(staged.targetCounts('unknown', 'current')).toEqual([])
  })

  test('one lookup can be dropped and built again without touching the others', () => {
    const staged = open()
    staged.putLookup('facts', 'a', { status: 'running' })
    staged.putLookup('facts', 'b', { status: 'done' })
    staged.putLookup('other', 'a', 1n)
    staged.clearLookup('facts')
    expect(staged.lookup('facts', 'a')).toBeUndefined()
    expect([...staged.lookupEntries('facts')]).toEqual([])
    expect(staged.lookup<bigint>('other', 'a')).toBe(1n)
    staged.putLookup('facts', 'a', { status: 'canceled' })
    expect(staged.lookup('facts', 'a')).toEqual({ status: 'canceled' })
    staged.clearLookup('never-built')
  })
})
