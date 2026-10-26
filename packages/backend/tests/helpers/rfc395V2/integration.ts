// Stage C uses the real bootstrap assembly. No replacement rules, lookups or sourceScope.
import { expect } from 'bun:test'
import {
  composeConversionInput,
  conversionContributions,
  composeBootUpgradeEnvironment,
} from '@/bootstrap/conversionRules'
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
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { projectConvertedClarifyAnswers } from '@/modules/collaboration/infrastructure/migration/clarifyRule'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { projectClarifyAnswers } from '@/modules/collaboration/domain/clarifyAnswers'
import { clarifyAnswerContentForPrompt } from '@/modules/collaboration/domain/clarifyAnswerContent'
import { decodeAgentSkillReferenceKey } from '@/modules/resource-catalog/domain/agentReferenceKey'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/migration/oracle/snapshot'
import { oracleRow } from '@/modules/task-execution/infrastructure/migration/run/source'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import type { RunSlot } from '@/modules/task-execution/domain/runSelection/slots'
import type { V2Harness } from '../rfc395V2Harness'
import { V2MemorySink } from '../rfc395V2MemorySink'
import { FakeContentInventory } from './contentFixtures'
import { assertTaskProjection } from './taskFixtures'

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
  const artifacts = new Map<string, Uint8Array>()
  const bootUpgradeFacts = await composeBootUpgradeEnvironment({
    async open() {
      return null
    },
  }).capture({
    stage: 'plan',
    source: {
      reader: input.source,
      preflight: input.preflight,
      preUpgrade: null,
      watermark: input.preflight.watermark,
      evidenceRoot: null,
      async close() {},
    },
    content: input.content,
    root: {
      kind: 'app-home',
      root: h.sourceHarness.operationRoot,
      runsSupplied: false,
      objects: 'none',
    },
    manifest: {
      version: 1,
      roots: [],
      files: [],
      objects: [],
      databaseTrees: [],
      digest: valueDigest([]),
    },
    async readArtifact(name) {
      return artifacts.get(name) ?? null
    },
    async writeArtifact(name, bytes) {
      artifacts.set(name, bytes)
    },
  })
  return composeConversionInput({ ...input, bootUpgradeFacts })
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

export function assertTaskDtos(result: IntegrationResult): void {
  for (const task of result.sourceRows.get('tasks') ?? [])
    if (
      ['pending', 'running', 'awaiting_human', 'awaiting_review', 'interrupted'].includes(
        String(task.values.status),
      )
    )
      assertTaskProjection(
        { ...result, facts: new Map(), mounts: new Map() },
        String(task.values.id),
      )
}

export function assertClarifyReplay(result: IntegrationResult): void {
  for (const source of result.sourceRows.get('clarify_rounds') ?? []) {
    const round = result.sink.rows('clarify_rounds').find((row) => row.id === source.values.id)!
    const rows = (table: string) =>
      result.sink.rows(table).filter((row) => row.round_id === round.id)
    const actual = projectConvertedClarifyAnswers(
      round,
      rows('clarify_answers'),
      rows('clarify_answer_drafts'),
      rows('clarify_answer_attributions'),
    )
    const old = decodeLegacyClarifyAnswerColumns({
      answersJson: source.values.answers_json as string | null,
      draftAnswersJson: source.values.draft_answers_json as string | null,
      answerAttributionsJson: source.values.answer_attributions_json as string | null,
    })
    const projection = projectClarifyAnswers(old.state)
    expect(actual.answers).toEqual(projection.answers)
    expect(actual.draftAnswers).toEqual(projection.draftAnswers)
    expect(actual.answerAttributions).toEqual(projection.answerAttributions)
    const targetProjection = projectClarifyAnswers(actual.state)
    expect(targetProjection.answerMap()).toEqual(projection.answerMap())
    expect(targetProjection.effectiveAnswers()).toEqual(projection.effectiveAnswers())
    for (const question of JSON.parse(String(source.values.questions_json)) as { id: string }[])
      expect(targetProjection.firstAnswer(question.id)).toEqual(projection.firstAnswer(question.id))
    expect(actual.detailAnswers).toEqual(old.detailAnswers)
    expect(clarifyAnswerContentForPrompt(actual.content)).toEqual(
      clarifyAnswerContentForPrompt(old.content),
    )
  }
}

export function assertAgentReplay(result: IntegrationResult): void {
  for (const source of result.sourceRows.get('agents') ?? []) {
    const ordered = (table: string) =>
      [...result.sink.rows(table)]
        .filter((row) => row.agent_id === source.values.id)
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    for (const [column, table, key] of [
      ['depends_on', 'agent_dependencies', 'dependency_agent_id'],
      ['mcp', 'agent_mcp_refs', 'mcp_id'],
      ['plugins', 'agent_plugin_refs', 'plugin_id'],
    ] as const)
      expect(ordered(table).map((row) => row[key])).toEqual(
        JSON.parse(String(source.values[column])),
      )
    expect(
      ordered('agent_skill_refs').map((row) =>
        decodeAgentSkillReferenceKey(String(row.reference_key)),
      ),
    ).toEqual(JSON.parse(String(source.values.skills)))
  }
}

export interface ExpectedRun {
  readonly id: string
  readonly taskId: string
  readonly slot: RunSlot
  readonly seq: number
  readonly container: string | null
  readonly scope: string
  readonly iteration: number
}
export async function assertRunOracle(result: IntegrationResult, expected: readonly ExpectedRun[]) {
  const sources = result.sourceRows.get('node_runs') ?? []
  expect(sources.map((row) => row.values.id).sort()).toEqual(expected.map((row) => row.id).sort())
  const oracleRows = expected.map((spec) => {
    const source = sources.find((row) => row.values.id === spec.id)!
    const target = result.sink.rows('node_runs').find((row) => row.id === spec.id)!
    expect(target).toMatchObject({
      seq: spec.seq,
      slot_key: encodeCanonicalRunSlot(spec.slot),
      container_run_id: spec.container,
      scope_path: spec.scope,
      iteration: spec.iteration,
      generation_seq: 0,
      record_mode: 'executable',
    })
    return oracleRow(source, spec.seq, {
      runId: spec.id,
      taskId: spec.taskId,
      containerRunId: spec.container,
      scopePath: spec.scope,
      iteration: spec.iteration,
      quality: 'recorded',
    })
  })
  const oracle = createRunSelectionOracleSnapshot(oracleRows)
  const slots = new Map(
    expected.map((row) => [JSON.stringify([row.taskId, encodeCanonicalRunSlot(row.slot)]), row]),
  )
  expect(result.sink.rows('node_run_selections')).toHaveLength(slots.size)
  let differences70 = 0
  for (const spec of slots.values()) {
    const legacy = await oracle.current(spec.taskId, spec.slot)
    expect(legacy).not.toBeNull()
    let selected = legacy!.id
    const oldSlot = expected.find((row) => row.id === selected)!.slot
    if (encodeCanonicalRunSlot(oldSlot) !== encodeCanonicalRunSlot(spec.slot)) {
      expect(spec.slot.kind).toBe('workgroup-host')
      expect(oldSlot.kind === 'synthetic' && oldSlot.syntheticKind === 'wg-gate').toBe(true)
      if (spec.slot.kind !== 'workgroup-host') throw new Error('unregistered oracle difference')
      const family = await oracle.familyHistory(spec.taskId, {
        nodeId: spec.slot.nodeId,
        shardKey: spec.slot.shardKey,
      })
      expect(family.at(-1)!.id).toBe(legacy!.id)
      selected = family
        .filter(
          (row) =>
            encodeCanonicalRunSlot(expected.find((entry) => entry.id === row.id)!.slot) ===
            encodeCanonicalRunSlot(spec.slot),
        )
        .at(-1)!.id
      differences70++
    }
    const target = result.sink
      .rows('node_run_selections')
      .find(
        (row) => row.task_id === spec.taskId && row.slot_key === encodeCanonicalRunSlot(spec.slot),
      )!
    expect(target.selected_run_id).toBe(selected)
  }
  return differences70
}

export const sinkDigests = (sink: V2MemorySink) =>
  [...sink.units.values()]
    .map((unit): readonly [string, string] => [unit.receipt.unitId, unit.receipt.digest])
    .sort(([a], [b]) => a!.localeCompare(b!))
export const rowsDigest = (sink: V2MemorySink) =>
  valueDigest(
    [...sink.units.values()]
      .flatMap((unit) => unit.rows)
      .map((group) => [
        group.table,
        group.rows.map((row: TargetRow) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array
                ? [...value]
                : typeof value === 'bigint'
                  ? String(value)
                  : value,
            ]),
          ),
        ),
      ]),
  )
