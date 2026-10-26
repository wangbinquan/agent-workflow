// RFC-395 V3-R: authored for T18; offline target receipts never activate runtime wiring.
import { expect, test } from 'bun:test'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
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
import type {
  MigrationRunInit,
  MigrationTraceResult,
} from '@/platform/persistence/migration/run/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { createTargetLoader } from '@/platform/persistence/migration/target/loader'
import { createMigrationMetaStore } from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { createMigrationTraceQuery } from '@/modules/system-operations/application/epochSwitch/trace'

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

describeV3Providers('RFC-395 V3 trace tiers', (h) => {
  test('same-key chunk range probes targets and sparse absent keys are not found', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    const base = unit()
    const other = unit('unit-c', 'c')
    await f.sink.commitUnit(
      sealUnit({
        ...base,
        receipt: {
          ...base.receipt,
          sources: [
            {
              ...base.receipt.sources[0]!,
              rows: 2,
              lastKey: other.receipt.sources[0]!.lastKey,
              counts: { converted: 2, preserved: 0, archived: 0, blocked: 0 },
            },
          ],
          targets: [{ ...base.receipt.targets[0]!, rows: 2 }],
          counts: { ...base.receipt.counts, converted: 2 },
        },
        rows: [
          { table: 'maintenance_state', rows: [...base.rows[0]!.rows, ...other.rows[0]!.rows] },
        ],
      }),
    )
    const trace = createMigrationTraceQuery({
      meta: f.meta,
      replay: {
        async replay(query) {
          expect(query.key).toEqual([canonicalValue('b')])
          return {
            runId: f.row.runId,
            sourceTable: query.table,
            sourcePhase: query.phase ?? 'current',
            sourceKey: encodeMigrationKey(query.table, query.key),
            proof: 'not-found',
            class: null,
            dispositions: [],
            unit: null,
            targets: [],
            artifacts: [],
            restrictions: [],
            blocks: [],
            archive: null,
          }
        },
      },
    })
    const result = await trace({
      operationId: h.operationId,
      table: 'maintenance_state',
      key: [canonicalValue('a')],
    })
    expect(result).toMatchObject({
      proof: 'unit-range',
      class: 'converted',
      targets: [{ table: 'maintenance_state', present: true, probed: true }],
    })
    expect(
      (
        await trace({
          operationId: h.operationId,
          table: 'maintenance_state',
          key: [canonicalValue('b')],
        })
      ).proof,
    ).toBe('not-found')
  })
  test('record-only metadata rows trace from exact evidence without replay', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    for (const [index, table] of [
      '__drizzle_migrations',
      'sqlite_sequence',
      'database_generations',
      'committed_event_family_cutovers',
    ].entries()) {
      const key = encodeMigrationKey(table, [canonicalValue('present')])
      const evidence = { sourceTable: table, sourceKey: key, sourcePhase: 'pre-upgrade', raw: '{}' }
      const base = unit(`record-${index}`)
      const output = sealUnit({
        ...base,
        rows: [],
        receipt: {
          ...base.receipt,
          unit: { kind: 'raw-chunk', table, phase: 'pre-upgrade', afterKey: null, limit: 10 },
          targets: [],
          sources: [
            {
              ...base.receipt.sources[0]!,
              table,
              phase: 'pre-upgrade',
              firstKey: key,
              lastKey: key,
            },
          ],
        },
        records: [
          index === 0
            ? { kind: 'source-journal', entries: evidence }
            : index === 1
              ? { kind: 'source-metadata', table, payload: evidence }
              : index === 2
                ? { kind: 'source-generation', generationId: 'old', evidence }
                : { kind: 'family-cutover-source', payload: evidence },
        ],
      })
      await f.sink.commitUnit(output)
      const trace = createMigrationTraceQuery({ meta: f.meta })
      const result = await trace({
        operationId: h.operationId,
        table,
        key: [canonicalValue('present')],
        phase: 'pre-upgrade',
      })
      expect(result).toMatchObject({
        proof: 'unit-range',
        class: 'converted',
        targets: [],
        unit: { unitId: output.receipt.unitId },
      })
      expect(
        (await trace({ operationId: h.operationId, table, key: [canonicalValue('present')] }))
          .proof,
      ).toBe('not-found')
    }
  })
  test('an absent key inside a load-blocked interval is not blocked; present siblings are', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    await f.sink.commitUnit(unit('old-a'))
    const base = unit('blocked-range')
    const last = unit('last-c', 'c')
    await f.sink.commitUnit(
      sealUnit({
        ...base,
        rows: [
          { table: 'maintenance_state', rows: [...base.rows[0]!.rows, ...last.rows[0]!.rows] },
        ],
        receipt: {
          ...base.receipt,
          sources: [
            {
              ...base.receipt.sources[0]!,
              rows: 2,
              lastKey: last.receipt.sources[0]!.lastKey,
              counts: { converted: 2, preserved: 0, archived: 0, blocked: 0 },
            },
          ],
          targets: [{ ...base.receipt.targets[0]!, rows: 2 }],
          counts: { ...base.receipt.counts, converted: 2 },
        },
      }),
    )
    let calls = 0
    const meta = {
      ...f.meta,
      unitSources: async (input: Parameters<typeof f.meta.unitSources>[0]) =>
        (await f.meta.unitSources(input)).filter((row) => row.unitId === 'blocked-range'),
    }
    const trace = createMigrationTraceQuery({
      meta,
      replay: {
        async replay(query) {
          calls++
          const present = query.key[0]?.type === 'text' && query.key[0].value === 'c'
          return {
            runId: f.row.runId,
            sourceTable: query.table,
            sourcePhase: 'current',
            sourceKey: encodeMigrationKey(query.table, query.key),
            proof: present ? 'replay' : 'not-found',
            class: present ? 'converted' : null,
            dispositions: [],
            unit: null,
            targets: [],
            artifacts: [],
            restrictions: [],
            blocks: [],
            archive: null,
          }
        },
      },
    })
    expect(
      await trace({
        operationId: h.operationId,
        table: 'maintenance_state',
        key: [canonicalValue('b')],
      }),
    ).toMatchObject({ proof: 'not-found', class: null, blocks: [] })
    expect(
      await trace({
        operationId: h.operationId,
        table: 'maintenance_state',
        key: [canonicalValue('c')],
      }),
    ).toMatchObject({
      proof: 'replay',
      class: 'blocked',
      targets: [],
      blocks: [{ code: 'v3-target-load-rejected' }],
    })
    expect(
      await trace({
        operationId: h.operationId,
        table: 'maintenance_state',
        key: [canonicalValue('a')],
      }),
    ).toMatchObject({ proof: 'unit-range', class: 'blocked' })
    expect(calls).toBe(2)
    await expect(
      createMigrationTraceQuery({ meta })({
        operationId: h.operationId,
        table: 'maintenance_state',
        key: [canonicalValue('b')],
      }),
    ).rejects.toThrow('v3-trace-replay-required')
  })
  for (const grouped of [false, true]) {
    test(`a different target key shape automatically replays a ${grouped ? 'group' : 'chunk'}`, async () => {
      const f = await fixture(h)
      await f.sink.open(f.binding)
      const base = unit()
      const key = [canonicalValue('owner'), canonicalValue('item')]
      const sourceKey = encodeMigrationKey('old_pair', key)
      await f.sink.commitUnit(
        sealUnit({
          ...base,
          receipt: {
            ...base.receipt,
            unit: grouped
              ? {
                  kind: 'group',
                  rule: 'fixture',
                  index: 0,
                  firstGroup: 'group-a',
                  lastGroup: 'group-a',
                }
              : base.receipt.unit,
            sources: [
              {
                ...base.receipt.sources[0]!,
                table: 'old_pair',
                firstKey: sourceKey,
                lastKey: sourceKey,
              },
            ],
          },
        }),
      )
      let calls = 0
      const trace = createMigrationTraceQuery({
        meta: f.meta,
        sourceProbe: {
          async groupKeys() {
            return ['group-a']
          },
        },
        replay: {
          async replay(query) {
            calls++
            return {
              runId: f.row.runId,
              sourceTable: query.table,
              sourcePhase: 'current',
              sourceKey,
              proof: 'replay',
              class: 'converted',
              dispositions: [],
              unit: null,
              targets: [
                {
                  table: 'maintenance_state',
                  key: base.receipt.sources[0]!.firstKey!,
                  present: true,
                  probed: true,
                },
              ],
              artifacts: [],
              restrictions: [],
              blocks: [],
              archive: null,
            }
          },
        },
      })
      expect(await trace({ operationId: h.operationId, table: 'old_pair', key })).toMatchObject({
        proof: 'replay',
        targets: [{ table: 'maintenance_state', present: true }],
      })
      expect(calls).toBe(1)
    })
  }
  test('exact disposition wins over ranges and phase filters preserve composite key bytes', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    const keys = [canonicalValue('a:/:[]'), canonicalValue('汉字|b')]
    const sourceKey = encodeMigrationKey('legacy_composite', keys)
    const base = unit()
    const output = sealUnit({
      ...base,
      receipt: {
        ...base.receipt,
        sources: [
          {
            ...base.receipt.sources[0]!,
            table: 'legacy_composite',
            phase: 'pre-upgrade',
            firstKey: sourceKey,
            lastKey: sourceKey,
          },
        ],
      },
      dispositions: [
        {
          sourceTable: 'legacy_composite',
          sourceKey,
          sourcePhase: 'pre-upgrade',
          class: 'converted',
          kind: 'derived-id',
          targets: [{ table: 'maintenance_state', key: base.receipt.sources[0]!.firstKey! }],
          archive: null,
          rule: base.receipt.rule,
          decision: { code: 'derive', detail: { key: 'a' } },
        },
      ],
    })
    await f.sink.commitUnit(output)
    const trace = createMigrationTraceQuery({ meta: f.meta })
    const result = await trace({
      operationId: h.operationId,
      table: 'legacy_composite',
      key: keys,
      phase: 'pre-upgrade',
    })
    expect(result).toMatchObject({
      proof: 'row-disposition',
      sourceKey,
      targets: [{ present: true }],
    })
    expect(
      (await trace({ operationId: h.operationId, table: 'legacy_composite', key: keys })).proof,
    ).toBe('not-found')
  })
  test('overlapping groups require retained-source membership, and replay is explicit', async () => {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    const first = unit('group-1', 'a')
    await f.sink.commitUnit(
      sealUnit({
        ...first,
        receipt: {
          ...first.receipt,
          unit: {
            kind: 'group',
            rule: 'fixture',
            index: 0,
            firstGroup: 'group-a',
            lastGroup: 'group-a',
          },
        },
      }),
    )
    const second = unit('group-2', 'b')
    await f.sink.commitUnit(
      sealUnit({
        ...second,
        receipt: {
          ...second.receipt,
          unit: {
            kind: 'group',
            rule: 'fixture',
            index: 1,
            firstGroup: 'group-b',
            lastGroup: 'group-b',
          },
          sources: first.receipt.sources,
        },
      }),
    )
    const trace = createMigrationTraceQuery({
      meta: f.meta,
      sourceProbe: {
        async groupKeys() {
          return ['group-a']
        },
      },
    })
    const result = await trace({
      operationId: h.operationId,
      table: 'maintenance_state',
      key: [canonicalValue('a')],
    })
    expect(result).toMatchObject({ proof: 'group-unit', unit: { unitId: 'group-1' } })
    const replayed: MigrationTraceResult = { ...result, proof: 'replay' }
    let calls = 0
    const fallback = createMigrationTraceQuery({
      meta: f.meta,
      replay: {
        async replay() {
          calls++
          return replayed
        },
      },
    })
    expect(
      (await fallback({ operationId: h.operationId, table: 'missing', key: [canonicalValue('x')] }))
        .proof,
    ).toBe('not-found')
    expect(calls).toBe(0)
    expect(
      await fallback({
        operationId: h.operationId,
        table: 'missing',
        key: [canonicalValue('x')],
        replay: true,
      }),
    ).toEqual(replayed)
    expect(calls).toBe(1)
  })
})
