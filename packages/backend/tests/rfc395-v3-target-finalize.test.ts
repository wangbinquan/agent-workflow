// RFC-395 V3-R: authored for T18; offline target receipts never activate runtime wiring.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { MigrationRunInit } from '@/platform/persistence/migration/run/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { createTargetLoader, targetTableName } from '@/platform/persistence/migration/target/loader'
import { createMigrationMetaStore } from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { createTargetGenerationHandle } from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import { enforceDeferredConstraints } from '@/platform/persistence/migration/target/finalize'
import {
  applyIdentityHighWater,
  foldIdentityHighWater,
  verifyIdentityHighWater,
} from '@/platform/persistence/migration/target/identity'
import { EPOCH2_SENTINEL } from '@/platform/persistence/schema/history/markers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { column, retention } from '@/platform/persistence/schema/dsl'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { r2Owner, r2Registry, parentTable, itemTable } from './helpers/rfc395R2Schema'

// Native target installation, admission and finalization take about 13 s per CI-scaled case; allow 40 s.
setDefaultTimeout(40000)

async function fixture(h: V3Harness) {
  await h.source.install()
  await seedRequiredRows(h.source)
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

describeV3Providers('RFC-395 V3 final constraints', (h) => {
  test('conversion head and generation initialization roll back together, then retry cleanly', async () => {
    const options = {
      head: h.head,
      metaTables: h.metaTables,
      generationId: h.generationId,
      now: 123,
    }
    const table = targetTableName(h.targetProvider, 'maintenance_state')
    await expect(
      installConversionTarget(h.target, {
        ...options,
        initialize: async (tx) => {
          await tx.execute(
            `INSERT INTO ${table} (key, value, updated_at) VALUES ('atomic-install', 'uncommitted', 1)`,
          )
          throw new Error('generation-initialization-failed')
        },
      }),
    ).rejects.toThrow('generation-initialization-failed')
    await expect(h.target.execute(`SELECT * FROM ${table}`)).rejects.toThrow()
    await installConversionTarget(h.target, options)
    expect(await h.target.execute(`SELECT * FROM ${table}`)).toEqual([])
    expect(
      await h.target.execute(
        `SELECT version FROM ${metaTableName(h.targetProvider, 'schema_history')}`,
      ),
    ).toHaveLength(1)
  })
  test('FKs permit out-of-order inserts during load and list orphans before enforcement', async () => {
    const fkName = `r2_parent_${'very_long_foreign_key_name_'.repeat(4)}`
    expect(Buffer.byteLength(fkName)).toBeGreaterThan(63)
    const registry = r2Registry([
      parentTable,
      { ...itemTable, foreignKeys: [{ ...itemTable.foreignKeys[0]!, name: fkName }] },
    ])
    const head = createHistoryVersion({ registry, slug: 'foreign-keys' })
    const installed = await installConversionTarget(h.target, {
      head,
      metaTables: h.metaTables,
      generationId: h.generationId,
      now: 123,
    })
    const loader = createTargetLoader({ registry, provider: h.targetProvider })
    await h.target.transaction((tx) =>
      loader.insert(tx, [
        {
          table: itemTable.id,
          rows: [{ id: 'child', parent_id: 'missing', amount: 1, label: 'label' }],
        },
      ]),
    )
    expect(
      await enforceDeferredConstraints(h.target, { registry, deferred: installed.deferred }),
    ).toMatchObject([{ table: itemTable.id, constraint: fkName, referencedTable: parentTable.id }])
    await h.target.transaction((tx) =>
      loader.insert(tx, [{ table: parentTable.id, rows: [{ id: 'missing', name: 'Parent' }] }]),
    )
    expect(
      await enforceDeferredConstraints(h.target, { registry, deferred: installed.deferred }),
    ).toEqual([])
    if (h.targetProvider === 'postgresql') {
      const rows = await h.target.execute(
        "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'agent_workflow.r2_items'::regclass AND contype='f'",
      )
      expect(rows).toHaveLength(1)
      expect(Buffer.byteLength(String(rows[0]!.conname))).toBeLessThanOrEqual(63)
      expect(rows[0]!.convalidated).toBe(true)
    }
    expect(
      await enforceDeferredConstraints(h.target, { registry, deferred: installed.deferred }),
    ).toEqual([])
    await expect(
      h.target.transaction((tx) =>
        loader.insert(tx, [
          {
            table: itemTable.id,
            rows: [{ id: 'orphan', parent_id: 'absent', amount: 1, label: 'label' }],
          },
        ]),
      ),
    ).rejects.toThrow()
  })
  test('conversion installs no seeds; full conversion admits head/meta/sentinel with all identities', async () => {
    const f = await fixture(h)
    expect(
      await h.target.execute(`SELECT * FROM ${targetTableName(h.targetProvider, 'users')}`),
    ).toEqual([])
    await runConversion(f.input, f.sink)
    const handle = createTargetGenerationHandle({
      target: h.target,
      generationId: h.generationId,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
    })
    const result = await handle.finalize({ runId: f.row.runId })
    expect(await handle.finalize({ runId: f.row.runId })).toEqual(result)
    const facts = await f.meta.select('migration_records', {
      runId: f.row.runId,
      unitId: 'v3:finalize:constraints',
    })
    expect(facts).toHaveLength(1)
    expect(facts[0]!.recordJson).toMatchObject({
      kind: 'decision',
      code: 'v3-deferred-constraints-applied',
    })
    expect(result).toMatchObject({
      deferredConstraintsApplied: true,
      violations: [],
      integrity: [],
      catalogAdmitted: true,
      identityVerified: true,
    })
    expect(result.identityHighWater.some((row) => row.table === 'node_run_seq_allocations')).toBe(
      true,
    )
    const sentinel =
      h.targetProvider === 'sqlite'
        ? await h.target.execute('SELECT hash FROM __drizzle_migrations WHERE id=-395')
        : await h.target.execute(
            `SELECT baseline_id FROM ${metaTableName(h.targetProvider, 'schema_migrations')}`,
          )
    expect(Object.values(sentinel[0]!)).toContain(EPOCH2_SENTINEL)
  })
  test('max-fold and empty identity set next allocation to high water plus one', async () => {
    const table = r2Owner.table({
      id: 'v3_identity',
      schemaSymbol: 'v3Identity',
      retention: retention.business,
      columns: { id: column.identity('id', { primary: true }), value: column.text('value') },
    })
    const registry = r2Registry([table])
    await installConversionTarget(h.target, {
      head: createHistoryVersion({ registry, slug: 'identity' }),
      metaTables: h.metaTables,
      generationId: h.generationId,
      now: 123,
    })
    const values = foldIdentityHighWater([
      {
        kind: 'identity-high-water',
        table: table.id,
        column: 'id',
        value: '8',
        basis: 'sequence',
        warning: 'source',
      },
      { kind: 'identity-high-water', table: table.id, column: 'id', value: '3', basis: 'max-row' },
    ])
    expect(values).toEqual([
      { table: table.id, column: 'id', value: '8', basis: 'both', warnings: ['source'] },
    ])
    await h.target.transaction((tx) =>
      applyIdentityHighWater(tx, { registry, values: [{ ...values[0]!, value: '0' }] }),
    )
    expect(await verifyIdentityHighWater(h.target, [{ ...values[0]!, value: '0' }])).toBe(true)
    let row = (
      await h.target.execute(
        `INSERT INTO ${targetTableName(h.targetProvider, table.id)} (value) VALUES ('first') RETURNING id`,
      )
    )[0]!
    expect(Number(row.id)).toBe(1)
    await h.target.transaction((tx) => applyIdentityHighWater(tx, { registry, values }))
    expect(await verifyIdentityHighWater(h.target, values)).toBe(true)
    row = (
      await h.target.execute(
        `INSERT INTO ${targetTableName(h.targetProvider, table.id)} (value) VALUES ('second') RETURNING id`,
      )
    )[0]!
    expect(Number(row.id)).toBe(9)
  })
})
