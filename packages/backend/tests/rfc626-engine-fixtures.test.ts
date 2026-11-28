// RFC-626 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md §3.1–§3.3, §4.3): the
// fixtures the engine and target tests of this RFC share. They exist so those tests can say
// what they mean with small synthetic rules instead of the whole assembly:
//
//   - a frozen source held in memory (real frozen epoch-1 table contracts, rows given by the
//     test) that reads strictly and, like the real readers, fails the strict read on a row the
//     frozen codec rejects and offers the raw channel instead;
//   - a small synthetic target schema with every kind of reference finalize has to resolve;
//   - a sink that records what the engine commits and can refuse target rows;
//   - stand-ins for the module contributions the engine only calls (task facts, settlers,
//     expansion).
//
// Nothing here knows how the engine is implemented; the few tests below only pin that the
// fixtures themselves behave like the things they stand in for.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { column as c, foreignKey, retention } from '@/platform/persistence/schema/dsl'
import { expr } from '@/platform/persistence/schema/targetDefinition'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'
import type { LogicalTableContract } from '@/platform/persistence/schema/contractTypes'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  compareCanonicalLogicalKeys,
  decodeLogicalValue,
  encodeLogicalRow,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { sourceChunk } from '@/platform/persistence/migration/sourceReader'
import type {
  DecodedSourceRow,
  DecodedSourceValue,
  RawSourceRow,
  SourcePreflight,
  SourceTableDisposition,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import {
  executionClass,
  TASK_FACTS,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ConversionInput,
  ConversionPlanSection,
} from '@/platform/persistence/migration/conversion/plan'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { MigrationRunInit } from '@/platform/persistence/migration/run/types'
import type {
  ConversionContribution,
  ConversionRule,
  SettlementContribution,
} from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionRunBinding,
  ConversionSink,
  ConversionSinkOpened,
  ConversionSummary,
} from '@/platform/persistence/migration/conversion/sink'
import type {
  EncodedKey,
  MigrationRecord,
  RowDisposition,
  TargetLoadRejection,
  TargetRow,
  TaskSettlement,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import { emptyV2Content } from './helpers/rfc395V2Harness'
import { r2Owner, r2Registry } from './helpers/rfc395R2Schema'

// ---- synthetic target ---------------------------------------------------------------------

/** The statuses a task can be stored with; the first five are the ones that can continue. */
export const TASK_STATUSES = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
  'interrupted',
  'done',
  'failed',
  'canceled',
] as const
export const CANCELABLE_STATUSES: readonly string[] = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
]

export const fxUsers = r2Owner.table({
  id: 'fx_users',
  schemaSymbol: 'fxUsers',
  retention: retention.business,
  columns: { id: c.id('id', { primary: true }), name: c.text('name') },
})
/**
 * `owner_id` and `reviewer_id` are declared `set null` (the reference is given up, the row
 * stays); `parent_id` has no way to be kept, so a task without its parent leaves the target.
 */
export const fxTasks = r2Owner.table({
  id: 'fx_tasks',
  schemaSymbol: 'fxTasks',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    status: c.enum('status', TASK_STATUSES),
    ownerId: c.id('owner_id', { nullable: true }),
    reviewerId: c.id('reviewer_id', { nullable: true }),
    parentId: c.id('parent_id', { nullable: true }),
    note: c.text('note', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('fx_tasks_owner_fk', ['owner_id'], 'fx_users', ['id'], { onDelete: 'set null' }),
    foreignKey('fx_tasks_reviewer_fk', ['reviewer_id'], 'fx_users', ['id'], {
      onDelete: 'set null',
    }),
    foreignKey('fx_tasks_parent_fk', ['parent_id'], 'fx_tasks', ['id']),
  ],
})
export const fxRuns = r2Owner.table({
  id: 'fx_runs',
  schemaSymbol: 'fxRuns',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    status: c.text('status'),
    label: c.text('label', { nullable: true }),
  },
  foreignKeys: [foreignKey('fx_runs_task_fk', ['task_id'], 'fx_tasks', ['id'])],
})
/** A run's inputs have their own key: the rows a source row becomes do not all carry its key. */
export const fxRunInputs = r2Owner.table({
  id: 'fx_run_inputs',
  schemaSymbol: 'fxRunInputs',
  retention: retention.business,
  columns: {
    runId: c.id('run_id'),
    name: c.text('name'),
    upstreamRunId: c.id('upstream_run_id', { nullable: true }),
  },
  primaryKey: ['run_id', 'name'],
  foreignKeys: [
    foreignKey('fx_run_inputs_run_fk', ['run_id'], 'fx_runs', ['id']),
    foreignKey('fx_run_inputs_upstream_fk', ['upstream_run_id'], 'fx_runs', ['id']),
  ],
})
/** `added_by` cannot be null: the only way to keep a member is to point it at the system user. */
export const fxMembers = r2Owner.table({
  id: 'fx_members',
  schemaSymbol: 'fxMembers',
  retention: retention.business,
  columns: {
    taskId: c.id('task_id'),
    userId: c.id('user_id'),
    addedBy: c.id('added_by'),
  },
  primaryKey: ['task_id', 'user_id'],
  foreignKeys: [
    foreignKey('fx_members_task_fk', ['task_id'], 'fx_tasks', ['id']),
    foreignKey('fx_members_added_by_fk', ['added_by'], 'fx_users', ['id']),
  ],
})
/** `reopened_from` is kept only when a module declares so; the schema itself says nothing. */
export const fxMissions = r2Owner.table({
  id: 'fx_missions',
  schemaSymbol: 'fxMissions',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    reopenedFrom: c.id('reopened_from', { nullable: true }),
  },
  foreignKeys: [foreignKey('fx_missions_reopened_fk', ['reopened_from'], 'fx_missions', ['id'])],
})
/** No references at all: the table of the target contract cases. */
export const fxThings = r2Owner.table({
  id: 'fx_things',
  schemaSymbol: 'fxThings',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    kind: c.enum('kind', ['plain', 'special']),
    amount: c.int('amount'),
    label: c.text('label', { nullable: true }),
  },
  checks: [
    {
      name: 'fx_things_amount_nonnegative',
      expression: expr.binary('>=', expr.column('amount'), expr.value(0)),
    },
  ],
})

export const SYSTEM_USER = '__system__'
export const SEED_MISSION = 'seed-mission'
/** Two seeds: one without references and one that has a reference of its own. */
export const fixtureTarget: SchemaRegistry = r2Registry(
  [fxUsers, fxTasks, fxRuns, fxRunInputs, fxMembers, fxMissions, fxThings],
  [
    { table: 'fx_users', mode: 'install-only', rows: [{ id: SYSTEM_USER, name: 'System' }] },
    {
      table: 'fx_missions',
      mode: 'install-only',
      rows: [{ id: SEED_MISSION, reopened_from: null }],
    },
  ],
)

export function targetKey(table: string, ...cells: readonly (string | number)[]): EncodedKey {
  return encodeMigrationKey(
    table,
    cells.map((cell) => canonicalValue(cell)),
  )
}
export function fxTask(id: string, values: TargetRow = {}): TargetRow {
  return {
    id,
    status: 'done',
    owner_id: null,
    reviewer_id: null,
    parent_id: null,
    note: null,
    ...values,
  }
}
export function fxRun(id: string, taskId: string, values: TargetRow = {}): TargetRow {
  return { id, task_id: taskId, status: 'done', label: null, ...values }
}
export function fxThing(id: string, values: TargetRow = {}): TargetRow {
  return { id, kind: 'plain', amount: 1, label: null, ...values }
}

// ---- frozen source held in memory ---------------------------------------------------------

export function frozenTable(table: string): LogicalTableContract {
  const contract = frozenEpoch1Contract.tables.find((entry) => entry.id === table)
  if (!contract) throw new Error(`rfc626 fixture: no frozen table ${table}`)
  return contract
}
/** A complete frozen row: the given cells, and a codec-valid filler for every other column. */
export function frozenRow(table: string, values: DecodedSourceRow = {}): DecodedSourceRow {
  const contract = frozenTable(table)
  for (const name of Object.keys(values))
    if (!contract.columns.some((column) => column.name === name))
      throw new Error(`rfc626 fixture: no frozen column ${table}.${name}`)
  return Object.fromEntries(
    contract.columns.map((column): [string, DecodedSourceValue] => {
      if (Object.hasOwn(values, column.name)) return [column.name, values[column.name]!]
      if (column.nullable) return [column.name, null]
      switch (column.logicalCodec) {
        case 'boolean':
          return [column.name, false]
        case 'integer':
        case 'epoch-milliseconds':
        case 'real':
          return [column.name, 1]
        case 'json-text':
          return [column.name, '{}']
        case 'opaque-bytes':
          return [column.name, new Uint8Array()]
        default:
          return [column.name, 'fixture']
      }
    }),
  )
}
export function sourceKey(table: string, ...cells: readonly (string | number)[]): EncodedKey {
  return targetKey(table, ...cells)
}

export interface MemorySource {
  readonly source: VersionedSourceReader
  readonly preflight: SourcePreflight
  /** The tables each channel was asked for, one entry per call, in call order. */
  readonly reads: { readonly strict: string[]; readonly raw: string[] }
}
/**
 * A frozen source over rows given by the test. The strict channel encodes with the frozen
 * codec and so fails on the chunk that holds a row the codec rejects, exactly like the SQLite
 * and PostgreSQL readers; the raw channel hands every row out by ordinal with its cells as
 * stored. Rows are complete frozen rows (`frozenRow`) with usable migration keys.
 */
export function memorySource(
  tables: Readonly<Record<string, readonly DecodedSourceRow[]>>,
  options: { readonly expectedAbsent?: readonly string[] } = {},
): MemorySource {
  const sourceVersion = 'fixture/rfc626'
  const reads = { strict: [] as string[], raw: [] as string[] }
  const stored = new Map(
    Object.entries(tables).map(([table, rows]) => {
      const contract = frozenTable(table)
      const keyed = rows.map((row) => ({
        row,
        key: contract.migrationKey.map((name) => canonicalValue(row[name] ?? null)),
      }))
      keyed.sort((a, b) => compareCanonicalLogicalKeys(a.key, b.key))
      return [table, { contract, rows: keyed }] as const
    }),
  )
  const entry = (table: string) => {
    const found = stored.get(table)
    if (!found) throw new Error(`rfc626 fixture: source has no table ${table}`)
    return found
  }
  const preflight: SourcePreflight = {
    version: 1,
    kind: 'logical-artifact',
    sourceVersion,
    contract: frozenEpoch1Contract,
    fingerprint: {
      version: 1,
      evidence: 'legacy-logical-artifact',
      provider: 'sqlite',
      catalog: [],
      catalogDigest: 'fixture',
      journal: [],
      journalEntryCount: 0,
      tableRows: Object.fromEntries(
        [...stored].map(([table, found]) => [table, found.rows.length]),
      ),
      digest: valueDigest('rfc626-fixture-source'),
    },
    sourceGenerationId: 'dbg_rfc626_fixture_source',
    identityHighWater: [],
    identityEvidence: 'not-recorded-by-epoch1-artifact',
    watermark: 'rfc626-fixture-watermark',
    requiresOfflineUpgrade: false,
    tables: [...stored].map(
      ([table, found]): SourceTableDisposition => ({
        table,
        physicalTable: table,
        rows: found.rows.length,
        disposition: 'converted',
        destination: { kind: 'business', tables: [table] },
        reason: 'fixture',
      }),
    ),
    expectedAbsent: options.expectedAbsent ?? [],
    content: [],
  }
  const source: VersionedSourceReader = {
    kind: 'logical-artifact',
    async preflight() {
      return preflight
    },
    async assertUnchanged() {},
    async close() {},
    async readChunk(table, afterKey, limit) {
      const found = entry(table)
      reads.strict.push(table)
      const start =
        afterKey === null
          ? 0
          : found.rows.findIndex((row) => compareCanonicalLogicalKeys(row.key, afterKey) > 0)
      const page = start < 0 ? [] : found.rows.slice(start, start + limit)
      return sourceChunk({
        sourceVersion,
        table: found.contract,
        afterKey,
        // Outside `sourceChunk`: a codec rejection reaches the caller as the codec's own error.
        rows: page.map((row) => encodeLogicalRow(found.contract, row.row)),
      })
    },
    async readRawChunk(table, afterKey, limit) {
      const found = entry(table)
      reads.raw.push(table)
      // The raw cursor is an ordinal, as a rowid is: never a logical key.
      const start = afterKey === null ? 0 : Number(decodeLogicalValue(afterKey[0]!))
      const rows = found.rows.slice(start, start + limit).map(
        (row, index): RawSourceRow => ({
          key: [{ type: 'integer', value: String(start + index + 1) }],
          cells: Object.fromEntries(
            found.contract.columns.map((column) => {
              const value = row.row[column.name] ?? null
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
        }),
      )
      return {
        version: 1,
        sourceVersion,
        table,
        migrationKey: ['rowid'],
        afterKey,
        firstKey: rows[0]?.key ?? null,
        lastKey: rows.at(-1)?.key ?? null,
        rows,
        sourceDigest: 'fixture',
      }
    },
  }
  return { source, preflight, reads }
}

/** Scratch directories of one test file, removed after each test. Call once at file level. */
export function scratchRoots(): () => string {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  return () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc626-'))
    roots.push(root)
    return root
  }
}
export const PLAN_TIME = 1_764_000_000_000
/**
 * A whole-source conversion input: every table of the memory source has to be claimed by a
 * rule of the contributions (an unclaimed one is a plan block, as it is in production).
 */
export function engineInput(
  memory: MemorySource,
  contributions: readonly ConversionContribution[],
  options: Partial<Omit<ConversionInput, 'source' | 'preflight' | 'contributions'>> & {
    readonly scratchRoot: string
  },
): ConversionInput {
  return {
    source: memory.source,
    preflight: memory.preflight,
    target: fixtureTarget,
    contributions,
    content: emptyV2Content,
    planTime: PLAN_TIME,
    chunkLimit: 2,
    targetGeneration: 'dbg_rfc626_fixture_target',
    candidateBuild: 'rfc626-fixture',
    sourceBackupId: null,
    contentManifestDigest: 'fixture:no-content',
    ...options,
  }
}

/** The run row a target registers for a conversion of the memory source. */
export function runInit(input: {
  readonly operationId: string
  readonly targetProvider: DatabaseProvider
  readonly plan: ConversionPlanSection
  readonly preflight: SourcePreflight
  readonly runId?: string
}): MigrationRunInit {
  return {
    version: 1,
    runId: input.runId ?? 'run-rfc626',
    operationId: input.operationId,
    ordinal: 1,
    kind: 'epoch-conversion',
    role: 'converted',
    sourceProvider: input.preflight.fingerprint.provider,
    sourceEpoch: 1,
    sourceKind: input.preflight.kind,
    targetProvider: input.targetProvider,
    targetEpoch: 2,
    migrationPlanDigest: valueDigest('rfc626-migration-plan'),
    approvalDigest: valueDigest('rfc626-approval'),
    conversionPlan: input.plan,
    emptyTables: [],
    startedAt: 123,
  }
}
/** The binding a hand-driven sink is opened with: the plan's, and two digests of the test's own. */
export function runBinding(plan: ConversionPlanSection): ConversionRunBinding {
  return {
    planDigest: plan.digest,
    sourceWatermark: plan.sourceWatermark,
    sourceVersion: plan.sourceVersion,
    sourceGenerationId: plan.sourceGenerationId,
    targetGeneration: plan.targetGeneration,
    converterVersion: plan.converterVersion,
    ruleSetDigest: plan.ruleSetDigest,
    preUpgradeWatermark: plan.preUpgradeWatermark,
    stagingDigest: valueDigest('rfc626-staging'),
    lookupDigest: valueDigest('rfc626-lookups'),
  }
}

// ---- recording sink -----------------------------------------------------------------------

/**
 * Keeps what the engine commits. `refuse` plays the target database: the target rows it
 * returns for an attempt are refused, nothing of that attempt is kept, and the engine is told.
 */
export class RecordingSink implements ConversionSink {
  binding: ConversionRunBinding | null = null
  summary: ConversionSummary | null = null
  /** Every `commitUnit` call, in order, refused ones included. */
  readonly attempts: UnitOutput[] = []
  readonly units = new Map<string, UnitOutput>()
  refuse: (output: UnitOutput) => readonly TargetLoadRejection[] = () => []
  /** What `open` hands back; default: the units this sink holds and no decisions. */
  opened: ConversionSinkOpened | null = null
  async open(binding: ConversionRunBinding): Promise<ConversionSinkOpened> {
    this.binding = binding
    return this.opened ?? { committedUnitIds: new Set(this.units.keys()) }
  }
  async commitUnit(
    output: UnitOutput,
  ): Promise<void | { readonly rejected: readonly TargetLoadRejection[] }> {
    this.attempts.push(output)
    const rejected = this.refuse(output)
    if (rejected.length) return { rejected }
    const existing = this.units.get(output.receipt.unitId)
    if (existing && existing.receipt.digest !== output.receipt.digest)
      throw new Error('rfc626-fixture-sink-unit-conflict')
    this.units.set(output.receipt.unitId, output)
  }
  async finish(summary: ConversionSummary): Promise<void> {
    this.summary = summary
  }
  rows(table: string): readonly TargetRow[] {
    return [...this.units.values()].flatMap((unit) =>
      unit.rows.filter((group) => group.table === table).flatMap((group) => group.rows),
    )
  }
  dispositions(): readonly RowDisposition[] {
    return [...this.units.values()].flatMap((unit) => unit.dispositions)
  }
  records(): readonly MigrationRecord[] {
    return [...this.units.values()].flatMap((unit) => unit.records)
  }
  /** The committed unit that consumed a source row of this table and key. */
  unitOf(table: string, key: EncodedKey): UnitOutput {
    const found = [...this.units.values()].filter((unit) =>
      unit.receipt.sources.some(
        (source) =>
          source.table === table &&
          source.firstKey !== null &&
          source.lastKey !== null &&
          Buffer.compare(Buffer.from(key), Buffer.from(source.firstKey)) >= 0 &&
          Buffer.compare(Buffer.from(key), Buffer.from(source.lastKey)) <= 0,
      ),
    )
    if (found.length !== 1) throw new Error(`rfc626 fixture: ${found.length} units hold ${key}`)
    return found[0]!
  }
}

// ---- stand-ins for module contributions ---------------------------------------------------

/** Task facts read from the staged `tasks` rows, so a settlement of a task is seen at once. */
export const taskFactsFromTasks: LookupBuilder<TaskFacts> = {
  key: TASK_FACTS,
  sources: ['tasks'],
  build(staged, put) {
    for (const row of staged.rows('tasks')) {
      const status = String(row.values.status)
      put(String(row.values.id), {
        taskId: String(row.values.id),
        parentTaskId:
          typeof row.values.parent_task_id === 'string' ? row.values.parent_task_id : null,
        rootTaskId: null,
        status,
        startedAt: 1,
        execution: executionClass(status),
        subjectKind: 'workflow',
        sourceId: null,
        definitionAnchorId: 'definition',
        engineKind: 'dag',
        spaceKind: 'internal',
        workflowVersion: 1,
      })
    }
  },
}
export const UPGRADE_SUMMARY = 'ended by upgrade'
export const UPGRADE_CODE = 'ended-by-upgrade'
/**
 * What a module that owns the task lifecycle contributes, reduced to what the engine needs to
 * be shown calling: the task becomes canceled, its unfinished runs with it, and a canceled
 * parent takes its cancelable children along.
 */
export const cancelSettlement: SettlementContribution = {
  settlers: [
    {
      tables: [{ table: 'tasks', taskColumn: 'id' }],
      settle(rows, ctx) {
        return (rows.get('tasks') ?? []).map((row) => ({
          table: 'tasks',
          key: row.encodedKey,
          values: {
            ...row.values,
            status: 'canceled',
            finished_at: ctx.planTime,
            error_summary:
              ctx.settlement.cause === 'parent-cascade'
                ? 'canceled by parent task'
                : UPGRADE_SUMMARY,
            error_message:
              ctx.settlement.cause === 'parent-cascade'
                ? 'canceled-by-parent-cascade'
                : UPGRADE_CODE,
          },
        }))
      },
    },
    {
      tables: [{ table: 'node_runs', taskColumn: 'task_id' }],
      settle(rows, ctx) {
        return (rows.get('node_runs') ?? [])
          .filter((row) => CANCELABLE_STATUSES.includes(String(row.values.status)))
          .map((row) => ({
            table: 'node_runs',
            key: row.encodedKey,
            values: {
              ...row.values,
              status: 'canceled',
              finished_at: ctx.planTime,
              error_message: UPGRADE_CODE,
            },
          }))
      },
    },
  ],
  expand({ settled, staged }) {
    const taken: TaskSettlement[] = []
    for (const row of staged.rows('tasks')) {
      const parent = row.values.parent_task_id
      const status = String(row.values.status)
      if (typeof parent === 'string' && settled.has(parent) && CANCELABLE_STATUSES.includes(status))
        taken.push({
          taskId: String(row.values.id),
          cause: 'parent-cascade',
          originalStatus: status,
          blockCodes: [],
          parentTaskId: parent,
        })
    }
    return taken
  },
}

/** Claims a table and accounts for every row without producing anything. */
export function noteRule(table: string, overrides: Partial<ConversionRule> = {}): ConversionRule {
  return {
    ref: { id: `fixture/note/${table}`, version: 1 },
    owner: 'fixture',
    claims: [table],
    produces: [],
    lookups: [],
    unit: { kind: 'source-chunk', table },
    convert(unit, ctx) {
      for (const row of unit.rows.get(table) ?? [])
        ctx.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
    },
    ...overrides,
  }
}

/** The target rows one source row becomes, written into that source row as JSON. */
export interface Emission {
  readonly table: string
  readonly values: TargetRow
}
/** One `maintenance_state` row per group; keys keep the order of the groups. */
export function emissionRows(groups: readonly (readonly Emission[])[]): DecodedSourceRow[] {
  return groups.map((group, index) =>
    frozenRow('maintenance_state', {
      key: emissionKey(index),
      value: JSON.stringify(group),
      updated_at: 1,
    }),
  )
}
export function emissionKey(index: number): string {
  return `source-${String(index).padStart(3, '0')}`
}
/** Turns every `maintenance_state` row into the target rows it lists, all from that row. */
export const emissionRule: ConversionRule = {
  ref: { id: 'fixture/emissions', version: 1 },
  owner: 'fixture',
  claims: ['maintenance_state'],
  produces: fixtureTarget.tables.map((table) => ({ table: table.id })),
  lookups: [],
  unit: { kind: 'source-chunk', table: 'maintenance_state' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('maintenance_state')!)
      for (const emission of JSON.parse(String(row.values.value)) as readonly Emission[])
        ctx.out.row(emission.table, emission.values, row)
  },
}

// ---- the fixtures behave like what they stand in for ---------------------------------------

test('RFC-626 fixtures: the memory source reads strictly in key order and fails on a rejected row', async () => {
  const rows = ['b', 'a', 'c'].map((key) =>
    frozenRow('maintenance_state', { key, value: `v-${key}`, updated_at: 7 }),
  )
  const memory = memorySource({ maintenance_state: rows })
  const first = await memory.source.readChunk('maintenance_state', null, 2)
  expect(first.decodedRows.map((row) => row.key)).toEqual(['a', 'b'])
  const second = await memory.source.readChunk('maintenance_state', first.lastKey, 2)
  expect(second.decodedRows).toEqual([rows[2]!])
  expect((await memory.source.readChunk('maintenance_state', second.lastKey, 2)).rows).toEqual([])
  const raw = await memory.source.readRawChunk('maintenance_state', null, 10)
  expect(raw.rows.map((row) => row.cells.key!.value)).toEqual(
    ['a', 'b', 'c'].map((key) => canonicalValue(key)),
  )
  expect(memory.preflight.tables).toEqual([
    expect.objectContaining({ table: 'maintenance_state', rows: 3, disposition: 'converted' }),
  ])
  const broken = memorySource({
    recovery_events: [
      frozenRow('recovery_events', { id: 'a' }),
      frozenRow('recovery_events', { id: 'b', before_json: '{ not json' }),
    ],
  })
  expect((await broken.source.readChunk('recovery_events', null, 1)).rows).toHaveLength(1)
  await expect(broken.source.readChunk('recovery_events', null, 2)).rejects.toThrow(
    'logical database codec',
  )
  expect(() => frozenRow('maintenance_state', { missing: 1 })).toThrow('no frozen column')
})

test('RFC-626 fixtures: the synthetic target declares the references the finalize cases need', () => {
  const byName = new Map(
    fixtureTarget.tables.flatMap((table) =>
      table.foreignKeys.map((key) => [key.name, key.onDelete] as const),
    ),
  )
  expect(byName.get('fx_tasks_owner_fk')).toBe('set null')
  expect(byName.get('fx_tasks_reviewer_fk')).toBe('set null')
  for (const name of [
    'fx_tasks_parent_fk',
    'fx_runs_task_fk',
    'fx_run_inputs_run_fk',
    'fx_run_inputs_upstream_fk',
    'fx_members_task_fk',
    'fx_members_added_by_fk',
    'fx_missions_reopened_fk',
  ])
    expect(byName.get(name)).toBe('no action')
  expect(
    fixtureTarget.contributions.flatMap((entry) => (entry.seeds ?? []).map((seed) => seed.table)),
  ).toEqual(['fx_users', 'fx_missions'])
})
