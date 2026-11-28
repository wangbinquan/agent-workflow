// RFC-626 §3.3 "装载被目标库拒绝" and §5 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md),
// on a real target database: the target sink of an automatic upgrade does not record a unit
// the database refuses as load-blocked. It rolls the unit back, returns every refused target
// row to the engine, and commits the adjusted unit — whose dispositions carry the decision —
// in one transaction. Opening a run hands those decisions back exactly as persisted, so a
// resumed conversion reproduces the committed units instead of meeting a digest conflict.
// The manual flow keeps recording load blocks.
//
// The first group drives the sink by hand and needs nothing but the sink; the second runs
// the engine against it, with an automatic conversion plan in the run row.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { join } from 'node:path'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { prepareConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  planConversion,
  type ConversionInput,
} from '@/platform/persistence/migration/conversion/plan'
import { bytesDigest, valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { readSourceTable } from '@/platform/persistence/migration/conversion/readSource'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type { ConversionSink } from '@/platform/persistence/migration/conversion/sink'
import type {
  ArchiveRef,
  JsonValue,
  LoadRejectionDecision,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { createTargetLoader, targetTableName } from '@/platform/persistence/migration/target/loader'
import {
  collectMigrationRows,
  createMigrationMetaStore,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { createTargetGenerationHandle } from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import {
  engineInput,
  frozenRow,
  memorySource,
  runBinding,
  runInit,
  sourceKey,
  targetKey,
} from './rfc626-engine-fixtures.test'

// Installing the whole target schema and committing against it takes about 17 s per case on a
// CI-scaled PostgreSQL (the figure rfc395-v3-sink.test.ts measured); allow 60 s.
setDefaultTimeout(60_000)

const LOAD_REJECTED = 'v3-target-load-rejected'
const stateKey = (id: string) => sourceKey('maintenance_state', id)

/** Every source row becomes the target row keyed by its `value`: equal values collide. */
const keyedByValue: ConversionRule = {
  ref: { id: 'fixture/keyed-by-value', version: 1 },
  owner: 'fixture',
  claims: ['maintenance_state'],
  produces: [{ table: 'maintenance_state' }],
  lookups: [],
  unit: { kind: 'source-chunk', table: 'maintenance_state' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('maintenance_state')!)
      ctx.out.row(
        'maintenance_state',
        { key: String(row.values.value), value: String(row.values.key), updated_at: 1 },
        row,
      )
  },
}
function source() {
  return memorySource({
    maintenance_state: [
      frozenRow('maintenance_state', { key: 'a', value: 'same', updated_at: 1 }),
      frozenRow('maintenance_state', { key: 'b', value: 'same', updated_at: 1 }),
      frozenRow('maintenance_state', { key: 'c', value: 'other', updated_at: 1 }),
    ],
  })
}
/** One unit per source row, so the collision is between units and only the database sees it. */
function input(h: V3Harness, resolution?: 'automatic'): ConversionInput {
  return engineInput(source(), [{ rules: [keyedByValue], lookups: [], validators: [] }], {
    scratchRoot: join(h.appHome, 'scratch'),
    target: persistenceSchema,
    targetGeneration: h.generationId,
    chunkLimit: 1,
    ...(resolution ? { resolution } : {}),
  })
}
async function installed(h: V3Harness) {
  await installConversionTarget(h.target, {
    head: h.head,
    metaTables: h.metaTables,
    generationId: h.generationId,
    now: 123,
  })
  return {
    meta: createMigrationMetaStore({ target: h.target, registry: persistenceSchema }),
    loader: createTargetLoader({ registry: persistenceSchema, provider: h.targetProvider }),
  }
}
async function stateRows(h: V3Harness): Promise<Record<string, string>> {
  const rows = await h.target.execute(
    `SELECT key, value FROM ${targetTableName(h.targetProvider, 'maintenance_state')}`,
  )
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]))
}

function sealUnit(output: UnitOutput): UnitOutput {
  const { digest: _digest, ...receipt } = output.receipt
  const { receipt: _receipt, ...payload } = output
  return {
    ...payload,
    receipt: { ...receipt, digest: valueDigest({ receipt, output: encodeStagedValue(payload) }) },
  }
}
/** A unit as some other producer would hand it to the sink: one source row, one target row. */
function unit(unitId: string, sourceId: string, targetId: string): UnitOutput {
  const encoded = stateKey(sourceId)
  const counts = { converted: 1, preserved: 0, archived: 0, blocked: 0 }
  return sealUnit({
    receipt: {
      version: 1,
      unitId,
      unit: {
        kind: 'source-chunk',
        table: 'maintenance_state',
        phase: 'current',
        afterKey: null,
        limit: 1,
      },
      sourceVersion: 'fixture',
      rule: { id: 'fixture/by-hand', version: 1 },
      lookups: [],
      sources: [
        {
          table: 'maintenance_state',
          phase: 'current',
          rows: 1,
          digest: valueDigest(sourceId),
          keyDigest: valueDigest(encoded),
          firstKey: encoded,
          lastKey: encoded,
          counts,
          exceptions: 0,
          historyOnly: 0,
        },
      ],
      targets: [{ table: 'maintenance_state', rows: 1, digest: valueDigest(targetId) }],
      counts: { ...counts, exceptions: 0, historyOnly: 0 },
      digest: '',
    },
    rows: [
      { table: 'maintenance_state', rows: [{ key: targetId, value: sourceId, updated_at: 123 }] },
    ],
    dispositions: [],
    artifacts: [],
    archives: [],
    records: [],
    blocks: [],
  })
}
/** The unit of a source row that was set aside, with the decision as its disposition detail. */
function setAsideUnit(
  unitId: string,
  sourceId: string,
  code: string,
  detail: JsonValue,
): UnitOutput {
  const base = unit(unitId, sourceId, 'unused')
  const bytes = new TextEncoder().encode(canonicalSchemaJson({ archived: sourceId }))
  const ref = `archive:${bytesDigest(bytes)}` as ArchiveRef
  const counts = { converted: 0, preserved: 0, archived: 1, blocked: 0 }
  return sealUnit({
    ...base,
    receipt: {
      ...base.receipt,
      sources: [{ ...base.receipt.sources[0]!, counts, exceptions: 1 }],
      targets: [],
      counts: { ...counts, exceptions: 1, historyOnly: 0 },
    },
    rows: [],
    dispositions: [
      {
        sourceTable: 'maintenance_state',
        sourceKey: stateKey(sourceId),
        sourcePhase: 'current',
        class: 'archived',
        kind: 'archived',
        targets: [],
        archive: ref,
        rule: base.receipt.rule,
        decision: { code, detail },
      },
    ],
    archives: [
      {
        kind: 'source-journal',
        sourceTable: 'maintenance_state',
        format: 'logical-row@1',
        bytes,
        rows: 1,
        ref,
      },
    ],
  })
}

describeV3Providers('RFC-626 target sink: a unit the database refuses', (h) => {
  async function byHand() {
    const { meta, loader } = await installed(h)
    const memory = source()
    const plan = planConversion(input(h))
    const run = runInit({
      operationId: h.operationId,
      targetProvider: h.targetProvider,
      plan,
      preflight: memory.preflight,
    })
    return { meta, loader, run, binding: runBinding(plan) }
  }

  test('with automatic resolution the refused rows are returned and nothing of the unit is recorded', async () => {
    const f = await byHand()
    const sink = createTargetConversionSink({
      target: h.target,
      loader: f.loader,
      meta: f.meta,
      run: f.run,
      now: () => 123,
      resolution: 'automatic',
    })
    await sink.open(f.binding)
    expect(await sink.commitUnit(unit('unit-a', 'a', 'same'))).toBeUndefined()
    const refused = await sink.commitUnit(unit('unit-b', 'b', 'same'))
    expect(refused).toEqual({
      rejected: [
        {
          table: 'maintenance_state',
          targetKey: targetKey('maintenance_state', 'same'),
          constraint: expect.any(String),
          message: expect.any(String),
        },
      ],
    })
    expect(await f.meta.unit(f.run.runId, 'unit-b')).toBeNull()
    expect(await sink.loadBlocks()).toEqual([])
    expect(await f.meta.blocks({ runId: f.run.runId })).toEqual([])
    expect(await stateRows(h)).toEqual({ same: 'a' })
    // The run goes on: the same unit without the refused row, and later units, commit.
    await sink.commitUnit(
      setAsideUnit('unit-b', 'b', LOAD_REJECTED, { refused: 'maintenance_state/same' }),
    )
    await sink.commitUnit(unit('unit-c', 'c', 'other'))
    expect(
      (await collectMigrationRows(f.meta.units(f.run.runId))).map((entry) => entry.outcome),
    ).toEqual(['committed', 'committed', 'committed'])
    expect(await stateRows(h)).toEqual({ same: 'a', other: 'c' })
  })

  test('the manual sink still records the unit as load-blocked', async () => {
    const f = await byHand()
    for (const resolution of [undefined, 'operator'] as const) {
      const runId = resolution ?? 'default'
      const run = { ...f.run, runId: `run-${runId}` }
      const sink = createTargetConversionSink({
        target: h.target,
        loader: f.loader,
        meta: f.meta,
        run,
        now: () => 123,
        ...(resolution ? { resolution } : {}),
      })
      await sink.open(f.binding)
      expect(await sink.commitUnit(unit('unit-a', 'a', `same-${runId}`))).toBeUndefined()
      expect(await sink.commitUnit(unit('unit-b', 'b', `same-${runId}`))).toBeUndefined()
      expect((await f.meta.unit(run.runId, 'unit-b'))?.outcome).toBe('load-blocked')
      expect(await sink.loadBlocks()).toEqual([
        expect.objectContaining({
          code: LOAD_REJECTED,
          detail: expect.objectContaining({
            unitId: 'unit-b',
            targetTable: 'maintenance_state',
            targetKey: targetKey('maintenance_state', `same-${runId}`),
          }),
        }),
      ])
    }
  })

  test('opening a run hands back the load-rejection decisions of its committed units, verbatim', async () => {
    const f = await byHand()
    const options = {
      target: h.target,
      loader: f.loader,
      meta: f.meta,
      run: f.run,
      now: () => 123,
    }
    const decision = (
      id: string,
      targets: LoadRejectionDecision['targets'],
    ): LoadRejectionDecision => ({
      sourcePhase: 'current',
      sourceTable: 'maintenance_state',
      sourceKey: stateKey(id),
      targets,
    })
    const one = decision('a', [
      {
        table: 'maintenance_state',
        key: targetKey('maintenance_state', 'same'),
        constraint: null,
        message: 'UNIQUE constraint failed: "maintenance_state"."key" — “引号” and \n newline',
      },
    ])
    const two = decision('b', [
      {
        table: 'maintenance_state',
        key: targetKey('maintenance_state', 'other'),
        constraint: 'maintenance_state_pkey',
        message: 'duplicate key value violates unique constraint',
      },
      {
        table: 'maintenance_state',
        key: targetKey('maintenance_state', 'third'),
        constraint: 'maintenance_state_pkey',
        message: 'duplicate key value violates unique constraint',
      },
    ])
    const sink = createTargetConversionSink({ ...options, resolution: 'automatic' })
    expect(await sink.open(f.binding)).toEqual({
      committedUnitIds: new Set(),
      loadRejections: new Map(),
    })
    await sink.commitUnit(setAsideUnit('unit-a', 'a', LOAD_REJECTED, one as unknown as JsonValue))
    await sink.commitUnit(setAsideUnit('unit-b', 'b', LOAD_REJECTED, two as unknown as JsonValue))
    // Set aside for another reason: not a decision the engine has to replay.
    await sink.commitUnit(setAsideUnit('unit-c', 'c', 'v2-dangling-reference', { column: 'x' }))

    const reopened = await createTargetConversionSink({ ...options, resolution: 'automatic' }).open(
      f.binding,
    )
    expect(reopened.committedUnitIds).toEqual(new Set(['unit-a', 'unit-b', 'unit-c']))
    expect(reopened.loadRejections).toEqual(
      new Map([
        ['unit-a', [one]],
        ['unit-b', [two]],
      ]),
    )
    // The manual sink answers as it always did.
    expect(await createTargetConversionSink(options).open(f.binding)).toEqual({
      committedUnitIds: new Set(['unit-a', 'unit-b', 'unit-c']),
    })
  })

  test('a target handle passes the resolution of the run on to its sink', async () => {
    const f = await byHand()
    const handle = createTargetGenerationHandle({
      target: h.target,
      generationId: h.generationId,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
      now: () => 123,
    })
    const sink = handle.openRun(f.run, { resolution: 'automatic' })
    await sink.open(f.binding)
    await sink.commitUnit(unit('unit-a', 'a', 'same'))
    expect(await sink.commitUnit(unit('unit-b', 'b', 'same'))).toMatchObject({
      rejected: [{ table: 'maintenance_state', targetKey: targetKey('maintenance_state', 'same') }],
    })
    // Without the option the handle gives the sink of the manual flow.
    const manual = handle.openRun(f.run)
    await manual.open(f.binding)
    expect(await manual.commitUnit(unit('unit-b', 'b', 'same'))).toBeUndefined()
    expect((await f.meta.unit(f.run.runId, 'unit-b'))?.outcome).toBe('load-blocked')
  })
})

describeV3Providers('RFC-626 engine and target sink: a collision between units', (h) => {
  async function prepared() {
    const { meta, loader } = await installed(h)
    const conversion = await prepareConversion(input(h, 'automatic'))
    const run = runInit({
      operationId: h.operationId,
      targetProvider: h.targetProvider,
      plan: conversion.plan,
      preflight: source().preflight,
    })
    const sink = (fault?: Parameters<typeof createTargetConversionSink>[0]['fault']) =>
      createTargetConversionSink({
        target: h.target,
        loader,
        meta,
        run,
        now: () => 123,
        resolution: 'automatic',
        ...(fault ? { fault } : {}),
      })
    return { meta, conversion, run, sink }
  }
  /** Counts what the engine asks of the sink. */
  function counting(sink: ConversionSink) {
    const seen = { commits: 0, refusals: 0 }
    const counted: ConversionSink = {
      open: (binding) => sink.open(binding),
      async commitUnit(output) {
        seen.commits++
        const result = await sink.commitUnit(output)
        if (result) seen.refusals++
        return result
      },
      finish: (summary) => sink.finish(summary),
    }
    return { sink: counted, seen }
  }
  const expectedDecision = {
    sourcePhase: 'current',
    sourceTable: 'maintenance_state',
    sourceKey: stateKey('b'),
    targets: [
      {
        table: 'maintenance_state',
        key: targetKey('maintenance_state', 'same'),
        constraint: expect.any(String),
        message: expect.any(String),
      },
    ],
  }

  test('the later row is set aside, the unit commits, and the run converts', async () => {
    const f = await prepared()
    try {
      const first = counting(f.sink())
      const summary = await f.conversion.run(first.sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      // Three units; the one with the collision was offered twice.
      expect(first.seen).toEqual({ commits: 4, refusals: 1 })
      expect(summary.resolutions!.setAside).toEqual({
        total: 1,
        rows: [
          {
            sourcePhase: 'current',
            sourceTable: 'maintenance_state',
            sourceKey: stateKey('b'),
            code: LOAD_REJECTED,
          },
        ],
      })
      expect(await stateRows(h)).toEqual({ same: 'a', other: 'c' })
      const units = await collectMigrationRows(f.meta.units(f.run.runId))
      expect(units.map((entry) => entry.outcome)).toEqual(['committed', 'committed', 'committed'])
      expect(await f.meta.blocks({ runId: f.run.runId })).toEqual([])
      expect((await f.meta.migrationRun(f.run.runId))?.state).toBe('converted')

      const dispositions = await collectMigrationRows(f.meta.dispositions({ runId: f.run.runId }))
      expect(dispositions).toEqual([
        expect.objectContaining({
          sourceTable: 'maintenance_state',
          sourceKey: stateKey('b'),
          class: 'archived',
          kind: 'archived',
          targets: [],
          decision: { code: LOAD_REJECTED, detail: expectedDecision },
        }),
      ])
      // The archive is the source row as the old database held it.
      const memory = source()
      const original = (
        await readSourceTable({
          source: memory.source,
          preflight: memory.preflight,
          table: 'maintenance_state',
        })
      ).find((row) => row.values.key === 'b')!
      const archive = await f.meta.archive({
        runId: f.run.runId,
        ref: dispositions[0]!.archive!,
      })
      expect(Buffer.from(archive!.bytes).toString('utf8')).toBe(
        canonicalSchemaJson({ canonical: original.canonical, raw: original.raw ?? null }),
      )
      expect(archive).toMatchObject({ kind: 'source-journal', format: 'logical-row@1' })
    } finally {
      f.conversion.close()
    }
  })

  test('converting the run again reproduces every committed unit without asking the database again', async () => {
    const f = await prepared()
    try {
      const summary = await f.conversion.run(f.sink())
      const committed = await collectMigrationRows(f.meta.units(f.run.runId))
      const again = await prepareConversion(input(h, 'automatic'))
      try {
        expect(again.plan.digest).toBe(f.conversion.plan.digest)
        const second = counting(f.sink())
        const replay = await again.run(second.sink)
        // One commit per unit: the decision came back from the run, the row was never offered.
        expect(second.seen).toEqual({ commits: 3, refusals: 0 })
        expect(valueDigest(replay)).toBe(valueDigest(summary))
        expect(await collectMigrationRows(f.meta.units(f.run.runId))).toEqual(committed)
        expect(await stateRows(h)).toEqual({ same: 'a', other: 'c' })
      } finally {
        again.close()
      }
    } finally {
      f.conversion.close()
    }
  })

  test('killed after the adjusted unit committed and before the engine heard of it: the resumed run completes', async () => {
    const f = await prepared()
    try {
      let acknowledged = 0
      const crashing = f.sink((point) => {
        // The second unit that commits is the one that set its row aside.
        if (point === 'before-ack' && ++acknowledged === 2) throw new Error('rfc626-crash')
      })
      await expect(f.conversion.run(crashing)).rejects.toThrow('rfc626-crash')
      const committed = await collectMigrationRows(f.meta.units(f.run.runId))
      expect(committed).toHaveLength(2)
      expect((await f.meta.migrationRun(f.run.runId))?.summaryDigest).toBeNull()
      expect(
        (await collectMigrationRows(f.meta.dispositions({ runId: f.run.runId }))).map(
          (entry) => entry.decision?.code,
        ),
      ).toEqual([LOAD_REJECTED])

      const resumed = await prepareConversion(input(h, 'automatic'))
      try {
        const second = counting(f.sink())
        const summary = await resumed.run(second.sink)
        expect(summary.status).toBe('converted')
        expect(second.seen).toEqual({ commits: 3, refusals: 0 })
        const units = await collectMigrationRows(f.meta.units(f.run.runId))
        expect(units).toHaveLength(3)
        for (const unit of committed)
          expect(units.find((entry) => entry.unitId === unit.unitId)).toEqual(unit)
        expect(await stateRows(h)).toEqual({ same: 'a', other: 'c' })
        expect((await f.meta.migrationRun(f.run.runId))?.state).toBe('converted')
      } finally {
        resumed.close()
      }
    } finally {
      f.conversion.close()
    }
  })
})
