// RFC-626 §3.1 and §3.2.1–§3.2.3 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md):
// with automatic resolution the conversion engine does not let "this task could continue, so
// its rows block" stop an upgrade. Before the target is opened it finds those tasks
// (discovery), ends them by rewriting the decoded values of their staged rows, and writes the
// set into the conversion plan. This file locks that step: which tasks enter the set and with
// what description, the fixed point, the expansion a module contributes, a registered set
// being applied instead of rediscovered, the two ways a rule can get it wrong (no `settles`
// declaration, a `tasksOf` that does not name the task), what settlers see and may write,
// and that operator resolution — the manual flow, and the default — is exactly what it was.
//
// The rules, validators, settlers and the expansion here are small stand-ins: the engine only
// iterates, sorts and calls, and that is all these cases assert about it.
import { describe, expect, test } from 'bun:test'
import {
  prepareConversion,
  runConversion,
} from '@/platform/persistence/migration/conversion/engine'
import {
  ConversionContractError,
  rowBlock,
} from '@/platform/persistence/migration/conversion/blockCodes'
import { TASK_FACTS } from '@/platform/persistence/migration/conversion/lookups/keys'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'
import { encodeLogicalRow } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type {
  ConversionContribution,
  ConversionRule,
  RowValidator,
  SettlementContribution,
  TaskSettler,
} from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionBlock,
  SourceRow,
  TargetRow,
  TaskSettlement,
} from '@/platform/persistence/migration/conversion/types'
import {
  RecordingSink,
  cancelSettlement,
  engineInput,
  frozenRow,
  frozenTable,
  fxRun,
  fxTask,
  memorySource,
  noteRule,
  scratchRoots,
  sourceKey,
  taskFactsFromTasks,
  UPGRADE_CODE,
  UPGRADE_SUMMARY,
} from './rfc626-engine-fixtures.test'

const scratch = scratchRoots()

const UNPROVABLE = 'fixture-run-unprovable'
const CHILD_ENDED = 'fixture-run-child-ended'

function task(id: string, status: string, values: DecodedSourceRow = {}): DecodedSourceRow {
  return frozenRow('tasks', { id, status, ...values })
}
function run(id: string, taskId: string, values: DecodedSourceRow = {}): DecodedSourceRow {
  return frozenRow('node_runs', {
    id,
    task_id: taskId,
    status: 'done',
    envelope_nonce: 'nonce',
    ...values,
  })
}
function executableBlock(
  code: string,
  row: SourceRow,
  executable: { readonly taskId: string; readonly status: string },
): ConversionBlock {
  return rowBlock(code, row, { executableTask: executable }, ['envelope_nonce'])
}
/** The task itself; part of the execution chain, so it declares `settles`. */
function tasksRule(overrides: Partial<ConversionRule> = {}): ConversionRule {
  return {
    ref: { id: 'fixture/tasks', version: 1 },
    owner: 'fixture',
    claims: ['tasks'],
    produces: [{ table: 'fx_tasks' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'tasks' },
    settles: {},
    convert(unit, ctx) {
      for (const row of unit.rows.get('tasks')!)
        ctx.out.row(
          'fx_tasks',
          fxTask(String(row.values.id), {
            status: String(row.values.status),
            note: row.values.error_summary ?? null,
          }),
          row,
        )
    },
    ...overrides,
  }
}
/**
 * A run. Two things make it unprovable while its task could continue: it never received a
 * nonce, or it waits on a child task that has been canceled. The block code of the first can
 * be set per row (`failure_code`). `seen` receives the id of every row the rule is given.
 */
function runsRule(seen: string[] = [], overrides: Partial<ConversionRule> = {}): ConversionRule {
  return {
    ref: { id: 'fixture/runs', version: 1 },
    owner: 'fixture',
    claims: ['node_runs'],
    produces: [{ table: 'fx_runs' }],
    lookups: [TASK_FACTS],
    unit: { kind: 'source-chunk', table: 'node_runs' },
    settles: {},
    convert(unit, ctx) {
      for (const row of unit.rows.get('node_runs')!) {
        seen.push(String(row.values.id))
        const facts = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
        if (facts?.execution === 'executable') {
          const executable = { taskId: facts.taskId, status: facts.status }
          const child =
            typeof row.values.child_task_id === 'string'
              ? ctx.lookup(TASK_FACTS).get(row.values.child_task_id)
              : undefined
          if (row.values.envelope_nonce === null) {
            const code =
              typeof row.values.failure_code === 'string' ? row.values.failure_code : UNPROVABLE
            ctx.out.blockExecutable(executable, executableBlock(code, row, executable))
            continue
          }
          if (child?.status === 'canceled') {
            ctx.out.blockExecutable(executable, executableBlock(CHILD_ENDED, row, executable))
            continue
          }
        }
        ctx.out.row(
          'fx_runs',
          fxRun(String(row.values.id), String(row.values.task_id), {
            status: String(row.values.status),
            label: row.values.error_message ?? null,
          }),
          row,
        )
      }
    },
    ...overrides,
  }
}
function contribution(
  rules: readonly ConversionRule[],
  extra: Partial<ConversionContribution> = {},
): ConversionContribution {
  return {
    rules,
    lookups: [taskFactsFromTasks],
    validators: [],
    settlement: cancelSettlement,
    ...extra,
  }
}
function unproven(taskId: string, originalStatus: string, ...blockCodes: string[]): TaskSettlement {
  return { taskId, cause: 'unprovable-records', originalStatus, blockCodes, parentTaskId: null }
}
function byId(rows: readonly TargetRow[]): Record<string, TargetRow> {
  return Object.fromEntries(rows.map((row) => [String(row.id), row]))
}
function automatic(
  tables: Readonly<Record<string, readonly DecodedSourceRow[]>>,
  contributions: readonly ConversionContribution[],
): ConversionInput {
  return engineInput(memorySource(tables), contributions, {
    scratchRoot: scratch(),
    resolution: 'automatic',
  })
}

describe('RFC-626 discovery: which tasks the conversion ends', () => {
  test('an unfinished task with an unprovable run is ended and its rows convert as history; a sound one is left alone', async () => {
    const input = automatic(
      {
        tasks: [
          task('t-broken', 'interrupted'),
          task('t-healthy', 'running'),
          task('t-done', 'done'),
        ],
        node_runs: [
          run('r-broken', 't-broken', { status: 'awaiting_human', envelope_nonce: null }),
          run('r-broken-done', 't-broken'),
          run('r-healthy', 't-healthy', { status: 'running' }),
          // No nonce either, but its task is finished: that was never a reason to block.
          run('r-done', 't-done', { envelope_nonce: null }),
        ],
      },
      [contribution([tasksRule(), runsRule()])],
    )
    const prepared = await prepareConversion(input)
    try {
      expect(prepared.plan.resolution).toBe('automatic')
      expect(prepared.plan.settlements).toEqual([unproven('t-broken', 'interrupted', UNPROVABLE)])
      const sink = new RecordingSink()
      const summary = await prepared.run(sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      expect(summary.plan).toEqual(prepared.plan)
      expect(summary.resolutions?.settledTasks).toEqual(prepared.plan.settlements)
      expect(byId(sink.rows('fx_tasks'))).toEqual({
        't-broken': fxTask('t-broken', { status: 'canceled', note: UPGRADE_SUMMARY }),
        't-healthy': fxTask('t-healthy', { status: 'running' }),
        't-done': fxTask('t-done', { status: 'done' }),
      })
      // The run that blocked is converted now: its task can no longer continue.
      expect(byId(sink.rows('fx_runs'))).toEqual({
        'r-broken': fxRun('r-broken', 't-broken', { status: 'canceled', label: UPGRADE_CODE }),
        'r-broken-done': fxRun('r-broken-done', 't-broken'),
        'r-healthy': fxRun('r-healthy', 't-healthy', { status: 'running' }),
        'r-done': fxRun('r-done', 't-done'),
      })
      expect(sink.dispositions()).toEqual([])
    } finally {
      prepared.close()
    }
  })

  test('the set is sorted by task and each entry lists its distinct block codes in order', async () => {
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [task('b-task', 'running'), task('a-task', 'pending'), task('c-task', 'failed')],
          node_runs: [
            run('r1', 'b-task', { envelope_nonce: null, failure_code: 'z-code' }),
            run('r2', 'b-task', { envelope_nonce: null, failure_code: 'a-code' }),
            run('r3', 'b-task', { envelope_nonce: null, failure_code: 'z-code' }),
            run('r4', 'a-task', { envelope_nonce: null }),
            run('r5', 'c-task', { envelope_nonce: null }),
          ],
        },
        [contribution([tasksRule(), runsRule()])],
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([
        unproven('a-task', 'pending', UNPROVABLE),
        unproven('b-task', 'running', 'a-code', 'z-code'),
      ])
    } finally {
      prepared.close()
    }
  })

  test('ending one task can make another one unprovable: the second round finds it and the third finds nothing', async () => {
    const seen: string[] = []
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [task('task-a', 'interrupted'), task('task-b', 'awaiting_review')],
          node_runs: [
            run('run-a', 'task-a', { envelope_nonce: null }),
            // Sound until task-a is canceled; then it waits on a task that will never answer.
            run('run-b', 'task-b', { status: 'awaiting_review', child_task_id: 'task-a' }),
          ],
        },
        [contribution([tasksRule(), runsRule(seen)])],
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([
        unproven('task-a', 'interrupted', UNPROVABLE),
        unproven('task-b', 'awaiting_review', CHILD_ENDED),
      ])
      // Discovery only: both runs share a unit, which is converted whole while one of its rows
      // can still end a task — in the first round (run-a blocks, run-b is sound) and in the
      // second (run-b blocks). A third round sees no row of a task that can still continue.
      expect(seen.filter((id) => id === 'run-a')).toHaveLength(2)
      expect(seen.filter((id) => id === 'run-b')).toHaveLength(2)
      const sink = new RecordingSink()
      const summary = await prepared.run(sink)
      expect(summary.status).toBe('converted')
      expect(byId(sink.rows('fx_tasks'))).toMatchObject({
        'task-a': { status: 'canceled' },
        'task-b': { status: 'canceled' },
      })
      // The conversion itself gives every row to its rule exactly once more.
      expect(seen.filter((id) => id === 'run-a')).toHaveLength(3)
      expect(seen.filter((id) => id === 'run-b')).toHaveLength(3)
    } finally {
      prepared.close()
    }
  })

  test('a module expansion adds the tasks an ended task takes along, level after level', async () => {
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [
            task('parent', 'running'),
            task('child-wait', 'awaiting_human', { parent_task_id: 'parent' }),
            // Not a state the stand-in expansion cancels: it stays as it is.
            task('child-interrupted', 'interrupted', { parent_task_id: 'parent' }),
            task('grandchild', 'pending', { parent_task_id: 'child-wait' }),
            task('unrelated', 'running'),
          ],
          node_runs: [run('run-parent', 'parent', { envelope_nonce: null })],
        },
        [contribution([tasksRule(), runsRule()])],
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([
        {
          taskId: 'child-wait',
          cause: 'parent-cascade',
          originalStatus: 'awaiting_human',
          blockCodes: [],
          parentTaskId: 'parent',
        },
        {
          taskId: 'grandchild',
          cause: 'parent-cascade',
          originalStatus: 'pending',
          blockCodes: [],
          parentTaskId: 'child-wait',
        },
        unproven('parent', 'running', UNPROVABLE),
      ])
      const sink = new RecordingSink()
      expect((await prepared.run(sink)).status).toBe('converted')
      expect(byId(sink.rows('fx_tasks'))).toMatchObject({
        parent: { status: 'canceled', note: UPGRADE_SUMMARY },
        'child-wait': { status: 'canceled', note: 'canceled by parent task' },
        grandchild: { status: 'canceled', note: 'canceled by parent task' },
        'child-interrupted': { status: 'interrupted' },
        unrelated: { status: 'running' },
      })
    } finally {
      prepared.close()
    }
  })

  test('one row can end several tasks: `tasksOf` names every task that uses it', async () => {
    const MISSING = 'fixture-content-missing'
    // A shared object without a task of its own; `reason` lists the tasks that use it.
    const users = (row: SourceRow): string[] => String(row.values.reason).split(',')
    const reached: string[] = []
    const contentRule: ConversionRule = {
      ...noteRule('recovery_events'),
      ref: { id: 'fixture/content', version: 1 },
      lookups: [TASK_FACTS],
      settles: {
        tasksOf: (row, lookup) =>
          users(row).filter((id) => lookup(TASK_FACTS).get(id) !== undefined),
      },
      convert(unit, ctx) {
        for (const row of unit.rows.get('recovery_events')!) {
          let blocked = false
          for (const id of users(row)) {
            const facts = ctx.lookup(TASK_FACTS).get(id)
            if (facts?.execution !== 'executable') continue
            reached.push(id)
            blocked = true
            ctx.out.blockExecutable(
              { taskId: id, status: facts.status },
              rowBlock(MISSING, row, { resourceUses: users(row) }),
            )
          }
          if (!blocked)
            ctx.out.record({ kind: 'decision', code: 'fixture-content-kept', payload: null }, row)
        }
      },
    }
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [task('user-1', 'running'), task('user-2', 'awaiting_human')],
          recovery_events: [
            frozenRow('recovery_events', { id: 'shared', reason: 'user-1,user-2,gone' }),
          ],
        },
        [contribution([tasksRule(), contentRule])],
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([
        unproven('user-1', 'running', MISSING),
        unproven('user-2', 'awaiting_human', MISSING),
      ])
      // One round was enough for both.
      expect(reached).toEqual(['user-1', 'user-2'])
      const sink = new RecordingSink()
      const summary = await prepared.run(sink)
      // The conversion never reaches `blockExecutable` again.
      expect(reached).toEqual(['user-1', 'user-2'])
      expect(summary.status).toBe('converted')
      expect(sink.records()).toContainEqual({
        kind: 'decision',
        code: 'fixture-content-kept',
        payload: null,
      })
    } finally {
      prepared.close()
    }
  })

  // A chunk is converted whole once one of its rows can still end a task (gate G1-4, below);
  // a chunk with no such row, and a group of a finished task, are not converted at all.
  test('discovery runs a rule only on units with a row that can still end a task', async () => {
    const seenEvents: string[] = []
    const seenGroups: string[] = []
    const eventsRule = noteRule('recovery_events', {
      settles: {},
      convert(unit, ctx) {
        for (const row of unit.rows.get('recovery_events')!) {
          seenEvents.push(String(row.values.id))
          ctx.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
        }
      },
    })
    const alertsRule = noteRule('lifecycle_alerts', {
      settles: { tasksOf: () => [] },
      convert(unit, ctx) {
        for (const row of unit.rows.get('lifecycle_alerts')!) {
          seenEvents.push(String(row.values.id))
          ctx.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
        }
      },
    })
    // Runs grouped by task: a group is converted whole or not at all.
    const groupedRuns = runsRule([], {
      unit: {
        kind: 'group',
        driver: TASK_FACTS,
        groupColumn: 'taskId',
        members: [{ table: 'node_runs', column: 'task_id' }],
      },
      convert(unit, ctx) {
        seenGroups.push(...(unit.groupKeys ?? []))
        for (const row of unit.rows.get('node_runs')!)
          ctx.out.row(
            'fx_runs',
            fxRun(String(row.values.id), String(row.values.task_id), {
              status: String(row.values.status),
            }),
            row,
          )
      },
    })
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [task('t-open', 'running'), task('t-closed', 'done')],
          node_runs: [run('r-open', 't-open'), run('r-closed', 't-closed')],
          // Two rows per unit: [e-closed, e-closed-2] (finished task only), [e-open, e-unknown].
          recovery_events: [
            // No task on the row: it cannot say, so it is always looked at.
            frozenRow('recovery_events', { id: 'e-unknown' }),
            frozenRow('recovery_events', { id: 'e-open', task_id: 't-open' }),
            frozenRow('recovery_events', { id: 'e-closed', task_id: 't-closed' }),
            frozenRow('recovery_events', { id: 'e-closed-2', task_id: 't-closed' }),
          ],
          // Declared to concern no task at all.
          lifecycle_alerts: [frozenRow('lifecycle_alerts', { id: 'alert', task_id: 't-open' })],
        },
        [contribution([tasksRule(), groupedRuns, eventsRule, alertsRule])],
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([])
      expect([...seenEvents].sort()).toEqual(['e-open', 'e-unknown'])
      expect(seenGroups).toEqual(['t-open'])
      seenEvents.length = 0
      seenGroups.length = 0
      expect((await prepared.run(new RecordingSink())).status).toBe('converted')
      expect([...seenEvents].sort()).toEqual([
        'alert',
        'e-closed',
        'e-closed-2',
        'e-open',
        'e-unknown',
      ])
      expect(seenGroups).toEqual(['t-closed', 't-open'])
    } finally {
      prepared.close()
    }
  })
})

// Implementation gate G1-4 (RFC-626): discovery used to give a chunk rule only the rows of tasks
// that could continue. The checks across the rows of one unit (here: two rows giving the same
// target key) then saw less than the conversion: an unfinished task's row that came second in
// its chunk was set aside only by the conversion, which ends the upgrade with
// v2-settlement-missed. Discovery now converts such a chunk whole.
describe('RFC-626 discovery converts a unit whole', () => {
  /** Every run becomes a run named by its node: two runs of one node share a target key. */
  const byNode = runsRule([], {
    convert(unit, ctx) {
      for (const row of unit.rows.get('node_runs')!)
        ctx.out.row(
          'fx_runs',
          fxRun(String(row.values.node_id), String(row.values.task_id), {
            status: String(row.values.status),
          }),
          row,
        )
    },
  })
  const tables = () => ({
    tasks: [task('t-done', 'done'), task('t-open', 'running')],
    // One chunk (two rows per unit): the finished task's run comes first.
    node_runs: [
      run('r-a', 't-done', { node_id: 'shared' }),
      run('r-b', 't-open', { node_id: 'shared', status: 'running' }),
    ],
  })

  test('a row the conversion would set aside for a key another row of its chunk took ends its task in discovery', async () => {
    const prepared = await prepareConversion(
      automatic(tables(), [contribution([tasksRule(), byNode])]),
    )
    try {
      expect(prepared.plan.settlements).toEqual([unproven('t-open', 'running', 'v2-target-unique')])
      const sink = new RecordingSink()
      const summary = await prepared.run(sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      expect(byId(sink.rows('fx_runs'))).toEqual({ shared: fxRun('shared', 't-done') })
      expect(byId(sink.rows('fx_tasks'))).toMatchObject({
        't-done': { status: 'done' },
        't-open': { status: 'canceled' },
      })
      expect(sink.dispositions()).toEqual([
        expect.objectContaining({
          sourceKey: sourceKey('node_runs', 'r-b'),
          class: 'archived',
          decision: expect.objectContaining({ code: 'v2-target-unique' }),
        }),
      ])
    } finally {
      prepared.close()
    }
  })

  test('operator resolution blocks the second row, as before', async () => {
    const summary = await runConversion(
      engineInput(memorySource(tables()), [contribution([tasksRule(), byNode])], {
        scratchRoot: scratch(),
      }),
      new RecordingSink(),
    )
    expect(summary.status).toBe('blocked')
    expect(summary.blocks.map((block) => [block.code, block.sourceKey])).toEqual([
      ['v2-target-unique', sourceKey('node_runs', 'r-b')],
    ])
  })
})

describe('RFC-626 discovery: a registered set', () => {
  const tables = {
    tasks: [task('task-a', 'interrupted'), task('task-b', 'awaiting_review')],
    node_runs: [
      run('run-a', 'task-a', { status: 'running', envelope_nonce: null }),
      run('run-b', 'task-b', { status: 'awaiting_review', child_task_id: 'task-a' }),
    ],
  }
  const rules = () => [contribution([tasksRule(), runsRule()])]

  test('the same frozen source gives the same set and plan digest, and a registered set converts to the same units', async () => {
    const first = await prepareConversion(automatic(tables, rules()))
    const second = await prepareConversion(automatic(tables, rules()))
    const registered = await prepareConversion({
      ...automatic(tables, rules()),
      settlements: first.plan.settlements,
    })
    try {
      expect(first.plan.settlements).toHaveLength(2)
      expect(second.plan.digest).toBe(first.plan.digest)
      expect(registered.plan.settlements).toEqual(first.plan.settlements)
      expect(registered.plan.digest).toBe(first.plan.digest)
      const discovered = new RecordingSink()
      const replayed = new RecordingSink()
      const summary = await first.run(discovered)
      const replay = await registered.run(replayed)
      // Applied in one batch instead of two rounds, and still the same bytes.
      expect([...replayed.units.keys()].sort()).toEqual([...discovered.units.keys()].sort())
      for (const [unitId, unit] of discovered.units)
        expect(replayed.units.get(unitId)!.receipt.digest).toBe(unit.receipt.digest)
      expect(valueDigest(replay)).toBe(valueDigest(summary))
      expect(replayed.binding).toEqual(discovered.binding)
    } finally {
      first.close()
      second.close()
      registered.close()
    }
  })

  test('a registered set that misses a task the source still gives ends with v2-settlement-drift', async () => {
    const first = await prepareConversion(automatic(tables, rules()))
    const settlements = first.plan.settlements!
    first.close()
    await expect(
      prepareConversion({ ...automatic(tables, rules()), settlements: settlements.slice(0, 1) }),
    ).rejects.toThrow('v2-settlement-drift')
    await expect(
      prepareConversion({ ...automatic(tables, rules()), settlements: [] }),
    ).rejects.toThrow('v2-settlement-drift')
  })
})

describe('RFC-626 discovery: what a rule may not get wrong', () => {
  const tables = {
    tasks: [task('t-open', 'running')],
    node_runs: [run('r-open', 't-open', { envelope_nonce: null, pid: 7 })],
  }
  const copyRuns = (overrides: Partial<ConversionRule> = {}): ConversionRule =>
    runsRule([], {
      settles: undefined,
      convert(unit, ctx) {
        for (const row of unit.rows.get('node_runs')!)
          ctx.out.row('fx_runs', fxRun(String(row.values.id), String(row.values.task_id)), row)
      },
      ...overrides,
    })
  /** Blocks through the validator's own form of `blockExecutable`. */
  const pidValidator = (overrides: Partial<RowValidator> = {}): RowValidator => ({
    ref: { id: 'fixture/run-validator', version: 1 },
    table: 'node_runs',
    lookups: [TASK_FACTS],
    validate(row, ctx) {
      const facts = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
      return facts?.execution === 'executable' && row.values.pid !== null
        ? [
            {
              executable: { taskId: facts.taskId, status: facts.status },
              block: rowBlock('fixture-run-in-flight', row, null),
            },
          ]
        : []
    },
    ...overrides,
  })
  const modes = [undefined, 'operator', 'automatic'] as const
  const input = (
    contributions: readonly ConversionContribution[],
    resolution: (typeof modes)[number],
  ): ConversionInput =>
    engineInput(memorySource(tables), contributions, {
      scratchRoot: scratch(),
      ...(resolution ? { resolution } : {}),
    })

  test('a rule without `settles` that calls blockExecutable is an engine error under either resolution', async () => {
    for (const resolution of modes)
      await expect(
        runConversion(
          input([contribution([tasksRule(), runsRule([], { settles: undefined })])], resolution),
          new RecordingSink(),
        ),
      ).rejects.toBeInstanceOf(ConversionContractError)
  })

  test('a validator without `settles` that returns an executable block is an engine error under either resolution', async () => {
    for (const resolution of modes)
      await expect(
        runConversion(
          input(
            [contribution([tasksRule(), copyRuns()], { validators: [pidValidator()] })],
            resolution,
          ),
          new RecordingSink(),
        ),
      ).rejects.toBeInstanceOf(ConversionContractError)
  })

  test('a validator that declares `settles` ends the task its executable block names', async () => {
    const prepared = await prepareConversion(
      input(
        [
          contribution([tasksRule(), copyRuns()], {
            validators: [pidValidator({ settles: {} })],
          }),
        ],
        'automatic',
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([
        unproven('t-open', 'running', 'fixture-run-in-flight'),
      ])
      const sink = new RecordingSink()
      expect((await prepared.run(sink)).status).toBe('converted')
      expect(byId(sink.rows('fx_tasks'))).toMatchObject({ 't-open': { status: 'canceled' } })
    } finally {
      prepared.close()
    }
  })

  // Design §3.2.2 step 1: "没有声明 settles 的规则或校验器调用 blockExecutable 时，收集器抛内部错误
  // （两种模式都抛），所以漏声明会被既有用例直接发现". The declaration is per caller: another
  // participant of the same unit having declared it does not cover the one that did not.
  test('a validator that declares `settles` does not cover a rule that calls blockExecutable without declaring it', async () => {
    for (const resolution of modes)
      await expect(
        runConversion(
          input(
            [
              contribution([tasksRule(), runsRule([], { settles: undefined })], {
                validators: [pidValidator({ settles: {}, validate: () => [] })],
              }),
            ],
            resolution,
          ),
          new RecordingSink(),
        ),
      ).rejects.toBeInstanceOf(ConversionContractError)
  })

  test('a rule that declares `settles` does not cover a validator that returns an executable block without declaring it', async () => {
    for (const resolution of modes)
      await expect(
        runConversion(
          input(
            [
              contribution([tasksRule(), copyRuns({ settles: {} })], {
                validators: [pidValidator()],
              }),
            ],
            resolution,
          ),
          new RecordingSink(),
        ),
      ).rejects.toBeInstanceOf(ConversionContractError)
  })

  test('reaching blockExecutable in the conversion itself ends with v2-settlement-missed', async () => {
    // `tasksOf` says the rows concern no task, so discovery never looks at them.
    const prepared = await prepareConversion(
      input(
        [contribution([tasksRule(), runsRule([], { settles: { tasksOf: () => [] } })])],
        'automatic',
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([])
      const sink = new RecordingSink()
      await expect(prepared.run(sink)).rejects.toThrow('v2-settlement-missed')
      expect(sink.summary).toBeNull()
    } finally {
      prepared.close()
    }
  })
})

describe('RFC-626 discovery: a row of the execution chain that is about to be set aside', () => {
  const CORRUPT = 'fixture-run-corrupt'
  /** Blocks the row plainly (not blockExecutable) when `exit_code` says so. */
  const checkedRuns = (emit: (row: SourceRow) => TargetRow): ConversionRule =>
    runsRule([], {
      convert(unit, ctx) {
        for (const row of unit.rows.get('node_runs')!) {
          if (row.values.exit_code === 13) ctx.out.block(rowBlock(CORRUPT, row, { exit: 13 }))
          else ctx.out.row('fx_runs', emit(row), row)
        }
      },
    })
  const plain = (row: SourceRow): TargetRow =>
    fxRun(String(row.values.id), String(row.values.task_id))
  const cases: readonly {
    readonly name: string
    readonly code: string
    readonly broken: DecodedSourceRow
    readonly rule: ConversionRule
  }[] = [
    {
      name: 'a row-level block of the rule',
      code: CORRUPT,
      broken: run('r-broken', 't-open', { exit_code: 13 }),
      rule: checkedRuns(plain),
    },
    {
      name: 'a row the frozen codec rejects',
      code: 'v2-source-codec',
      broken: run('r-broken', 't-open', { runtime_params_json: '{ not json' }),
      rule: checkedRuns(plain),
    },
    {
      name: 'a target row the target contract refuses',
      code: 'v2-target-null',
      broken: run('r-broken', 't-open', { merge_state: 'no-task' }),
      rule: checkedRuns((row) =>
        row.values.merge_state === 'no-task' ? { ...plain(row), task_id: null } : plain(row),
      ),
    },
  ]
  for (const entry of cases)
    test(`${entry.name} ends the unfinished task it belongs to`, async () => {
      const prepared = await prepareConversion(
        automatic(
          {
            tasks: [task('t-open', 'running'), task('t-other', 'running')],
            node_runs: [entry.broken, run('r-fine', 't-open'), run('r-other', 't-other')],
          },
          [contribution([tasksRule(), entry.rule])],
        ),
      )
      try {
        expect(prepared.plan.settlements).toEqual([unproven('t-open', 'running', entry.code)])
        const sink = new RecordingSink()
        const summary = await prepared.run(sink)
        expect(summary.blocks).toEqual([])
        expect(summary.status).toBe('converted')
        expect(byId(sink.rows('fx_tasks'))).toMatchObject({
          't-open': { status: 'canceled' },
          't-other': { status: 'running' },
        })
        expect(Object.keys(byId(sink.rows('fx_runs'))).sort()).toEqual(['r-fine', 'r-other'])
        expect(sink.dispositions()).toEqual([
          expect.objectContaining({
            sourceTable: 'node_runs',
            sourceKey: sourceKey('node_runs', 'r-broken'),
            class: 'archived',
            decision: expect.objectContaining({ code: entry.code }),
          }),
        ])
      } finally {
        prepared.close()
      }
    })

  test('the same row of a finished task is set aside without ending anything', async () => {
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [task('t-closed', 'done')],
          node_runs: [run('r-broken', 't-closed', { exit_code: 13 })],
        },
        [contribution([tasksRule(), checkedRuns(plain)])],
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([])
      const sink = new RecordingSink()
      expect((await prepared.run(sink)).status).toBe('converted')
      expect(sink.dispositions()).toEqual([
        expect.objectContaining({
          class: 'archived',
          decision: { code: CORRUPT, detail: { exit: 13 } },
        }),
      ])
    } finally {
      prepared.close()
    }
  })

  test('a group whose row cannot be decoded is set aside whole and ends its unfinished task', async () => {
    const grouped = runsRule([], {
      unit: {
        kind: 'group',
        driver: TASK_FACTS,
        groupColumn: 'taskId',
        members: [{ table: 'node_runs', column: 'task_id' }],
      },
      convert(unit, ctx) {
        for (const row of unit.rows.get('node_runs')!) ctx.out.row('fx_runs', plain(row), row)
      },
    })
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [task('t-open', 'awaiting_review'), task('t-other', 'running')],
          node_runs: [
            run('r-1', 't-open', { runtime_params_json: '{ not json' }),
            run('r-2', 't-open'),
            run('r-other', 't-other'),
          ],
        },
        [contribution([tasksRule(), grouped])],
      ),
    )
    try {
      expect(prepared.plan.settlements).toEqual([
        {
          ...unproven('t-open', 'awaiting_review'),
          blockCodes: expect.arrayContaining(['v2-source-codec']),
        },
      ])
      const sink = new RecordingSink()
      const summary = await prepared.run(sink)
      expect(summary.status).toBe('converted')
      // The task itself is converted (canceled) and has no run records left.
      expect(byId(sink.rows('fx_tasks'))).toMatchObject({ 't-open': { status: 'canceled' } })
      expect(Object.keys(byId(sink.rows('fx_runs')))).toEqual(['r-other'])
      expect(
        sink
          .dispositions()
          .map((entry) => `${entry.class} ${entry.sourceKey}`)
          .sort(),
      ).toEqual(['r-1', 'r-2'].map((id) => `archived ${sourceKey('node_runs', id)}`).sort())
    } finally {
      prepared.close()
    }
  })
})

describe('RFC-626 settlers', () => {
  const taskSettler = cancelSettlement.settlers[0]!
  const tables = () => ({
    tasks: [task('t-wait', 'awaiting_human'), task('t-other', 'running')],
    node_runs: [
      run('r-bad', 't-wait', { envelope_nonce: null }),
      // Canceled long ago; the open clarify round still points at it.
      run('r-gate', 't-wait', { status: 'canceled', error_message: 'old-reason' }),
      run('r-other', 't-other', { status: 'running' }),
    ],
    clarify_rounds: [
      frozenRow('clarify_rounds', {
        id: 'round-open',
        task_id: 't-wait',
        kind: 'self',
        status: 'awaiting_human',
        intermediary_node_run_id: 'r-gate',
      }),
      frozenRow('clarify_rounds', {
        id: 'round-answered',
        task_id: 't-wait',
        kind: 'self',
        status: 'answered',
        intermediary_node_run_id: 'r-bad',
      }),
    ],
  })
  /** Closes the open rounds of the task. */
  const roundsSettler: TaskSettler = {
    tables: [{ table: 'clarify_rounds', taskColumn: 'task_id' }],
    settle(rows) {
      return (rows.get('clarify_rounds') ?? [])
        .filter((row) => row.values.status === 'awaiting_human')
        .map((row) => ({
          table: 'clarify_rounds',
          key: row.encodedKey,
          values: { ...row.values, status: 'canceled' },
        }))
    },
  }
  /** Stamps the run an open round waits on; it only reads the rounds. */
  const gateSettler = (read: string[]): TaskSettler => ({
    tables: [
      { table: 'clarify_rounds', taskColumn: 'task_id', write: false },
      { table: 'node_runs', taskColumn: 'task_id' },
    ],
    settle(rows) {
      const open = (rows.get('clarify_rounds') ?? []).filter(
        (row) => row.values.status === 'awaiting_human',
      )
      read.push(...(rows.get('clarify_rounds') ?? []).map((row) => String(row.values.status)))
      return (rows.get('node_runs') ?? [])
        .filter((row) =>
          open.some((round) => round.values.intermediary_node_run_id === row.values.id),
        )
        .map((row) => ({
          table: 'node_runs',
          key: row.encodedKey,
          values: { ...row.values, error_message: 'task-canceled' },
        }))
    },
  })
  const capture = (table: string, into: SourceRow[]): ConversionRule =>
    noteRule(table, {
      convert(unit, ctx) {
        for (const row of unit.rows.get(table)!) {
          into.push(row)
          ctx.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
        }
      },
    })
  const withSettlement = (
    settlement: SettlementContribution,
    rounds: SourceRow[] = [],
    runs: SourceRow[] = [],
  ): ConversionContribution =>
    contribution(
      [
        tasksRule(),
        runsRule([], {
          convert(unit, ctx) {
            for (const row of unit.rows.get('node_runs')!) {
              runs.push(row)
              const facts = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
              if (facts?.execution === 'executable' && row.values.envelope_nonce === null)
                ctx.out.blockExecutable(
                  { taskId: facts.taskId, status: facts.status },
                  rowBlock(UNPROVABLE, row, null),
                )
              else ctx.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
            }
          },
        }),
        capture('clarify_rounds', rounds),
      ],
      { settlement },
    )

  test('every settler reads the rows as staged; all rewrites land together and leave the evidence alone', async () => {
    const read: string[] = []
    const rounds: SourceRow[] = []
    const runs: SourceRow[] = []
    const source = tables()
    // The settler that closes the rounds comes first; the one that reads them still sees
    // the open round.
    const prepared = await prepareConversion(
      automatic(source, [
        withSettlement({ settlers: [taskSettler, roundsSettler, gateSettler(read)] }, rounds, runs),
      ]),
    )
    try {
      expect(prepared.plan.settlements).toEqual([unproven('t-wait', 'awaiting_human', UNPROVABLE)])
      expect([...read].sort()).toEqual(['answered', 'awaiting_human'])
      runs.length = 0
      const sink = new RecordingSink()
      expect((await prepared.run(sink)).status).toBe('converted')

      // Each rewritten row says so once, in the unit that consumed it, and names itself.
      const noted = sink
        .records()
        .flatMap((record) =>
          record.kind === 'decision' && record.code === 'v2-task-settled-at-upgrade'
            ? [
                record.payload as {
                  readonly taskId: string
                  readonly sourcePhase: string
                  readonly sourceTable: string
                  readonly sourceKey: string
                },
              ]
            : [],
        )
        .map(
          (payload) =>
            `${payload.taskId} ${payload.sourcePhase} ${payload.sourceTable} ${payload.sourceKey}`,
        )
        .sort()
      expect(noted).toEqual(
        [
          `t-wait current clarify_rounds ${sourceKey('clarify_rounds', 'round-open')}`,
          `t-wait current node_runs ${sourceKey('node_runs', 'r-gate')}`,
          `t-wait current tasks ${sourceKey('tasks', 't-wait')}`,
        ].sort(),
      )

      const open = rounds.find((row) => row.values.id === 'round-open')!
      expect(open.values.status).toBe('canceled')
      expect(open.settlement).toEqual({
        taskId: 't-wait',
        cause: 'unprovable-records',
        columns: {
          status: { before: canonicalValue('awaiting_human'), after: canonicalValue('canceled') },
        },
      })
      const answered = rounds.find((row) => row.values.id === 'round-answered')!
      expect(answered.values.status).toBe('answered')
      expect(answered.settlement).toBeUndefined()

      const gate = runs.find((row) => row.values.id === 'r-gate')!
      const original = source.node_runs.find((row) => row.id === 'r-gate')!
      expect(gate.values).toEqual({ ...original, error_message: 'task-canceled' })
      expect(gate.settlement?.columns).toEqual({
        error_message: {
          before: canonicalValue('old-reason'),
          after: canonicalValue('task-canceled'),
        },
      })
      // The evidence is the source row as the old database wrote it.
      expect(gate.canonical).toEqual(encodeLogicalRow(frozenTable('node_runs'), original))
      expect(gate.raw).toBeUndefined()
      expect(open.canonical).toEqual(
        encodeLogicalRow(
          frozenTable('clarify_rounds'),
          source.clarify_rounds.find((row) => row.id === 'round-open')!,
        ),
      )
      // Rows of other tasks are not touched.
      const other = runs.find((row) => row.values.id === 'r-other')!
      expect(other.values).toEqual(source.node_runs.find((row) => row.id === 'r-other')!)
      expect(other.settlement).toBeUndefined()
    } finally {
      prepared.close()
    }
  })

  test('rewriting changes no source digest: receipts and the staging digest equal those of an operator run', async () => {
    const settlement = { settlers: [taskSettler, roundsSettler, gateSettler([])] }
    const ended = new RecordingSink()
    const blocked = new RecordingSink()
    const endedSummary = await runConversion(
      automatic(tables(), [withSettlement(settlement)]),
      ended,
    )
    const blockedSummary = await runConversion(
      engineInput(memorySource(tables()), [withSettlement(settlement)], { scratchRoot: scratch() }),
      blocked,
    )
    expect(endedSummary.status).toBe('converted')
    expect(blockedSummary.status).toBe('blocked')
    expect(endedSummary.stagingDigest).toBe(blockedSummary.stagingDigest)
    const evidence = (receipts: typeof endedSummary.tableReceipts) =>
      receipts.map((receipt) => ({
        table: receipt.sourceTable,
        rows: receipt.rowsRead,
        keyDigest: receipt.keyDigest,
        contentDigest: receipt.contentDigest,
      }))
    expect(evidence(endedSummary.tableReceipts)).toEqual(evidence(blockedSummary.tableReceipts))
    const sources = (sink: RecordingSink) =>
      [...sink.units.values()]
        .flatMap((unit) => unit.receipt.sources)
        .map((source) => [source.table, source.firstKey, source.digest, source.keyDigest].join('|'))
        .sort()
    expect(sources(ended)).toEqual(sources(blocked))
  })

  test('two settlers giving one row different values for a column end with v2-settlement-conflict', async () => {
    const stamp = (value: string): TaskSettler => ({
      tables: [{ table: 'node_runs', taskColumn: 'task_id' }],
      settle(rows) {
        return (rows.get('node_runs') ?? [])
          .filter((row) => row.values.id === 'r-gate')
          .map((row) => ({
            table: 'node_runs',
            key: row.encodedKey,
            values: { ...row.values, error_message: value },
          }))
      },
    })
    await expect(
      prepareConversion(
        automatic(tables(), [
          withSettlement({ settlers: [taskSettler, stamp('one-reason'), stamp('another-reason')] }),
        ]),
      ),
    ).rejects.toThrow('v2-settlement-conflict')
  })

  test('a settler cannot write a table it only reads, nor a row that is not the task its own', async () => {
    const readOnly: TaskSettler = {
      tables: [{ table: 'clarify_rounds', taskColumn: 'task_id', write: false }],
      settle(rows) {
        return (rows.get('clarify_rounds') ?? []).map((row) => ({
          table: 'clarify_rounds',
          key: row.encodedKey,
          values: { ...row.values, status: 'canceled' },
        }))
      },
    }
    const foreign: TaskSettler = {
      tables: [{ table: 'node_runs', taskColumn: 'task_id' }],
      settle(rows) {
        const row = (rows.get('node_runs') ?? [])[0]!
        return [
          {
            table: 'node_runs',
            key: sourceKey('node_runs', 'r-other'),
            values: { ...row.values, status: 'canceled' },
          },
        ]
      },
    }
    for (const settler of [readOnly, foreign])
      await expect(
        prepareConversion(
          automatic(tables(), [withSettlement({ settlers: [taskSettler, settler] })]),
        ),
      ).rejects.toBeInstanceOf(ConversionContractError)
  })
})

describe('RFC-626 operator resolution is what it was', () => {
  const tables = {
    tasks: [task('t-open', 'interrupted'), task('t-closed', 'done')],
    node_runs: [
      run('r-open', 't-open', { envelope_nonce: null }),
      run('r-closed', 't-closed', { envelope_nonce: null }),
    ],
  }
  const operator = (rules: readonly ConversionRule[], resolution?: 'operator'): ConversionInput =>
    engineInput(memorySource(tables), [contribution(rules)], {
      scratchRoot: scratch(),
      ...(resolution ? { resolution } : {}),
    })

  test('the same input blocks: blockExecutable is block, and the plan carries neither new field', async () => {
    const seenResolution: string[] = []
    const sink = new RecordingSink()
    const summary = await runConversion(
      operator([
        tasksRule(),
        runsRule([], {
          convert(unit, ctx) {
            seenResolution.push(ctx.resolution)
            return runsRule().convert(unit, ctx)
          },
        }),
      ]),
      sink,
    )
    const facts = { taskId: 't-open', status: 'interrupted' }
    // The block the rule passed, unchanged.
    const expected: ConversionBlock = {
      code: UNPROVABLE,
      scope: 'row',
      sourceTable: 'node_runs',
      sourceKey: sourceKey('node_runs', 'r-open'),
      sourcePhase: 'current',
      taskId: 't-open',
      runId: 'r-open',
      missingFields: ['envelope_nonce'],
      detail: { executableTask: facts },
    }
    expect(summary.status).toBe('blocked')
    expect(summary.blocks).toEqual([expected])
    expect(summary.plan).not.toHaveProperty('resolution')
    expect(summary.plan).not.toHaveProperty('settlements')
    expect(summary).not.toHaveProperty('resolutions')
    expect(new Set(seenResolution)).toEqual(new Set(['operator']))
    expect(sink.dispositions()).toEqual([
      expect.objectContaining({
        sourceKey: sourceKey('node_runs', 'r-open'),
        class: 'blocked',
        kind: 'blocked',
        archive: null,
        decision: { code: UNPROVABLE, detail: { executableTask: facts } },
      }),
    ])
    // Nothing was ended, nothing rewritten, nothing set aside.
    expect(byId(sink.rows('fx_tasks'))).toMatchObject({ 't-open': { status: 'interrupted' } })
    expect(Object.keys(byId(sink.rows('fx_runs')))).toEqual(['r-closed'])
    expect(sink.records().filter((record) => record.kind === 'decision')).toEqual([])
    expect(
      summary.tableReceipts.find((receipt) => receipt.sourceTable === 'node_runs')!.counts,
    ).toEqual({ converted: 1, preserved: 0, archived: 0, blocked: 1 })
  })

  test('`operator` given explicitly is the default, and blockExecutable gives the bytes block gives', async () => {
    const withBlock = runsRule([], {
      convert(unit, ctx) {
        for (const row of unit.rows.get('node_runs')!) {
          const facts = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
          if (facts?.execution === 'executable' && row.values.envelope_nonce === null) {
            const executable = { taskId: facts.taskId, status: facts.status }
            ctx.out.block(executableBlock(UNPROVABLE, row, executable))
          } else
            ctx.out.row(
              'fx_runs',
              fxRun(String(row.values.id), String(row.values.task_id), {
                status: String(row.values.status),
                label: row.values.error_message ?? null,
              }),
              row,
            )
        }
      },
    })
    const outcomes: { plan: string; summary: string; units: string[] }[] = []
    for (const input of [
      operator([tasksRule(), runsRule()]),
      operator([tasksRule(), runsRule()], 'operator'),
      operator([tasksRule(), withBlock]),
    ]) {
      const sink = new RecordingSink()
      const summary = await runConversion(input, sink)
      outcomes.push({
        plan: summary.plan.digest,
        summary: valueDigest(summary),
        units: [...sink.units.values()].map((unit) => unit.receipt.digest).sort(),
      })
    }
    expect(outcomes[1]).toEqual(outcomes[0]!)
    expect(outcomes[2]).toEqual(outcomes[0]!)
  })

  test('automatic resolution is told to the rule and changes the plan digest', async () => {
    const seen: string[] = []
    const rules = (): ConversionRule[] => [
      tasksRule(),
      runsRule([], {
        convert(unit, ctx) {
          seen.push(ctx.resolution)
          return runsRule().convert(unit, ctx)
        },
      }),
    ]
    const manual = await prepareConversion(operator(rules()))
    const auto = await prepareConversion(automatic(tables, [contribution(rules())]))
    try {
      expect(new Set(seen)).toEqual(new Set(['automatic']))
      expect(auto.plan.digest).not.toBe(manual.plan.digest)
      expect(auto.plan.converterVersion).toBe(manual.plan.converterVersion)
      expect(auto.plan.ruleSetDigest).toBe(manual.plan.ruleSetDigest)
      const {
        digest: _digest,
        resolution: _resolution,
        settlements: _settlements,
        ...rest
      } = auto.plan
      const { digest: _manualDigest, ...manualRest } = manual.plan
      expect(rest).toEqual(manualRest)
    } finally {
      manual.close()
      auto.close()
    }
  })
})
