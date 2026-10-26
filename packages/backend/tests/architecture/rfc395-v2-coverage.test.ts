import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writerDrainLookup } from '@/platform/persistence/migration/archives/writerDrain'
import { buildLookups } from '@/platform/persistence/migration/conversion/lookups'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import { conversionContributions } from '@/bootstrap/conversionRules'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import roster from '@/bootstrap/targetSchemaRoster.json'
import dispositions from '@/platform/persistence/migration/epoch1/tableDispositions.json'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  sourceMetadataTables,
  sourceTableDispositions,
} from '@/platform/persistence/migration/sourceDispositions'
import type {
  SourcePreflight,
  SourceTableDisposition,
} from '@/platform/persistence/migration/sourceTypes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { genericCopyTables } from '@/platform/persistence/migration/conversion/generic/tables'
import { sourceTableRules } from '@/platform/persistence/migration/conversion/generic/sourceTables'
import { resolveContributions } from '@/platform/persistence/migration/conversion/plan'
import { createUnitCollector } from '@/platform/persistence/migration/conversion/receipts'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import { deterministicChildId } from '@/platform/persistence/migration/conversion/ids'
import { emptyV2Content } from '../helpers/rfc395V2Harness'
import type { UnitOutput } from '@/platform/persistence/migration/conversion/types'

function coverageViolations(
  rules: readonly ConversionRule[],
  sources: readonly string[],
  targets = roster,
): string[] {
  const errors: string[] = []
  for (const table of sources) {
    const count = rules.flatMap((rule) => rule.claims).filter((claim) => claim === table).length
    if (count !== 1) errors.push(`claims:${table}:${count}`)
  }
  for (const rule of rules) {
    for (const claim of rule.claims)
      if (!sources.includes(claim)) errors.push(`extra-claim:${claim}`)
    for (const output of rule.produces)
      if (
        !targets.some(
          (entry) =>
            entry.table === output.table &&
            entry.sources.some((source) => rule.claims.includes(source)),
        )
      )
        errors.push(`produces:${rule.ref.id}:${output.table}`)
  }
  return errors.sort()
}

function preflight(tables: readonly SourceTableDisposition[]): SourcePreflight {
  return {
    version: 1,
    kind: 'logical-artifact',
    sourceVersion: 'coverage',
    contract: frozenEpoch1Contract,
    fingerprint: {
      version: 1,
      evidence: 'legacy-logical-artifact',
      provider: 'sqlite',
      catalog: [],
      catalogDigest: 'catalog',
      journal: [],
      journalEntryCount: 0,
      tableRows: Object.fromEntries(tables.map((entry) => [entry.physicalTable, entry.rows])),
      digest: 'fingerprint',
    },
    sourceGenerationId: 'source',
    identityHighWater: [],
    identityEvidence: 'not-recorded-by-epoch1-artifact',
    watermark: 'watermark',
    requiresOfflineUpgrade: false,
    tables,
    expectedAbsent: [],
    content: [],
  }
}

function frozenCatalog(provider: 'sqlite' | 'postgresql'): SourcePreflight {
  const base = preflight([])
  const present = frozenEpoch1Contract.tables.filter((table) => table.providerTables[provider])
  const fingerprint = {
    ...base.fingerprint,
    provider,
    tableRows: Object.fromEntries(present.map((table) => [table.id, 0])),
  }
  return {
    ...base,
    fingerprint,
    tables: sourceTableDispositions({ source: fingerprint, contract: frozenEpoch1Contract }),
    expectedAbsent: frozenEpoch1Contract.tables
      .filter((table) => !table.providerTables[provider])
      .map((table) => table.id),
  }
}
function resolve(preflight: SourcePreflight) {
  return resolveContributions({
    preflight,
    target: persistenceSchema,
    contributions: conversionContributions,
  })
}

describe('RFC-395 V2 source coverage', () => {
  test('all 222 frozen tables have exactly one owner and only roster-approved products', () => {
    const sources = frozenEpoch1Contract.tables.map((table) => table.id)
    expect(sources).toHaveLength(222)
    expect(dispositions.map((table) => table.table).sort()).toEqual([...sources].sort())
    expect(genericCopyTables).toHaveLength(169)
    expect(coverageViolations(resolve(frozenCatalog('sqlite')).rules, sources)).toEqual([])
  })
  test('frozen PostgreSQL claims only present tables and explicitly packages all six expected absences', async () => {
    const catalog = frozenCatalog('postgresql')
    expect(catalog.expectedAbsent).toEqual([
      'code_artifacts',
      'code_fix_attempts',
      'code_mr_leases',
      'code_produced_mrs',
      'code_publish_intents',
      'code_work_observations',
    ])
    const resolved = resolve(catalog)
    expect(
      coverageViolations(
        resolved.rules,
        catalog.tables.map((table) => table.table),
      ),
    ).toEqual([])
    expect(
      resolved.rules
        .flatMap((rule) => rule.claims)
        .some((table) => catalog.expectedAbsent.includes(table)),
    ).toBe(false)
    const outputs: UnitOutput[] = []
    const target = targetRegistryView(persistenceSchema)
    const scratch = mkdtempSync(join(tmpdir(), 'rfc395-coverage-'))
    const staged = createStagingStore(scratch)
    try {
      // Even an empty history must prove the global writer-drain fact. Use the
      // production lookup builder; an absent global row remains a visible block.
      const lookup = await buildLookups([writerDrainLookup], staged)
      for (const rule of resolved.rules.filter((rule) => rule.ref.id.startsWith('history/'))) {
        const collector = createUnitCollector({
          rule,
          sourceRows: [],
          sourceVersion: catalog.sourceVersion,
          sourceContract: catalog.contract!.digest,
          target,
          topology: persistenceSchema.tables.map((table) => table.id),
        })
        await rule.convert(
          { rows: new Map(rule.claims.map((table) => [table, []])), groupKeys: [] },
          {
            sourceVersion: catalog.sourceVersion,
            sourceProvider: 'postgresql',
            sourceGenerationId: catalog.sourceGenerationId,
            preflight: catalog,
            planTime: 123,
            target,
            lookup,
            ids: { child: deterministicChildId },
            content: emptyV2Content,
            out: collector.out,
          },
        )
        outputs.push(
          collector.finish({
            unit: { kind: 'group', rule: rule.ref.id, index: 0, firstGroup: null, lastGroup: null },
            unitId: rule.ref.id,
            lookups: [],
          }),
        )
      }
      expect(outputs.flatMap((output) => output.blocks)).toContainEqual(
        expect.objectContaining({ code: 'v2-writer-state-missing' }),
      )
    } finally {
      staged.close()
      rmSync(scratch, { recursive: true, force: true })
    }
    const rows = outputs
      .flatMap((output) => output.rows)
      .filter((group) => group.table === 'code_history_archives')
      .flatMap((group) => group.rows)
    expect(rows).toHaveLength(13)
    for (const table of catalog.expectedAbsent) {
      expect(rows.filter((row) => row.source_table === table && row.row_count === 0)).toHaveLength(
        1,
      )
      expect(
        outputs
          .flatMap((output) => output.archives)
          .filter((archive) => archive.sourceTable === table && archive.rows === 0),
      ).toHaveLength(1)
      expect(outputs.flatMap((output) => output.records)).toContainEqual(
        expect.objectContaining({
          kind: 'decision',
          code: 'v2-code-history-originally-absent-table',
          payload: expect.objectContaining({ table }),
        }),
      )
    }
    const unexplained = resolve({ ...catalog, expectedAbsent: catalog.expectedAbsent.slice(1) })
    expect(
      coverageViolations(
        unexplained.rules,
        catalog.tables.map((table) => table.table),
      ),
    ).toContain(`extra-claim:${catalog.expectedAbsent[0]}`)
  })
  test('negative missing, duplicate, within-rule duplicate, foreign claim and foreign product fixtures fail', () => {
    const base: ConversionRule = {
      ref: { id: 'fixture', version: 1 },
      owner: 'fixture',
      claims: ['users'],
      produces: [{ table: 'users' }],
      lookups: [],
      unit: { kind: 'source-chunk', table: 'users' },
      convert() {},
    }
    expect(coverageViolations([base], ['users'])).toEqual([])
    expect(coverageViolations([], ['users'])).toEqual(['claims:users:0'])
    expect(
      coverageViolations([base, { ...base, ref: { id: 'other', version: 1 } }], ['users']),
    ).toEqual(['claims:users:2'])
    expect(coverageViolations([{ ...base, claims: ['users', 'users'] }], ['users'])).toEqual([
      'claims:users:2',
    ])
    expect(coverageViolations([{ ...base, claims: ['users', 'foreign'] }], ['users'])).toEqual([
      'extra-claim:foreign',
    ])
    expect(
      coverageViolations([{ ...base, produces: [{ table: 'task_definitions' }] }], ['users']),
    ).toEqual(['produces:fixture:task_definitions'])
    expect(
      coverageViolations([{ ...base, produces: [{ table: 'imaginary' }] }], ['users']),
    ).toEqual(['produces:fixture:imaginary'])
  })
  test('every metadata, retired, decided extra, blocked extra and dropped physical kind has a handler', () => {
    const metadata: SourceTableDisposition[] = sourceMetadataTables.map((physicalTable) => ({
      table: physicalTable.replace(/^agent_workflow_meta\./, ''),
      physicalTable,
      rows: 0,
      disposition: 'metadata',
      destination: { kind: 'migration-records', records: ['migration'] },
      reason: 'V1 metadata',
    }))
    // The two provider namespaces are alternatives, never duplicate logical tables in one source.
    const unique = [...new Map(metadata.map((entry) => [entry.table, entry])).values()]
    const retired: SourceTableDisposition = {
      table: 'recent_repos',
      physicalTable: 'recent_repos',
      rows: 2,
      disposition: 'archived',
      destination: { kind: 'archive' },
      reason: 'frozen historical table: archive pre-upgrade rows before the chain removes it',
    }
    const extra: SourceTableDisposition = {
      ...retired,
      table: 'operator_extra',
      physicalTable: 'operator_extra',
      rows: 0,
      reason: 'reviewed catalog-bound decision',
    }
    const unknown: SourceTableDisposition = {
      ...extra,
      table: 'unknown',
      physicalTable: 'unknown',
      disposition: 'blocked',
      destination: { kind: 'blocked' },
      reason: 'unknown empty table requires a decision',
    }
    const before = { ...retired, table: 'dropped_by_chain', physicalTable: 'dropped_by_chain' }
    const current = [...unique, retired, extra, unknown]
    const rules = sourceTableRules({
      preflight: preflight(current),
      preUpgradePreflight: preflight([before]),
      target: persistenceSchema,
    })
    for (const entry of current)
      expect(
        rules.filter((rule) => rule.sourcePhase === 'current' && rule.claims.includes(entry.table)),
      ).toHaveLength(1)
    expect(
      rules.filter(
        (rule) => rule.sourcePhase === 'pre-upgrade' && rule.claims.includes(before.table),
      ),
    ).toHaveLength(1)
    expect(
      rules.every((rule) => rule.produces.length === 0 && rule.unit.kind === 'raw-chunk'),
    ).toBe(true)
    expect(rules.find((rule) => rule.claims.includes('unknown'))!.ref.id).toContain('/blocked/')
    const noDecision = {
      ...extra,
      disposition: 'preserved' as const,
      destination: { kind: 'business' as const, tables: ['users'] },
    }
    expect(
      sourceTableRules({ preflight: preflight([noDecision]), target: persistenceSchema })[0]!.ref
        .id,
    ).toContain('/blocked/')
    expect(
      coverageViolations(
        rules.filter((rule) => rule.sourcePhase === 'current').slice(1),
        current.map((entry) => entry.table),
      ),
    ).not.toEqual([])
  })
})

test('activation registers final B, P, X and T rules and dependencies', () => {
  const { rules, lookups, validators } = resolve(frozenCatalog('sqlite'))
  for (const id of [
    'source-control/boot-repository-urls',
    'knowledge-evolution/boot-fusion-provenance',
    'memory/boot-fused-provenance',
    'integration/boot-scheduled-payload',
    'runtime-management/boot-runtime-config',
  ])
    expect(rules.find((rule) => rule.ref.id === id)?.ref.version).toBe(2)
  expect(
    rules.find((rule) => rule.ref.id === 'resource-catalog/boot-skills')?.produces,
  ).toContainEqual({ table: 'skill_content_entries' })
  expect(
    rules.some((rule) => ['content/skills', 'content/skill_versions'].includes(rule.ref.id)),
  ).toBe(false)
  for (const id of ['resource-catalog/bundle-applies-profile', 'intent/apply-journal-profile'])
    expect(rules.find((rule) => rule.ref.id === id)?.ref.version).toBe(3)
  expect(rules.find((rule) => rule.ref.id === 'task-execution/task')?.ref.version).toBe(4)
  expect(
    validators.find(
      (validator) => validator.ref.id === 'task-execution/unsettled-workspace-preparation',
    )?.ref.version,
  ).toBe(3)
  const catalog = lookups.find((lookup) => lookup.key.id === 'content/catalog')
  expect(catalog?.key.version).toBe(4)
  expect(JSON.stringify(catalog)).toContain('collaboration_gate_operations')
})
