import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  loadTaskProjection,
  taskListSummariesProjection,
  taskListItemsProjection,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { loadAgentPersistenceRows } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { createDatabaseTaskLifecycleWsProjection } from '@/modules/task-execution/infrastructure/taskLifecycleWsProjection'
import { projectTaskSubject } from '@/modules/task-execution/domain/taskSubject'
import {
  TASK_DEFINITION_HOSTS,
  TaskSchema,
  TaskSummarySchema,
  TaskListItemSchema,
} from '@agent-workflow/shared'

const definition = { $schema_version: 6, inputs: [], nodes: [], edges: [] }
describeEachProvider('RFC-395 Q-1 design section 8 projection fields', (h) => {
  test('detail, summary and list retain workflow facts and the zero-mount repository projection', async () => {
    await workflowFixture(h.db, {
      id: 'q1-w',
      name: 'Live workflow name',
      definition: JSON.stringify(definition),
      version: 9,
    })
    await taskFixture(h.db, {
      id: 'q1-t',
      name: 'Original task',
      workflowId: 'q1-w',
      workflowSnapshot: JSON.stringify(definition),
      workflowVersion: 4,
      repoPath: '',
      worktreePath: '',
      baseBranch: '',
      branch: 'original-branch',
      inputs: '{"x":"original"}',
      status: 'done',
      startedAt: 7,
      spaceKind: 'scratch',
      repos: [],
    })
    const task = TaskSchema.parse(await loadTaskProjection(h.db, 'q1-t'))
    expect(task).toMatchObject({
      id: 'q1-t',
      workflowId: 'q1-w',
      workflowName: 'Live workflow name',
      workflowVersion: 4,
      workflowSnapshot: definition,
      inputs: { x: 'original' },
      worktreePath: '',
      repoCount: 1,
      branch: 'original-branch',
    })
    expect(task.repos[0]).toMatchObject({ mountPath: '', worktreeDirName: '' })
    const summaries = await taskListSummariesProjection(h.db, {})
    const summary = TaskSummarySchema.parse(summaries.find((r) => r.id === 'q1-t'))
    expect(summary).toMatchObject({
      workflowId: task.workflowId,
      workflowName: task.workflowName,
      status: task.status,
      repoCount: 1,
    })
    const items = await taskListItemsProjection(
      { db: h.db, owners: { loadOwnerIdentities: async () => new Map() } },
      {},
    )
    expect(TaskListItemSchema.parse(items.find((r) => r.id === 'q1-t'))).toMatchObject({
      id: task.id,
      workflowName: task.workflowName,
    })
    await h.db.delete(tablesOf(h.db).workflows).where(eq(tablesOf(h.db).workflows.id, 'q1-w'))
    expect((await loadTaskProjection(h.db, 'q1-t'))?.workflowName).toBeNull()
    const { taskDefinitions } = tablesOf(h.db)
    await h.db
      .update(taskDefinitions)
      .set({ subjectKind: 'unknown' })
      .where(eq(taskDefinitions.taskId, 'q1-t'))
    expect(
      await createDatabaseTaskLifecycleWsProjection(h.db).findCreatedTask('q1-t'),
    ).toMatchObject({
      id: 'q1-t',
      workflowId: 'q1-w',
      workflowName: null,
      repoCount: 1,
    })
  })
  test('agent relation lists replay ordinal order, duplicate references, project names and dangling ids', async () => {
    const { agents, agentSkillRefs, agentMcpRefs, agentPluginRefs, agentDependencies } = tablesOf(
      h.db,
    )
    await h.db.insert(agents).values({ id: 'q1-a', name: 'Q1', createdAt: 1, updatedAt: 1 })
    await h.db.insert(agentSkillRefs).values([
      {
        agentId: 'q1-a',
        referenceKey: 'managed',
        occurrence: 1,
        ordinal: 2,
        kind: 'managed',
        skillId: 'missing',
        projectName: null,
      },
      {
        agentId: 'q1-a',
        referenceKey: 'project',
        occurrence: 0,
        ordinal: 0,
        kind: 'project',
        skillId: null,
        projectName: 'project-only',
      },
      {
        agentId: 'q1-a',
        referenceKey: 'managed',
        occurrence: 0,
        ordinal: 1,
        kind: 'managed',
        skillId: 'missing',
        projectName: null,
      },
    ])
    for (const [ordinal, id] of ['z', 'a', 'z'].entries()) {
      const occurrence = ordinal === 2 ? 1 : 0
      await h.db.insert(agentMcpRefs).values({ agentId: 'q1-a', mcpId: id, occurrence, ordinal })
      await h.db
        .insert(agentPluginRefs)
        .values({ agentId: 'q1-a', pluginId: id, occurrence, ordinal })
      await h.db
        .insert(agentDependencies)
        .values({ agentId: 'q1-a', dependencyAgentId: id, occurrence, ordinal })
    }
    const [agent] = await loadAgentPersistenceRows(h.db, (tx) =>
      tx.select().from(agents).where(eq(agents.id, 'q1-a')),
    )
    expect(agent).toMatchObject({
      skills: [
        { kind: 'project', name: 'project-only' },
        { kind: 'managed', skillId: 'missing' },
        { kind: 'managed', skillId: 'missing' },
      ],
      mcp: ['z', 'a', 'z'],
      plugins: ['z', 'a', 'z'],
      dependsOn: ['z', 'a', 'z'],
    })
  })
})
test('all non-workflow hosts retain their epoch-1 public identities', () => {
  for (const kind of ['agent', 'workgroup', 'code-round', 'digital-employee'] as const) {
    const subject =
      kind === 'agent'
        ? { kind, sourceId: 'a', sourceName: 'Agent' }
        : kind === 'digital-employee'
          ? { kind, sourceId: null }
          : { kind, sourceId: 'source' }
    expect(projectTaskSubject(subject, 'ignored')).toEqual({
      workflowId: TASK_DEFINITION_HOSTS[kind].id,
      workflowName: TASK_DEFINITION_HOSTS[kind].name,
    })
  }
})
