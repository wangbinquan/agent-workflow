// RFC-395 V3-R: authored for T18; offline target receipts never activate runtime wiring.
import { expect, test } from 'bun:test'
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
import { createTargetLoader, targetTableName } from '@/platform/persistence/migration/target/loader'
import {
  createMigrationMetaStore,
  collectMigrationRows,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { createDryRunSink } from '@/modules/system-operations/infrastructure/epochSwitch/dryRunSink'
import { createTargetGenerationPort } from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import type { EpochSwitchFaults } from '@/modules/system-operations/domain/epochSwitch/model'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
function nativePort(h: V3Harness) {
  return createTargetGenerationPort({
    appHome: h.appHome,
    registry: persistenceSchema,
    head: h.head,
    catalogCache: h.catalogCache,
    postgresql: {
      open: async () => openConversionTarget({ runtime: h.runtime }),
      preflight: async ({ location, provider }) => ({
        location,
        provider,
        fingerprint: valueDigest('target'),
        empty: true,
        postgresqlMajor: (await h.catalog()).postgresqlMajor,
        encoding: 'UTF8',
        collation: 'C',
        canCreate: true,
        availableBytes: null,
        blocks: [],
      }),
    },
  })
}
async function fixture(h: V3Harness, faults?: EpochSwitchFaults) {
  await h.source.install()
  await seedRequiredRows(h.source)
  const input = await h.input({ contentManifestDigest: valueDigest('content') })
  const plan = planConversion(input)
  const port = nativePort(h)
  const handle = faults
    ? await port.create({
        generationId: h.generationId,
        provider: h.targetProvider,
        location: h.targetLocation,
        operationId: h.operationId,
        runId: 'run-r',
        role: 'converted',
        sourceGenerationId: plan.sourceGenerationId,
        now: 123,
        faults,
      })
    : null
  if (!handle)
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
  return { input, plan, meta, row, binding, loader, sink, summary, port, handle }
}

describeV3Providers('RFC-395 V3 atomic sink', (h) => {
  test('open, commit, finish and full-binding replay retain one durable unit', async () => {
    const f = await fixture(h)
    expect((await f.sink.open(f.binding)).committedUnitIds.size).toBe(0)
    await f.sink.commitUnit(unit())
    await f.sink.commitUnit(unit())
    await f.sink.finish(f.summary)
    await f.sink.finish(f.summary)
    expect((await f.sink.open(f.binding)).committedUnitIds).toEqual(new Set(['unit-a']))
    expect((await f.meta.migrationRun(f.row.runId))?.state).toBe('converted')
    expect(await collectMigrationRows(f.meta.units(f.row.runId))).toHaveLength(1)
    for (const key of Object.keys(f.binding) as (keyof typeof f.binding)[]) {
      await expect(
        f.sink.open({
          ...f.binding,
          [key]:
            key === 'preUpgradeWatermark' ? valueDigest('changed') : `${f.binding[key]}-changed`,
        }),
      ).rejects.toThrow('v3-run-binding-mismatch')
    }
    await expect(f.sink.finish({ ...f.summary, status: 'blocked' })).rejects.toThrow(
      'v3-sink-summary-conflict',
    )
  })
  for (const fault of ['after-rows', 'after-receipts', 'before-ack'] as const)
    test(`${fault} recovers without orphan rows or missing receipts`, async () => {
      const f = await fixture(h)
      let fail = true
      const sink = createTargetConversionSink({
        target: h.target,
        loader: f.loader,
        meta: f.meta,
        run: f.row,
        now: () => 123,
        fault: (point) => {
          if (fail && point === fault) {
            fail = false
            throw new Error('crash')
          }
        },
      })
      await sink.open(f.binding)
      await expect(sink.commitUnit(unit())).rejects.toThrow('crash')
      const committed = fault === 'before-ack'
      expect(await collectMigrationRows(f.meta.units(f.row.runId))).toHaveLength(committed ? 1 : 0)
      expect(
        await h.target.execute(
          `SELECT * FROM ${targetTableName(h.targetProvider, 'maintenance_state')}`,
        ),
      ).toHaveLength(committed ? 1 : 0)
      await sink.commitUnit(unit())
      expect(await collectMigrationRows(f.meta.units(f.row.runId))).toHaveLength(1)
      expect(
        await h.target.execute(
          `SELECT * FROM ${targetTableName(h.targetProvider, 'maintenance_state')}`,
        ),
      ).toHaveLength(1)
    })
  for (const point of ['after-rows', 'after-receipts', 'before-ack'] as const)
    test(`public create/open forwards ${point} into the real sink`, async () => {
      const faults: EpochSwitchFaults = (at) => {
        if (at === point) throw new Error(`public:${point}`)
      }
      const f = await fixture(h, faults)
      const initial = f.handle!
      try {
        const sink = initial.openRun(f.row)
        await sink.open(f.binding)
        await expect(sink.commitUnit(unit())).rejects.toThrow(`public:${point}`)
        expect(await collectMigrationRows(f.meta.units(f.row.runId))).toHaveLength(
          point === 'before-ack' ? 1 : 0,
        )
      } finally {
        await initial.close()
      }
      const failedAgain = await f.port.open({
        generationId: h.generationId,
        provider: h.targetProvider,
        location: h.targetLocation,
        faults,
      })
      try {
        const sink = failedAgain.openRun(f.row)
        await sink.open(f.binding)
        await expect(sink.commitUnit(unit())).rejects.toThrow(`public:${point}`)
      } finally {
        await failedAgain.close()
      }
      const reopened = await f.port.open({
        generationId: h.generationId,
        provider: h.targetProvider,
        location: h.targetLocation,
      })
      try {
        const sink = reopened.openRun(f.row)
        await sink.open(f.binding)
        await sink.commitUnit(unit())
        expect(await collectMigrationRows(reopened.trace().units(f.row.runId))).toHaveLength(1)
        expect(
          await h.target.execute(
            `SELECT * FROM ${targetTableName(h.targetProvider, 'maintenance_state')}`,
          ),
        ).toHaveLength(1)
      } finally {
        await reopened.close()
      }
    })
  if (h.targetProvider === 'sqlite')
    test('discard resumes from the moved database and remaining sidecars, then repeats', async () => {
      const f = await fixture(h, () => {})
      const handle = f.handle!
      const sink = handle.openRun(f.row)
      await sink.open(f.binding)
      await sink.commitUnit(unit())
      expect(await handle.retireIfUnwritten()).toBe('retired')
      await handle.close()
      await h.target.close()
      const destination = join(h.operationRoot, 'discarded', h.generationId)
      mkdirSync(destination, { recursive: true })
      renameSync(h.targetPath, join(destination, 'db.sqlite'))
      // The main file rename completed; these are the empty checkpointed sidecars left behind.
      writeFileSync(`${h.targetPath}-wal`, '')
      writeFileSync(`${h.targetPath}-shm`, '')
      const request = { generationId: h.generationId, location: h.targetLocation, destination }
      await f.port.discard(request)
      await f.port.discard(request)
      expect(existsSync(h.targetPath)).toBe(false)
      expect(existsSync(`${h.targetPath}-wal`)).toBe(false)
      expect(existsSync(`${h.targetPath}-shm`)).toBe(false)
      const retained = await f.port.open({
        generationId: h.generationId,
        provider: h.targetProvider,
        location: { kind: 'sqlite-file', relativePath: join(destination, 'db.sqlite') },
      })
      try {
        expect(await retained.retireIfUnwritten()).toBe('already-retired')
        expect(
          await retained
            .trace()
            .probeTarget({ table: 'maintenance_state', key: unit().receipt.sources[0]!.firstKey! }),
        ).toBe(true)
        expect(await retained.firstLiveWriteAt()).toBeNull()
      } finally {
        await retained.close()
      }
      await expect(
        f.port.discard({ ...request, generationId: 'dbg_wrong_generation' }),
      ).rejects.toThrow('v3-target-generation-mismatch')
    })
  test('invalid full output digest and same-id changed output are rejected', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    await expect(
      f.sink.commitUnit({ ...unit(), records: [{ kind: 'source-journal', entries: [] }] }),
    ).rejects.toThrow('v3-sink-invalid-unit-digest')
    await f.sink.commitUnit(unit())
    await expect(f.sink.commitUnit(unit('unit-a', 'other'))).rejects.toThrow(
      'v3-sink-unit-conflict',
    )
  })
  test('full assembly engine replay equals clean unit digests and target counts', async () => {
    const f = await fixture(h)
    const clean = new V2MemorySink()
    const expected = await runConversion(f.input, clean)
    const sink = createTargetConversionSink({
      target: h.target,
      loader: f.loader,
      meta: f.meta,
      run: f.row,
      now: () => 123,
    })
    await runConversion(f.input, sink)
    await runConversion(f.input, sink)
    expect(await sink.loadBlocks()).toEqual([])
    expect(
      (await collectMigrationRows(f.meta.units(f.row.runId)))
        .map((row) => row.receipt.digest)
        .sort(),
    ).toEqual([...clean.units.values()].map((row) => row.receipt.digest).sort())
    expect((await f.meta.migrationRun(f.row.runId))?.summaryDigest).toBe(valueDigest(expected))
    const dry = createDryRunSink()
    await runConversion(f.input, dry)
    for (const count of dry.result.targetCounts) {
      const rows = await h.target.execute(
        `SELECT COUNT(*) AS n FROM ${targetTableName(h.targetProvider, count.table)}`,
      )
      expect(Number(rows[0]!.n)).toBe(count.rows)
    }
  }, 180000)
})

describeV3CrossProvider('RFC-395 V3 SQLite to PostgreSQL target', (h) => {
  test('full source assembly loads and replays with the same unit receipts', async () => {
    const f = await fixture(h)
    const expected = new V2MemorySink()
    await runConversion(f.input, expected)
    await runConversion(f.input, f.sink)
    await runConversion(f.input, f.sink)
    expect(await f.sink.loadBlocks()).toEqual([])
    expect(
      (await collectMigrationRows(f.meta.units(f.row.runId)))
        .map((row) => row.receipt.digest)
        .sort(),
    ).toEqual([...expected.units.values()].map((row) => row.receipt.digest).sort())
    for (const table of new Set(
      [...expected.units.values()].flatMap((unit) => unit.rows.map((group) => group.table)),
    )) {
      expect(
        Number(
          (
            await h.target.execute(
              `SELECT COUNT(*) AS n FROM ${targetTableName(h.targetProvider, table)}`,
            )
          )[0]!.n,
        ),
      ).toBe(expected.rows(table).length)
    }
  }, 180000)
})
