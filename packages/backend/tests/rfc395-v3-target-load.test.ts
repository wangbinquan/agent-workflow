// RFC-395 V3-R: authored for T18; offline target receipts never activate runtime wiring.
import { expect, setDefaultTimeout, test } from 'bun:test'
import {
  describeV3Providers,
  describeV3CrossProvider,
  type V3Harness,
} from './helpers/rfc395V3Harness'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type { UnitOutput } from '@/platform/persistence/migration/conversion/types'
import type { MigrationRunInit } from '@/platform/persistence/migration/run/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import {
  createTargetLoader,
  targetTableName,
  constraintRejection,
} from '@/platform/persistence/migration/target/loader'
import {
  createMigrationMetaStore,
  collectMigrationRows,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { column, retention } from '@/platform/persistence/schema/dsl'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { r2Owner, r2Registry } from './helpers/rfc395R2Schema'
import { CODECS } from '@/platform/persistence/schema/codecs'

// The first case in a process installs the source and target fixtures: 26.0 s on Ubuntu CI and 24.3 s on
// the macOS nightly before the shared fixture templates, about 2 s locally after them; allow 30 s.
setDefaultTimeout(30_000)

function sealUnit(output: UnitOutput): UnitOutput {
  const { digest: _digest, ...receipt } = output.receipt
  const { receipt: _receipt, ...payload } = output
  return {
    ...payload,
    receipt: { ...receipt, digest: valueDigest({ receipt, output: encodeStagedValue(payload) }) },
  }
}
function unit(id = 'unit-a', key = 'a'): UnitOutput {
  const encoded = encodeMigrationKey('maintenance_state', [canonicalValue(key)])
  const counts = { converted: 1, preserved: 0, archived: 0, blocked: 0 }
  return sealUnit({
    receipt: {
      version: 1,
      unitId: id,
      unit: {
        kind: 'source-chunk',
        table: 'maintenance_state',
        phase: 'current',
        afterKey: null,
        limit: 1,
      },
      sourceVersion: 'fixture',
      rule: { id: 'fixture/copy', version: 1 },
      lookups: [],
      sources: [
        {
          table: 'maintenance_state',
          phase: 'current',
          rows: 1,
          digest: valueDigest(key),
          keyDigest: valueDigest(encoded),
          firstKey: encoded,
          lastKey: encoded,
          counts,
          exceptions: 0,
          historyOnly: 0,
        },
      ],
      targets: [{ table: 'maintenance_state', rows: 1, digest: valueDigest(key) }],
      counts: { ...counts, exceptions: 0, historyOnly: 0 },
      digest: '',
    },
    rows: [{ table: 'maintenance_state', rows: [{ key, value: 'value', updated_at: 123 }] }],
    dispositions: [],
    artifacts: [],
    archives: [],
    records: [],
    blocks: [],
  })
}
async function fixture(h: V3Harness, sourceValue?: string) {
  await h.source.install()
  await seedRequiredRows(h.source)
  if (sourceValue !== undefined)
    await h.source.write('maintenance_state', [{ key: 'bad', value: sourceValue, updated_at: 123 }])
  const input = await h.input({ contentManifestDigest: valueDigest('content') })
  const plan = planConversion(input)
  await installConversionTarget(h.target, {
    head: h.head,
    metaTables: h.metaTables,
    generationId: h.generationId,
    now: 123,
  })
  const meta = createMigrationMetaStore({ target: h.target, registry: persistenceSchema })
  const row: MigrationRunInit = {
    version: 1,
    runId: 'run-r',
    operationId: h.operationId,
    ordinal: 1,
    kind: 'epoch-conversion',
    role: 'converted',
    sourceProvider: h.sourceProvider,
    sourceEpoch: 1,
    sourceKind: input.preflight.kind,
    targetProvider: h.targetProvider,
    targetEpoch: 2,
    migrationPlanDigest: valueDigest('plan'),
    approvalDigest: valueDigest('approval'),
    conversionPlan: plan,
    emptyTables: [],
    startedAt: 123,
  }
  const binding = {
    planDigest: plan.digest,
    sourceWatermark: plan.sourceWatermark,
    sourceVersion: plan.sourceVersion,
    sourceGenerationId: plan.sourceGenerationId,
    targetGeneration: plan.targetGeneration,
    converterVersion: plan.converterVersion,
    ruleSetDigest: plan.ruleSetDigest,
    preUpgradeWatermark: plan.preUpgradeWatermark,
    stagingDigest: valueDigest('stage'),
    lookupDigest: valueDigest('lookup'),
  }
  const loader = createTargetLoader({
    registry: persistenceSchema,
    provider: h.targetProvider,
  })
  const sink = createTargetConversionSink({
    target: h.target,
    loader,
    meta,
    run: row,
    now: () => 123,
  })
  const summary = {
    status: 'converted' as const,
    tableReceipts: [],
    blocks: [],
    records: [],
    historyOnly: [],
    stagingDigest: binding.stagingDigest,
    plan,
  }
  return { input, plan, meta, row, binding, loader, sink, summary }
}

describeV3Providers('RFC-395 V3 target load', (h) => {
  test('every codec, large bigint, bytes, JSON text, unicode and negative zero reach native storage', async () => {
    const table = r2Owner.table({
      id: 'v3_codecs',
      schemaSymbol: 'v3Codecs',
      retention: retention.business,
      columns: {
        id: column.id('id'),
        text: column.text('text'),
        enum: column.enum('enum', ['x']),
        bool: column.bool('bool'),
        int: column.int('int'),
        bigint: column.bigint('bigint'),
        epoch: column.epochMs('epoch'),
        duration: column.durationMs('duration'),
        real: column.real('real'),
        jsonText: column.jsonText('json_text'),
        jsonDoc: column.jsonDoc('json_doc'),
        rawJson: column.rawJson('raw_json'),
        bytes: column.bytes('bytes'),
        seq: column.seq('seq'),
        identity: column.identity('identity', { primary: true }),
        slot: column.slotKey('slot'),
      },
    })
    const registry = r2Registry([table])
    const head = createHistoryVersion({ registry, slug: 'codecs' })
    await installConversionTarget(h.target, {
      head,
      metaTables: h.metaTables,
      generationId: h.generationId,
      now: 123,
    })
    const loader = createTargetLoader({ registry, provider: h.targetProvider })
    const row = {
      id: 'a',
      text: '汉字😀\u0001',
      enum: 'x',
      bool: true,
      int: 13,
      bigint: 9007199254740993n,
      epoch: 123456789,
      duration: 41,
      real: 1.25,
      json_text: ' { "n": 2 } ',
      json_doc: '{"n":2}',
      raw_json: '{bad JSON retained',
      bytes: new Uint8Array([0, 255, 12]),
      seq: 8,
      identity: 19,
      slot: 's:/:[]',
    }
    await h.target.transaction((tx) => loader.insert(tx, [{ table: table.id, rows: [row] }]))
    const saved = (
      await h.target.execute(
        `SELECT *, CAST(bigint AS TEXT) AS exact_bigint FROM ${targetTableName(h.targetProvider, table.id)}`,
      )
    )[0]!
    expect(
      Object.values(table.columns)
        .map((column) => String(column.codec))
        .sort(),
    ).toEqual(Object.keys(CODECS).sort())
    expect(saved.exact_bigint).toBe('9007199254740993')
    expect(Buffer.from(saved.bytes as Uint8Array)).toEqual(Buffer.from(row.bytes))
    expect(saved.text).toBe(row.text)
    expect(Number(saved.real)).toBe(1.25)
    expect(saved.json_text).toBe(row.json_text)
    expect(saved.raw_json).toBe(row.raw_json)
    expect(
      typeof saved.json_doc === 'string' ? JSON.parse(saved.json_doc) : saved.json_doc,
    ).toEqual({ n: 2 })
    expect(saved.bool === true || Number(saved.bool) === 1).toBe(true)
    const negative = h.target.transaction((tx) =>
      loader.insert(tx, [
        { table: table.id, rows: [{ ...row, id: 'negative', identity: 20, real: -0 }] },
      ]),
    )
    if (h.targetProvider === 'sqlite') {
      await expect(negative).rejects.toThrow('negative zero')
      expect(
        await h.target.execute(
          `SELECT * FROM ${targetTableName(h.targetProvider, table.id)} WHERE identity = 20`,
        ),
      ).toHaveLength(0)
    } else {
      await negative
      const signed = (
        await h.target.execute(
          `SELECT real FROM ${targetTableName(h.targetProvider, table.id)} WHERE identity = 20`,
        )
      )[0]!
      expect(Object.is(Number(signed.real), -0)).toBe(true)
    }
  })
  test('cross-unit uniqueness rejects the complete unit and records a load block', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    await f.sink.commitUnit(unit('one', 'same'))
    const rejected = sealUnit({
      ...unit('two', 'same'),
      rows: [
        {
          table: 'maintenance_state',
          rows: [
            { key: 'new', value: 'rollback', updated_at: 1 },
            { key: 'same', value: 'duplicate', updated_at: 1 },
          ],
        },
      ],
    })
    await f.sink.commitUnit(rejected)
    expect((await f.meta.unit(f.row.runId, 'two'))?.outcome).toBe('load-blocked')
    expect(
      await h.target.execute(
        `SELECT * FROM ${targetTableName(h.targetProvider, 'maintenance_state')}`,
      ),
    ).toHaveLength(1)
    expect(await f.sink.loadBlocks()).toMatchObject([
      { code: 'v3-target-load-rejected', scope: 'row' },
    ])
    await f.sink.finish(f.summary)
    expect((await f.meta.migrationRun(f.row.runId))?.state).toBe('blocked')
    await f.sink.commitUnit(rejected)
    expect(await collectMigrationRows(f.meta.units(f.row.runId))).toHaveLength(2)
  })
  test('only explicit exceptions are persisted one-to-one beside same-key conversions', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    const base = unit()
    const exception = unit('unused', 'b')
    const output = sealUnit({
      ...base,
      rows: [
        { table: 'maintenance_state', rows: [...base.rows[0]!.rows, ...exception.rows[0]!.rows] },
      ],
      receipt: {
        ...base.receipt,
        counts: { ...base.receipt.counts, converted: 2, exceptions: 1 },
        sources: [
          {
            ...base.receipt.sources[0]!,
            rows: 2,
            lastKey: exception.receipt.sources[0]!.lastKey,
            counts: { converted: 2, preserved: 0, archived: 0, blocked: 0 },
            exceptions: 1,
          },
        ],
        targets: [{ ...base.receipt.targets[0]!, rows: 2 }],
      },
      dispositions: [
        {
          sourceTable: 'maintenance_state',
          sourcePhase: 'current',
          sourceKey: exception.receipt.sources[0]!.firstKey!,
          class: 'converted',
          kind: 'conflict-resolved',
          rule: base.receipt.rule,
          targets: [{ table: 'maintenance_state', key: exception.receipt.sources[0]!.firstKey! }],
          archive: null,
          decision: { code: 'fixture-explicit-resolution', detail: {} },
        },
      ],
    })
    await f.sink.commitUnit(output)
    await f.sink.commitUnit(output)
    expect(await collectMigrationRows(f.meta.dispositions({ runId: f.row.runId }))).toEqual([
      ...output.dispositions,
    ])
    expect(
      await collectMigrationRows(
        f.meta.dispositions({
          runId: f.row.runId,
          source: {
            sourceTable: 'maintenance_state',
            sourcePhase: 'current',
            sourceKey: base.receipt.sources[0]!.firstKey!,
          },
        }),
      ),
    ).toEqual([])
    expect((await f.meta.unit(f.row.runId, 'unit-a'))?.rowsWritten).toBe(2)
  })
})

describeV3CrossProvider('RFC-395 V3 native data load errors', (h) => {
  for (const codec of ['text', 'jsonDoc'] as const)
    test(`SQLite ${codec} NUL becomes a PostgreSQL row load block`, async () => {
      const value =
        codec === 'text' ? 'before\u0000after' : JSON.stringify({ text: 'before\u0000after' })
      const f = await fixture(h, value)
      const sourceValue = (
        await f.input.source.readChunk('maintenance_state', null, 100)
      ).decodedRows.find((row) => row.key === 'bad')!.value!
      expect(sourceValue).toBe(value)
      const table = r2Owner.table({
        id: 'v3_data_error',
        schemaSymbol: 'v3DataError',
        retention: retention.business,
        columns: {
          id: column.id('id', { primary: true }),
          value: codec === 'text' ? column.text('value') : column.jsonDoc('value'),
        },
      })
      const registry = r2Registry([table])
      const head = createHistoryVersion({ registry, slug: 'data-error' })
      for (const statement of head.postgresql.head) await h.target.execute(statement.sql)
      const key = encodeMigrationKey(table.id, [canonicalValue('bad')])
      const base = unit()
      const output = sealUnit({
        ...base,
        receipt: {
          ...base.receipt,
          sources: [{ ...base.receipt.sources[0]!, table: table.id, firstKey: key, lastKey: key }],
          targets: [{ table: table.id, rows: 1, digest: valueDigest('bad') }],
        },
        rows: [{ table: table.id, rows: [{ id: 'bad', value: sourceValue }] }],
      })
      const sink = createTargetConversionSink({
        target: h.target,
        meta: f.meta,
        loader: createTargetLoader({ registry, provider: h.targetProvider }),
        run: f.row,
        now: () => 123,
      })
      await sink.open(f.binding)
      await sink.commitUnit(output)
      expect(await sink.loadBlocks()).toMatchObject([
        {
          code: 'v3-target-load-rejected',
          scope: 'row',
          sourceTable: table.id,
          sourceKey: key,
          detail: { targetTable: table.id, targetKey: key },
        },
      ])
      expect((await f.meta.unit(f.row.runId, output.receipt.unitId))?.outcome).toBe('load-blocked')
      expect(
        await h.target.execute(`SELECT * FROM ${targetTableName(h.targetProvider, table.id)}`),
      ).toEqual([])
      await sink.commitUnit(output)
      expect(await sink.loadBlocks()).toHaveLength(1)
    })
})

test('native data failures are row-load errors while transport and programming failures propagate', () => {
  expect(constraintRejection({ code: '22021', message: 'NUL text' })?.rejection.message).toBe(
    'NUL text',
  )
  expect(
    constraintRejection({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '22P05', message: 'NUL jsonb' })
      ?.rejection.message,
  ).toBe('NUL jsonb')
  expect(constraintRejection({ code: '08006', message: 'connection lost' })).toBeNull()
  expect(constraintRejection(new Error('programming error'))).toBeNull()
})
