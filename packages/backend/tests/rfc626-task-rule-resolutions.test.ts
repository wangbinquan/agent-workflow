// RFC-626 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md §3.1–§3.4, §3.6, §7 "结束任务"
// and "封存与保留"): what the task-execution task rule, its lookups and its validators do with
// automatic resolution, against real frozen epoch-1 rows on both providers.
//
//   - every task-body issue of an unfinished task ends the task (it enters the plan's
//     settlements) instead of blocking; a finished task keeps its read-only history; operator
//     resolution still blocks exactly as before;
//   - a workspace preparation in flight for an unfinished task ends that task; one that never
//     named a task takes the "no task" path; an in-flight hosted command is set aside;
//   - generation 0 comes from the task rule with the task row as its source, also for a task
//     without runs and for one whose run group is set aside whole;
//   - when mount ordinal 0 cannot be carried no mount is (the target probe needs min ordinal 0);
//   - task rows whose values the lookups cannot use, and undecodable task rows, no longer abort
//     the conversion in either mode: the row is blocked (operator) or set aside (automatic) and
//     every other task converts; a still-running child set aside ends its waiting parent;
//   - an unreadable cache URL keeps the task, linked to the cache by URL hash;
//   - a task whose owner is gone is kept with the owner cleared;
//   - ending a task takes its cancelable children along, level by level.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'
import {
  runConversion as runContribution,
  taskConversion,
} from '@/modules/task-execution/composition/conversion'
import { executeConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  repositoryUrlFactKey,
  repositoryUrlFacts,
  type RepositoryUrlFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { preservedRule } from '@/platform/persistence/migration/conversion/generic/preserved'
import { columnLookup, idSetLookup } from '@/platform/persistence/migration/conversion/lookups'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import type { ConversionSummary } from '@/platform/persistence/migration/conversion/sink'
import type {
  ConversionResolution,
  EncodedKey,
  RowDisposition,
  TargetRef,
  TaskSettlement,
} from '@/platform/persistence/migration/conversion/types'
import type {
  DecodedSourceRow,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { describeV2Providers, fixtureLookup, type V2Harness } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { overrideSourceValues } from './helpers/rfc395V2/sourceOverride'
import { runValues } from './helpers/rfc395V2/runFixtures'
import { repoRow, taskRow, writeTaskFixture } from './helpers/rfc395V2/taskFixtures'

// Each case runs one or two full task conversions on a real provider; allow 60 s.
setDefaultTimeout(60_000)

const preparations: ConversionContribution = {
  rules: [preservedRule('task_workspace_preparations'), preservedRule('hosted_workspace_commands')],
  lookups: [],
  validators: [],
}

async function convert(
  h: V2Harness,
  options: {
    readonly resolution?: ConversionResolution
    readonly extra?: readonly ConversionContribution[]
    readonly source?: VersionedSourceReader
    readonly urlFacts?: readonly (readonly [string, RepositoryUrlFact])[]
  } = {},
) {
  const generic: ConversionContribution = {
    rules: [],
    validators: [],
    lookups: [
      idSetLookup('users', 'id'),
      columnLookup('workflows', ['id'], ['builtin']),
      columnLookup('node_runs', ['id'], ['continuation_slot_key']),
      fixtureLookup(repositoryUrlFacts, options.urlFacts ?? []),
    ],
  }
  const input = await h.input([taskConversion, generic, ...(options.extra ?? [])], {
    candidateBuild: 'rfc626-f1-task-rule',
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.source ? { source: options.source } : {}),
  })
  const sink = new V2MemorySink()
  const links = new Map<string, readonly TargetRef[]>()
  try {
    const summary = await executeConversion(input, sink, {
      unit(_output, rows, linked) {
        for (const row of rows) links.set(`${row.table}|${row.encodedKey}`, [...linked(row)])
      },
    })
    return { summary, sink, links }
  } finally {
    await input.source.close()
  }
}

const key = (table: string, id: string): EncodedKey =>
  encodeMigrationKey(table, [{ type: 'text', value: id }])
const settlements = (summary: ConversionSummary): readonly TaskSettlement[] =>
  summary.plan.settlements ?? []
const settled = (summary: ConversionSummary, taskId: string) =>
  settlements(summary).find((entry) => entry.taskId === taskId)
const dispositions = (sink: V2MemorySink): readonly RowDisposition[] =>
  [...sink.units.values()].flatMap((unit) => unit.dispositions)
const archivedAs = (sink: V2MemorySink, table: string, id: string) =>
  dispositions(sink).find(
    (row) =>
      row.class === 'archived' && row.sourceTable === table && row.sourceKey === key(table, id),
  )?.decision?.code
const decisions = (summary: ConversionSummary, code: string) =>
  summary.records.flatMap((record) =>
    record.kind === 'decision' && record.code === code ? [record.payload] : [],
  )
const taskTarget = (sink: V2MemorySink, id: string) =>
  sink.rows('tasks').find((row) => row.id === id)

// ---- task-body issues --------------------------------------------------------------------

/** One task per task-body issue code of task/rule.ts; every task gets `status`. */
const BODY_ISSUES: readonly (readonly [string, string])[] = [
  ['subject', 'v2-task-subject-mismatch'],
  ['config', 'v2-task-config-undecodable'],
  ['definition', 'v2-task-definition-incomplete'],
  ['origin', 'v2-task-launch-origin-mismatch'],
  ['mount-path', 'v2-task-mount-path'],
  ['branch-state', 'v2-task-mount-branch-state'],
  ['mount-conflict', 'v2-task-mount-conflict'],
  ['repo-count', 'v2-task-repo-count'],
]
async function seedBodyIssues(h: V2Harness, status: string): Promise<void> {
  await writeTaskFixture(
    h,
    taskRow('subject', { status, workflow_id: TASK_DEFINITION_HOSTS.workgroup.id }),
  )
  await writeTaskFixture(
    h,
    taskRow('config', {
      status,
      workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
      workgroup_id: 'group',
      workgroup_config_json: '{broken',
    }),
  )
  await writeTaskFixture(h, taskRow('definition', { status, workflow_snapshot: '{bad' }))
  await writeTaskFixture(h, taskRow('origin-parent'))
  await writeTaskFixture(
    h,
    taskRow('origin', { status, parent_task_id: 'origin-parent', launch_origin: 'api' }),
  )
  // The epoch-1 SQLite schema copies the parent's launch origin onto a child on insert
  // (`trg_tasks_launch_origin_inherit_child`, AFTER INSERT only), so the differing origin a
  // mixed-version writer could leave behind is set by a later update.
  await h.sourceHarness.native.execute(
    `UPDATE ${h.sourceHarness.table('tasks')} SET launch_origin = 'api' WHERE id = 'origin'`,
  )
  const mountPath = taskRow('mount-path', { status })
  await writeTaskFixture(h, mountPath, { repos: [repoRow(mountPath, { worktree_path: 'wrong' })] })
  const branchState = taskRow('branch-state', {
    status,
    space_kind: 'internal',
    branch: '',
    base_branch: 'main',
    base_commit: 'sha',
  })
  await writeTaskFixture(h, branchState, { repos: [repoRow(branchState)] })
  const conflict = taskRow('mount-conflict', { status })
  await writeTaskFixture(h, conflict, {
    repos: [repoRow(conflict, { base_branch: 'different', branch: 'other' })],
  })
  const count = taskRow('repo-count', { status, repo_count: 7 })
  await writeTaskFixture(h, count, { repos: [repoRow(count)] })
}

describeV2Providers('RFC-626 F1 task rule resolutions', (h) => {
  test('automatic: every task-body issue of an unfinished task ends it instead of blocking', async () => {
    await h.install()
    await seedBodyIssues(h, 'running')
    const { summary, sink } = await convert(h, { resolution: 'automatic' })
    expect(summary.blocks).toEqual([])
    for (const [id, code] of BODY_ISSUES) {
      const entry = settled(summary, id)
      expect(entry).toMatchObject({
        taskId: id,
        cause: 'unprovable-records',
        originalStatus: 'running',
        parentTaskId: null,
      })
      expect(entry!.blockCodes).toContain(code)
      // After the ending the rule takes its existing "task cannot continue" path.
      expect(taskTarget(sink, id)).toMatchObject({
        status: 'canceled',
        finished_at: 123,
        error_summary: 'ended by upgrade',
        error_message: 'ended-by-upgrade',
      })
      expect(
        summary.historyOnly.some(
          (row) => row.history?.taskId === id && row.history.execution === 'retryable-history',
        ),
      ).toBe(true)
    }
    // A finished parent is not ended.
    expect(settled(summary, 'origin-parent')).toBeUndefined()
  }, 180_000)

  // The epoch-1 SQLite schema fills missing lineage on insert (0210 trigger), and a parent the
  // child names must exist (FK); the unresolvable shape is injected at the converter seam.
  test('both modes: an unfinished child whose lineage cannot be derived ends (automatic) or blocks (operator)', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('orphan-lineage', { status: 'awaiting_review' }))
    const source = async () =>
      overrideSourceValues(await h.sourceHarness.source(), 'tasks', (row) => ({
        ...row,
        parent_task_id: 'deleted-parent',
        execution_lineage_id: null,
        lineage_slot_path_json: null,
      }))
    const automatic = await convert(h, { resolution: 'automatic', source: await source() })
    expect(automatic.summary.blocks).toEqual([])
    expect(settled(automatic.summary, 'orphan-lineage')).toMatchObject({
      cause: 'unprovable-records',
      originalStatus: 'awaiting_review',
      blockCodes: ['v2-task-lineage-unresolved'],
    })
    expect(taskTarget(automatic.sink, 'orphan-lineage')).toMatchObject({ status: 'canceled' })
    const operator = await convert(h, { source: await source() })
    expect(operator.summary.blocks.map((block) => [block.code, block.taskId])).toEqual([
      ['v2-task-lineage-unresolved', 'orphan-lineage'],
    ])
  }, 180_000)

  test('operator: the same unfinished tasks block exactly as before and nothing is settled', async () => {
    await h.install()
    await seedBodyIssues(h, 'running')
    const { summary } = await convert(h)
    expect(summary.plan).not.toHaveProperty('settlements')
    for (const [id, code] of BODY_ISSUES)
      expect(
        summary.blocks.some(
          (block) =>
            block.code === code &&
            block.taskId === id &&
            JSON.stringify(block.detail).includes('"executableTask"'),
        ),
      ).toBe(true)
  }, 180_000)

  test('automatic: a finished task with the same issues keeps its read-only history', async () => {
    await h.install()
    await seedBodyIssues(h, 'failed')
    const { summary, sink } = await convert(h, { resolution: 'automatic' })
    expect(summary.blocks).toEqual([])
    expect(settlements(summary)).toEqual([])
    for (const [id] of BODY_ISSUES) {
      expect(taskTarget(sink, id)).toMatchObject({ status: 'failed' })
      expect(summary.historyOnly.some((row) => row.history?.taskId === id)).toBe(true)
    }
  }, 180_000)

  test('automatic: an undecodable task name (SQLite storage class) ends the unfinished task', async () => {
    if (h.sourceHarness.provider !== 'sqlite') return
    await h.install()
    await writeTaskFixture(
      h,
      taskRow('named', { status: 'awaiting_human', name: new Uint8Array([255]) }),
    )
    const { summary, sink } = await convert(h, { resolution: 'automatic' })
    expect(summary.blocks).toEqual([])
    expect(settled(summary, 'named')!.blockCodes).toContain('v2-task-name-undecodable')
    expect(taskTarget(sink, 'named')).toMatchObject({ status: 'canceled' })
  }, 180_000)

  // ---- workspace preparation and hosted commands ----------------------------------------

  const seedPreparations = async () => {
    await writeTaskFixture(h, taskRow('prep', { status: 'running', worktree_path: '' }))
    await h.write('task_workspace_preparations', [
      {
        id: 'bound',
        admission_key: 'bound-admission',
        request_digest: 'digest',
        lane: 'repository-preparation',
        state: 'preparing',
        admitted_task_id: 'prep',
        created_at: 1,
        updated_at: 2,
      },
      {
        id: 'unbound',
        admission_key: 'unbound-admission',
        request_digest: 'digest',
        lane: 'repository-preparation',
        state: 'prepared',
        created_at: 1,
        updated_at: 2,
      },
    ])
    await h.write('hosted_workspace_commands', [
      {
        execution_id: 'command',
        task_id: 'external-task',
        business_task_id: 'business-task',
        operation: 'prepare',
        request_key: 'command',
        request_json: '{ "original": true }',
        state: 'running',
        epoch: 1,
        created_at: 1,
        updated_at: 2,
      },
    ])
  }

  test('automatic: an in-flight preparation ends its task; an unbound one is kept; a hosted command is set aside', async () => {
    await h.install()
    await seedPreparations()
    const { summary, sink } = await convert(h, {
      resolution: 'automatic',
      extra: [preparations],
    })
    expect(summary.blocks).toEqual([])
    expect(settlements(summary)).toEqual([
      {
        taskId: 'prep',
        cause: 'unprovable-records',
        originalStatus: 'running',
        blockCodes: ['v2-task-workspace-preparation-in-flight'],
        parentTaskId: null,
      },
    ])
    expect(taskTarget(sink, 'prep')).toMatchObject({ status: 'canceled' })
    // The bound row now belongs to a task that cannot continue: the existing history path.
    expect(decisions(summary, 'v2-task-workspace-preparation-history')).toMatchObject([
      { taskId: 'prep', state: 'preparing', execution: 'retryable-history' },
    ])
    // §3.4 row 18: the unbound row takes the "no task" path and is reported as kept.
    expect(decisions(summary, 'v2-task-workspace-preparation-orphan')).toMatchObject([
      {
        automatic: 'kept',
        sourceTable: 'task_workspace_preparations',
        sourceKey: key('task_workspace_preparations', 'unbound'),
        taskId: null,
        state: 'prepared',
      },
    ])
    expect(
      sink
        .rows('task_workspace_preparations')
        .map((row) => [row.id, row.state])
        .sort(),
    ).toEqual([
      ['bound', 'preparing'],
      ['unbound', 'prepared'],
    ])
    expect(sink.rows('hosted_workspace_commands')).toEqual([])
    expect(
      dispositions(sink).find(
        (row) => row.sourceTable === 'hosted_workspace_commands' && row.class === 'archived',
      )?.decision?.code,
    ).toBe('v2-task-hosted-workspace-command-in-flight')
    expect(
      decisions(summary, 'v2-row-set-aside').some(
        (payload) =>
          (payload as { sourceTable?: string }).sourceTable === 'hosted_workspace_commands',
      ),
    ).toBe(true)
  }, 180_000)

  test('operator: the three in-flight rows still block as before', async () => {
    await h.install()
    await seedPreparations()
    const { summary } = await convert(h, { extra: [preparations] })
    expect(
      summary.blocks.map((block) => [block.code, block.sourceTable, block.taskId]).sort(),
    ).toEqual(
      [
        [
          'v2-task-hosted-workspace-command-in-flight',
          'hosted_workspace_commands',
          'external-task',
        ],
        ['v2-task-workspace-preparation-in-flight', 'task_workspace_preparations', 'prep'],
        ['v2-task-workspace-preparation-in-flight', 'task_workspace_preparations', null],
      ].sort(),
    )
    expect(decisions(summary, 'v2-task-workspace-preparation-orphan')).toEqual([])
  }, 180_000)

  // ---- generation 0 ---------------------------------------------------------------------

  for (const resolution of ['operator', 'automatic'] as const)
    test(`${resolution}: generation 0 is emitted by the task rule from the task row, without runs`, async () => {
      await h.install()
      await writeTaskFixture(h, taskRow('plain'))
      const { summary, sink, links } = await convert(h, { resolution })
      expect(summary.blocks).toEqual([])
      expect(sink.rows('task_execution_generations')).toEqual([
        {
          task_id: 'plain',
          generation_seq: 0,
          cause: 'legacy-epoch1',
          previous_generation_seq: null,
          operation_ref: null,
          created_at: 1001,
        },
      ])
      expect(
        links
          .get(`tasks|${key('tasks', 'plain')}`)!
          .filter((target) => target.table === 'task_execution_generations'),
      ).toHaveLength(1)
    }, 180_000)

  test('automatic: a finished task whose run group is set aside still has generation 0', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('old-runs'))
    await h.write('node_runs', [
      runValues('broken-run', { task_id: 'old-runs', runtime_params_json: '{bad', seq: 1 }),
      runValues('fine-run', { task_id: 'old-runs', seq: 2, retry_index: 1 }),
    ])
    const { summary, sink } = await convert(h, {
      resolution: 'automatic',
      extra: [runContribution],
    })
    expect(summary.blocks).toEqual([])
    expect(settlements(summary)).toEqual([])
    expect(sink.rows('node_runs')).toEqual([])
    expect(archivedAs(sink, 'node_runs', 'broken-run')).toBe('v2-source-codec')
    expect(archivedAs(sink, 'node_runs', 'fine-run')).toBe('v2-group-member-blocked')
    expect(taskTarget(sink, 'old-runs')).toMatchObject({ status: 'done' })
    expect(
      sink
        .rows('task_execution_generations')
        .filter((row) => row.task_id === 'old-runs')
        .map((row) => row.generation_seq),
    ).toEqual([0])
  }, 180_000)

  test('automatic: the same run group set aside under an unfinished task ends it, generation 0 kept', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('live-runs', { status: 'interrupted' }))
    await h.write('node_runs', [
      runValues('broken-live', { task_id: 'live-runs', runtime_params_json: '{bad' }),
    ])
    const { summary, sink } = await convert(h, {
      resolution: 'automatic',
      extra: [runContribution],
    })
    expect(summary.blocks).toEqual([])
    expect(settled(summary, 'live-runs')).toMatchObject({
      cause: 'unprovable-records',
      originalStatus: 'interrupted',
    })
    expect(settled(summary, 'live-runs')!.blockCodes).toContain('v2-source-codec')
    expect(taskTarget(sink, 'live-runs')).toMatchObject({ status: 'canceled' })
    expect(sink.rows('node_runs')).toEqual([])
    expect(
      sink.rows('task_execution_generations').filter((row) => row.task_id === 'live-runs'),
    ).toHaveLength(1)
  }, 180_000)

  // ---- mount ordinal 0 ------------------------------------------------------------------

  for (const resolution of ['operator', 'automatic'] as const)
    test(`${resolution}: when mount ordinal 0 cannot be carried, the other mounts are not either`, async () => {
      await h.install()
      const task = taskRow('multi', { repo_count: 2 })
      await writeTaskFixture(h, task, {
        repos: [
          repoRow(task, { repo_index: 0, worktree_path: 'wrong' }),
          repoRow(task, {
            repo_index: 1,
            mount_path: 'pkg',
            worktree_dir_name: 'pkg',
            worktree_path: '/work/multi/pkg',
          }),
        ],
      })
      const { summary, sink } = await convert(h, { resolution })
      expect(summary.blocks).toEqual([])
      expect(sink.rows('task_repository_mounts')).toEqual([])
      const evidence = sink
        .rows('execution_legacy_evidence')
        .filter((row) => row.record_kind === 'task-repo')
        .map((row) => Buffer.from(row.content_inline_bytes as Uint8Array).toString())
      expect(evidence).toHaveLength(2)
      expect(
        evidence.filter((content) => content.includes('v2-task-mount-first-mount-unavailable')),
      ).toHaveLength(1)
      expect(taskTarget(sink, 'multi')).toMatchObject({ status: 'done' })
    }, 180_000)

  // ---- rows the lookups cannot use ------------------------------------------------------

  const UNUSABLE: readonly (readonly [string, string, DecodedSourceRow])[] = [
    ['bad-status', 'status', { status: 'paused' }],
    ['bad-space', 'space_kind', { space_kind: 'cloud' }],
    ['bad-start', 'started_at', { started_at: 9007199254740993n }],
    ['bad-version', 'workflow_version', { workflow_version: 9007199254740993n }],
    ['bad-count', 'repo_count', { repo_count: 9007199254740993n }],
  ]
  const seedUnusable = async () => {
    await writeTaskFixture(h, taskRow('good'))
    for (const [id] of UNUSABLE) {
      const task = taskRow(id)
      await writeTaskFixture(h, task, id === 'bad-count' ? { repos: [repoRow(task)] } : {})
    }
    const overrides = new Map(UNUSABLE.map(([id, , values]) => [id, values]))
    return overrideSourceValues(await h.sourceHarness.source(), 'tasks', (row) => ({
      ...row,
      ...(overrides.get(String(row.id)) ?? {}),
    }))
  }

  test('operator: unusable task rows block row by row instead of aborting the conversion', async () => {
    await h.install()
    const source = await seedUnusable()
    const { summary, sink } = await convert(h, { source })
    for (const [id, column] of UNUSABLE)
      expect(
        summary.blocks.find(
          (block) => block.code === 'v2-task-row-unusable' && block.sourceKey === key('tasks', id),
        ),
      ).toMatchObject({ scope: 'row', taskId: id, missingFields: [column], detail: { column } })
    expect(sink.rows('tasks').map((row) => row.id)).toEqual(['good'])
  }, 180_000)

  test('automatic: unusable task rows are set aside and every other task converts', async () => {
    await h.install()
    const source = await seedUnusable()
    const { summary, sink } = await convert(h, { resolution: 'automatic', source })
    expect(summary.blocks).toEqual([])
    for (const [id] of UNUSABLE) expect(archivedAs(sink, 'tasks', id)).toBe('v2-task-row-unusable')
    expect(
      dispositions(sink).find((row) => row.class === 'archived' && row.sourceTable === 'task_repos')
        ?.decision?.code,
    ).toBe('v2-group-member-blocked')
    expect(sink.rows('tasks').map((row) => row.id)).toEqual(['good'])
    expect(sink.rows('task_execution_generations').map((row) => row.task_id)).toEqual(['good'])
  }, 180_000)

  test('both modes: a repository index above 2^53 (SQLite) blocks its task group instead of aborting', async () => {
    if (h.sourceHarness.provider !== 'sqlite') return
    await h.install()
    const task = taskRow('bad-index')
    await writeTaskFixture(h, task, {
      repos: [repoRow(task, { repo_index: 9007199254740993n })],
    })
    await writeTaskFixture(h, taskRow('fine'))
    for (const resolution of ['operator', 'automatic'] as const) {
      const { summary, sink } = await convert(h, { resolution })
      expect(sink.rows('tasks').map((row) => row.id)).toEqual(['fine'])
      if (resolution === 'operator')
        expect(
          summary.blocks.some(
            (block) => block.code === 'v2-task-row-unusable' && block.sourceTable === 'task_repos',
          ),
        ).toBe(true)
      else {
        expect(summary.blocks).toEqual([])
        expect(
          dispositions(sink).find(
            (row) => row.class === 'archived' && row.sourceTable === 'task_repos',
          )?.decision?.code,
        ).toBe('v2-task-row-unusable')
      }
    }
  }, 180_000)

  test('both modes: an undecodable task row no longer aborts; a running child set aside ends its parent', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('fine'))
    await writeTaskFixture(h, taskRow('waiting', { status: 'running' }))
    await writeTaskFixture(
      h,
      taskRow('broken-child', {
        status: 'running',
        parent_task_id: 'waiting',
        ref_closure_json: '{bad',
      }),
    )
    await writeTaskFixture(h, taskRow('unaffected', { status: 'running' }))
    await writeTaskFixture(
      h,
      taskRow('old-child', {
        status: 'done',
        parent_task_id: 'unaffected',
        ref_closure_json: '{bad',
      }),
    )
    for (const resolution of ['operator', 'automatic'] as const) {
      const { summary, sink } = await convert(h, { resolution })
      if (resolution === 'operator') {
        expect(
          summary.blocks
            .filter((block) => block.code === 'v2-source-codec')
            .map((block) => block.taskId)
            .sort(),
        ).toEqual(['broken-child', 'old-child'])
        expect(
          sink
            .rows('tasks')
            .map((row) => row.id)
            .sort(),
        ).toEqual(['fine', 'unaffected', 'waiting'])
      } else {
        expect(summary.blocks).toEqual([])
        expect(settlements(summary)).toEqual([
          {
            taskId: 'waiting',
            cause: 'unprovable-records',
            originalStatus: 'running',
            blockCodes: ['v2-source-codec'],
            parentTaskId: null,
          },
        ])
        expect(archivedAs(sink, 'tasks', 'broken-child')).toBe('v2-source-codec')
        expect(archivedAs(sink, 'tasks', 'old-child')).toBe('v2-source-codec')
        expect(taskTarget(sink, 'waiting')).toMatchObject({ status: 'canceled' })
        expect(taskTarget(sink, 'unaffected')).toMatchObject({ status: 'running' })
        expect(taskTarget(sink, 'fine')).toMatchObject({ status: 'done' })
      }
    }
  }, 180_000)

  // ---- unreadable cache URL -------------------------------------------------------------

  const linkedUrl = 'https://example.test/group/linked.git'
  const conflictUrl = 'https://example.test/group/conflict.git'
  const urlFacts: readonly (readonly [string, RepositoryUrlFact])[] = [
    [
      repositoryUrlFactKey(linkedUrl),
      {
        state: 'blocked',
        cachedRepoId: 'cache-linked',
        repoUrl: linkedUrl,
        rawUrlDigest: null,
        factIds: ['repository-url:cache-linked'],
        reason: 'v2-boot-url-key-missing',
      },
    ],
    [
      repositoryUrlFactKey(conflictUrl),
      {
        state: 'blocked',
        cachedRepoId: null,
        repoUrl: conflictUrl,
        rawUrlDigest: null,
        factIds: [],
        reason: 'v2-boot-url-reference-conflict',
      },
    ],
  ]
  const seedUrls = async () => {
    for (const [id, url] of [
      ['linked', linkedUrl],
      ['unlinked', conflictUrl],
    ] as const) {
      const task = taskRow(id, { status: 'running', repo_url: url, cached_repo_id: null })
      await writeTaskFixture(h, task, { repos: [repoRow(task)] })
    }
  }

  test('operator: an unreadable cache URL still blocks the task', async () => {
    await h.install()
    await seedUrls()
    const { summary, sink } = await convert(h, { urlFacts })
    expect(
      summary.blocks
        .filter((block) => block.code === 'v2-boot-url-key-missing')
        .map((block) => block.sourceTable)
        .sort(),
    ).toEqual(['task_repos', 'tasks'])
    expect(sink.rows('tasks')).toEqual([])
  }, 180_000)

  test('automatic: an unreadable cache URL keeps the task, linked to the cache by URL hash', async () => {
    await h.install()
    await seedUrls()
    const { summary, sink } = await convert(h, { resolution: 'automatic', urlFacts })
    expect(summary.blocks).toEqual([])
    expect(settlements(summary)).toEqual([])
    expect(taskTarget(sink, 'linked')).toMatchObject({ status: 'running' })
    const requested = (id: string) =>
      JSON.parse(
        String(sink.rows('task_workspaces').find((row) => row.task_id === id)!.requested_source),
      ) as { cachedRepoId: string | null }
    expect(requested('linked').cachedRepoId).toBe('cache-linked')
    expect(requested('unlinked').cachedRepoId).toBeNull()
    expect(
      sink
        .rows('task_repository_mounts')
        .map((row) => [row.task_id, row.cached_repo_id])
        .sort(),
    ).toEqual([
      ['linked', 'cache-linked'],
      ['unlinked', null],
    ])
    const kept = decisions(summary, 'v2-boot-url-kept-unreadable') as {
      sourceTable: string
      taskId: string
      cachedRepoId: string | null
      reason: string
      automatic: string
    }[]
    expect(
      kept
        .map((entry) => [entry.taskId, entry.sourceTable, entry.cachedRepoId, entry.reason])
        .sort(),
    ).toEqual(
      [
        ['linked', 'task_repos', 'cache-linked', 'v2-boot-url-key-missing'],
        ['linked', 'tasks', 'cache-linked', 'v2-boot-url-key-missing'],
        ['unlinked', 'task_repos', null, 'v2-boot-url-reference-conflict'],
        ['unlinked', 'tasks', null, 'v2-boot-url-reference-conflict'],
      ].sort(),
    )
    expect(kept.every((entry) => entry.automatic === 'kept')).toBe(true)
  }, 180_000)

  // Implementation gate G2-3: a cache row that could not be decoded is set aside by the cache
  // rule; the task and its mount that name it by hash are kept without a cache ID (as the
  // schedule rule keeps a schedule unlinked), never pointed at a row the new database lacks.
  test('automatic: a cache that is set aside for its own row is not linked by URL hash', async () => {
    await h.install()
    const codecUrl = 'https://example.test/group/codec.git'
    const task = taskRow('codec', { status: 'running', repo_url: codecUrl, cached_repo_id: null })
    await writeTaskFixture(h, task, { repos: [repoRow(task)] })
    const { summary, sink } = await convert(h, {
      resolution: 'automatic',
      urlFacts: [
        [
          repositoryUrlFactKey(codecUrl),
          {
            state: 'blocked',
            cachedRepoId: 'cache-codec',
            repoUrl: codecUrl,
            rawUrlDigest: null,
            factIds: ['repository-url:cache-codec'],
            reason: 'v2-boot-url-source-codec',
          },
        ],
      ],
    })
    expect(summary.blocks).toEqual([])
    expect(settlements(summary)).toEqual([])
    expect(taskTarget(sink, 'codec')).toMatchObject({ status: 'running' })
    const requested = JSON.parse(
      String(sink.rows('task_workspaces').find((row) => row.task_id === 'codec')!.requested_source),
    ) as { cachedRepoId: string | null; repoUrl: string | null }
    expect(requested).toMatchObject({ cachedRepoId: null, repoUrl: codecUrl })
    expect(
      sink.rows('task_repository_mounts').map((row) => [row.task_id, row.cached_repo_id]),
    ).toEqual([['codec', null]])
    const kept = decisions(summary, 'v2-boot-url-kept-unreadable') as {
      sourceTable: string
      cachedRepoId: string | null
      reason: string
    }[]
    expect(
      kept.map((entry) => [entry.sourceTable, entry.cachedRepoId, entry.reason]).sort(),
    ).toEqual([
      ['task_repos', null, 'v2-boot-url-source-codec'],
      ['tasks', null, 'v2-boot-url-source-codec'],
    ])
  }, 180_000)

  // ---- missing owner --------------------------------------------------------------------

  const seedOwners = async () => {
    await writeTaskFixture(h, taskRow('owned-done'))
    await writeTaskFixture(h, taskRow('owned-running', { status: 'running' }))
    return overrideSourceValues(await h.sourceHarness.source(), 'tasks', (row) => ({
      ...row,
      owner_user_id: 'nonexistent-owner',
    }))
  }

  test('operator: a missing owner still always blocks', async () => {
    await h.install()
    const source = await seedOwners()
    const { summary, sink } = await convert(h, { source })
    expect(
      summary.blocks
        .filter((block) => block.code === 'v2-task-owner-dangling')
        .map((block) => block.taskId)
        .sort(),
    ).toEqual(['owned-done', 'owned-running'])
    expect(sink.rows('tasks')).toEqual([])
  }, 180_000)

  test('automatic: a missing owner keeps the task with its owner cleared', async () => {
    await h.install()
    const source = await seedOwners()
    const { summary, sink } = await convert(h, { resolution: 'automatic', source })
    expect(summary.blocks).toEqual([])
    // The owner says nothing about whether the task can continue; nothing is ended.
    expect(settlements(summary)).toEqual([])
    for (const id of ['owned-done', 'owned-running'])
      expect(taskTarget(sink, id)).toMatchObject({ owner_user_id: null })
    expect(taskTarget(sink, 'owned-running')).toMatchObject({ status: 'running' })
    expect(decisions(summary, 'v2-task-owner-dangling-kept')).toEqual(
      expect.arrayContaining([
        {
          automatic: 'kept',
          sourceTable: 'tasks',
          sourceKey: key('tasks', 'owned-done'),
          taskId: 'owned-done',
          ownerUserId: 'nonexistent-owner',
        },
        {
          automatic: 'kept',
          sourceTable: 'tasks',
          sourceKey: key('tasks', 'owned-running'),
          taskId: 'owned-running',
          ownerUserId: 'nonexistent-owner',
        },
      ]),
    )
  }, 180_000)

  // ---- cascade --------------------------------------------------------------------------

  test('automatic: ending a task takes its cancelable children along, level by level', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('root', { status: 'running', workflow_snapshot: '{bad' }))
    for (const status of [
      'pending',
      'running',
      'awaiting_review',
      'awaiting_human',
      'interrupted',
      'done',
    ])
      await writeTaskFixture(h, taskRow(`child-${status}`, { status, parent_task_id: 'root' }))
    await writeTaskFixture(
      h,
      taskRow('grandchild', { status: 'pending', parent_task_id: 'child-pending' }),
    )
    await writeTaskFixture(
      h,
      taskRow('under-interrupted', { status: 'running', parent_task_id: 'child-interrupted' }),
    )
    const { summary, sink } = await convert(h, { resolution: 'automatic' })
    expect(summary.blocks).toEqual([])
    expect([...settlements(summary)].sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual(
      (
        [
          {
            taskId: 'child-awaiting_human',
            cause: 'parent-cascade',
            originalStatus: 'awaiting_human',
            blockCodes: [],
            parentTaskId: 'root',
          },
          {
            taskId: 'child-awaiting_review',
            cause: 'parent-cascade',
            originalStatus: 'awaiting_review',
            blockCodes: [],
            parentTaskId: 'root',
          },
          {
            taskId: 'child-pending',
            cause: 'parent-cascade',
            originalStatus: 'pending',
            blockCodes: [],
            parentTaskId: 'root',
          },
          {
            taskId: 'child-running',
            cause: 'parent-cascade',
            originalStatus: 'running',
            blockCodes: [],
            parentTaskId: 'root',
          },
          {
            taskId: 'grandchild',
            cause: 'parent-cascade',
            originalStatus: 'pending',
            blockCodes: [],
            parentTaskId: 'child-pending',
          },
          {
            taskId: 'root',
            cause: 'unprovable-records',
            originalStatus: 'running',
            blockCodes: ['v2-task-definition-incomplete'],
            parentTaskId: null,
          },
        ] satisfies TaskSettlement[]
      ).sort((a, b) => a.taskId.localeCompare(b.taskId)),
    )
    for (const id of ['child-pending', 'child-running', 'grandchild'])
      expect(taskTarget(sink, id)).toMatchObject({
        status: 'canceled',
        finished_at: 123,
        error_summary: 'canceled by parent task',
        error_message: 'canceled-by-parent-cascade',
      })
    expect(taskTarget(sink, 'root')).toMatchObject({
      status: 'canceled',
      error_summary: 'ended by upgrade',
    })
    expect(taskTarget(sink, 'child-interrupted')).toMatchObject({ status: 'interrupted' })
    expect(taskTarget(sink, 'under-interrupted')).toMatchObject({ status: 'running' })
    expect(taskTarget(sink, 'child-done')).toMatchObject({ status: 'done' })
  }, 180_000)
})
