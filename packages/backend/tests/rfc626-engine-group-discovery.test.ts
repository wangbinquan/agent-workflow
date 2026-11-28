// RFC-626 implementation gate G1-5 (design §3.2.2 step 2: "按任务分组的规则只取可继续任务的组"):
// discovery read every group of a group rule each round and only then skipped the groups whose
// tasks had all finished (the run rule read every run of the source each round). A rule — and
// every validator of its tables that declares `settles` — can now declare `tasksOfGroup`, and
// discovery leaves a group none of whose covering tasks can continue unread. It only saves
// time: the tasks discovery ends, the plan and the committed units are the same with and
// without the declaration. Batches of `groupsPerUnit` are formed before anything is skipped,
// so every unit that is read is the unit the conversion converts (gate G1-4: checks across the
// rows of a unit must see the same rows). The declarations of the task and run rules are
// checked against the `tasksOf` they cover.
import { describe, expect, test } from 'bun:test'
import { prepareConversion } from '@/platform/persistence/migration/conversion/engine'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import {
  TASK_FACTS,
  executionClass,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type { LookupResolver } from '@/platform/persistence/migration/conversion/lookups'
import type {
  ConversionRule,
  RowValidator,
  SettlesDeclaration,
} from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow, TaskSettlement } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { taskConversionRule } from '@/modules/task-execution/infrastructure/migration/task/rule'
import {
  taskRuleTasksOf,
  taskRuleTasksOfGroup,
} from '@/modules/task-execution/infrastructure/migration/task/settles'
import {
  RecordingSink,
  cancelSettlement,
  engineInput,
  frozenRow,
  fxRun,
  memorySource,
  noteRule,
  scratchRoots,
  taskFactsFromTasks,
} from './rfc626-engine-fixtures.test'
import { sourceRow } from './helpers/rfc395V2/runFixtures'

const scratch = scratchRoots()

const UNPROVABLE = 'fixture-run-unprovable'

function task(id: string, status: string): DecodedSourceRow {
  return frozenRow('tasks', { id, status })
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
function unproven(taskId: string, originalStatus: string, ...blockCodes: string[]): TaskSettlement {
  return { taskId, cause: 'unprovable-records', originalStatus, blockCodes, parentTaskId: null }
}

/**
 * Runs grouped by task through the task facts. A run without a nonce of a task that could
 * continue blocks through `blockExecutable`; every other run becomes a run named by `name`.
 * `seen` receives every row `tasksOf` is asked about, `asked` every group `tasksOfGroup` is.
 */
function groupedRuns(options: {
  readonly seen: string[]
  readonly asked?: string[]
  readonly groupsPerUnit?: number
  readonly name?: (row: SourceRow) => string
}): ConversionRule {
  const settles: SettlesDeclaration = {
    tasksOf(row) {
      options.seen.push(String(row.values.id))
      return [String(row.values.task_id)]
    },
    ...(options.asked
      ? {
          tasksOfGroup(groupKey) {
            options.asked!.push(groupKey)
            return [groupKey]
          },
        }
      : {}),
  }
  return {
    ref: { id: 'fixture/grouped-runs', version: 1 },
    owner: 'fixture',
    claims: ['node_runs'],
    produces: [{ table: 'fx_runs' }],
    lookups: [TASK_FACTS],
    unit: {
      kind: 'group',
      driver: TASK_FACTS,
      groupColumn: 'taskId',
      members: [{ table: 'node_runs', column: 'task_id' }],
      ...(options.groupsPerUnit ? { groupsPerUnit: options.groupsPerUnit } : {}),
    },
    settles,
    convert(unit, ctx) {
      for (const row of unit.rows.get('node_runs')!) {
        const facts = ctx.lookup(TASK_FACTS).get(String(row.values.task_id))
        if (facts?.execution === 'executable' && row.values.envelope_nonce === null) {
          ctx.out.blockExecutable(
            { taskId: facts.taskId, status: facts.status },
            rowBlock(UNPROVABLE, row, null),
          )
          continue
        }
        ctx.out.row(
          'fx_runs',
          fxRun(options.name?.(row) ?? String(row.values.id), String(row.values.task_id)),
          row,
        )
      }
    },
  }
}
const contribution = (rule: ConversionRule, validators: readonly RowValidator[] = []) => ({
  rules: [noteRule('tasks'), rule],
  lookups: [taskFactsFromTasks],
  validators,
  settlement: cancelSettlement,
})
const automatic = (
  tables: Readonly<Record<string, readonly DecodedSourceRow[]>>,
  rule: ConversionRule,
  validators: readonly RowValidator[] = [],
) =>
  engineInput(memorySource(tables), [contribution(rule, validators)], {
    scratchRoot: scratch(),
    resolution: 'automatic',
  })

describe('RFC-626 discovery leaves groups of finished tasks unread', () => {
  const tables = () => ({
    tasks: [
      task('t-broken', 'interrupted'),
      task('t-open', 'running'),
      task('t-done', 'done'),
      task('t-failed', 'failed'),
    ],
    node_runs: [
      run('r-broken', 't-broken', { envelope_nonce: null }),
      run('r-open', 't-open', { status: 'running' }),
      run('r-done-1', 't-done'),
      run('r-done-2', 't-done'),
      run('r-failed', 't-failed'),
    ],
  })
  const finishedRuns = ['r-done-1', 'r-done-2', 'r-failed']

  test('with `tasksOfGroup` a group none of whose tasks can continue is not read; the outcome is the same', async () => {
    const declaredSeen: string[] = []
    const asked: string[] = []
    const undeclaredSeen: string[] = []
    const declared = await prepareConversion(
      automatic(tables(), groupedRuns({ seen: declaredSeen, asked })),
    )
    const undeclared = await prepareConversion(
      automatic(tables(), groupedRuns({ seen: undeclaredSeen })),
    )
    try {
      const expected = [unproven('t-broken', 'interrupted', UNPROVABLE)]
      expect(declared.plan.settlements).toEqual(expected)
      expect(undeclared.plan.settlements).toEqual(expected)
      expect(declared.plan.digest).toBe(undeclared.plan.digest)
      // Read before: every finished task's runs were looked at in each round.
      expect(undeclaredSeen).toEqual(expect.arrayContaining(finishedRuns))
      // Read now: only groups whose task could continue; the others were only asked about.
      expect(declaredSeen.filter((id) => finishedRuns.includes(id))).toEqual([])
      expect(declaredSeen).toContain('r-open')
      expect(asked).toEqual(expect.arrayContaining(['t-done', 't-failed']))
      // The conversion commits the same units, byte for byte.
      const one = new RecordingSink()
      const other = new RecordingSink()
      expect((await declared.run(one)).status).toBe('converted')
      expect((await undeclared.run(other)).status).toBe('converted')
      const digests = (sink: RecordingSink) =>
        Object.fromEntries([...sink.units].map(([id, unit]) => [id, unit.receipt.digest]))
      expect(digests(one)).toEqual(digests(other))
    } finally {
      declared.close()
      undeclared.close()
    }
  })

  test('a validator of its tables that declares `settles` without `tasksOfGroup` keeps every group read', async () => {
    const seen: string[] = []
    const asked: string[] = []
    const validator: RowValidator = {
      ref: { id: 'fixture/run-validator', version: 1 },
      table: 'node_runs',
      settles: {},
      validate: () => [],
    }
    const prepared = await prepareConversion(
      automatic(tables(), groupedRuns({ seen, asked }), [validator]),
    )
    try {
      expect(prepared.plan.settlements).toEqual([unproven('t-broken', 'interrupted', UNPROVABLE)])
      expect(asked).toEqual([])
      expect(seen).toEqual(expect.arrayContaining(finishedRuns))
    } finally {
      prepared.close()
    }
  })

  test('batches are formed before groups are skipped: a unit read holds every group the conversion gives it', async () => {
    const seen: string[] = []
    // Two groups per unit: [t-a, t-b] and [t-c, t-d]. The runs of t-a and t-b give the same
    // target key, so the conversion sets aside t-b's run, which comes second in its unit.
    const rule = groupedRuns({
      seen,
      asked: [],
      groupsPerUnit: 2,
      name: (row) => String(row.values.node_id),
    })
    const prepared = await prepareConversion(
      automatic(
        {
          tasks: [
            task('t-a', 'done'),
            task('t-b', 'running'),
            task('t-c', 'done'),
            task('t-d', 'failed'),
          ],
          node_runs: [
            run('r-a', 't-a', { node_id: 'shared' }),
            run('r-b', 't-b', { node_id: 'shared', status: 'running' }),
            run('r-c', 't-c', { node_id: 'node-c' }),
            run('r-d', 't-d', { node_id: 'node-d' }),
          ],
        },
        rule,
      ),
    )
    try {
      // The unit with t-b was read whole, its finished neighbour included.
      expect(prepared.plan.settlements).toEqual([unproven('t-b', 'running', 'v2-target-unique')])
      expect(seen).toEqual(expect.arrayContaining(['r-a', 'r-b']))
      expect(seen.filter((id) => id === 'r-c' || id === 'r-d')).toEqual([])
      const sink = new RecordingSink()
      const summary = await prepared.run(sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      expect(
        sink
          .rows('fx_runs')
          .map((row) => [row.id, row.task_id])
          .sort(),
      ).toEqual([
        ['node-c', 't-c'],
        ['node-d', 't-d'],
        ['shared', 't-a'],
      ])
    } finally {
      prepared.close()
    }
  })
})

describe('RFC-626 the group declarations of the task and run rules cover their rows', () => {
  const facts = (taskId: string, status: string, parentTaskId: string | null): TaskFacts => ({
    taskId,
    parentTaskId,
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
  const lookupOf = (entries: readonly TaskFacts[]): LookupResolver =>
    (() => ({
      get: (id: string) => entries.find((entry) => entry.taskId === id),
    })) as unknown as LookupResolver

  test('the task rule declares `taskRuleTasksOfGroup` beside `taskRuleTasksOf`', () => {
    expect(taskConversionRule.settles).toEqual({
      tasksOf: taskRuleTasksOf,
      tasksOfGroup: taskRuleTasksOfGroup,
    })
  })

  const cases = [
    { status: 'done', parent: 'parent' },
    { status: 'failed', parent: 'parent' },
    { status: 'canceled', parent: null },
    { status: 'running', parent: 'parent' },
    { status: 'awaiting_human', parent: null },
  ] as const
  for (const item of cases)
    test(`a ${item.status} task ${item.parent ? 'with' : 'without'} a parent: every row of its group lies within the declaration`, () => {
      const lookup = lookupOf([facts('task', item.status, item.parent)])
      const covering = taskRuleTasksOfGroup('task', lookup)
      expect(covering).toBeDefined()
      const rows: SourceRow[] = [
        sourceRow(
          'tasks',
          frozenRow('tasks', { id: 'task', status: item.status, parent_task_id: item.parent }),
        ),
        sourceRow('task_repos', frozenRow('task_repos', { task_id: 'task' })),
        sourceRow('task_space_nodes', frozenRow('task_space_nodes', { task_id: 'task' })),
        sourceRow('workgroup_task_state', frozenRow('workgroup_task_state', { task_id: 'task' })),
      ]
      for (const row of rows)
        for (const taskId of taskRuleTasksOf(row)) expect(covering).toContain(taskId)
      // A finished task covers itself only: discovery skips its group.
      if (executionClass(item.status) !== 'executable') expect(covering).toEqual(['task'])
    })

  test('a task without facts cannot be told from its key: its group is read', () => {
    expect(taskRuleTasksOfGroup('task', lookupOf([]))).toBeUndefined()
  })
})
