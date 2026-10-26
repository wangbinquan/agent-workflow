// RFC-395 V2 fix round: frozen codec failures reach the owner and every lookup, with explicit decisions.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { LogicalDatabaseCodecError } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type {
  RawSourceRow,
  SourcePreflight,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { explainSourceRow } from '@/platform/persistence/migration/conversion/trace'
import {
  planConversion,
  type ConversionInput,
} from '@/platform/persistence/migration/conversion/plan'
import {
  columnLookup,
  idSetLookup,
  lookupKey,
  type LookupBuilder,
} from '@/platform/persistence/migration/conversion/lookups'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow, TargetValue } from '@/platform/persistence/migration/conversion/types'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { emptyV2Content } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rawTask(id: string, overrides: Readonly<Record<string, TargetValue>> = {}): RawSourceRow {
  const table = frozenEpoch1Contract.tables.find((table) => table.id === 'tasks')!
  return {
    key: [canonicalValue(id)],
    cells: Object.fromEntries(
      table.columns.map((column) => {
        const value = Object.hasOwn(overrides, column.name)
          ? overrides[column.name]!
          : column.name === 'id'
            ? id
            : column.nullable
              ? null
              : column.logicalCodec === 'boolean'
                ? true
                : ['integer', 'epoch-milliseconds', 'real'].includes(column.logicalCodec)
                  ? 1
                  : column.logicalCodec === 'json-text'
                    ? '{}'
                    : 'fixture'
        return [
          column.name,
          {
            storageClass:
              value === null ? 'null' : value instanceof Uint8Array ? 'blob' : typeof value,
            value: canonicalValue(value),
          },
        ]
      }),
    ),
  }
}
function fixtureRule(
  columns: readonly string[] = ['workgroup_config_json', 'name'],
): ConversionRule {
  return {
    ref: { id: 'fixture/takeover', version: 1 },
    owner: 'fixture',
    claims: ['tasks'],
    produces: [{ table: 'maintenance_state' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'tasks' },
    codecTakeovers: [{ table: 'tasks', columns }],
    convert(unit, ctx) {
      for (const row of unit.rows.get('tasks')!) {
        const values = { key: String(row.values.id), value: 'converted', updated_at: 1 }
        ctx.out.row('maintenance_state', values, row)
        if (row.codecTakeovers?.length)
          ctx.out.exception({
            sourceTable: row.table,
            sourceKey: row.encodedKey,
            class: 'converted',
            kind: 'conflict-resolved',
            targets: [
              { table: 'maintenance_state', key: ctx.target.key('maintenance_state', values) },
            ],
            archive: null,
            codecColumns: row.codecTakeovers.map((failure) => failure.column),
            decision: {
              code: 'fixture-use-fallback',
              detail: { rule: 'retain raw source; emit fixture fallback' },
            },
          })
      }
    },
  }
}
function fixtureInput(
  raw: readonly RawSourceRow[],
  rule = fixtureRule(),
  lookups: readonly LookupBuilder<unknown>[] = [],
): ConversionInput {
  const preflight: SourcePreflight = {
    version: 1,
    kind: 'logical-artifact',
    sourceVersion: 'fixture/frozen-codec',
    contract: frozenEpoch1Contract,
    fingerprint: {
      version: 1,
      evidence: 'legacy-logical-artifact',
      provider: 'sqlite',
      catalog: [],
      catalogDigest: 'fixture',
      journal: [],
      journalEntryCount: 0,
      tableRows: { tasks: raw.length },
      digest: 'fixture',
    },
    sourceGenerationId: 'source',
    identityHighWater: [],
    identityEvidence: 'not-recorded-by-epoch1-artifact',
    watermark: 'fixture',
    requiresOfflineUpgrade: false,
    tables: [
      {
        table: 'tasks',
        physicalTable: 'tasks',
        rows: raw.length,
        disposition: 'converted',
        destination: { kind: 'business', tables: ['tasks'] },
        reason: 'fixture',
      },
    ],
    expectedAbsent: [],
    content: [],
  }
  const source: VersionedSourceReader = {
    kind: 'logical-artifact',
    async preflight() {
      return preflight
    },
    async assertUnchanged() {},
    async close() {},
    async readChunk() {
      throw new LogicalDatabaseCodecError(
        'logical-codec-json',
        'fixture requests frozen raw decoding',
      )
    },
    async readRawChunk(table, afterKey, limit) {
      const after = afterKey
        ? raw.findIndex((row) => JSON.stringify(row.key) === JSON.stringify(afterKey)) + 1
        : 0
      const rows = raw.slice(after, after + limit)
      return {
        version: 1,
        sourceVersion: preflight.sourceVersion,
        table,
        migrationKey: ['id'],
        afterKey,
        firstKey: rows[0]?.key ?? null,
        lastKey: rows.at(-1)?.key ?? null,
        rows,
        sourceDigest: 'fixture',
      }
    },
  }
  const scratchRoot = mkdtempSync(join(tmpdir(), 'v2-takeover-'))
  roots.push(scratchRoot)
  return {
    source,
    preflight,
    target: persistenceSchema,
    contributions: [{ rules: [rule], lookups, validators: [] }],
    content: emptyV2Content,
    scratchRoot,
    planTime: 123,
    chunkLimit: 1,
    targetGeneration: 'target',
    candidateBuild: 'fixture',
    sourceBackupId: null,
    contentManifestDigest: 'fixture',
    sourceScope: ['tasks'],
  }
}

describe('RFC-395 V2 column codec takeovers', () => {
  test('invalid JSON and frozen NOT NULL failures preserve raw cells and reach the same lookup and rule', async () => {
    const seen = lookupKey<SourceRow>('fixture/seen', 1)
    const base = fixtureRule()
    const raw = [
      rawTask('bad-json', { workgroup_config_json: '{ invalid' }),
      rawTask('null-name', { name: null }),
    ]
    const lookup: LookupBuilder<SourceRow> = {
      key: seen,
      sources: ['tasks'],
      build(staged, put) {
        for (const row of staged.rows('tasks')) {
          expect(staged.group('tasks', 'id', String(row.values.id))[0]).toEqual(row)
          put(String(row.values.id), row)
        }
      },
    }
    const rows: SourceRow[] = []
    const input = fixtureInput(
      raw,
      {
        ...base,
        lookups: [seen],
        convert(unit, ctx) {
          for (const row of unit.rows.get('tasks')!) {
            expect(ctx.lookup(seen).require(String(row.values.id))).toEqual(row)
            expect(row.codecFailure).toBeUndefined()
            expect(row.values.started_at).toBe(1)
            rows.push(row)
          }
          return base.convert(unit, ctx)
        },
      },
      [lookup],
    )
    const sink = new V2MemorySink()
    const summary = await runConversion(input, sink)
    expect(summary.blocks).toEqual([])
    expect(summary.tableReceipts[0]!.counts.converted).toBe(2)
    expect(sink.rows('maintenance_state')).toHaveLength(2)
    expect(rows[0]!.codecTakeovers).toEqual([
      {
        column: 'workgroup_config_json',
        raw: raw[0]!.cells.workgroup_config_json!,
        message: expect.stringContaining('invalid JSON'),
      },
    ])
    expect(rows[1]!.codecTakeovers).toEqual([
      {
        column: 'name',
        raw: raw[1]!.cells.name!,
        message: expect.stringContaining('unexpected NULL'),
      },
    ])
    expect(
      [...sink.units.values()]
        .flatMap((unit) => unit.dispositions)
        .map((item) => item.codecColumns),
    ).toEqual([['workgroup_config_json'], ['name']])
  })
  test('raw bytes and storage class survive takeover of a value outside the frozen codec', async () => {
    const base = fixtureRule(['name'])
    const bytes = new Uint8Array([0, 255, 1])
    const input = fixtureInput([rawTask('bytes', { name: bytes })], {
      ...base,
      convert(unit, ctx) {
        const row = unit.rows.get('tasks')![0]!
        expect(row.values.name).toEqual(bytes)
        expect(row.codecTakeovers![0]!.raw).toEqual({
          storageClass: 'blob',
          value: canonicalValue(bytes),
        })
        return base.convert(unit, ctx)
      },
    })
    expect((await runConversion(input, new V2MemorySink())).status).toBe('converted')
  })
  test('undeclared failures block, even when another failed column was taken over', async () => {
    const base = fixtureRule(['workgroup_config_json'])
    const input = fixtureInput(
      [rawTask('mixed', { workgroup_config_json: '{broken', name: null })],
      {
        ...base,
        convert() {
          throw new Error('blocked row must not reach the rule')
        },
      },
    )
    const summary = await runConversion(input, new V2MemorySink())
    expect(summary.blocks).toEqual([
      expect.objectContaining({ code: 'v2-source-codec', missingFields: ['name'] }),
    ])
    expect(summary.tableReceipts[0]!.counts.blocked).toBe(1)
  })
  test('every taken-over column needs a decision; ordinary output and partial decisions cannot silently accept it', async () => {
    for (const decided of [[], ['name']]) {
      const base = fixtureRule()
      const input = fixtureInput(
        [rawTask('missing-decision', { name: null, workgroup_config_json: '{broken' })],
        {
          ...base,
          convert(unit, ctx) {
            const row = unit.rows.get('tasks')![0]!
            ctx.out.row(
              'maintenance_state',
              { key: 'missing-decision', value: 'output before decision', updated_at: 1 },
              row,
            )
            if (decided.length)
              ctx.out.exception({
                sourceTable: row.table,
                sourceKey: row.encodedKey,
                class: 'converted',
                kind: 'conflict-resolved',
                codecColumns: decided,
                targets: [],
                archive: null,
                decision: { code: 'fixture-name-fallback', detail: null },
              })
          },
        },
      )
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual([
        expect.objectContaining({
          code: 'v2-undecided-source-codec',
          missingFields: expect.arrayContaining(['workgroup_config_json']),
        }),
      ])
      expect(sink.rows('maintenance_state')).toEqual([])
      expect(summary.tableReceipts[0]!.targets).toEqual([])
      const trace = await explainSourceRow(input, 'tasks', [canonicalValue('missing-decision')])
      expect(trace.class).toBe('blocked')
      expect(trace.targets).toEqual([])
      expect(trace.dispositions.every((item) => item.targets.length === 0)).toBe(true)
    }
  })
  test('a codec decision cannot name an unrelated column or omit its documented rule', async () => {
    for (const [codecColumns, code] of [
      [['started_at'], 'fixture'],
      [['name', 'name'], 'fixture'],
      [['name'], ''],
    ] as const) {
      const input = fixtureInput([rawTask('bad-decision', { name: null })], {
        ...fixtureRule(),
        convert(unit, ctx) {
          const row = unit.rows.get('tasks')![0]!
          ctx.out.exception({
            sourceTable: row.table,
            sourceKey: row.encodedKey,
            class: 'converted',
            kind: 'conflict-resolved',
            codecColumns,
            targets: [],
            archive: null,
            decision: { code, detail: null },
          })
        },
      })
      await expect(runConversion(input, new V2MemorySink())).rejects.toThrow('v2-codec-decision')
    }
  })
  test('history-only decisions and explicit row blocks account for every failed column', async () => {
    for (const mode of ['history-only', 'block'] as const) {
      const input = fixtureInput([rawTask(mode, { name: null })], {
        ...fixtureRule(),
        convert(unit, ctx) {
          const row = unit.rows.get('tasks')![0]!
          if (mode === 'block')
            ctx.out.block(rowBlock('fixture-domain-refused', row, null, ['name']))
          else
            ctx.out.exception({
              sourceTable: row.table,
              sourceKey: row.encodedKey,
              class: 'converted',
              kind: 'history-only',
              codecColumns: ['name'],
              targets: [],
              archive: null,
              history: {
                taskId: mode,
                runId: null,
                execution: 'retryable-history',
                missingFields: ['name'],
              },
              decision: { code: 'fixture-history', detail: null },
            })
        },
      })
      const summary = await runConversion(input, new V2MemorySink())
      expect(summary.blocks.map((block) => block.code)).toEqual(
        mode === 'block' ? ['fixture-domain-refused'] : [],
      )
      expect(summary.historyOnly).toHaveLength(mode === 'history-only' ? 1 : 0)
    }
  })
  test('plan rejects duplicate, foreign, unknown and key-column takeovers and binds declarations into the digest', () => {
    const rule = fixtureRule()
    const input = fixtureInput([], rule)
    expect(() =>
      planConversion({
        ...input,
        contributions: [
          {
            rules: [rule, { ...rule, ref: { id: 'other', version: 1 } }],
            lookups: [],
            validators: [],
          },
        ],
      }),
    ).toThrow('v2-duplicate-codec-takeover')
    for (const [table, columns, code] of [
      ['other', ['name'], 'source'],
      ['tasks', ['missing'], 'column'],
      ['tasks', ['id'], 'column'],
      ['tasks', ['name', 'name'], 'duplicate'],
    ] as const) {
      const invalid = { ...rule, codecTakeovers: [{ table, columns }] }
      expect(() => planConversion(fixtureInput([], invalid))).toThrow(
        code === 'duplicate' ? 'v2-duplicate-codec-takeover' : `v2-codec-takeover-${code}`,
      )
    }
    expect(planConversion(input).digest).not.toBe(
      planConversion(fixtureInput([], fixtureRule(['name']))).digest,
    )
  })
  test('generic lookups retain present but undecodable rows, omit failed values, and bind markers into lookup digests', async () => {
    const ids = idSetLookup('tasks', 'id')
    const columns = columnLookup('tasks', ['id'], ['name', 'started_at'])
    const base = fixtureRule(['workgroup_config_json'])
    const probe = lookupKey<boolean>('fixture/probe', 1)
    const inspect: LookupBuilder<boolean> = {
      key: probe,
      sources: [],
      dependsOn: [ids.key, columns.key],
      build(_staged, put, lookup) {
        expect(lookup(ids.key).get('bad')).toBe(true)
        expect(lookup(ids.key).get('absent')).toBeUndefined()
        expect(lookup(ids.key).sourceStatus('bad')).toMatchObject({
          state: 'present-but-undecodable',
          columns: ['name'],
          takenOverColumns: [],
        })
        expect(lookup(columns.key).get('bad')).toEqual({ started_at: 1 })
        expect(lookup(columns.key).sourceStatus('bad')).toEqual(lookup(ids.key).sourceStatus('bad'))
        expect(lookup(ids.key).sourceStatus('good')).toBeUndefined()
        expect(lookup(columns.key).get('good')!.name).toBe('fixture')
        expect(lookup(ids.key).get('invalid-key')).toBeUndefined()
        put('complete', true)
      },
    }
    const invalidKey = rawTask('invalid-key')
    const input = fixtureInput(
      [
        rawTask('bad', { name: null }),
        rawTask('good'),
        {
          ...invalidKey,
          cells: { ...invalidKey.cells, id: { storageClass: 'integer', value: canonicalValue(4) } },
        },
      ],
      {
        ...base,
        lookups: [probe],
        convert(unit, ctx) {
          expect(ctx.lookup(probe).require('complete')).toBe(true)
          return base.convert(unit, ctx)
        },
      },
      [inspect, ids, columns],
    )
    const summary = await runConversion(input, new V2MemorySink())
    expect(summary.blocks.every((block) => block.code === 'v2-source-codec')).toBe(true)
    expect(summary.tableReceipts[0]!.counts).toEqual({
      converted: 1,
      preserved: 0,
      archived: 0,
      blocked: 2,
    })
  })
  test('a later target validation failure removes all outputs of that origin while retaining other origins and unit rows', async () => {
    const input = fixtureInput([rawTask('bad'), rawTask('good')], {
      ...fixtureRule(),
      convert(unit, ctx) {
        for (const row of unit.rows.get('tasks')!) {
          const values = { key: String(row.values.id), value: 'first', updated_at: 1 }
          ctx.out.row('maintenance_state', values, row)
          if (row.values.id === 'bad') {
            ctx.out.exception({
              sourceTable: row.table,
              sourceKey: row.encodedKey,
              class: 'converted',
              kind: 'conflict-resolved',
              targets: [
                { table: 'maintenance_state', key: ctx.target.key('maintenance_state', values) },
              ],
              archive: null,
              decision: { code: 'fixture-before-failure', detail: null },
            })
            ctx.out.row(
              'maintenance_state',
              { key: 'invalid', value: 'second', updated_at: 'invalid' },
              row,
            )
            ctx.out.row(
              'maintenance_state',
              { key: 'after-block', value: 'third', updated_at: 1 },
              row,
            )
            ctx.out.row(
              'maintenance_state',
              { key: 'unit-row', value: 'independent', updated_at: 1 },
              null,
            )
          }
        }
      },
    })
    const sink = new V2MemorySink()
    const summary = await runConversion(input, sink)
    expect(summary.tableReceipts[0]!.counts).toEqual({
      converted: 1,
      preserved: 0,
      archived: 0,
      blocked: 1,
    })
    expect(summary.tableReceipts[0]!.targets).toEqual([{ table: 'maintenance_state', rows: 1 }])
    expect(
      sink
        .rows('maintenance_state')
        .map((row) => row.key)
        .sort(),
    ).toEqual(['good', 'unit-row'])
    expect(
      [...sink.units.values()]
        .flatMap((unit) => unit.receipt.targets)
        .reduce((sum, target) => sum + target.rows, 0),
    ).toBe(2)
    const trace = await explainSourceRow(input, 'tasks', [canonicalValue('bad')])
    expect(trace.class).toBe('blocked')
    expect(trace.targets).toEqual([])
    expect(trace.dispositions.every((disposition) => disposition.targets.length === 0)).toBe(true)
    expect(trace.blocks).toEqual([expect.objectContaining({ code: 'v2-target-codec' })])
  })
  test('active claims are stable across chunks, separated by source phase and leave disposition counts unchanged', async () => {
    const rule: ConversionRule = {
      ...fixtureRule(),
      produces: [],
      convert(unit, ctx) {
        for (const row of unit.rows.get('tasks')!)
          ctx.out.record(
            {
              kind: 'source-metadata',
              table: row.table,
              payload: {
                kind: 'active-claim',
                sourcePhase: row.phase,
                sourceKey: row.encodedKey,
                values: {
                  id: canonicalValue(row.values.id!),
                  name: canonicalValue(row.values.name!),
                },
              },
            },
            row,
          )
      },
    }
    const input = fixtureInput([rawTask('z'), rawTask('a')], rule)
    const before = fixtureInput([rawTask('z', { name: 'before-upgrade' })], rule)
    const summary = await runConversion(
      {
        ...input,
        preUpgradeSource: before.source,
        preUpgradePreflight: before.preflight,
        contributions: [
          {
            rules: [
              rule,
              { ...rule, ref: { id: 'fixture/before', version: 1 }, sourcePhase: 'pre-upgrade' },
            ],
            validators: [],
            lookups: [],
          },
        ],
      },
      new V2MemorySink(),
    )
    expect(summary.blocks).toEqual([])
    const current = summary.tableReceipts.find((receipt) => receipt.sourcePhase === 'current')!
    const previous = summary.tableReceipts.find((receipt) => receipt.sourcePhase === 'pre-upgrade')!
    expect(current.activeClaims.map((claim) => claim.sourceKey)).toEqual(
      ['a', 'z'].map((id) => encodeMigrationKey('tasks', [canonicalValue(id)])),
    )
    expect(previous.activeClaims).toEqual([
      {
        sourceKey: encodeMigrationKey('tasks', [canonicalValue('z')]),
        values: { id: canonicalValue('z'), name: canonicalValue('before-upgrade') },
      },
    ])
    expect(current.counts).toEqual({ converted: 2, preserved: 0, archived: 0, blocked: 0 })
    expect(previous.counts).toEqual({ converted: 1, preserved: 0, archived: 0, blocked: 0 })
    expect(current.exceptions).toBe(0)
    expect(previous.exceptions).toBe(0)
    expect(current.units).toBe(2)
  })
  test('source checks occur before opening and finishing and never once per unit', async () => {
    for (const failAt of [0, 1, 2, 3]) {
      const input = fixtureInput(['a', 'b', 'c', 'd'].map((id) => rawTask(id)))
      let checks = 0
      const sink = new V2MemorySink()
      const run = runConversion(
        {
          ...input,
          source: {
            ...input.source,
            async assertUnchanged() {
              checks++
              if (checks === failAt) throw new Error('fixture-source-changed')
            },
          },
        },
        sink,
      )
      if (failAt) await expect(run).rejects.toThrow('fixture-source-changed')
      else expect((await run).status).toBe('converted')
      expect(checks).toBe(failAt || 3)
      expect(sink.units.size).toBe(failAt === 1 || failAt === 2 ? 0 : 4)
      if (failAt === 1 || failAt === 2) expect(sink.binding).toBeNull()
      expect(sink.summary === null).toBe(failAt !== 0)
    }
  })
  test('lookup digests include the undecodable marker even when projected values are unchanged', async () => {
    const ids = idSetLookup('tasks', 'id')
    const columns = columnLookup('tasks', ['id'], ['started_at'])
    const versions: string[][] = []
    for (const name of ['fixture', null]) {
      const probe = lookupKey<boolean>('fixture/version-probe', 1)
      const input = fixtureInput([rawTask('same', { name })], fixtureRule(['name']), [
        {
          key: probe,
          sources: [],
          dependsOn: [ids.key, columns.key],
          build(_staged, put, lookup) {
            expect(lookup(ids.key).get('same')).toBe(true)
            expect(lookup(columns.key).get('same')).toEqual({ started_at: 1 })
            expect(lookup(ids.key).sourceStatus('same')?.takenOverColumns).toEqual(
              name === null ? ['name'] : undefined,
            )
            versions.push([lookup(ids.key).version.digest, lookup(columns.key).version.digest])
            put('complete', true)
          },
        },
        ids,
        columns,
      ])
      expect((await runConversion(input, new V2MemorySink())).status).toBe('converted')
    }
    expect(versions[0]![0]).not.toBe(versions[1]![0])
    expect(versions[0]![1]).not.toBe(versions[1]![1])
  })
})
