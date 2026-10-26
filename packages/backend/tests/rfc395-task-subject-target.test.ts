import type { TaskCreationInput } from '@/modules/task-execution/application/ports/taskCreation'
import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq, sql, getTableColumns, getTableName, type Table } from 'drizzle-orm'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { describeEachProvider, resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'

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

import { splitTaskCreation } from '@/modules/task-execution/domain/taskCreation'
import {
  definitionAnchorId,
  taskSubjectFromDefinition,
  type TaskSubject,
} from '@/modules/task-execution/domain/taskSubject'
import { createTaskArchiveTaskSectionReader } from '@/modules/task-execution/infrastructure/taskArchiveContentCoordinator'
import { DatabaseTaskSubjectQueries } from '@/modules/task-execution/infrastructure/taskSubjectQueries'

const subjects: readonly TaskSubject[] = [
  { kind: 'workflow', sourceId: 'workflow' },
  { kind: 'agent', sourceId: 'agent', sourceName: 'Agent' },
  { kind: 'workgroup', sourceId: 'group' },
  { kind: 'digital-employee', sourceId: null },
  { kind: 'code-round', sourceId: 'round' },
]
describeEachProvider('RFC-395 T five target subjects and task cascade', (harness) => {
  for (const subject of subjects)
    test(`${subject.kind} creates/restores without a host workflow row`, async () => {
      const base = taskInput(subject.kind)
      const input: TaskCreationInput = {
        ...base,
        subject,
        definition: {
          ...base.definition,
          definitionOrigin: subject.kind === 'workflow' ? 'authored' : 'platform',
        },
      }
      await harness.session.transaction((tx) => createTaskCreationParticipantInTx(tx).create(input))
      const { taskDefinitions } = tablesOf(harness.db)
      const [definition] = await harness.db
        .select()
        .from(taskDefinitions)
        .where(eq(taskDefinitions.taskId, subject.kind))
      expect(taskSubjectFromDefinition(definition!)).toEqual(subject)
      const projected = (
        await new DatabaseTaskSubjectQueries(harness.db).taskDefinitionProjection([subject.kind])
      ).get(subject.kind)
      expect(projected?.workflowId).toBe(definitionAnchorId(subject))
      expect(projected?.origin).toBe(input.definition.definitionOrigin)
      const section = await harness.session.snapshotRead((tx) =>
        createTaskArchiveTaskSectionReader().load(tx, [subject.kind]),
      )
      expect(section.rows.task_definitions).toEqual([definition!])
      expect(section.rows.task_launch_contexts[0]?.executionLineageId).toBe(subject.kind)
    })
  test('deleting a root cascades through child tasks and every new task-owned table', async () => {
    const base = taskInput('root')
    const root: TaskCreationInput = {
      ...base,
      subject: { kind: 'workgroup', sourceId: 'group' },
      definition: {
        ...base.definition,
        definitionOrigin: 'platform',
        workgroupConfigJson:
          '{"workgroupId":"group","workgroupName":"frozen","mode":"sequential","goal":"goal","leaderMemberId":"leader"}',
      },
      repos: [
        {
          ordinal: 0,
          mountPath: 'svc',
          repoPath: '/cache',
          repoUrl: null,
          cachedRepoId: null,
          baseBranch: 'main',
          branch: 'topic',
          baseCommit: 'sha',
          workingBranch: null,
          worktreePath: '/work/svc',
          subdir: '',
          readonly: false,
          readonlyDirtyCount: null,
          hasSubmodules: false,
          submoduleInitOk: true,
          submoduleInitError: null,
        },
      ],
      nodePaths: ['svc'],
    }
    const child = {
      ...taskInput('child'),
      core: { ...taskInput('child').core, parentTaskId: 'root' },
    }
    await harness.session.transaction(async (tx) => {
      await createTaskCreationParticipantInTx(tx).create(root)
      await createTaskCreationParticipantInTx(tx).create(child)
    })
    const tables = tablesOf(harness.db)
    expect(await harness.db.select().from(tables.taskRepositoryMounts)).toHaveLength(1)
    expect(await harness.db.select().from(tables.workgroupTaskState)).toHaveLength(1)
    await harness.session.transaction(async (tx) => {
      await tx.delete(tables.tasks).where(eq(tables.tasks.id, 'root'))
    })
    for (const table of [
      tables.tasks,
      tables.taskDefinitions,
      tables.taskLaunchContexts,
      tables.taskWorkspaces,
      tables.taskRepositoryMounts,
      tables.taskExecutionGenerations,
      tables.taskSpaceNodes,
      tables.workgroupTaskState,
    ])
      expect(
        await rawRows<{ count: number }>(harness.db, sql`select count(*) as count from ${table}`, {
          count: 'int',
        }),
      ).toEqual([{ count: 0 }])
  })
})
test('the pure task split does not place definition/source/workspace facts on the root', () => {
  const split = splitTaskCreation(taskInput('split'))
  expect(split.task).not.toHaveProperty('workflowId')
  expect(split.task).not.toHaveProperty('repoCount')
  expect(split.task).not.toHaveProperty('worktreePath')
  expect(split.task.workspaceRootRef).toBeNull()
  expect(split.definition.sourceRevision).toBe(4)
  expect(split.launchContext.launchOrigin).toBe('api')
})

// W1 F3: replay converter output into a real target and exercise list/detail/route projections.
import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'

import { conversion as taskConversion } from '@/modules/task-execution/infrastructure/migration/task'
import { TASK_LINEAGE } from '@/modules/task-execution/infrastructure/migration/task/lineage'
import { initialTaskExecutionGeneration } from '@/modules/task-execution/application/ports/taskExecutionGenerations'
import { createTaskDetailQueries } from '@/modules/task-execution/infrastructure/taskDetailQueries'
import {
  loadTaskProjection,
  taskListSummariesProjection,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { createTaskListPage } from '@/modules/task-execution/infrastructure/taskListPage/page'
import { repositoryUrlFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { convertTaskFixtures, taskRow, writeTaskFixture } from './helpers/rfc395V2/taskFixtures'
import { createTestDb } from './helpers/testDatabase'

describeV2Providers('RFC-395 W1 unknown historical task stays readable', (h) => {
  for (const [anchor, expectedBlock] of [
    [TASK_DEFINITION_HOSTS.agent.id, 'v2-task-subject-mismatch'],
    ['', 'v2-task-definition-incomplete'],
  ] as const)
    for (const status of ['done', 'failed', 'canceled', 'running'] as const)
      test(`${anchor || 'missing-anchor'} ${status}: unknown subject and lineage retain headers, evidence and original anchor`, async () => {
        await h.install()
        const id = `unknown-${anchor || 'missing-anchor'}-${status}`
        await writeTaskFixture(
          h,
          taskRow(id, {
            status,
            workflow_id: anchor,
            source_agent_name: '',
            worktree_path: '',
            repo_path: '',
            base_commit: null,
          }),
        )
        const result = await convertTaskFixtures(h, {
          contribution: {
            ...taskConversion,
            lookups: taskConversion.lookups!.map((lookup) =>
              lookup.key.id === TASK_LINEAGE.id
                ? fixtureLookup(TASK_LINEAGE, [
                    [
                      id,
                      {
                        executionLineageId: id,
                        lineageSlotPathJson: '[]',
                        launchOrigin: 'manual',
                        parentLaunchOrigin: null,
                        derived: false,
                        missingFields: ['lineage_slot_path_json'],
                      },
                    ],
                  ])
                : lookup,
            ),
          },
          extra: [{ rules: [], validators: [], lookups: [fixtureLookup(repositoryUrlFacts, [])] }],
        })
        if (status === 'running') {
          expect(result.summary.blocks.some((block) => block.code === expectedBlock)).toBe(true)
          return
        }
        expect(result.summary.blocks).toEqual([])
        expect(result.sink.rows('task_definitions')).toMatchObject([
          { task_id: id, subject_kind: 'unknown', source_id: anchor },
        ])
        expect(result.sink.rows('task_launch_contexts')).toMatchObject([
          { task_id: id, execution_lineage_id: null, lineage_slot_path_json: null },
        ])
        expect(result.sink.rows('execution_legacy_evidence')).toMatchObject([
          { task_id: id, provenance_quality: 'unknown' },
        ])
        const target = await createTestDb(
          h.sourceHarness.provider === 'sqlite'
            ? { provider: 'sqlite' }
            : { provider: 'postgresql', urlEnv: resolvePostgresqlTestUrlEnv(process.env)! },
        )
        try {
          const tables = tablesOf(target.db)
          await target.session.transaction(async (tx) => {
            const order: readonly Table[] = [
              tables.tasks,
              tables.taskDefinitions,
              tables.taskLaunchContexts,
              tables.taskWorkspaces,
              tables.taskRepositoryMounts,
              tables.taskSpaceNodes,
            ]
            for (const table of order)
              for (const row of result.sink.rows(getTableName(table))) {
                const values = Object.fromEntries(
                  Object.entries(getTableColumns(table)).map(([key, column]) => [
                    key,
                    row[column.name],
                  ]),
                )
                await tx.insert(table).values(values)
              }
            await insertOne(
              tx,
              tables.taskExecutionGenerations,
              initialTaskExecutionGeneration(id, 1001),
            )
          })
          const detail = await createTaskDetailQueries(target.db).read(id)
          expect(detail?.task).toMatchObject({
            id,
            status,
            workflowId: anchor,
            workflowName: null,
          })
          expect(await loadTaskProjection(target.db, id)).toMatchObject({
            id,
            workflowId: anchor,
            workflowName: null,
          })
          expect(await taskListSummariesProjection(target.db, {})).toMatchObject([
            { id, workflowId: anchor, workflowName: null },
          ])
          const page = createTaskListPage({
            db: target.db,
            owners: {
              async loadOwnerIdentities() {
                return new Map()
              },
            },
            async failureCodes() {
              return new Map()
            },
          })
          for (const options of [{}, { catalogVisibility: 'public' as const }]) {
            const response = await page.list(
              { userId: 'reader', canReadAllTasks: true },
              { view: 'all' },
              options,
            )
            expect(response.items).toMatchObject([{ id, workflowId: anchor, workflowName: null }])
          }
        } finally {
          await target.close()
        }
      }, 180_000)
})
