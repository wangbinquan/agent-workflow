// RFC-616 (design/RFC-616-process-metrics/design.md §5.1, §14 "任务事实 / 子孙任务 /
// 执行聚合"): the task facts process metrics are computed from, on both providers.
// This file protects what the metrics engine relies on:
//   - units: the task visibility rule, the window, the three-way subject filter,
//     and that internal host tasks and called tasks are units like any other;
//   - origin: digital employee, called task, launch origin, by hand;
//   - autoMs: the existing effective running time (running time minus the human
//     wait of call nodes), and null for an ended task that was never measured;
//   - descendants: called tasks at any depth, under the call node of the unit;
//   - executions: grouped rows that keep the raw rerun cause, so the engine can
//     tell a manual retry's placeholder and a review-superseded row from a failure;
//   - wrappers and node runs: frames, rounds, shards and the agent a run used;
//   - every id list is bounded at 500.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SETTINGS_NUMERIC_BOUNDS,
  WORKFLOW_SCHEMA_VERSION,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
} from '@agent-workflow/shared'
import { createProcessTaskFacts } from '@/modules/task-execution/composition/processFacts'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import {
  PROCESS_FACT_ID_BATCH,
  type ProcessExecutionRow,
  type ProcessTaskFacts,
  type ProcessViewer,
} from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider } from './helpers/eachProvider'
import {
  nodeRunFixture,
  readNodeRunFixtures,
  taskFixture,
  workflowFixture,
  type NodeRunFixtureSpec,
  type TaskFixtureSpec,
} from './helpers/model'
import { taskChildrenFixture } from './helpers/model/taskChildren'
import { withTargetMintIdentity } from './helpers/rfc395Mint'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 1)
const WINDOW = { from: T0, to: T0 + 7 * DAY }
/** The moment the facts are read at: open stretches are measured against it. */
const NOW = T0 + 30 * DAY

const ALL: ProcessViewer = { userId: 'u-admin', canReadAll: true }
const as = (userId: string): ProcessViewer => ({ userId, canReadAll: false })

const factsOf = (db: PersistenceDb): ProcessTaskFacts => createProcessTaskFacts(db, () => NOW)

async function seedBase(db: PersistenceDb): Promise<void> {
  const { users } = tablesOf(db)
  for (const id of ['u-admin', 'u-owner', 'u-peer', 'u-other'])
    await insertOne(db, users, {
      id,
      username: id,
      displayName: id,
      role: id === 'u-admin' ? ('admin' as const) : ('user' as const),
      status: 'active' as const,
      createdAt: T0,
      updatedAt: T0,
    })
  for (const id of ['wf-a', 'wf-b']) await workflowFixture(db, { id, name: id, definition: '{}' })
}

async function seedTask(
  db: PersistenceDb,
  id: string,
  spec: Partial<TaskFixtureSpec> = {},
): Promise<void> {
  await taskFixture(db, {
    id,
    name: `task ${id}`,
    workflowId: 'wf-a',
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'done',
    inputs: '{}',
    startedAt: T0 + HOUR,
    ...spec,
  })
}

async function seedRun(db: PersistenceDb, spec: NodeRunFixtureSpec) {
  const [row] = await nodeRunFixture(db, spec)
  if (row === undefined) throw new Error(`node run fixture '${spec.id}' was not written`)
  return row
}

/** The running configuration of a workgroup task; only the frozen launch fields matter here. */
function groupConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workgroupId: 'wg-1',
    workgroupName: 'release squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: '',
    goal: 'ship the release',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        agentId: 'agent-lead',
        userId: null,
        displayName: 'lead',
        roleDesc: '',
      },
    ],
    ...overrides,
  })
}

const groupKey = (row: ProcessExecutionRow): string =>
  [
    row.taskId,
    row.nodeId,
    row.rerunCause ?? '∅',
    row.containerRunId ?? '∅',
    row.wgRound ?? '∅',
  ].join(' | ')

/** Grouped executions as `key → [runs, ended, failed, interrupted, activeMs]`. */
function groupsOf(rows: readonly ProcessExecutionRow[]): Record<string, number[]> {
  return Object.fromEntries(
    rows.map((row) => [
      groupKey(row),
      [row.runs, row.endedRuns, row.failedRuns, row.interruptedRuns, row.activeMs],
    ]),
  )
}

describeEachProvider('RFC-616 process task facts', (harness) => {
  describe('units', () => {
    test('a member sees the tasks they own or joined, in the window, newest first; read-all sees every one', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 't-first', { ownerUserId: 'u-owner', startedAt: WINDOW.from })
      await seedTask(db, 't-own', { ownerUserId: 'u-owner', startedAt: T0 + HOUR })
      await seedTask(db, 't-joined', { ownerUserId: 'u-other', startedAt: T0 + 2 * HOUR })
      await seedTask(db, 't-foreign', { ownerUserId: 'u-other', startedAt: T0 + 3 * HOUR })
      await seedTask(db, 't-deleted', {
        ownerUserId: 'u-owner',
        startedAt: T0 + 4 * HOUR,
        deletedAt: T0 + 5 * HOUR,
      })
      // The window is [from, to): one millisecond early and exactly `to` are both outside.
      await seedTask(db, 't-before', { ownerUserId: 'u-owner', startedAt: WINDOW.from - 1 })
      await seedTask(db, 't-after', { ownerUserId: 'u-owner', startedAt: WINDOW.to })
      await seedTask(db, 't-group', {
        ownerUserId: 'u-owner',
        startedAt: T0 + 6 * HOUR,
        workgroupId: 'wg-1',
        workgroupConfigJson: groupConfig(),
      })
      const { taskCollaborators } = tablesOf(db)
      await insertOne(db, taskCollaborators, {
        taskId: 't-joined',
        userId: 'u-owner',
        role: 'collaborator',
        addedBy: 'u-other',
        addedAt: T0,
      })

      const facts = factsOf(db)
      const ids = async (
        viewer: ProcessViewer,
        query: Partial<Parameters<ProcessTaskFacts['units']>[1]> = {},
      ) =>
        (await facts.units(viewer, { ...WINDOW, kind: 'workflow', limit: 50, ...query })).map(
          (unit) => unit.taskId,
        )

      expect(await ids(as('u-owner'))).toEqual(['t-joined', 't-own', 't-first'])
      expect(await ids(as('u-other'))).toEqual(['t-foreign', 't-joined'])
      expect(await ids(as('u-peer'))).toEqual([])
      expect(await ids(ALL)).toEqual(['t-foreign', 't-joined', 't-own', 't-first'])
      // The limit keeps the newest.
      expect(await ids(ALL, { limit: 2 })).toEqual(['t-foreign', 't-joined'])
      // The other subject kind is a different set of units.
      expect(await ids(as('u-owner'), { kind: 'workgroup' })).toEqual(['t-group'])
    })

    test('the origin: digital employee, called task, launch origin, and by hand when nothing was recorded', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'o-manual')
      await seedTask(db, 'o-scheduled', { launchOrigin: 'scheduled' })
      await seedTask(db, 'o-event', { launchOrigin: 'event' })
      // A digital employee's host task: internal, and launched through the API.
      await seedTask(db, 'o-round', {
        launchOrigin: 'api',
        digitalEmployeeRoundId: 'round-1',
        catalogVisibility: 'internal',
      })
      await seedTask(db, 'o-case', { digitalEmployeeCaseId: 'case-1' })
      // A called task inherits its parent's launch origin; it is a subtask all the same.
      await seedTask(db, 'o-called', { parentTaskId: 'o-scheduled' })
      // Tasks without a launch context row at all.
      await taskChildrenFixture(db, {
        id: 'o-bare',
        status: 'done',
        startedAt: T0 + HOUR,
        subjectKind: 'workflow',
      })
      await taskChildrenFixture(db, {
        id: 'o-bare-called',
        status: 'done',
        startedAt: T0 + HOUR,
        parentTaskId: 'o-manual',
        subjectKind: 'workflow',
      })

      const facts = factsOf(db)
      const units = await facts.units(ALL, { ...WINDOW, kind: 'workflow', limit: 50 })
      // The internal host task and both called tasks are units too.
      expect(Object.fromEntries(units.map((unit) => [unit.taskId, unit.origin]))).toEqual({
        'o-manual': 'manual',
        'o-scheduled': 'scheduled',
        'o-event': 'event',
        'o-round': 'digital-employee',
        'o-case': 'digital-employee',
        'o-called': 'subtask',
        'o-bare': 'manual',
        'o-bare-called': 'subtask',
      })
      expect((await facts.unit(ALL, 'o-round'))?.origin).toBe('digital-employee')
      expect((await facts.unit(ALL, 'o-bare-called'))?.origin).toBe('subtask')
    })

    test('the subject filter: one subject, tasks without a subject, or every subject of the kind', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 's-a1', { workflowId: 'wf-a', startedAt: T0 + HOUR })
      await seedTask(db, 's-a2', { workflowId: 'wf-a', startedAt: T0 + 2 * HOUR })
      await seedTask(db, 's-b', { workflowId: 'wf-b', startedAt: T0 + 3 * HOUR })
      await taskChildrenFixture(db, {
        id: 's-none',
        status: 'done',
        startedAt: T0 + 4 * HOUR,
        subjectKind: 'workflow',
      })

      const facts = factsOf(db)
      const subjects = async (subjectId?: string | null) =>
        (
          await facts.units(ALL, {
            ...WINDOW,
            kind: 'workflow',
            limit: 50,
            ...(subjectId === undefined ? {} : { subjectId }),
          })
        ).map((unit) => [unit.taskId, unit.subjectId])

      expect(await subjects('wf-a')).toEqual([
        ['s-a2', 'wf-a'],
        ['s-a1', 'wf-a'],
      ])
      expect(await subjects(null)).toEqual([['s-none', null]])
      expect(await subjects()).toEqual([
        ['s-none', null],
        ['s-b', 'wf-b'],
        ['s-a2', 'wf-a'],
        ['s-a1', 'wf-a'],
      ])
      expect(await subjects('wf-unknown')).toEqual([])
    })

    test('a unit row carries the subject, its revision, the engine kind and the frozen group name', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'shape-flow', {
        name: 'nightly build',
        ownerUserId: 'u-owner',
        workflowVersion: 7,
        status: 'canceled',
        errorSummary: 'task-time-limit-exceeded',
        startedAt: T0 + HOUR,
        finishedAt: T0 + 2 * HOUR,
        runningMs: 30 * MINUTE,
      })
      await seedTask(db, 'shape-group', {
        name: 'squad run',
        ownerUserId: 'u-owner',
        workgroupId: 'wg-1',
        workgroupConfigJson: groupConfig(),
        status: 'running',
        startedAt: T0 + 3 * HOUR,
        runningSince: NOW - 5 * MINUTE,
      })
      await seedTask(db, 'shape-plan', {
        workgroupId: 'wg-2',
        workgroupConfigJson: groupConfig({
          workgroupId: 'wg-2',
          workgroupName: 'planners',
          mode: 'dynamic_workflow',
          leaderMemberId: null,
        }),
      })
      // A task whose stored configuration is not even JSON keeps no group name.
      await seedTask(db, 'shape-broken', {
        workgroupId: 'wg-3',
        workgroupConfigJson: '{not json',
      })

      const facts = factsOf(db)
      expect(await facts.unit(ALL, 'shape-flow')).toEqual({
        taskId: 'shape-flow',
        name: 'nightly build',
        subjectId: 'wf-a',
        subjectName: null,
        subjectRevision: 7,
        engineKind: 'dag',
        status: 'canceled',
        errorSummary: 'task-time-limit-exceeded',
        origin: 'manual',
        ownerUserId: 'u-owner',
        startedAt: T0 + HOUR,
        finishedAt: T0 + 2 * HOUR,
        autoMs: 30 * MINUTE,
      })
      expect(await facts.unit(ALL, 'shape-group')).toEqual({
        taskId: 'shape-group',
        name: 'squad run',
        subjectId: 'wg-1',
        subjectName: 'release squad',
        subjectRevision: null,
        engineKind: 'workgroup-turns',
        status: 'running',
        errorSummary: null,
        origin: 'manual',
        ownerUserId: 'u-owner',
        startedAt: T0 + 3 * HOUR,
        finishedAt: null,
        autoMs: 5 * MINUTE,
      })
      expect(await facts.unit(ALL, 'shape-plan')).toMatchObject({
        subjectId: 'wg-2',
        subjectName: 'planners',
        engineKind: 'dw-generate',
      })
      expect(await facts.unit(ALL, 'shape-broken')).toMatchObject({
        subjectId: 'wg-3',
        subjectName: null,
        engineKind: 'workgroup-turns',
      })
    })

    test('one unit: null when the task is missing, deleted, not visible, or not a workflow or workgroup task', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'one-own', { ownerUserId: 'u-owner' })
      await seedTask(db, 'one-deleted', { ownerUserId: 'u-owner', deletedAt: T0 + 2 * HOUR })
      await seedTask(db, 'one-agent', { ownerUserId: 'u-owner', sourceAgentName: 'planner' })
      await taskChildrenFixture(db, {
        id: 'one-host',
        status: 'done',
        startedAt: T0 + HOUR,
        subjectKind: 'digital-employee',
      })

      const facts = factsOf(db)
      expect((await facts.unit(as('u-owner'), 'one-own'))?.taskId).toBe('one-own')
      expect((await facts.unit(ALL, 'one-own'))?.taskId).toBe('one-own')
      expect(await facts.unit(as('u-peer'), 'one-own')).toBeNull()
      expect(await facts.unit(ALL, 'one-missing')).toBeNull()
      expect(await facts.unit(ALL, 'one-deleted')).toBeNull()
      expect(await facts.unit(ALL, 'one-agent')).toBeNull()
      expect(await facts.unit(ALL, 'one-host')).toBeNull()
    })
  })

  describe('effective running time', () => {
    test('running time, the open running stretch, and null for an ended task that was never measured', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'a-done', { status: 'done', runningMs: 10_000 })
      await seedTask(db, 'a-done-unmeasured', { status: 'done' })
      await seedTask(db, 'a-failed-unmeasured', { status: 'failed' })
      await seedTask(db, 'a-canceled-unmeasured', { status: 'canceled' })
      await seedTask(db, 'a-running', {
        status: 'running',
        runningMs: 4_000,
        runningSince: NOW - 1_500,
      })
      // Not ended, so "no running time yet" is a measured zero, not a missing record.
      await seedTask(db, 'a-pending', { status: 'pending' })
      await seedTask(db, 'a-interrupted', { status: 'interrupted' })

      const facts = factsOf(db)
      const ids = [
        'a-done',
        'a-done-unmeasured',
        'a-failed-unmeasured',
        'a-canceled-unmeasured',
        'a-running',
        'a-pending',
        'a-interrupted',
      ]
      const expected = {
        'a-done': 10_000,
        'a-done-unmeasured': null,
        'a-failed-unmeasured': null,
        'a-canceled-unmeasured': null,
        'a-running': 5_500,
        'a-pending': 0,
        'a-interrupted': 0,
      }
      const units = await facts.units(ALL, { ...WINDOW, kind: 'workflow', limit: 50 })
      expect(Object.fromEntries(units.map((unit) => [unit.taskId, unit.autoMs]))).toEqual(expected)
      // A task summary reports the same figure.
      const summaries = await facts.taskSummaries(ids)
      expect(Object.fromEntries(summaries.map((row) => [row.taskId, row.autoMs]))).toEqual(expected)
    })

    test('the time call nodes waited for people inside child tasks is taken off, per task', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'w-call', { status: 'done', runningMs: 10_000 })
      // A wait that ended, a wait still open, and a call that never waited.
      await seedRun(db, {
        id: 'w-call-closed',
        taskId: 'w-call',
        nodeId: 'call-review',
        status: 'done',
        childTaskId: 'w-child-a',
        wrapperProgressJson: { callHumanWaitMs: 3_000, callHumanWaitSince: null },
      })
      await seedRun(db, {
        id: 'w-call-open',
        taskId: 'w-call',
        nodeId: 'call-design',
        status: 'running',
        childTaskId: 'w-child-b',
        wrapperProgressJson: { callHumanWaitMs: 500, callHumanWaitSince: NOW - 1_000 },
      })
      await seedRun(db, {
        id: 'w-call-direct',
        taskId: 'w-call',
        nodeId: 'call-test',
        status: 'done',
        childTaskId: 'w-child-c',
      })
      // A wrapper's own progress document is not a call ledger, whatever it contains.
      await seedRun(db, {
        id: 'w-loop',
        taskId: 'w-call',
        nodeId: 'loop',
        status: 'done',
        rerunCause: 'wrapper-init',
        wrapperProgressJson: { kind: 'loop', iteration: 4, callHumanWaitMs: 99_000 },
      })
      await seedTask(db, 'w-other', { status: 'done', runningMs: 8_000 })
      await seedRun(db, {
        id: 'w-other-call',
        taskId: 'w-other',
        nodeId: 'call-review',
        status: 'done',
        childTaskId: 'w-child-d',
        wrapperProgressJson: { callHumanWaitMs: 2_000, callHumanWaitSince: null },
      })
      // More waiting than running never turns into negative time.
      await seedTask(db, 'w-swamped', { status: 'done', runningMs: 1_000 })
      await seedRun(db, {
        id: 'w-swamped-call',
        taskId: 'w-swamped',
        nodeId: 'call-review',
        status: 'done',
        childTaskId: 'w-child-e',
        wrapperProgressJson: { callHumanWaitMs: 5_000, callHumanWaitSince: null },
      })

      const facts = factsOf(db)
      const expected = { 'w-call': 5_500, 'w-other': 6_000, 'w-swamped': 0 }
      const units = await facts.units(ALL, { ...WINDOW, kind: 'workflow', limit: 50 })
      expect(Object.fromEntries(units.map((unit) => [unit.taskId, unit.autoMs]))).toEqual(expected)
      expect((await facts.unit(ALL, 'w-call'))?.autoMs).toBe(5_500)
      const summaries = await facts.taskSummaries(['w-call', 'w-other', 'w-swamped'])
      expect(Object.fromEntries(summaries.map((row) => [row.taskId, row.autoMs]))).toEqual(expected)
    })

    test('task summaries cover existing tasks whoever owns them, and skip deleted and unknown ids', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'sum-failed', {
        ownerUserId: 'u-other',
        status: 'failed',
        errorSummary: 'node-failed',
        startedAt: T0 + HOUR,
        finishedAt: T0 + 2 * HOUR,
        runningMs: 20 * MINUTE,
      })
      await seedTask(db, 'sum-deleted', { deletedAt: T0 + 3 * HOUR })

      const facts = factsOf(db)
      expect(await facts.taskSummaries(['sum-failed', 'sum-deleted', 'sum-missing'])).toEqual([
        {
          taskId: 'sum-failed',
          status: 'failed',
          errorSummary: 'node-failed',
          startedAt: T0 + HOUR,
          finishedAt: T0 + 2 * HOUR,
          autoMs: 20 * MINUTE,
        },
      ])
    })
  })

  describe('descendants', () => {
    test('called tasks at every depth hang under the call node of the unit that started the branch', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'root')
      await seedRun(db, {
        id: 'root-call-a',
        taskId: 'root',
        nodeId: 'call-a',
        status: 'done',
        childTaskId: 'kid-1',
      })
      await seedRun(db, {
        id: 'root-call-b',
        taskId: 'root',
        nodeId: 'call-b',
        status: 'done',
        childTaskId: 'kid-2',
      })
      // Two runs of the same call node bound to one child: the first one started the branch.
      await seedRun(db, {
        id: 'root-call-c-first',
        taskId: 'root',
        nodeId: 'call-c',
        status: 'interrupted',
        childTaskId: 'kid-3',
      })
      await seedRun(db, {
        id: 'root-call-c-again',
        taskId: 'root',
        nodeId: 'call-c',
        status: 'done',
        retryIndex: 1,
        childTaskId: 'kid-3',
      })
      await seedTask(db, 'kid-1', {
        parentTaskId: 'root',
        parentNodeRunId: 'root-call-a',
        startedAt: T0 + HOUR + 1,
      })
      await seedTask(db, 'kid-2', {
        parentTaskId: 'root',
        parentNodeRunId: 'root-call-b',
        startedAt: T0 + HOUR + 2,
      })
      // No launch context: kid-3 is known only from the parent's call run, kid-4 from nowhere.
      await taskChildrenFixture(db, [
        {
          id: 'kid-3',
          status: 'done',
          startedAt: T0 + HOUR + 3,
          parentTaskId: 'root',
          subjectKind: 'workflow',
        },
        {
          id: 'kid-4',
          status: 'done',
          startedAt: T0 + HOUR + 4,
          parentTaskId: 'root',
          subjectKind: 'workflow',
        },
      ])
      // A launch context naming a run of some other task says nothing about the unit's nodes.
      await seedTask(db, 'elsewhere')
      await seedRun(db, {
        id: 'elsewhere-run',
        taskId: 'elsewhere',
        nodeId: 'call-z',
        status: 'done',
      })
      await seedTask(db, 'kid-5', {
        parentTaskId: 'root',
        parentNodeRunId: 'elsewhere-run',
        startedAt: T0 + HOUR + 5,
      })
      // A deleted called task is gone together with what it called.
      await seedTask(db, 'kid-gone', {
        parentTaskId: 'root',
        startedAt: T0 + HOUR + 6,
        deletedAt: T0 + 2 * HOUR,
      })
      await seedTask(db, 'grandkid-gone', { parentTaskId: 'kid-gone', startedAt: T0 + HOUR + 7 })
      await seedRun(db, {
        id: 'kid-1-call',
        taskId: 'kid-1',
        nodeId: 'inner-call',
        status: 'done',
        childTaskId: 'grandkid',
      })
      await seedTask(db, 'grandkid', {
        parentTaskId: 'kid-1',
        parentNodeRunId: 'kid-1-call',
        startedAt: T0 + HOUR + 8,
      })
      await seedTask(db, 'great-grandkid', { parentTaskId: 'grandkid', startedAt: T0 + HOUR + 9 })

      const facts = factsOf(db)
      const underA = { callNodeId: 'call-a', callNodeRunId: 'root-call-a' }
      expect(await facts.descendants(['root'])).toEqual([
        { unitTaskId: 'root', taskId: 'kid-1', ...underA },
        { unitTaskId: 'root', taskId: 'kid-2', callNodeId: 'call-b', callNodeRunId: 'root-call-b' },
        {
          unitTaskId: 'root',
          taskId: 'kid-3',
          callNodeId: 'call-c',
          callNodeRunId: 'root-call-c-first',
        },
        { unitTaskId: 'root', taskId: 'kid-4', callNodeId: null, callNodeRunId: null },
        { unitTaskId: 'root', taskId: 'kid-5', callNodeId: null, callNodeRunId: null },
        // Deeper levels inherit the call node of their top-level ancestor.
        { unitTaskId: 'root', taskId: 'grandkid', ...underA },
        { unitTaskId: 'root', taskId: 'great-grandkid', ...underA },
      ])
      expect(await facts.descendants(['kid-2'])).toEqual([])

      // A called task queried as a unit of its own keeps both views apart.
      const both = await facts.descendants(['root', 'kid-1'])
      const underInner = { callNodeId: 'inner-call', callNodeRunId: 'kid-1-call' }
      expect(both.filter((row) => row.unitTaskId === 'kid-1')).toEqual([
        { unitTaskId: 'kid-1', taskId: 'grandkid', ...underInner },
        { unitTaskId: 'kid-1', taskId: 'great-grandkid', ...underInner },
      ])
      expect(both.filter((row) => row.unitTaskId === 'root').map((row) => row.taskId)).toEqual([
        'kid-1',
        'kid-2',
        'kid-3',
        'kid-4',
        'kid-5',
        'grandkid',
        'great-grandkid',
      ])
    })

    test('a call chain is followed down to the deepest nesting the platform allows', async () => {
      const db = harness.db
      await seedBase(db)
      const deepest = SETTINGS_NUMERIC_BOUNDS.maxInvocationDepth.max
      await taskChildrenFixture(db, {
        id: 'chain-00',
        status: 'done',
        startedAt: T0 + HOUR,
        subjectKind: 'workflow',
      })
      // Two levels more than can exist, to see where the walk stops.
      for (let level = 1; level <= deepest + 2; level++)
        await taskChildrenFixture(db, {
          id: `chain-${String(level).padStart(2, '0')}`,
          status: 'done',
          startedAt: T0 + HOUR + level,
          parentTaskId: `chain-${String(level - 1).padStart(2, '0')}`,
          subjectKind: 'workflow',
        })

      const found = await factsOf(db).descendants(['chain-00'])
      expect(found.map((row) => row.taskId)).toEqual(
        Array.from(
          { length: deepest },
          (_, index) => `chain-${String(index + 1).padStart(2, '0')}`,
        ),
      )
    })
  })

  describe('executions', () => {
    test('rows are grouped by task, node, raw rerun cause, wrapper invocation and workgroup round', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'exec')
      const base = { taskId: 'exec' }
      await seedRun(db, {
        ...base,
        id: 'e-plan',
        nodeId: 'plan',
        rerunCause: 'initial',
        status: 'done',
        startedAt: 1_000,
        finishedAt: 4_000,
      })
      await seedRun(db, {
        ...base,
        id: 'e-code-1',
        nodeId: 'code',
        rerunCause: 'initial',
        status: 'failed',
        failureCode: 'runtime-stream-interrupted',
        startedAt: 5_000,
        finishedAt: 6_000,
      })
      await seedRun(db, {
        ...base,
        id: 'e-code-2',
        nodeId: 'code',
        rerunCause: 'process-retry',
        retryIndex: 1,
        status: 'failed',
        failureCode: 'runtime-stream-interrupted',
        startedAt: 6_000,
        finishedAt: 6_500,
      })
      await seedRun(db, {
        ...base,
        id: 'e-code-3',
        nodeId: 'code',
        rerunCause: 'process-retry',
        retryIndex: 2,
        status: 'failed',
        failureCode: 'clarify-forbidden',
        startedAt: 6_500,
        finishedAt: 7_000,
      })
      // A manual retry's placeholder, minted the way the retry command mints it:
      // born failed, with the moment the retry was queued as its finish time.
      const queuedAt = Date.now()
      const placeholderId = await new DrizzleNodeRunLifecyclePersistence(db).mint(
        withTargetMintIdentity({
          taskId: 'exec',
          nodeId: 'code',
          role: 'node-attempt',
          syntheticKind: null,
          status: 'failed',
          cause: 'retry-node',
          retryIndex: 3,
          executionGeneration: {
            kind: 'operation',
            cause: 'retry',
            operationRef: 'task-retry:exec:rfc616',
          },
          overrides: { identity: { finishedAt: queuedAt, errorMessage: 'queued for retry' } },
        }),
      )
      await seedRun(db, {
        ...base,
        id: 'e-code-4',
        nodeId: 'code',
        rerunCause: 'revival',
        retryIndex: 4,
        status: 'done',
        startedAt: 8_000,
        finishedAt: 9_500,
      })
      // Superseded by a review decision: canceled, not failed.
      await seedRun(db, {
        ...base,
        id: 'e-doc-1',
        nodeId: 'doc',
        rerunCause: 'initial',
        status: 'canceled',
        supersededByReview: 'iterated',
        startedAt: 10_000,
        finishedAt: 11_000,
      })
      // The rework the review asked for has not started yet.
      await seedRun(db, {
        ...base,
        id: 'e-doc-2',
        nodeId: 'doc',
        rerunCause: 'review-iterate',
        retryIndex: 1,
        status: 'pending',
        startedAt: null,
      })
      await seedRun(db, {
        ...base,
        id: 'e-test-1',
        nodeId: 'test',
        rerunCause: 'initial',
        status: 'interrupted',
        startedAt: 12_000,
      })
      await seedRun(db, {
        ...base,
        id: 'e-test-2',
        nodeId: 'test',
        rerunCause: 'revival',
        retryIndex: 1,
        status: 'running',
        startedAt: 13_000,
      })
      // A wrapper invocation is not an execution; the runs inside it are, in its frame.
      await seedRun(db, {
        ...base,
        id: 'e-loop',
        nodeId: 'loop',
        rerunCause: 'wrapper-init',
        status: 'done',
        startedAt: 14_000,
        finishedAt: 20_000,
      })
      await seedRun(db, {
        ...base,
        id: 'e-step-0',
        nodeId: 'step',
        rerunCause: 'initial',
        containerRunId: 'e-loop',
        iteration: 0,
        status: 'done',
        startedAt: 14_000,
        finishedAt: 15_000,
      })
      await seedRun(db, {
        ...base,
        id: 'e-step-1',
        nodeId: 'step',
        rerunCause: 'initial',
        containerRunId: 'e-loop',
        iteration: 1,
        status: 'done',
        startedAt: 15_000,
        finishedAt: 17_000,
      })
      // A row from before rerun causes were recorded.
      await seedRun(db, {
        ...base,
        id: 'e-old',
        nodeId: 'legacy',
        status: 'done',
        startedAt: 100,
        finishedAt: 300,
      })
      await seedRun(db, {
        ...base,
        id: 'e-skip',
        nodeId: 'branch',
        rerunCause: 'branch-skip',
        status: 'skipped',
        startedAt: null,
      })

      await seedTask(db, 'exec-group', {
        workgroupId: 'wg-1',
        workgroupConfigJson: groupConfig(),
      })
      const group = { taskId: 'exec-group' }
      await seedRun(db, {
        ...group,
        id: 'g-lead-1',
        nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
        rerunCause: 'wg-leader-round',
        wgRound: 1,
        status: 'done',
        startedAt: 1_000,
        finishedAt: 2_000,
      })
      await seedRun(db, {
        ...group,
        id: 'g-card-1',
        nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
        shardKey: 'card-1',
        rerunCause: 'wg-assignment',
        wgRound: 1,
        status: 'done',
        startedAt: 2_000,
        finishedAt: 5_000,
      })
      await seedRun(db, {
        ...group,
        id: 'g-lead-2',
        nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
        rerunCause: 'wg-leader-round',
        wgRound: 2,
        status: 'done',
        startedAt: 5_000,
        finishedAt: 6_000,
      })
      await seedRun(db, {
        ...group,
        id: 'g-lead-2-retry',
        nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
        rerunCause: 'wg-protocol-retry',
        retryIndex: 1,
        wgRound: 2,
        status: 'done',
        startedAt: 6_000,
        finishedAt: 6_400,
      })
      // The completion-gate holder sits on the leader node; its cause tells it apart.
      await seedRun(db, {
        ...group,
        id: 'g-gate',
        nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
        rerunCause: 'wg-gate',
        wgRound: 2,
        status: 'awaiting_review',
        startedAt: 6_400,
      })

      // The ledger shape of the placeholder: both timestamps, finished no later than started.
      const [placeholder] = await readNodeRunFixtures(db, { id: placeholderId })
      expect(placeholder).toMatchObject({
        status: 'failed',
        rerunCause: 'retry-node',
        finishedAt: queuedAt,
      })
      expect(placeholder?.startedAt ?? 0).toBeGreaterThanOrEqual(queuedAt)

      const facts = factsOf(db)
      const rows = await facts.executions(['exec', 'exec-group'])
      expect(groupsOf(rows)).toEqual({
        // [runs, ended, failed, interrupted, activeMs]
        'exec | plan | initial | ∅ | ∅': [1, 1, 0, 0, 3_000],
        'exec | code | initial | ∅ | ∅': [1, 1, 1, 0, 1_000],
        'exec | code | process-retry | ∅ | ∅': [2, 2, 2, 0, 1_000],
        // Kept, with its raw cause: the engine counts it as one manual retry, not as a failed execution.
        'exec | code | retry-node | ∅ | ∅': [1, 1, 1, 0, 0],
        'exec | code | revival | ∅ | ∅': [1, 1, 0, 0, 1_500],
        'exec | doc | initial | ∅ | ∅': [1, 1, 0, 0, 1_000],
        'exec | doc | review-iterate | ∅ | ∅': [1, 0, 0, 0, 0],
        'exec | test | initial | ∅ | ∅': [1, 0, 0, 1, 0],
        'exec | test | revival | ∅ | ∅': [1, 0, 0, 0, 0],
        'exec | step | initial | e-loop | ∅': [2, 2, 0, 0, 3_000],
        'exec | legacy | ∅ | ∅ | ∅': [1, 1, 0, 0, 200],
        'exec | branch | branch-skip | ∅ | ∅': [1, 0, 0, 0, 0],
        [`exec-group | ${WORKGROUP_TURN_LEADER_NODE_ID} | wg-leader-round | ∅ | 1`]: [
          1, 1, 0, 0, 1_000,
        ],
        [`exec-group | ${WORKGROUP_TURN_MEMBER_NODE_ID} | wg-assignment | ∅ | 1`]: [
          1, 1, 0, 0, 3_000,
        ],
        [`exec-group | ${WORKGROUP_TURN_LEADER_NODE_ID} | wg-leader-round | ∅ | 2`]: [
          1, 1, 0, 0, 1_000,
        ],
        [`exec-group | ${WORKGROUP_TURN_LEADER_NODE_ID} | wg-protocol-retry | ∅ | 2`]: [
          1, 1, 0, 0, 400,
        ],
        [`exec-group | ${WORKGROUP_TURN_LEADER_NODE_ID} | wg-gate | ∅ | 2`]: [1, 0, 0, 0, 0],
      })
      // One task's rows only.
      expect(new Set((await facts.executions(['exec-group'])).map((row) => row.taskId))).toEqual(
        new Set(['exec-group']),
      )

      // Failure codes travel on the runs themselves (the engine tallies them per stage):
      // every failed run that recorded one, with its raw cause.
      const coded = (await facts.nodeRuns(['exec']))
        .concat(await facts.nodeRuns(['exec-group']))
        .filter((row) => row.status === 'failed' && row.failureCode !== null)
      expect(
        coded
          .map((row) =>
            [row.taskId, row.nodeId, row.rerunCause ?? '∅', row.failureCode].join(' | '),
          )
          .sort(),
      ).toEqual([
        'exec | code | initial | runtime-stream-interrupted',
        'exec | code | process-retry | clarify-forbidden',
        'exec | code | process-retry | runtime-stream-interrupted',
      ])
    })

    test('a failure code is read off a leaf run: a wrapper invocation is not one, a run without a code has none', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'codes')
      await seedRun(db, {
        id: 'c-canceled',
        taskId: 'codes',
        nodeId: 'code',
        rerunCause: 'initial',
        status: 'canceled',
        failureCode: 'canceled',
      })
      await seedRun(db, {
        id: 'c-loop',
        taskId: 'codes',
        nodeId: 'loop',
        rerunCause: 'wrapper-init',
        status: 'failed',
        failureCode: 'wrapper-loop-exit-port-missing',
      })
      await seedRun(db, {
        id: 'c-failed-twice-1',
        taskId: 'codes',
        nodeId: 'test',
        rerunCause: 'initial',
        status: 'failed',
        failureCode: 'runtime-stream-interrupted',
      })
      await seedRun(db, {
        id: 'c-failed-twice-2',
        taskId: 'codes',
        nodeId: 'test',
        rerunCause: 'initial',
        iteration: 1,
        status: 'failed',
        failureCode: 'runtime-stream-interrupted',
      })
      await seedRun(db, {
        id: 'c-failed-uncoded',
        taskId: 'codes',
        nodeId: 'test',
        rerunCause: 'revival',
        retryIndex: 1,
        status: 'failed',
      })

      const runs = await factsOf(db).nodeRuns(['codes'])
      expect(
        runs
          .map((row) => [row.nodeRunId, row.status, row.failureCode] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ).toEqual([
        // A canceled run keeps the code it recorded; only failed runs are tallied by the engine.
        ['c-canceled', 'canceled', 'canceled'],
        ['c-failed-twice-1', 'failed', 'runtime-stream-interrupted'],
        ['c-failed-twice-2', 'failed', 'runtime-stream-interrupted'],
        ['c-failed-uncoded', 'failed', null],
      ])
      // The failed loop invocation is a wrapper row, read by `wrappers`, never as a run.
      expect(runs.some((row) => row.nodeRunId === 'c-loop')).toBe(false)
    })
  })

  describe('wrappers and node runs', () => {
    test('one row per wrapper invocation: its frame, mint order, rounds, shards and final status', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'wrap')
      const base = { taskId: 'wrap' }
      // A loop that ran three rounds and hit its limit.
      const first = await seedRun(db, {
        ...base,
        id: 'loop-1',
        nodeId: 'loop',
        rerunCause: 'wrapper-init',
        status: 'exhausted',
        startedAt: 1_000,
        finishedAt: 9_000,
      })
      for (const iteration of [0, 1, 2])
        await seedRun(db, {
          ...base,
          id: `loop-1-step-${iteration}`,
          nodeId: 'step',
          rerunCause: 'initial',
          containerRunId: 'loop-1',
          iteration,
          status: 'done',
        })
      // A git wrapper inside the loop's second round: it sits in that frame.
      await seedRun(db, {
        ...base,
        id: 'git-1',
        nodeId: 'git',
        rerunCause: 'wrapper-init',
        containerRunId: 'loop-1',
        iteration: 1,
        status: 'done',
      })
      await seedRun(db, {
        ...base,
        id: 'git-1-commit',
        nodeId: 'commit',
        rerunCause: 'initial',
        containerRunId: 'git-1',
        iteration: 1,
        status: 'done',
      })
      // The loop invoked again in the same frame: a later invocation of the same node.
      const second = await seedRun(db, {
        ...base,
        id: 'loop-2',
        nodeId: 'loop',
        rerunCause: 'wrapper-init',
        status: 'done',
      })
      await seedRun(db, {
        ...base,
        id: 'loop-2-step-0',
        nodeId: 'step',
        rerunCause: 'initial',
        containerRunId: 'loop-2',
        iteration: 0,
        status: 'done',
      })
      // A fan-out over three shards, one of which failed twice.
      await seedRun(db, {
        ...base,
        id: 'fan-1',
        nodeId: 'fan',
        rerunCause: 'wrapper-init',
        status: 'failed',
      })
      for (const [id, shardKey, status, rerunCause, retryIndex] of [
        ['fan-1-a', 'src/a.ts', 'done', 'fanout-shard', 0],
        ['fan-1-b', 'src/b.ts', 'failed', 'fanout-shard', 0],
        ['fan-1-b-retry', 'src/b.ts', 'failed', 'process-retry', 1],
        ['fan-1-c', 'src/c.ts', 'done', 'fanout-shard', 0],
      ] as const)
        await seedRun(db, {
          ...base,
          id,
          nodeId: 'work',
          rerunCause,
          retryIndex,
          containerRunId: 'fan-1',
          parentNodeRunId: 'fan-1',
          shardKey,
          status,
        })
      // An invocation nothing ran inside.
      await seedRun(db, {
        ...base,
        id: 'idle-1',
        nodeId: 'idle',
        rerunCause: 'wrapper-init',
        status: 'done',
      })

      const rows = await factsOf(db).wrappers(['wrap'])
      expect(rows.map(({ seq: _seq, ...row }) => row)).toEqual([
        {
          taskId: 'wrap',
          runId: 'loop-1',
          nodeId: 'loop',
          rerunCause: 'wrapper-init',
          containerRunId: null,
          iteration: 0,
          status: 'exhausted',
          startedAt: 1_000,
          finishedAt: 9_000,
          rounds: 3,
          shards: 0,
        },
        {
          taskId: 'wrap',
          runId: 'git-1',
          nodeId: 'git',
          rerunCause: 'wrapper-init',
          containerRunId: 'loop-1',
          iteration: 1,
          status: 'done',
          startedAt: null,
          finishedAt: null,
          // The body of a git wrapper runs in its own frame's round: highest inner round + 1.
          rounds: 2,
          shards: 0,
        },
        {
          taskId: 'wrap',
          runId: 'loop-2',
          nodeId: 'loop',
          rerunCause: 'wrapper-init',
          containerRunId: null,
          iteration: 0,
          status: 'done',
          startedAt: null,
          finishedAt: null,
          rounds: 1,
          shards: 0,
        },
        {
          taskId: 'wrap',
          runId: 'fan-1',
          nodeId: 'fan',
          rerunCause: 'wrapper-init',
          containerRunId: null,
          iteration: 0,
          status: 'failed',
          startedAt: null,
          finishedAt: null,
          rounds: 1,
          shards: 3,
        },
        {
          taskId: 'wrap',
          runId: 'idle-1',
          nodeId: 'idle',
          rerunCause: 'wrapper-init',
          containerRunId: null,
          iteration: 0,
          status: 'done',
          startedAt: null,
          finishedAt: null,
          rounds: 0,
          shards: 0,
        },
      ])
      // The listing asks without counts: the same rows, and no inner row is read for them.
      const bare = await factsOf(db).wrappers(['wrap'], { counts: false })
      expect(bare).toEqual(rows.map((row) => ({ ...row, rounds: 0, shards: 0 })))
      // Mint order: the engine tells the first invocation of a frame from a later one by it.
      const seqs = rows.map((row) => row.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(rows[0]?.seq).toBe(first.seq)
      expect(rows[2]?.seq).toBe(second.seq)
    })

    test('a row on a wrapper slot carries the cause it was minted with: a review rerun, a manual-retry placeholder', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'wrap-causes')
      const base = { taskId: 'wrap-causes', nodeId: 'loop' }
      await seedRun(db, { ...base, id: 'c-loop-1', rerunCause: 'wrapper-init', status: 'done' })
      // A review sent back what the loop exposes: the replacement sits on the same slot.
      await seedRun(db, {
        ...base,
        id: 'c-loop-2',
        rerunCause: 'review-iterate',
        wrapperProgressJson: { kind: 'loop', iteration: 0 },
        status: 'done',
      })
      // A person retried the loop: the placeholder is failed and never started.
      await seedRun(db, {
        ...base,
        id: 'c-loop-placeholder',
        rerunCause: 'retry-node',
        wrapperProgressJson: { kind: 'loop', iteration: 0 },
        status: 'failed',
        finishedAt: 5_000,
      })
      await seedRun(db, {
        ...base,
        id: 'c-loop-3',
        rerunCause: 'revival',
        wrapperProgressJson: { kind: 'loop', iteration: 0 },
        status: 'done',
      })
      const rows = await factsOf(db).wrappers(['wrap-causes'])
      expect(rows.map((row) => [row.runId, row.rerunCause, row.status, row.startedAt])).toEqual([
        ['c-loop-1', 'wrapper-init', 'done', null],
        ['c-loop-2', 'review-iterate', 'done', null],
        ['c-loop-placeholder', 'retry-node', 'failed', null],
        ['c-loop-3', 'revival', 'done', null],
      ])
      // None of them is a leaf run: the engine reads their causes from here, not from the executions.
      expect(await factsOf(db).nodeRuns(['wrap-causes'])).toEqual([])
      expect(await factsOf(db).executions(['wrap-causes'])).toEqual([])
    })

    test('node runs: every run that is not a wrapper invocation, with the agent it ran with', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'runs-flow')
      const plan = await seedRun(db, {
        id: 'n-plan',
        taskId: 'runs-flow',
        nodeId: 'plan',
        rerunCause: 'initial',
        status: 'done',
        startedAt: 1_000,
        finishedAt: 2_000,
      })
      await seedRun(db, {
        id: 'n-loop',
        taskId: 'runs-flow',
        nodeId: 'loop',
        rerunCause: 'wrapper-init',
        status: 'done',
      })
      const step = await seedRun(db, {
        id: 'n-step',
        taskId: 'runs-flow',
        nodeId: 'step',
        rerunCause: 'initial',
        containerRunId: 'n-loop',
        iteration: 1,
        status: 'running',
        startedAt: 3_000,
      })
      await seedTask(db, 'runs-group', {
        workgroupId: 'wg-1',
        workgroupConfigJson: groupConfig(),
      })
      const lead = await seedRun(db, {
        id: 'n-lead',
        taskId: 'runs-group',
        nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
        rerunCause: 'wg-leader-round',
        wgRound: 1,
        agentOverrideId: 'agent-lead',
        status: 'done',
        startedAt: 1_000,
        finishedAt: 1_500,
      })
      const card = await seedRun(db, {
        id: 'n-card',
        taskId: 'runs-group',
        nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
        shardKey: 'card-1',
        rerunCause: 'wg-assignment',
        wgRound: 1,
        agentOverrideId: 'agent-coder',
        status: 'failed',
        failureCode: 'clarify-forbidden',
        startedAt: 3_000,
        finishedAt: 3_500,
      })

      const facts = factsOf(db)
      expect(await facts.nodeRuns(['runs-flow'])).toEqual([
        {
          taskId: 'runs-flow',
          nodeRunId: 'n-plan',
          nodeId: 'plan',
          rerunCause: 'initial',
          containerRunId: null,
          wgRound: null,
          shardKey: null,
          // No configuration was recorded for this run.
          agentOverrideId: null,
          status: 'done',
          failureCode: null,
          startedAt: 1_000,
          finishedAt: 2_000,
          seq: plan.seq,
        },
        {
          taskId: 'runs-flow',
          nodeRunId: 'n-step',
          nodeId: 'step',
          rerunCause: 'initial',
          containerRunId: 'n-loop',
          wgRound: null,
          shardKey: null,
          agentOverrideId: null,
          status: 'running',
          failureCode: null,
          startedAt: 3_000,
          finishedAt: null,
          seq: step.seq,
        },
      ])
      const groupRuns = await facts.nodeRuns(['runs-group'])
      expect(groupRuns).toEqual([
        {
          taskId: 'runs-group',
          nodeRunId: 'n-lead',
          nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
          rerunCause: 'wg-leader-round',
          containerRunId: null,
          wgRound: 1,
          shardKey: null,
          agentOverrideId: 'agent-lead',
          status: 'done',
          failureCode: null,
          startedAt: 1_000,
          finishedAt: 1_500,
          seq: lead.seq,
        },
        {
          taskId: 'runs-group',
          nodeRunId: 'n-card',
          nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
          rerunCause: 'wg-assignment',
          containerRunId: null,
          wgRound: 1,
          shardKey: 'card-1',
          agentOverrideId: 'agent-coder',
          status: 'failed',
          failureCode: 'clarify-forbidden',
          startedAt: 3_000,
          finishedAt: 3_500,
          seq: card.seq,
        },
      ])

      // Narrowed to some nodes; no node at all selects nothing.
      expect(
        (
          await facts.nodeRuns(['runs-flow', 'runs-group'], {
            nodeIds: [WORKGROUP_TURN_MEMBER_NODE_ID, 'plan'],
          })
        )
          .map((row) => row.nodeRunId)
          .sort(),
      ).toEqual(['n-card', 'n-plan'])
      expect(await facts.nodeRuns(['runs-flow'], { nodeIds: [] })).toEqual([])
      // Several tasks in one call: each task's runs stay in mint order.
      const mixed = await facts.nodeRuns(['runs-group', 'runs-flow'])
      expect(mixed.filter((row) => row.taskId === 'runs-flow').map((row) => row.nodeRunId)).toEqual(
        ['n-plan', 'n-step'],
      )
      expect(
        mixed.filter((row) => row.taskId === 'runs-group').map((row) => row.nodeRunId),
      ).toEqual(['n-lead', 'n-card'])
    })
  })

  describe('definition and host tasks', () => {
    test('the frozen definition, upgraded to the current schema; null when missing or unreadable', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'def-current', {
        workflowSnapshot: JSON.stringify({
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [],
          nodes: [
            { id: 'plan', kind: 'agent-single', agentId: 'agent-1' },
            { id: 'check', kind: 'review' },
          ],
          edges: [],
        }),
      })
      await seedTask(db, 'def-old', {
        workflowSnapshot: JSON.stringify({
          $schema_version: 1,
          inputs: [],
          nodes: [{ id: 'n1', kind: 'agent-single' }],
          edges: [],
        }),
      })
      await seedTask(db, 'def-not-json', { workflowSnapshot: '{not json' })
      await seedTask(db, 'def-wrong-shape', { workflowSnapshot: '{}' })

      const facts = factsOf(db)
      const current = await facts.definition('def-current')
      expect(current?.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
      expect(current?.nodes.map((node) => [node.id, node.kind])).toEqual([
        ['plan', 'agent-single'],
        ['check', 'review'],
      ])
      const old = await facts.definition('def-old')
      expect(old?.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
      expect(old?.nodes.map((node) => node.id)).toEqual(['n1'])
      expect(await facts.definition('def-not-json')).toBeNull()
      expect(await facts.definition('def-wrong-shape')).toBeNull()
      expect(await facts.definition('def-missing')).toBeNull()
    })

    test('the host tasks of digital-employee rounds, oldest first per round', async () => {
      const db = harness.db
      await seedBase(db)
      const host = { catalogVisibility: 'internal' as const }
      await seedTask(db, 'host-retry', {
        ...host,
        digitalEmployeeRoundId: 'round-1',
        startedAt: T0 + 2 * HOUR,
      })
      await seedTask(db, 'host-first', {
        ...host,
        digitalEmployeeRoundId: 'round-1',
        startedAt: T0 + HOUR,
      })
      await seedTask(db, 'host-other', {
        ...host,
        digitalEmployeeRoundId: 'round-2',
        startedAt: T0 + HOUR,
      })
      await seedTask(db, 'host-deleted', {
        ...host,
        digitalEmployeeRoundId: 'round-1',
        startedAt: T0 + 3 * HOUR,
        deletedAt: T0 + 4 * HOUR,
      })
      await seedTask(db, 'host-unrelated', { digitalEmployeeRoundId: 'round-9' })
      await seedTask(db, 'not-a-host')

      expect(
        await factsOf(db).reactionHostTasks(['round-1', 'round-2', 'round-without-task']),
      ).toEqual([
        { roundId: 'round-1', taskId: 'host-first' },
        { roundId: 'round-1', taskId: 'host-retry' },
        { roundId: 'round-2', taskId: 'host-other' },
      ])
    })
  })

  describe('id lists', () => {
    test('more than 500 ids are refused, an empty list reads nothing, a repeated id is read once', async () => {
      const db = harness.db
      await seedBase(db)
      await seedTask(db, 'batch', { digitalEmployeeRoundId: 'batch-round', runningMs: 1_000 })
      await seedRun(db, {
        id: 'batch-run',
        taskId: 'batch',
        nodeId: 'plan',
        rerunCause: 'initial',
        status: 'failed',
        failureCode: 'runtime-stream-interrupted',
      })
      await seedRun(db, {
        id: 'batch-loop',
        taskId: 'batch',
        nodeId: 'loop',
        rerunCause: 'wrapper-init',
        status: 'done',
      })
      await seedTask(db, 'batch-kid', { parentTaskId: 'batch' })

      const facts = factsOf(db)
      const tooMany = Array.from({ length: PROCESS_FACT_ID_BATCH + 1 }, (_, index) => `id-${index}`)
      const atLimit = tooMany.slice(1)
      const readers: Record<string, (ids: readonly string[]) => Promise<readonly unknown[]>> = {
        taskSummaries: (ids) => facts.taskSummaries(ids),
        descendants: (ids) => facts.descendants(ids),
        executions: (ids) => facts.executions(ids),
        wrappers: (ids) => facts.wrappers(ids),
        nodeRuns: (ids) => facts.nodeRuns(ids),
        'nodeRuns nodeIds': (ids) => facts.nodeRuns(['batch'], { nodeIds: ids }),
        reactionHostTasks: (ids) => facts.reactionHostTasks(ids),
      }
      for (const [name, read] of Object.entries(readers)) {
        await expect(read(tooMany), name).rejects.toBeInstanceOf(RangeError)
        // Exactly at the limit is a legal batch.
        expect(await read(atLimit), name).toEqual([])
        expect(await read([]), name).toEqual([])
      }

      const twice = (id: string) => [id, id, id]
      expect(await facts.taskSummaries(twice('batch'))).toHaveLength(1)
      expect(await facts.descendants(twice('batch'))).toHaveLength(1)
      expect(await facts.executions(twice('batch'))).toHaveLength(1)
      expect(await facts.wrappers(twice('batch'))).toHaveLength(1)
      expect(await facts.nodeRuns(twice('batch'))).toHaveLength(1)
      expect(await facts.nodeRuns(['batch'], { nodeIds: twice('plan') })).toHaveLength(1)
      expect(await facts.reactionHostTasks(twice('batch-round'))).toHaveLength(1)
    })
  })
})

// The fixtures cannot write a run without a role (every fixture row gets one),
// yet a history row whose identity the upgrade could not prove has none and
// must stay in the execution facts: `role <> 'container'` alone would drop it,
// because a comparison with NULL is not true. This keeps the explicit NULL arm in place.
test('RFC-616 process task facts: a run without a role is read as a leaf run', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../src/modules/task-execution/infrastructure/processTaskFacts.ts'),
    'utf8',
  )
  expect(source).toContain("or(isNull(nodeRuns.role), ne(nodeRuns.role, 'container'))")
})
