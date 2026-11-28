// RFC-626 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md §3.3 "悬空行" and
// "收尾处置", §4.2): the fixtures the real-target tests of this RFC share. Finalizing,
// validating, retiring and tracing a target are all about rows that are in a real database
// and about what the run recorded beside them, so these tests need a target the real
// installer built and a run the real engine and the real sink left behind — but not the
// whole product schema. This file gives them that for the small synthetic schema of
// rfc626-engine-fixtures: a compiled head, the keep policies a module would declare, target
// rows written as plain lists, and a conversion that puts them into the target under test.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { V3Harness } from './helpers/rfc395V3Harness'
import { HistoryCatalogCache } from '@/platform/persistence/schema/history/catalog'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { prepareConversion } from '@/platform/persistence/migration/conversion/engine'
import type {
  ConversionInput,
  ConversionPlanSection,
} from '@/platform/persistence/migration/conversion/plan'
import type {
  ConversionContribution,
  ConversionRule,
  ReferenceKeepPolicy,
} from '@/platform/persistence/migration/conversion/rule'
import type { ConversionSummary } from '@/platform/persistence/migration/conversion/sink'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'
import type { ConversionTargetConnection } from '@/platform/persistence/migration/run/types'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { createTargetLoader, targetTableName } from '@/platform/persistence/migration/target/loader'
import {
  createMigrationMetaStore,
  type MigrationMetaStore,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetConversionSink } from '@/modules/system-operations/infrastructure/epochSwitch/conversionSink'
import { createTargetGenerationHandle } from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import {
  SEED_MISSION,
  SYSTEM_USER,
  emissionRows,
  emissionRule,
  engineInput,
  fixtureTarget,
  fxRun,
  fxTask,
  memorySource,
  runInit,
  type Emission,
  type MemorySource,
} from './rfc626-engine-fixtures.test'

export const fixtureHead = createHistoryVersion({ registry: fixtureTarget, slug: 'rfc626-fixture' })
/** What a module declares: a reopened mission survives without its origin, a member is kept under the system user. */
export const keepPolicies: readonly ReferenceKeepPolicy[] = [
  { table: 'fx_missions', foreignKey: 'fx_missions_reopened_fk', action: { kind: 'detach' } },
  {
    table: 'fx_members',
    foreignKey: 'fx_members_added_by_fk',
    action: { kind: 'substitute', values: { added_by: SYSTEM_USER } },
  },
]

export const user = (id: string): Emission => ({
  table: 'fx_users',
  values: { id, name: `name of ${id}` },
})
export const task = (id: string, values: Emission['values'] = {}): Emission => ({
  table: 'fx_tasks',
  values: fxTask(id, values),
})
export const run = (id: string, taskId: string): Emission => ({
  table: 'fx_runs',
  values: fxRun(id, taskId),
})
export const runInput = (runId: string, name: string, upstream: string | null): Emission => ({
  table: 'fx_run_inputs',
  values: { run_id: runId, name, upstream_run_id: upstream },
})
export const member = (taskId: string, userId: string, addedBy: string): Emission => ({
  table: 'fx_members',
  values: { task_id: taskId, user_id: userId, added_by: addedBy },
})
export const mission = (id: string, reopenedFrom: string | null): Emission => ({
  table: 'fx_missions',
  values: { id, reopened_from: reopenedFrom },
})
/** The seed rows every converted target of this schema has, one source row each. */
export const seedRows: readonly (readonly Emission[])[] = [
  [user(SYSTEM_USER)],
  [mission(SEED_MISSION, null)],
]

/** The synthetic head on the target under test, without seeds, as the conversion installs it. */
export async function installFixtureTarget(h: V3Harness): Promise<MigrationMetaStore> {
  await installConversionTarget(h.target, {
    head: fixtureHead,
    metaTables: h.metaTables,
    generationId: h.generationId,
    now: 123,
  })
  return createMigrationMetaStore({ target: h.target, registry: fixtureTarget })
}
export interface ConvertedTarget {
  readonly runId: string
  readonly meta: MigrationMetaStore
  readonly preflight: SourcePreflight
  readonly plan: ConversionPlanSection
  readonly summary: ConversionSummary
  /**
   * The input of a replay of this run: the same frozen source and rules, a scratch directory
   * of its own and — for an automatic run — the settlements the run registered in its plan.
   */
  replayInput(): ConversionInput
}
/**
 * A memory source converted by the engine and loaded by the target sink into the target under
 * test: the run, its units and their receipts are the ones a conversion leaves behind.
 */
export async function convertedSource(
  h: V3Harness,
  memory: MemorySource,
  contributions: readonly ConversionContribution[],
  options: { readonly resolution?: 'automatic' } = {},
): Promise<ConvertedTarget> {
  const meta = await installFixtureTarget(h)
  const input = (scratch: string, settlements?: ConversionPlanSection['settlements']) =>
    engineInput(memory, contributions, {
      scratchRoot: join(h.appHome, scratch),
      targetGeneration: h.generationId,
      ...(options.resolution ? { resolution: options.resolution } : {}),
      ...(settlements ? { settlements } : {}),
    })
  const prepared = await prepareConversion(input('scratch'))
  try {
    const row = runInit({
      operationId: h.operationId,
      targetProvider: h.targetProvider,
      plan: prepared.plan,
      preflight: memory.preflight,
    })
    const summary = await prepared.run(
      createTargetConversionSink({
        target: h.target,
        loader: createTargetLoader({ registry: fixtureTarget, provider: h.targetProvider }),
        meta,
        run: row,
        now: () => 123,
        ...(options.resolution ? { resolution: options.resolution } : {}),
      }),
    )
    expect(summary.blocks).toEqual([])
    const plan = prepared.plan
    return {
      runId: row.runId,
      meta,
      preflight: memory.preflight,
      plan,
      summary,
      replayInput: () => input('replay-scratch', plan.settlements),
    }
  } finally {
    prepared.close()
  }
}
/**
 * One source row per group, each becoming the target rows the group lists. `rule` replaces
 * the rule that turns a source row into those rows.
 */
export function convertedTarget(
  h: V3Harness,
  groups: readonly (readonly Emission[])[],
  options: { readonly resolution?: 'automatic'; readonly rule?: ConversionRule } = {},
): Promise<ConvertedTarget> {
  return convertedSource(
    h,
    memorySource({ maintenance_state: emissionRows(groups) }),
    [{ rules: [options.rule ?? emissionRule], lookups: [], validators: [] }],
    options.resolution ? { resolution: options.resolution } : {},
  )
}
/** The handle of the generation under test; `target` lets a test put a connection of its own in between. */
export function fixtureHandle(h: V3Harness, target: ConversionTargetConnection = h.target) {
  return createTargetGenerationHandle({
    target,
    generationId: h.generationId,
    registry: fixtureTarget,
    head: fixtureHead,
    // The fixture schema has no compiled PostgreSQL catalog; admission is not what is tested.
    catalogCache: new HistoryCatalogCache(),
    now: () => 123,
  })
}
export async function targetRows(h: V3Harness, table: string): Promise<Record<string, unknown>[]> {
  return [...(await h.target.execute(`SELECT * FROM ${targetTableName(h.targetProvider, table)}`))]
}
export async function targetIds(h: V3Harness, table: string, column = 'id'): Promise<string[]> {
  return (await targetRows(h, table)).map((row) => String(row[column])).sort()
}
export async function targetRow(
  h: V3Harness,
  table: string,
  id: string,
): Promise<Record<string, unknown>> {
  const found = (await targetRows(h, table)).find((row) => row.id === id)
  if (!found) throw new Error(`rfc626 fixture: no target row ${table}/${id}`)
  return found
}

test('RFC-626 target fixtures: every keep policy names a declared foreign key and re-points only at a seed row', () => {
  const seeded = new Map(
    fixtureTarget.contributions.flatMap((entry) =>
      (entry.seeds ?? []).map((seed) => [seed.table, seed.rows.map((row) => row.id)] as const),
    ),
  )
  for (const policy of keepPolicies) {
    const declared = fixtureTarget.tables
      .find((table) => table.id === policy.table)
      ?.foreignKeys.find((key) => key.name === policy.foreignKey)
    expect(declared).toBeDefined()
    if (policy.action.kind !== 'substitute') continue
    expect(Object.keys(policy.action.values)).toEqual([...declared!.columns])
    expect(seeded.get(declared!.foreignTable)).toEqual<unknown>(Object.values(policy.action.values))
  }
  expect(seedRows.flat().map((entry) => `${entry.table}/${String(entry.values.id)}`)).toEqual([
    `fx_users/${SYSTEM_USER}`,
    `fx_missions/${SEED_MISSION}`,
  ])
})
