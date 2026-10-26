// Wave-2 integration binds the complete owner contributions before A publishes the same bootstrap assembly.
// No replacement rules or fixture lookups: coverage and receipts remain the full frozen 222-table proof.
import { expect } from 'bun:test'
import { composeConversionInput } from '@/bootstrap/conversionRules'
import {
  taskConversion,
  runConversion as runs,
} from '@/modules/task-execution/composition/conversion'
import { conversion as collaboration } from '@/modules/collaboration/composition/conversion'
import {
  conversion as resources,
  createSkillBootConversion,
  skillBootEnvironment,
} from '@/modules/resource-catalog/composition/conversion'
import { conversion as intent } from '@/modules/intent/composition/conversion'
import {
  conversion as contentConversion,
  convertFrozenSkillContent,
} from '@/platform/content/migration'
import { conversion as archives } from '@/platform/persistence/migration/archives'
import { conversion as generic } from '@/platform/persistence/migration/conversion/generic'
import { conversion as alignment } from '@/platform/persistence/migration/conversion/alignment'
import {
  conversion as urls,
  repositoryUrlEnvironment,
} from '@/modules/source-control/composition/conversion'
import { conversion as fusions } from '@/modules/knowledge-evolution/composition/conversion'
import { conversion as memory } from '@/modules/memory/composition/conversion'
import {
  conversion as schedules,
  scheduledPayloadEnvironment,
} from '@/modules/integration/infrastructure/migration/scheduledPayloadRule'
import {
  conversion as runtime,
  runtimeConfigEnvironment,
} from '@/modules/runtime-management/composition/conversion'
import { createBootUpgradeEnvironment } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
const conversionContributions = [
  taskConversion,
  runs,
  collaboration,
  resources,
  intent,
  contentConversion,
  archives,
  generic,
  alignment,
  urls,
  fusions,
  memory,
  schedules,
  runtime,
  createSkillBootConversion(convertFrozenSkillContent),
] as const

import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  decodeLogicalValue,
  encodeLogicalValue,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import {
  executeConversion,
  runConversion,
} from '@/platform/persistence/migration/conversion/engine'
import {
  resolveContributions,
  type ConversionInput,
} from '@/platform/persistence/migration/conversion/plan'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { unorderedDigest, valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  createUnitUniqueChecker,
  targetRegistryView,
  validateTargetRow,
} from '@/platform/persistence/migration/conversion/targetRows'
import type {
  DispositionClass,
  MigrationKey,
  SourceRow,
} from '@/platform/persistence/migration/conversion/types'
import type { V2Harness } from '../rfc395V2Harness'
import { V2MemorySink } from '../rfc395V2MemorySink'
import { FakeContentInventory } from '../rfc395V2/contentFixtures'

export async function integrationInput(
  h: V2Harness,
  options: Partial<
    Pick<ConversionInput, 'source' | 'preUpgradeSource' | 'preUpgradePreflight' | 'content'>
  > = {},
): Promise<ConversionInput> {
  const { sourceScope: _scope, ...input } = await h.input(conversionContributions, {
    candidateBuild: 'rfc395-v2-core-c',
    targetGeneration: 'dbg_rfc395_v2_core_c',
    chunkLimit: 17,
    content: new FakeContentInventory(),
    ...options,
  })
  const composed = { ...composeConversionInput(input), contributions: conversionContributions }
  const artifacts = new Map<string, Uint8Array>()
  const bootUpgradeFacts = await createBootUpgradeEnvironment([
    repositoryUrlEnvironment({ open: async () => null }),
    skillBootEnvironment(),
    scheduledPayloadEnvironment(),
    runtimeConfigEnvironment(),
  ]).capture({
    stage: 'freeze',
    source: {
      reader: composed.source,
      preflight: composed.preflight,
      preUpgrade: null,
      watermark: composed.preflight.watermark,
      evidenceRoot: null,
      close: async () => {},
    },
    root: {
      kind: 'app-home',
      root: h.sourceHarness.operationRoot,
      runsSupplied: false,
      objects: 'none',
    },
    content: composed.content,
    manifest: {
      version: 1,
      roots: [],
      files: [],
      objects: [],
      databaseTrees: [],
      digest: valueDigest([]),
    },
    readArtifact: async (name) => artifacts.get(name) ?? null,
    writeArtifact: async (name, bytes) => {
      artifacts.set(name, bytes)
    },
  })
  return { ...composed, bootUpgradeFacts }
}

export function assertCoverage(input: ConversionInput): void {
  expect(input.contributions).toBe(conversionContributions)
  expect(input.sourceScope).toBeUndefined()
  expect(frozenEpoch1Contract.tables).toHaveLength(222)
  const names = frozenEpoch1Contract.tables.map((table) => table.id).sort()
  expect(
    [
      ...input.preflight.tables
        .map((table) => table.table)
        .filter((table) => names.includes(table)),
      ...input.preflight.expectedAbsent,
    ].sort(),
  ).toEqual(names)
  const { rules } = resolveContributions(input)
  for (const rule of rules.filter((entry) => (entry.sourcePhase ?? 'current') === 'current'))
    for (const claim of rule.claims)
      expect(input.preflight.tables.some((entry) => entry.table === claim)).toBe(true)
  for (const table of input.preflight.tables)
    expect(
      rules.filter(
        (rule) =>
          (rule.sourcePhase ?? 'current') === 'current' && rule.claims.includes(table.table),
      ),
    ).toHaveLength(1)
  for (const rule of rules)
    for (const output of rule.produces)
      expect(
        input.targetRoster!.some(
          (entry) =>
            entry.table === output.table &&
            entry.sources.some((source) => rule.claims.includes(source)),
        ),
      ).toBe(true)
}

/** Raw inventory is independent of converter staging, including metadata and pre-upgrade rows. */
async function inventory(input: ConversionInput) {
  const result = new Map<string, string[]>()
  for (const [phase, reader, preflight] of [
    ['current', input.source, input.preflight],
    ['pre-upgrade', input.preUpgradeSource, input.preUpgradePreflight],
  ] as const) {
    if (!reader || !preflight) continue
    for (const table of preflight.tables) {
      // Before-upgrade business rows are represented by the upgraded current source;
      // only retired/metadata evidence is consumed again under the pre-upgrade phase.
      if (
        phase === 'pre-upgrade' &&
        input.preflight.tables.some((entry) => entry.table === table.table) &&
        frozenEpoch1Contract.tables.some((entry) => entry.id === table.table)
      )
        continue
      const keys: string[] = []
      const contract = preflight.contract?.tables.find((entry) => entry.id === table.table)
      let after: MigrationKey | null = null
      do {
        const chunk = await reader.readRawChunk(table.table, after, 53)
        keys.push(
          ...chunk.rows.map((row) => {
            // Raw pagination is ordinal on PostgreSQL. Business identity comes from
            // frozen key columns, even when an unrelated JSON column is malformed.
            const key = contract
              ? contract.migrationKey.map((name) => {
                  const cell = row.cells[name]!
                  let value = decodeLogicalValue(cell.value)
                  if (typeof value === 'string') {
                    if (/^(smallint|integer|bigint)$/.test(cell.storageClass)) value = BigInt(value)
                    else if (cell.storageClass === 'boolean')
                      value = value === 'true' || value === 't'
                    else if (/^(real|double precision|numeric(?:\(.*\))?)$/.test(cell.storageClass))
                      value = Number(value)
                    else if (cell.storageClass === 'bytea' && value.startsWith('\\x'))
                      value = Buffer.from(value.slice(2), 'hex')
                  }
                  return encodeLogicalValue(
                    table.table,
                    contract.columns.find((column) => column.name === name)!,
                    value,
                  )
                })
              : row.key
            return encodeMigrationKey(table.table, key)
          }),
        )
        if (chunk.rows.length < 53) break
        after = chunk.lastKey
      } while (after)
      expect(keys).toHaveLength(table.rows)
      expect(new Set(keys).size).toBe(keys.length)
      result.set(JSON.stringify([phase, table.table]), keys.sort())
    }
  }
  return result
}

/** First run through runConversion; replay through its trace entry to prove per-row ownership. */
export async function convertIntegration(input: ConversionInput, sink = new V2MemorySink()) {
  assertCoverage(input)
  const expected = await inventory(input)
  const summary = await runConversion(input, sink)
  expect(summary.plan.coverage).toBe('complete')
  expect(summary.plan.blocks).toEqual([])
  const digests = [...sink.units.values()].map((unit) => unit.receipt.digest)
  const rules = resolveContributions(input).rules
  const seen = new Map<string, string[]>()
  const sourceRows = new Map<string, SourceRow[]>()
  const replay = await executeConversion(input, sink, {
    unit(output, rows) {
      const rule = rules.find((entry) => entry.ref.id === output.receipt.rule.id)!
      for (const receipt of output.receipt.sources) {
        const members = rows.filter(
          (row) => row.table === receipt.table && row.phase === receipt.phase,
        )
        const key = JSON.stringify([receipt.phase, receipt.table])
        seen.set(key, [...(seen.get(key) ?? []), ...members.map((row) => row.encodedKey)])
        if (receipt.phase === 'current')
          sourceRows.set(receipt.table, [...(sourceRows.get(receipt.table) ?? []), ...members])
        expect(receipt.rows).toBe(members.length)
        expect(receipt.keyDigest).toBe(unorderedDigest(members.map((row) => row.encodedKey)))
        const outcomes: Record<DispositionClass, number> = {
          converted: 0,
          preserved: 0,
          archived: 0,
          blocked: 0,
        }
        for (const row of members) {
          const decisions = output.dispositions.filter((item) => item.sourceKey === row.encodedKey)
          // Multiple evidence notes are allowed; every source row has one final disposition class.
          const outcome = decisions.some((item) => item.class === 'blocked')
            ? 'blocked'
            : (decisions.at(-1)?.class ?? rule.disposition ?? 'converted')
          outcomes[outcome]++
          if (outcome === 'blocked')
            expect(
              output.blocks.some(
                (block) =>
                  block.sourceKey === row.encodedKey ||
                  (block.scope === 'table' && block.sourceTable === row.table) ||
                  block.scope === 'global',
              ),
            ).toBe(true)
        }
        expect(outcomes).toEqual(receipt.counts)
      }
    },
  })
  expect(replay).toEqual(summary)
  expect([...sink.units.values()].map((unit) => unit.receipt.digest)).toEqual(digests)
  expect(
    summary.tableReceipts
      .map((receipt) => JSON.stringify([receipt.sourcePhase, receipt.sourceTable]))
      .sort(),
  ).toEqual([...expected.keys()].sort())
  for (const receipt of summary.tableReceipts) {
    const key = JSON.stringify([receipt.sourcePhase, receipt.sourceTable])
    const actual = seen.get(key) ?? []
    expect(actual.length).toBe(new Set(actual).size)
    expect(expected.has(key)).toBe(true)
    expect([...actual].sort()).toEqual(expected.get(key)!)
    expect(receipt.rowsRead).toBe(actual.length)
    expect(Object.values(receipt.counts).reduce((a, b) => a + b, 0)).toBe(actual.length)
    expect(receipt.keyDigest).toBe(unorderedDigest(actual))
    const parts = [...sink.units.values()]
      .flatMap((unit) => unit.receipt.sources)
      .filter((part) => part.table === receipt.sourceTable && part.phase === receipt.sourcePhase)
    for (const kind of ['converted', 'preserved', 'archived', 'blocked'] as const)
      expect(receipt.counts[kind]).toBe(parts.reduce((sum, part) => sum + part.counts[kind], 0))
  }
  const target = targetRegistryView(input.target)
  const unique = createUnitUniqueChecker(target)
  for (const unit of sink.units.values())
    for (const group of unit.rows)
      for (const row of group.rows) {
        validateTargetRow(target, group.table, row)
        unique(group.table, row)
      }
  for (const disposition of summary.historyOnly) {
    expect(disposition.history).toBeDefined()
    expect(disposition.history!.taskId).not.toBe('')
    expect(disposition.history!.missingFields.length).toBeGreaterThan(0)
    expect(disposition.archive !== null || disposition.targets.length > 0).toBe(true)
  }
  await input.source.assertUnchanged(input.preflight)
  return { input, summary, sink, sourceRows }
}
export type IntegrationResult = Awaited<ReturnType<typeof convertIntegration>>
