// RFC-395 V3-R: authored for T18; offline target receipts never activate runtime wiring.
import { expect, setDefaultTimeout, test } from 'bun:test'
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
import {
  type MigrationRunInit,
  VALIDATION_CHECKS,
} from '@/platform/persistence/migration/run/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { createTargetLoader } from '@/platform/persistence/migration/target/loader'
import {
  createMigrationMetaStore,
  collectMigrationRows,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  exportMigrationReceipts,
  type MigrationReceiptFiles,
} from '@/modules/system-operations/infrastructure/epochSwitch/receiptExport'

import { historyRestrictionsDigest } from '@/modules/system-operations/infrastructure/epochSwitch/historyRestrictions'

// The first case in a process installs the source and target fixtures: 28.2 s on Ubuntu CI and 19.1 s on
// the macOS nightly before the shared fixture templates, under 1 s locally after them; allow 30 s.
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

describeV3Providers('RFC-395 V3 write-once receipts', (h) => {
  async function exported() {
    const f = await fixture(h)
    await f.sink.open(f.binding)
    const base = unit()
    const sourceKey = base.receipt.sources[0]!.firstKey!
    await f.sink.commitUnit(
      sealUnit({
        ...base,
        dispositions: [
          {
            sourceTable: 'maintenance_state',
            sourceKey,
            sourcePhase: 'current',
            class: 'converted',
            kind: 'derived-id',
            rule: base.receipt.rule,
            targets: [{ table: 'maintenance_state', key: sourceKey }],
            archive: null,
            decision: null,
          },
        ],
        artifacts: [
          {
            sourceTable: 'maintenance_state',
            sourceKey,
            sourceColumn: 'value',
            originalReference: 'file',
            target: {
              table: 'maintenance_state',
              key: sourceKey,
              contentId: null,
              backend: 'local-file',
            },
            bytes: { sha256: 'a'.repeat(64), size: 1 },
            publication: 'not-required',
            missing: null,
          },
        ],
      }),
    )
    await f.sink.finish(f.summary)
    const payload = {
      version: 1 as const,
      runId: f.row.runId,
      validatedAt: 123,
      passed: true,
      checks: VALIDATION_CHECKS.map((check) => ({ check, passed: true, detail: null })),
      blocks: [],
      contentDrift: [],
      historyRestrictionsDigest: historyRestrictionsDigest([]),
      probes: [],
    }
    await h.target.transaction((tx) =>
      f.meta.withConnection(tx).saveValidation({ ...payload, digest: valueDigest(payload) }),
    )
    const request = {
      target: h.target,
      meta: f.meta,
      runId: f.row.runId,
      operationRoot: h.operationRoot,
    }
    return { ...f, request, receipt: await exportMigrationReceipts(request) }
  }
  test('equal re-export is a no-op and NDJSON is complete against meta rows', async () => {
    const f = await exported()
    expect(await exportMigrationReceipts(f.request)).toEqual(f.receipt)
    const saved = await f.meta.receiptExport(f.row.runId)
    const document = JSON.parse(Buffer.from(saved!.bytes!).toString()) as MigrationReceiptFiles
    for (const [name, contents] of Object.entries(document.files))
      expect(await readFile(join(f.receipt.path!, name), 'utf8')).toBe(contents)
    expect(
      document.files['units.ndjson']
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(await collectMigrationRows(f.meta.units(f.row.runId)))
    expect(
      document.files['dispositions.ndjson']
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(await collectMigrationRows(f.meta.dispositions({ runId: f.row.runId })))
    expect(
      document.files['artifacts.ndjson']
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(await collectMigrationRows(f.meta.artifacts({ runId: f.row.runId })))
    expect(await readFile(join(f.receipt.path!, 'receipt.digest'), 'utf8')).toBe(
      `${f.receipt.digest}\n`,
    )
  })
  test('different existing file or database bytes throw and remain untouched', async () => {
    const f = await exported()
    const path = join(f.receipt.path!, 'units.ndjson')
    await writeFile(path, 'conflict')
    await expect(exportMigrationReceipts(f.request)).rejects.toThrow('v3-receipt-export-conflict')
    expect(await readFile(path, 'utf8')).toBe('conflict')
    await expect(
      h.target.transaction((tx) =>
        f.meta
          .withConnection(tx)
          .saveExport(f.row.runId, { ...f.receipt, bytes: Buffer.from('different') }),
      ),
    ).rejects.toThrow('v3-receipt-export-conflict')
  })
  test('hosted export stores the same versioned bytes without a file path', async () => {
    const f = await exported()
    const hosted = await exportMigrationReceipts({ ...f.request, operationRoot: null })
    expect(hosted).toEqual({ path: null, digest: f.receipt.digest })
    expect((await f.meta.receiptExport(f.row.runId))?.bytes).not.toBeNull()
  })
  test('empty and truncated final files and an abandoned temporary file do not block retry', async () => {
    const f = await exported()
    const saved = (await f.meta.receiptExport(f.row.runId))!
    const document = JSON.parse(Buffer.from(saved.bytes!).toString()) as MigrationReceiptFiles
    await writeFile(join(f.receipt.path!, 'receipt.json'), '')
    await writeFile(
      join(f.receipt.path!, 'units.ndjson'),
      document.files['units.ndjson'].slice(0, 11),
    )
    await writeFile(join(f.receipt.path!, 'receipt.digest'), f.receipt.digest.slice(0, 9))
    const orphan = 'receipt.json.interrupted.tmp'
    await writeFile(join(f.receipt.path!, orphan), 'partial temporary bytes')
    expect(await exportMigrationReceipts(f.request)).toEqual(f.receipt)
    for (const [name, contents] of Object.entries(document.files))
      expect(await readFile(join(f.receipt.path!, name), 'utf8')).toBe(contents)
    expect(await readFile(join(f.receipt.path!, 'receipt.digest'), 'utf8')).toBe(
      `${f.receipt.digest}\n`,
    )
    expect((await readdir(f.receipt.path!)).filter((name) => name.endsWith('.tmp'))).toEqual([
      orphan,
    ])
    expect((await f.meta.receiptExport(f.row.runId))!.bytes).toEqual(saved.bytes)
  })
})
