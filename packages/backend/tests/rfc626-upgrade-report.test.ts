// RFC-626 §3.3 / §3.7 (plan T3 "报告"): what an automatic upgrade decided in place of a person is
// written down where a person finds it.
//
// Why this file exists: the upgrade no longer refuses because of the data — it ends tasks it
// cannot carry over, records content that is gone as missing, sets rows aside, clears
// references — and none of that may happen silently. The conversion summary is final when the
// conversion ends, and finalizing the target (which runs later) makes decisions of its own, so
// the plan of the actual result is where the two lists meet (`resolutions`); that section is
// material to the approval. The receipt, the completion log and `db migration status` all read
// that plan. This file locks the merge, its limits (at most 1000 entries per kind in the plan,
// 50 per kind in the log, exact totals always), the wording of the lines, the count of
// unfinished tasks (read tolerantly, without the tasks that were ended), and that a plan of the
// manual flow has no such section.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import {
  RESOLUTION_LIST_LIMIT,
  type ConversionResolutions,
} from '@/platform/persistence/migration/conversion/sink'
import type { ArchiveRef, TaskSettlement } from '@/platform/persistence/migration/conversion/types'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import type {
  FinalizeDisposition,
  FrozenSourceHandle,
} from '@/platform/persistence/migration/run/types'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import {
  automaticTaskCensus,
  unfinishedTasks,
} from '@/modules/system-operations/application/epochSwitch/planner'
import type { EpochResolutionsView } from '@/modules/system-operations/public/types'
import {
  PlanResolutionsSchema,
  createMigrationPlanDocument,
  type PlanResolutions,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import { resolutionReportLines } from '@/modules/system-operations/domain/epochSwitch/planDocument'
import { mergePlanResolutions } from '@/modules/system-operations/domain/epochSwitch/resolutions'
import type { EpochSwitchStatusView } from '@/modules/system-operations/public/types'
import { directSwitchFixture, type DirectSwitchFixture } from './helpers/rfc626DirectSwitch'

const fixtures: DirectSwitchFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close()
})
function fixture(options: Parameters<typeof directSwitchFixture>[0] = {}): DirectSwitchFixture {
  const f = directSwitchFixture(options)
  fixtures.push(f)
  return f
}

const key = (table: string, id: string) => encodeMigrationKey(table, [{ type: 'text', value: id }])
const RECORDS = 'agent_workflow_meta.migration_records'
const SETTLED: TaskSettlement[] = [
  {
    taskId: 'task_b',
    cause: 'unprovable-records',
    originalStatus: 'running',
    blockCodes: ['v2-run-unprovable', 'v2-session-unprovable'],
    parentTaskId: null,
  },
  {
    taskId: 'task_c',
    cause: 'parent-cascade',
    originalStatus: 'pending',
    blockCodes: [],
    parentTaskId: 'task_b',
  },
]
const CONVERSION: ConversionResolutions = {
  settledTasks: SETTLED,
  setAside: {
    total: 3,
    rows: [
      {
        sourcePhase: 'current',
        sourceTable: 'node_runs',
        sourceKey: key('node_runs', 'run_1'),
        code: 'v2-source-reference-missing',
      },
      {
        sourcePhase: 'current',
        sourceTable: 'node_runs',
        sourceKey: key('node_runs', 'run_2'),
        code: 'v2-source-reference-missing',
      },
      {
        sourcePhase: 'pre-upgrade',
        sourceTable: 'events',
        sourceKey: key('events', '7'),
        code: 'v2-codec-rejected',
      },
    ],
  },
  missingContent: {
    total: 2,
    rows: [
      {
        sourceTable: 'node_runs',
        sourceKey: key('node_runs', 'run_3'),
        sourceColumn: 'log_path',
        reference: 'runs/task_a/run_3.log',
        state: 'missing',
        // The cases that name a task set their own row; these two stay without one.
        taskId: null,
      },
      {
        sourceTable: 'skills',
        sourceKey: key('skills', 'skill_1'),
        sourceColumn: 'path',
        reference: null,
        state: 'unsupported',
        taskId: null,
      },
    ],
  },
  kept: {
    total: 4,
    byCode: { 'v2-boot-schedule-kept-disabled': 3, 'v2-boot-runtime-defaults-not-carried': 1 },
    rows: [
      {
        sourceTable: 'scheduled_tasks',
        sourceKey: key('scheduled_tasks', 's1'),
        code: 'v2-boot-schedule-kept-disabled',
      },
    ],
  },
  acknowledged: { total: 5, byCode: { 'v2-code-history-unfinished': 5 } },
}
const FINALIZE: FinalizeDisposition[] = [
  {
    targetTable: 'tasks',
    targetKey: key('tasks', 'task_a'),
    foreignKey: 'tasks_owner_user_id_fk',
    references: 'users',
    action: 'detached',
    archive: null,
  },
  {
    targetTable: 'task_collaborators',
    targetKey: key('task_collaborators', 'c1'),
    foreignKey: 'task_collaborators_user_id_fk',
    references: 'users',
    action: 'set-aside',
    archive: `archive:sha256:${'a'.repeat(64)}` as ArchiveRef,
  },
]
const NAMES = new Map<string, string | null>([
  ['task_b', 'Nightly audit'],
  ['task_c', null],
])
const merged = (listLimit = RESOLUTION_LIST_LIMIT, recordsTable = RECORDS) =>
  mergePlanResolutions({
    conversion: CONVERSION,
    finalize: FINALIZE,
    taskNames: NAMES,
    listLimit,
    recordsTable,
  })
// Gate G4-2: the totals say which of the two counts a row moved to the archive while
// finalizing is in (the second: it is a dangling reference finalizing resolved).
const summaryLine = (totals: PlanResolutions['totals']) =>
  `Decisions made by the upgrade: ${totals.settledTasks} unfinished task(s) ended; ` +
  `${totals.missingContent} content reference(s) recorded as missing; ` +
  `${totals.setAside} row(s) set aside by the conversion; ` +
  `${totals.finalize} dangling reference(s) resolved while finalizing ` +
  `(cleared, re-pointed, or with the referring row moved to the archive); ` +
  `${totals.acknowledged} retired item(s) acknowledged; ` +
  `${totals.kept} row(s) kept with a marker.`
/** The lines of the fixture's decisions, as the completion log and the plan print them. */
const LINES = (recordsTable: string) => [
  summaryLine({
    settledTasks: 2,
    missingContent: 2,
    setAside: 3,
    finalize: 2,
    acknowledged: 5,
    kept: 4,
  }),
  'task ended by the upgrade: task_b "Nightly audit", was running (v2-run-unprovable, v2-session-unprovable)',
  'task ended by the upgrade: task_c "", was pending (ended with its parent task_b)',
  'content recorded as missing: node_runs(run_3) log_path -> runs/task_a/run_3.log (missing)',
  'content recorded as missing: skills(skill_1) path -> no reference (unsupported)',
  'row set aside: node_runs(run_1): v2-source-reference-missing',
  'row set aside: node_runs(run_2): v2-source-reference-missing',
  'row set aside: events(7): v2-codec-rejected',
  'reference detached: tasks(task_a) tasks_owner_user_id_fk -> users',
  'reference set-aside: task_collaborators(c1) task_collaborators_user_id_fk -> users',
  'acknowledged for the upgrade: v2-code-history-unfinished x 5',
  'row kept with a marker: scheduled_tasks(s1): v2-boot-schedule-kept-disabled',
  'kept by code: v2-boot-runtime-defaults-not-carried x 1',
  'kept by code: v2-boot-schedule-kept-disabled x 3',
  // Four rows were kept and the conversion named one of them.
  `Not every decision is listed here; all of them are in ${recordsTable} of the new database.`,
]

describe('RFC-626 —— 转换的决定与收尾的处置在实际结果的计划里合并', () => {
  test('两份清单并成一份：任务带上旧库里的名称，封存分转换与收尾两段，合计各自精确', () => {
    const resolutions = merged()
    expect(resolutions).toEqual({
      settledTasks: [
        { ...SETTLED[0]!, name: 'Nightly audit' },
        { ...SETTLED[1]!, name: null },
      ],
      missingContent: [
        {
          table: 'node_runs',
          key: key('node_runs', 'run_3'),
          column: 'log_path',
          reference: 'runs/task_a/run_3.log',
          state: 'missing',
        },
        {
          table: 'skills',
          key: key('skills', 'skill_1'),
          column: 'path',
          reference: null,
          state: 'unsupported',
        },
      ],
      setAside: [
        ...CONVERSION.setAside.rows.map((row) => ({ stage: 'conversion' as const, ...row })),
        ...FINALIZE.map((row) => ({ stage: 'finalize' as const, ...row })),
      ],
      acknowledged: { 'v2-code-history-unfinished': 5 },
      kept: [
        {
          table: 'scheduled_tasks',
          key: key('scheduled_tasks', 's1'),
          code: 'v2-boot-schedule-kept-disabled',
        },
      ],
      keptByCode: {
        'v2-boot-runtime-defaults-not-carried': 1,
        'v2-boot-schedule-kept-disabled': 3,
      },
      totals: {
        settledTasks: 2,
        missingContent: 2,
        setAside: 3,
        finalize: 2,
        acknowledged: 5,
        kept: 4,
      },
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    // Counts by code are written in a stable order, whatever order the conversion counted in.
    expect(Object.keys(resolutions.keptByCode)).toEqual([
      'v2-boot-runtime-defaults-not-carried',
      'v2-boot-schedule-kept-disabled',
    ])
    expect(RESOLUTION_LIST_LIMIT).toBe(1000)
    // The plan's strict form accepts exactly this.
    expect(PlanResolutionsSchema.parse(resolutions)).toEqual(resolutions)
  })

  test('每类清单至多 listLimit 条（封存：转换与收尾各自计），合计不受截断影响', () => {
    const capped = merged(1)
    expect(capped.settledTasks.map((task) => task.taskId)).toEqual(['task_b'])
    expect(capped.missingContent).toHaveLength(1)
    expect(capped.setAside.map((row) => row.stage)).toEqual(['conversion', 'finalize'])
    expect(capped.kept).toHaveLength(1)
    expect(capped.listLimit).toBe(1)
    expect(capped.totals).toEqual(merged().totals)
    expect(capped.keptByCode).toEqual(merged().keptByCode)
    expect(capped.acknowledged).toEqual(merged().acknowledged)
  })

  test('什么都没有决定时也是一份完整的记录：全为零', () => {
    const none = mergePlanResolutions({
      conversion: undefined,
      finalize: [],
      taskNames: new Map(),
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    expect(none).toEqual({
      settledTasks: [],
      missingContent: [],
      setAside: [],
      acknowledged: {},
      kept: [],
      keptByCode: {},
      totals: {
        settledTasks: 0,
        missingContent: 0,
        setAside: 0,
        finalize: 0,
        acknowledged: 0,
        kept: 0,
      },
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    expect(PlanResolutionsSchema.safeParse(none).success).toBe(true)
    expect(resolutionReportLines(none, { listed: 50 })).toEqual([summaryLine(none.totals)])
  })

  test('只有收尾有处置时照样记录', () => {
    const only = mergePlanResolutions({
      conversion: undefined,
      finalize: FINALIZE,
      taskNames: new Map(),
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    expect(only.totals).toMatchObject({ setAside: 0, finalize: 2 })
    expect(only.setAside.map((row) => row.stage)).toEqual(['finalize', 'finalize'])
    expect(resolutionReportLines(only, { listed: 50 })).toEqual([
      summaryLine(only.totals),
      'reference detached: tasks(task_a) tasks_owner_user_id_fk -> users',
      'reference set-aside: task_collaborators(c1) task_collaborators_user_id_fk -> users',
    ])
  })

  test('严格形态：多出来的键、认不得的阶段或动作、不成形的键都不接受', () => {
    const valid = merged()
    expect(PlanResolutionsSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
    expect(
      PlanResolutionsSchema.safeParse({
        ...valid,
        totals: { ...valid.totals, retried: 0 },
      }).success,
    ).toBe(false)
    expect(
      PlanResolutionsSchema.safeParse({
        ...valid,
        setAside: [{ ...valid.setAside[0]!, stage: 'validation' }],
      }).success,
    ).toBe(false)
    expect(
      PlanResolutionsSchema.safeParse({
        ...valid,
        setAside: [{ ...valid.setAside.at(-1)!, action: 'deleted' }],
      }).success,
    ).toBe(false)
    expect(
      PlanResolutionsSchema.safeParse({
        ...valid,
        kept: [{ table: 'scheduled_tasks', key: 's1', code: 'x' }],
      }).success,
    ).toBe(false)
    expect(
      PlanResolutionsSchema.safeParse({
        ...valid,
        settledTasks: [{ ...valid.settledTasks[0]!, cause: 'operator' }],
      }).success,
    ).toBe(false)
    expect(PlanResolutionsSchema.safeParse({ ...valid, listLimit: 0 }).success).toBe(false)
  })
})

describe('RFC-626 —— 报告的文字', () => {
  test('合计一行；被结束的任务逐个列出；其余每类逐条；按代码的计数；有没列出的就指向记录表', () => {
    expect(resolutionReportLines(merged(), { listed: 50 })).toEqual(LINES(RECORDS))
  })

  test('每类至多列出 listed 条；任务不受这个限制；没列全时最后一行说明全部在哪里', () => {
    const lines = resolutionReportLines(merged(), { listed: 1 })
    expect(lines).toEqual([
      LINES(RECORDS)[0]!,
      // Every ended task is named: a person has to know which of their tasks was ended.
      LINES(RECORDS)[1]!,
      LINES(RECORDS)[2]!,
      'content recorded as missing: node_runs(run_3) log_path -> runs/task_a/run_3.log (missing)',
      'row set aside: node_runs(run_1): v2-source-reference-missing',
      // Gate G4-2: what finalizing resolved is a kind of its own, listed up to `listed` too.
      'reference detached: tasks(task_a) tasks_owner_user_id_fk -> users',
      'acknowledged for the upgrade: v2-code-history-unfinished x 5',
      'row kept with a marker: scheduled_tasks(s1): v2-boot-schedule-kept-disabled',
      'kept by code: v2-boot-runtime-defaults-not-carried x 1',
      'kept by code: v2-boot-schedule-kept-disabled x 3',
      LINES(RECORDS).at(-1)!,
    ])
  })

  test('日志每类 50 条：第 51 条起不列，合计仍是全部', () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      sourcePhase: 'current' as const,
      sourceTable: 'node_runs',
      sourceKey: key('node_runs', `run_${String(index).padStart(2, '0')}`),
      code: 'v2-source-reference-missing',
    }))
    const many = mergePlanResolutions({
      conversion: {
        ...CONVERSION,
        settledTasks: [],
        setAside: { total: 2400, rows },
        missingContent: { total: 0, rows: [] },
        kept: { total: 0, byCode: {}, rows: [] },
        acknowledged: { total: 0, byCode: {} },
      },
      finalize: [],
      taskNames: new Map(),
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    const lines = resolutionReportLines(many, { listed: 50 })
    expect(lines[0]).toContain('2400 row(s) set aside')
    expect(lines.filter((line) => line.startsWith('row set aside: '))).toHaveLength(50)
    expect(lines[50]).toBe('row set aside: node_runs(run_49): v2-source-reference-missing')
    expect(lines.at(-1)).toBe(
      `Not every decision is listed here; all of them are in ${RECORDS} of the new database.`,
    )
    expect(lines).toHaveLength(52)
  })

  // Gate G4-2: the conversion's rows came first in the one list and filled the 50 lines, so
  // the references finalizing resolved never reached the log although the receipt has them.
  test('转换封存满 50 条时，收尾的处置照样各列出自己的前 50 条', () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      sourcePhase: 'current' as const,
      sourceTable: 'node_runs',
      sourceKey: key('node_runs', `run_${String(index).padStart(2, '0')}`),
      code: 'v2-source-reference-missing',
    }))
    const many = mergePlanResolutions({
      conversion: {
        ...CONVERSION,
        settledTasks: [],
        setAside: { total: 60, rows },
        missingContent: { total: 0, rows: [] },
        kept: { total: 0, byCode: {}, rows: [] },
        acknowledged: { total: 0, byCode: {} },
      },
      finalize: FINALIZE,
      taskNames: new Map(),
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    const lines = resolutionReportLines(many, { listed: 50 })
    expect(lines.filter((line) => line.startsWith('row set aside: '))).toHaveLength(50)
    expect(lines.filter((line) => line.startsWith('reference '))).toEqual([
      'reference detached: tasks(task_a) tasks_owner_user_id_fk -> users',
      'reference set-aside: task_collaborators(c1) task_collaborators_user_id_fk -> users',
    ])
    expect(lines.at(-1)).toBe(
      `Not every decision is listed here; all of them are in ${RECORDS} of the new database.`,
    )
    // Both lists complete: nothing points at the records table.
    const fewer = resolutionReportLines(many, { listed: 60 })
    expect(fewer.filter((line) => line.startsWith('row set aside: '))).toHaveLength(60)
    expect(fewer.some((line) => line.startsWith('Not every decision'))).toBe(false)
  })

  // Gate G4-3: the report says which task the missing content belongs to; content of no task
  // (a skill file) has no task, and the plan's entry then has no `taskId` key at all.
  test('缺失的内容带上所属任务；不属于任务的内容不带', () => {
    const [runLog, skillFile] = CONVERSION.missingContent.rows
    const ofTask = { ...runLog!, taskId: 'task_a' }
    const ofNoTask = { ...skillFile!, taskId: null }
    const resolutions = mergePlanResolutions({
      conversion: { ...CONVERSION, missingContent: { total: 2, rows: [ofTask, ofNoTask] } },
      finalize: [],
      taskNames: NAMES,
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    expect(resolutions.missingContent).toEqual([
      {
        table: 'node_runs',
        key: key('node_runs', 'run_3'),
        column: 'log_path',
        reference: 'runs/task_a/run_3.log',
        state: 'missing',
        taskId: 'task_a',
      },
      {
        table: 'skills',
        key: key('skills', 'skill_1'),
        column: 'path',
        reference: null,
        state: 'unsupported',
      },
    ])
    expect(Object.hasOwn(resolutions.missingContent[1]!, 'taskId')).toBe(false)
    expect(PlanResolutionsSchema.parse(resolutions)).toEqual(resolutions)
    expect(
      resolutionReportLines(resolutions, { listed: 50 }).filter((line) =>
        line.startsWith('content recorded as missing: '),
      ),
    ).toEqual([
      'content recorded as missing: node_runs(run_3) log_path -> runs/task_a/run_3.log (missing), task task_a',
      'content recorded as missing: skills(skill_1) path -> no reference (unsupported)',
    ])
    // A task id is text, never an empty or null value in the plan.
    expect(
      PlanResolutionsSchema.safeParse({
        ...resolutions,
        missingContent: [{ ...resolutions.missingContent[0]!, taskId: null }],
      }).success,
    ).toBe(false)
  })

  test('全部列出时没有那一行；只要合计（status）时不列任务也不列条目', () => {
    const complete = mergePlanResolutions({
      conversion: {
        ...CONVERSION,
        kept: { ...CONVERSION.kept, total: 1, byCode: { 'v2-boot-schedule-kept-disabled': 1 } },
      },
      finalize: FINALIZE,
      taskNames: NAMES,
      listLimit: 1000,
      recordsTable: RECORDS,
    })
    const all = resolutionReportLines(complete, { listed: 50 })
    expect(all.at(-1)).toBe('kept by code: v2-boot-schedule-kept-disabled x 1')
    expect(all.some((line) => line.startsWith('Not every decision'))).toBe(false)
    expect(resolutionReportLines(merged(), { listed: 0, tasks: false })).toEqual([
      LINES(RECORDS)[0]!,
      'acknowledged for the upgrade: v2-code-history-unfinished x 5',
      'kept by code: v2-boot-runtime-defaults-not-carried x 1',
      'kept by code: v2-boot-schedule-kept-disabled x 3',
      LINES(RECORDS).at(-1)!,
    ])
  })

  test('读不出的键原样写出，不让报告失败', () => {
    const odd = PlanResolutionsSchema.parse({
      ...merged(),
      kept: [{ table: 'scheduled_tasks', key: 'mk1:not json', code: 'kept' }],
    })
    expect(resolutionReportLines(odd, { listed: 50 })).toContain(
      'row kept with a marker: scheduled_tasks mk1:not json: kept',
    )
  })
})

describe('RFC-626 —— 一次自动升级的回执、完成日志与 status', () => {
  const decided = (f: DirectSwitchFixture) => {
    f.scenario.tasks = [
      { id: 'task_a', name: 'Left as it is', status: 'pending' },
      { id: 'task_b', name: 'Nightly audit', status: 'running' },
      { id: 'task_c', name: null, status: 'pending' },
      { id: 'task_d', name: 'Finished long ago', status: 'done' },
      { id: 'task_e', name: 'Waiting for a review', status: 'awaiting_review' },
    ]
    f.scenario.settlements = SETTLED
    f.scenario.resolutions = CONVERSION
    f.scenario.dispositions = FINALIZE
  }
  const recordsTable = metaTableName('sqlite', 'migration_records')

  test('实际结果的计划：合并后的决定，未完成任务不含被结束的那些', async () => {
    const f = fixture()
    decided(f)
    const result = await f.start()
    expect(result.outcome).toBe('done')
    const actual = await f.plan()
    expect(actual.payload.resolutions).toEqual(merged(1000, recordsTable))
    // task_b and task_c were ended: they are canceled in the new database.
    expect(actual.payload.unfinishedTasks).toEqual([
      { status: 'awaiting_review', count: 1 },
      { status: 'pending', count: 1 },
    ])
    // The run is registered with the plan that names the tasks it ends.
    expect(f.seen.openRun[0]![0].conversionPlan.settlements).toEqual(SETTLED)
    expect(actual.payload.conversionPlan.settlements).toEqual(SETTLED)
    // The plan before the run had no decisions to report yet.
    const pinned = await f.plan((await f.pin())!.planDigest)
    expect(pinned.payload.resolutions).toBeUndefined()
    expect(pinned.payload.unfinishedTasks).toEqual([])
    expect(pinned.approvalDigest).not.toBe(actual.approvalDigest)
  })

  test('回执带着同一份决定；日志先是一行结论，再逐条列出', async () => {
    const f = fixture()
    decided(f)
    const result = await f.start()
    const actual = await f.plan()
    expect(result.receipt!.resolutions).toEqual(
      JSON.parse(JSON.stringify(actual.payload.resolutions)),
    )
    expect(result.receipt!.restrictions).toEqual([])
    expect(result.receipt!.runId).toBe((await f.journal()).payload.run!.runId)
    // The published receipt is what the session's completion record holds.
    const completed = (await f.session()).records.at(-1)!
    expect(completed.kind).toBe('completed')
    expect(completed.data.receipt).toEqual(result.receipt!)

    const prefix = 'Automatic database upgrade completed: '
    expect(f.logs[0]!.line).toStartWith(prefix)
    expect(f.logs[0]!.warning).toBe(false)
    const summary = JSON.parse(f.logs[0]!.line.slice(prefix.length)) as Record<string, unknown>
    // The decisions are not repeated inside the one-line summary.
    expect(Object.hasOwn(summary, 'resolutions')).toBe(false)
    expect(summary.operationId).toBe(f.operationId)
    // Something to read: the lines are warnings when anything was decided.
    expect(f.logs.slice(1).map((entry) => entry.line)).toEqual(LINES(recordsTable))
    expect(f.logs.slice(1).every((entry) => entry.warning)).toBe(true)
  })

  test('什么都没有决定的升级：回执里是全零的记录，日志只多一行合计，不作为警告', async () => {
    const f = fixture()
    const result = await f.start()
    expect(result.outcome).toBe('done')
    const resolutions = result.receipt!.resolutions as unknown as PlanResolutions
    expect(resolutions.totals).toEqual({
      settledTasks: 0,
      missingContent: 0,
      setAside: 0,
      finalize: 0,
      acknowledged: 0,
      kept: 0,
    })
    expect(f.logs).toHaveLength(2)
    expect(f.logs[1]).toEqual({ line: summaryLine(resolutions.totals), warning: false })
  })

  test('status：决定的合计与按代码的计数，条目在计划文件里', async () => {
    const f = fixture()
    decided(f)
    await f.start()
    const journal = await f.journal()
    const view = (await f.app.status({ operationId: f.operationId })) as EpochSwitchStatusView & {
      readonly resolutions?: EpochResolutionsView
    }
    const planPath = epochArtifactPath('plans', `${journal.payload.plan!.digest}.json`)
    expect(view.mode).toBe('auto')
    expect(view.resolutions).toEqual({
      planDigest: journal.payload.plan!.digest,
      planPath,
      totals: merged().totals,
      acknowledged: { 'v2-code-history-unfinished': 5 },
      keptByCode: {
        'v2-boot-runtime-defaults-not-carried': 1,
        'v2-boot-schedule-kept-disabled': 3,
      },
      listLimit: 1000,
      recordsTable,
    })
    expect(view.guidance.slice(-6)).toEqual([
      LINES(recordsTable)[0]!,
      'acknowledged for the upgrade: v2-code-history-unfinished x 5',
      'kept by code: v2-boot-runtime-defaults-not-carried x 1',
      'kept by code: v2-boot-schedule-kept-disabled x 3',
      LINES(recordsTable).at(-1)!,
      `The plan lists them: ${planPath}`,
    ])
    expect(view.guidance.some((line) => line.startsWith('task ended by the upgrade'))).toBe(false)
    expect(view.guidance.some((line) => line.startsWith('row set aside'))).toBe(false)
  })

  test('计划的可读版本多出「自动升级做出的决定」一节，位于启动转换一节之前', async () => {
    const f = fixture()
    decided(f)
    await f.start()
    const journal = await f.journal()
    const markdown = Buffer.from(
      (await f.artifact(`plans/${journal.payload.plan!.digest}.md`))!,
    ).toString('utf8')
    const section = markdown.indexOf('## Decisions made by the automatic upgrade')
    expect(section).toBeGreaterThan(0)
    expect(section).toBeLessThan(markdown.indexOf('## Legacy boot conversions'))
    for (const line of LINES(recordsTable)) expect(markdown).toContain(`- ${line}`)
    // The plan made before the run has no such section.
    const pinned = Buffer.from(
      (await f.artifact(`plans/${(await f.pin())!.planDigest}.md`))!,
    ).toString('utf8')
    expect(pinned).not.toContain('Decisions made by the automatic upgrade')
  })

  test('决定是批准材料的一部分：决定不同，批准摘要不同', async () => {
    const f = fixture()
    decided(f)
    await f.start()
    const actual = await f.plan()
    const resolutions = actual.payload.resolutions!
    const more = createMigrationPlanDocument({
      ...actual.payload,
      resolutions: { ...resolutions, totals: { ...resolutions.totals, setAside: 4 } },
    })
    expect(more.approvalDigest).not.toBe(actual.approvalDigest)
    const { resolutions: _decisions, ...rest } = actual.payload
    const without = createMigrationPlanDocument(rest)
    expect(without.approvalDigest).not.toBe(actual.approvalDigest)
    expect(Object.hasOwn(without.payload, 'resolutions')).toBe(false)
    // Only present when given: every other plan keeps the digest it had.
    const source = readFileSync(
      join(import.meta.dir, '../src/modules/system-operations/domain/epochSwitch/documents.ts'),
      'utf8',
    )
    expect(source).toContain('...(p.resolutions ? { resolutions: p.resolutions } : {})')
  })
})

describe('RFC-626 —— 没有 direct 的流程不产生这些', () => {
  test('人工流程：计划没有决定一节，status 没有汇总', async () => {
    const f = fixture({ direct: false })
    const view = await f.app.plan({})
    await f.app.run({ operationId: f.operationId, approve: view.plan.approvalDigest })
    await f.app.verify({ operationId: f.operationId })
    const journal = await f.journal()
    const actual = await f.plan()
    expect(Object.hasOwn(actual.payload, 'resolutions')).toBe(false)
    expect(Object.hasOwn(actual.payload.conversionPlan, 'resolution')).toBe(false)
    const markdown = Buffer.from(
      (await f.artifact(`plans/${journal.payload.plan!.digest}.md`))!,
    ).toString('utf8')
    expect(markdown).not.toContain('Decisions made by the automatic upgrade')
    const status = (await f.app.status({ operationId: f.operationId })) as EpochSwitchStatusView
    expect(Object.hasOwn(status, 'resolutions')).toBe(false)
    expect(status.guidance.some((line) => line.startsWith('Decisions made by the upgrade'))).toBe(
      false,
    )
  })

  test('不带 direct 的自动会话（分段流程）照旧完成：回执没有决定，限制取自最后一次评估', async () => {
    const f = fixture({ direct: false })
    const result = await f.start()
    expect(result).toMatchObject({ outcome: 'done', exitCode: 0 })
    expect(await f.recordKinds()).toEqual(['intent', 'plan-evaluated', 'approved', 'completed'])
    expect(Object.hasOwn(result.receipt!, 'resolutions')).toBe(false)
    expect(result.receipt!.restrictions).toEqual([])
    expect(f.logs.map((entry) => entry.line)).toEqual([
      expect.stringContaining('Automatic database upgrade completed: '),
    ])
    expect(await f.pin()).toBeNull()
    expect(f.calls.dryRun).toBe(2)
    expect(f.calls.prepare).toBe(0)
  })
})

/** A frozen source that has only a `tasks` table. */
function tasksSource(
  rows: readonly { id: string; name: string | null; status: string | number }[],
  options: { readonly table?: boolean; readonly contract?: boolean } = {},
): { source: FrozenSourceHandle; reads: { strict: number; raw: number } } {
  const reads = { strict: 0, raw: 0 }
  const text = (value: string) => ({ type: 'text' as const, value })
  const column = (name: string, nullable: boolean) => ({
    name,
    logicalCodec: 'text',
    nullable,
    primary: name === 'id',
    hasDefault: false,
    defaultKind: 'none',
    defaultValue: null,
    providerDefault: { sqlite: null, postgresql: null },
    identity: false,
    uniqueName: null,
    enumValues: [],
    providerType: { sqlite: 'text', postgresql: 'text' },
  })
  const preflight = {
    version: 1,
    kind: 'sqlite-file',
    sourceVersion: 'epoch1-fixture',
    // With a contract the table is read strictly first, as a released source is.
    contract: options.contract
      ? {
          tables: [
            {
              id: 'tasks',
              migrationKey: ['id'],
              columns: [column('id', false), column('name', true), column('status', false)],
            },
          ],
        }
      : null,
    tables:
      options.table === false
        ? []
        : [
            {
              table: 'tasks',
              rows: rows.length,
              physicalTable: 'tasks',
              destination: { kind: 'business', tables: ['tasks'] },
              disposition: 'converted',
              reason: 'fixture',
            },
          ],
    expectedAbsent: [],
  }
  const bad = rows.some((row) => typeof row.status !== 'string')
  const source = {
    preflight,
    watermark: 'fixture',
    preUpgrade: null,
    evidenceRoot: null,
    reader: {
      kind: 'sqlite-file',
      async preflight() {
        return preflight
      },
      async assertUnchanged() {},
      async readChunk(_table: string, afterKey: unknown) {
        reads.strict++
        // The frozen codec rejects the whole chunk that holds a value it cannot decode.
        if (bad) throw new Error('logical database codec rejected tasks.status: expected text')
        const page = afterKey === null ? rows : []
        return {
          rows: page.map((row) => ({ key: [text(row.id)], values: [] })),
          decodedRows: page.map((row) => ({ id: row.id, name: row.name, status: row.status })),
          lastKey: page.length ? [text(page.at(-1)!.id)] : null,
        }
      },
      async readRawChunk(_table: string, afterKey: unknown) {
        reads.raw++
        const page = afterKey === null ? rows : []
        return {
          rows: page.map((row) => ({
            key: [text(row.id)],
            cells: {
              id: { storageClass: 'text', value: text(row.id) },
              name:
                row.name === null
                  ? { storageClass: 'null', value: { type: 'null' as const } }
                  : { storageClass: 'text', value: text(row.name) },
              status:
                typeof row.status === 'string'
                  ? { storageClass: 'text', value: text(row.status) }
                  : {
                      storageClass: 'integer',
                      value: { type: 'integer' as const, value: `${row.status}` },
                    },
            },
          })),
          lastKey: page.length ? [text(page.at(-1)!.id)] : null,
        }
      },
      async close() {},
    },
    async close() {},
  }
  return { source: source as unknown as FrozenSourceHandle, reads }
}

describe('RFC-626 —— 未完成任务的计数', () => {
  const ROWS = [
    { id: 'task_a', name: 'Left as it is', status: 'pending' },
    { id: 'task_b', name: 'Nightly audit', status: 'running' },
    { id: 'task_c', name: null, status: 'pending' },
    { id: 'task_d', name: 'Finished long ago', status: 'done' },
    { id: 'task_e', name: 'Failed once', status: 'failed' },
    { id: 'task_f', name: 'Interrupted', status: 'interrupted' },
  ] as const

  test('自动模式：按转换的读法读，被结束的任务不计入并带回名称', async () => {
    const { source } = tasksSource(ROWS)
    const census = await automaticTaskCensus(source, new Set(['task_b', 'task_c', 'not a task']))
    expect(census.unfinished).toEqual([
      { status: 'interrupted', count: 1 },
      { status: 'pending', count: 1 },
    ])
    expect([...census.names]).toEqual([
      ['task_b', 'Nightly audit'],
      ['task_c', null],
    ])
    // The same through the entry the plan step shares with the manual flow.
    expect(
      await unfinishedTasks(source, { resolution: 'automatic', settled: new Set(['task_b']) }),
    ).toEqual([
      { status: 'interrupted', count: 1 },
      { status: 'pending', count: 2 },
    ])
    expect(await unfinishedTasks(source, { resolution: 'automatic' })).toEqual([
      { status: 'interrupted', count: 1 },
      { status: 'pending', count: 2 },
      { status: 'running', count: 1 },
    ])
  })

  test('自动模式：冻结编解码拒绝的行跳过而不是让计数失败（那一行由转换封存）', async () => {
    const { source, reads } = tasksSource(
      [...ROWS, { id: 'task_g', name: 'Unreadable status', status: 7 }],
      { contract: true },
    )
    const census = await automaticTaskCensus(source, new Set())
    expect(census.unfinished).toEqual([
      { status: 'interrupted', count: 1 },
      { status: 'pending', count: 2 },
      { status: 'running', count: 1 },
    ])
    // Read strictly once, then the whole table again through the raw channel.
    expect(reads.strict).toBe(1)
    expect(reads.raw).toBeGreaterThan(0)
  })

  test('人工模式：照旧严格读，读不了就失败；能读时计数与以前相同', async () => {
    const readable = tasksSource(ROWS)
    expect(await unfinishedTasks(readable.source)).toEqual([
      { status: 'interrupted', count: 1 },
      { status: 'pending', count: 2 },
      { status: 'running', count: 1 },
    ])
    expect(readable.reads.strict).toBeGreaterThan(0)
    expect(readable.reads.raw).toBe(0)
    const unreadable = tasksSource([...ROWS, { id: 'task_g', name: null, status: 7 }], {
      contract: true,
    })
    await expect(unfinishedTasks(unreadable.source)).rejects.toThrow('logical database codec')
    expect(unreadable.reads.raw).toBe(0)
  })

  test('旧库没有 tasks 表时两种读法都不去读', async () => {
    const { source, reads } = tasksSource([], { table: false })
    expect(await automaticTaskCensus(source, new Set(['task_b']))).toEqual({
      unfinished: [],
      names: new Map(),
    })
    expect(await unfinishedTasks(source)).toEqual([])
    expect(reads).toEqual({ strict: 0, raw: 0 })
  })
})
