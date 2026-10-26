import { nonViewCondition } from '@/modules/task-execution/infrastructure/taskListPage/filters'
import type { TaskCreationInput } from '@/modules/task-execution/application/ports/taskCreation'
import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { describeEachProvider } from './helpers/eachProvider'

const taskInput = (id: string): TaskCreationInput => ({
  subject: { kind: 'workflow', sourceId: 'workflow' },
  core: {
    id,
    name: id,
    status: 'failed',
    startedAt: 10,
    ownerUserId: null,
    catalogVisibility: 'public',
    branchStartedAt: 10,
  },
  definition: {
    definitionOrigin: 'authored',
    workflowSnapshot: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 4,
    inputs: '{}',
  },
  launch: { kind: 'root', launchOrigin: 'api' },
  launchContext: {},
  workspace: {
    repoPath: '',
    worktreePath: '',
    baseBranch: '',
    branch: `agent-workflow/${id}`,
    baseCommit: null,
    spaceKind: 'scratch',
  },
  repos: [],
  nodePaths: [],
})

import {
  decodeWorkspacePreparationReceipt,
  encodeWorkspacePreparationReceipt,
} from '@/modules/source-control/infrastructure/workspaceMaterializer'
import { baseCtes } from '@/modules/task-execution/infrastructure/taskListPage/query'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { sql, eq } from 'drizzle-orm'

describeEachProvider('RFC-395 T task facet target SQL', (harness) => {
  test('subject and launch facets read target definitions and contexts while preserving counts', async () => {
    for (const [id, subject, origin] of [
      ['one', { kind: 'workflow', sourceId: 'workflow' }, 'api'],
      ['two', { kind: 'agent', sourceId: 'agent', sourceName: 'Agent' }, 'event'],
    ] as const)
      await harness.session.transaction((tx) =>
        createTaskCreationParticipantInTx(tx).create({
          ...taskInput(id),
          subject,
          launch: { kind: 'root', launchOrigin: origin },
        }),
      )
    const rows = await rawRows<{ subject_kind: string; launch_origin: string }>(
      harness.db,
      sql`with recursive ${baseCtes(
        harness.db,
        sql`select id from tasks`,
        sql`1=1`,
        sql`1=1`,
      )} select subject_kind, launch_origin from base order by id`,
    )
    expect(rows).toEqual([
      { subject_kind: 'workflow', launch_origin: 'api' },
      { subject_kind: 'agent', launch_origin: 'event' },
    ])
    const predicate = nonViewCondition(
      harness.db,
      { userId: 'viewer', canReadAllTasks: true },
      { view: 'all', statuses: [], subject: 'agent', scope: 'all', origin: 'event' },
      'b',
    )
    const filtered = await rawRows<{ id: string }>(
      harness.db,
      sql`with recursive ${baseCtes(harness.db, sql`select id from tasks`, predicate, sql`1=1`)} select id from non_view_matches`,
    )
    expect(filtered).toEqual([{ id: 'two' }])
    const { taskDefinitions, taskLaunchContexts } = tablesOf(harness.db)
    expect(await harness.db.select().from(taskDefinitions)).toHaveLength(2)
    expect(await harness.db.select().from(taskLaunchContexts)).toHaveLength(2)
  })
})
test('workspace replay accepts v2 and rejects the old or malformed envelope', () => {
  expect(() => decodeWorkspacePreparationReceipt('task', '{"version":1}')).toThrow()
  expect(() => decodeWorkspacePreparationReceipt('task', '{"version":2,"space":{}}')).toThrow()
  expect(
    decodeWorkspacePreparationReceipt(
      'task',
      encodeWorkspacePreparationReceipt('{"version":1,"detail":"stopped"}'),
    ).version,
  ).toBe(2)
})

import { createTaskTriggerQueries } from '@/modules/task-execution/infrastructure/taskTriggerQueries'
import { listSourceTerminationTargets } from '@/modules/task-execution/infrastructure/sourceTerminationTargets'
import { findTaskAutomationReceipt } from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import { taskListSummariesProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { taskWorkgroupConfigSelection } from '@/modules/task-execution/infrastructure/taskWorkgroupConfig'

describeEachProvider('RFC-395 W1 indexed launch lookups and nullable config', (harness) => {
  test('keyed lookups predicate directly on launch context columns', async () => {
    for (const [id, revision] of [
      ['older', 1],
      ['current', 2],
      ['unrelated', 1],
    ] as const) {
      const base = taskInput(id)
      await harness.session.transaction((tx) =>
        createTaskCreationParticipantInTx(tx).create({
          ...base,
          launch: { kind: 'root', launchOrigin: 'scheduled' },
          launchContext: {
            scheduledTaskId: `schedule-${id}`,
            webhookFireId: `fire-${id}`,
            eventDeliveryId: `delivery-${id}`,
            sourceTerminationBinding: id === 'unrelated' ? 'other' : 'binding',
            sourceTerminationLaunchRev: revision,
          },
        }),
      )
    }
    const recording = harness.recordStatements()
    try {
      const trigger = createTaskTriggerQueries(harness.db)
      expect(await trigger.findByOrigin({ fireId: 'fire-older' })).toBe('older')
      expect(
        await trigger.findByOrigin({ fireId: 'ignored', eventDeliveryId: 'delivery-current' }),
      ).toBe('current')
      expect(await trigger.findByOrigin({ fireId: 'absent' })).toBeNull()
      expect(await findTaskAutomationReceipt(harness.db, 'delivery-older')).toBe('older')
      expect(await findTaskAutomationReceipt(harness.db, 'absent')).toBeNull()
      expect(
        await listSourceTerminationTargets(harness.db, {
          effectId: 'effect',
          binding: 'binding',
          streamRevision: 2,
          kind: 'fence-closed',
          deliveryId: 'delivery',
        }),
      ).toEqual([{ id: 'older' }])
      expect(
        (
          await taskListSummariesProjection(harness.db, { scheduledTaskId: 'schedule-current' })
        ).map((row) => row.id),
      ).toEqual(['current'])
      const reads = recording.selects().map((statement) => statement.sql)
      for (const column of [
        'webhook_fire_id',
        'event_delivery_id',
        'scheduled_task_id',
        'source_termination_binding',
      ]) {
        expect(reads.some((query) => query.includes(`"task_launch_contexts"."${column}" =`))).toBe(
          true,
        )
      }
      // PostgreSQL qualifies tables with the application schema.
      expect(
        reads.some((query) =>
          /in \(select "task_id" from (?:"agent_workflow"\.)?"task_launch_contexts"/i.test(query),
        ),
      ).toBe(true)
      expect(
        reads.some((query) =>
          /from (?:"agent_workflow"\.)?"task_launch_contexts" inner join (?:"agent_workflow"\.)?"tasks"/i.test(
            query,
          ),
        ),
      ).toBe(true)
    } finally {
      recording.stop()
    }
  })
  test('SQL selection keeps NULL absence and independently decodes Unicode launch and raw runtime text', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('no-config')),
    )
    const tables = tablesOf(harness.db)
    const read = async () =>
      (
        await harness.db
          .select({ config: taskWorkgroupConfigSelection(harness.db) })
          .from(tables.tasks)
          .where(eq(tables.tasks.id, 'no-config'))
      )[0]!.config
    expect(await read()).toBeNull()
    const launch = JSON.stringify({
      workgroupId: 'group',
      workgroupName: '中文:😀',
      goal: '目标:🚀',
    })
    await harness.db
      .update(tables.taskDefinitions)
      .set({ workgroupConfigJson: launch })
      .where(eq(tables.taskDefinitions.taskId, 'no-config'))
    expect(await read()).toMatchObject({
      launch: { workgroupName: '中文:😀', goal: '目标:🚀' },
      runtime: { revision: null },
    })
    const runtime = '  {"workgroupName":"edited", "extra":"🧪:值"}  '
    await harness.db
      .insert(tables.workgroupTaskState)
      .values({ taskId: 'no-config', runtimeConfigJson: runtime, updatedAt: 20 })
    expect(await read()).toMatchObject({
      launch: { workgroupName: '中文:😀', goal: '目标:🚀' },
      runtime: { raw: { extra: '🧪:值' }, revision: runtime },
    })
    await harness.db
      .update(tables.workgroupTaskState)
      .set({ runtimeConfigJson: 'invalid:😀' })
      .where(eq(tables.workgroupTaskState.taskId, 'no-config'))
    expect(await read()).toMatchObject({
      launch: { workgroupName: '中文:😀' },
      runtime: { raw: null, revision: 'invalid:😀' },
    })
  })
})
