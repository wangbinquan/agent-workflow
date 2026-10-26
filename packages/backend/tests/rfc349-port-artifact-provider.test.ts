import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider } from './helpers/eachProvider'
import {
  workflowFixture,
  taskFixture,
  taskRepoFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
} from './helpers/model'

describeEachProvider('RFC-349 port-artifact provider cutover', (h) => {
  const parent = async (id: string, owner: string, snapshot = '{}') => {
    await insertOne(h.db, tablesOf(h.db).users, {
      id: owner,
      username: owner,
      displayName: owner,
      role: 'user',
      status: 'active',
      forcePasswordChange: false,
      createdAt: 1,
      updatedAt: 1,
    })
    await workflowFixture(h.db, { id: 'workflow', name: 'workflow', definition: '{}' })
    await taskFixture(h.db, {
      id,
      ownerUserId: owner,
      workflowId: 'workflow',
      workflowSnapshot: snapshot,
      repoPath: '/repo',
      worktreePath: '/worktrees/' + id,
      baseBranch: 'main',
      branch: 'main',
      status: 'running',
      inputs: {},
      startedAt: 1,
    })
  }
  const fixture = () => {
    const recording = h.recordStatements()
    return { reads: createTaskExecutionReadModels(h.db), executions: recording.statements }
  }
  test('Selected provider freezes visibility, run ownership, output and repo prefix in one closed result', async () => {
    await parent('task-1', 'owner-1')
    await nodeRunFixture(h.db, { id: 'run-1', taskId: 'task-1', nodeId: 'node', status: 'done' })
    await nodeRunOutputFixture(h.db, {
      nodeRunId: 'run-1',
      portName: 'result',
      content: 'docs/result.md',
      kind: 'path<md>',
      archiveJson: '{"v":1,"items":[]}',
    })
    await taskRepoFixture(h.db, {
      taskId: 'task-1',
      repoIndex: 0,
      mountPath: 'api',
      repoPath: '/repo/api',
      branch: 'main',
      worktreePath: '/worktrees/task-1/api',
    })
    const fake = fixture()

    await expect(
      fake.reads.portArtifacts.find({
        actor: { userId: 'owner-1', canReadAllTasks: false },
        taskId: 'task-1',
        nodeRunId: 'run-1',
        portName: 'result',
      }),
    ).resolves.toEqual({
      status: 'found',
      artifact: {
        taskId: 'task-1',
        worktreePath: '/worktrees/task-1',
        archiveJson: '{"v":1,"items":[]}',
        content: 'docs/result.md',
        kind: 'path<md>',
        legacyRepoDirName: 'api',
      },
    })
    expect(fake.executions).toHaveLength(4)
    expect(fake.executions[3]?.sql).toContain('"task_repository_mounts"."ordinal"')
  })

  test('Selected provider collapses missing membership into task-not-found before reading the run', async () => {
    await parent('task-2', 'owner-2')
    const fake = fixture()

    await expect(
      fake.reads.portArtifacts.find({
        actor: { userId: 'stranger', canReadAllTasks: false },
        taskId: 'task-2',
        nodeRunId: 'run-2',
        portName: 'result',
      }),
    ).resolves.toEqual({ status: 'task-not-found' })
    expect(fake.executions).toHaveLength(2)
  })

  test('Selected provider reads prefix and tail per sibling and returns one ordered session source', async () => {
    const snapshot = JSON.stringify({ nodes: [{ id: 'agent-1', kind: 'agent-single' }] })
    await parent('task-3', 'owner-3', snapshot)
    for (const [id, promptText, startedAt, retryIndex] of [
      ['run-a', 'first', 10, 0],
      ['run-b', 'second', 20, 1],
    ] as const)
      await nodeRunFixture(h.db, {
        id,
        taskId: 'task-3',
        nodeId: 'agent-1',
        status: 'done',
        promptText,
        startedAt,
        retryIndex,
        opencodeSessionId: 'session-3',
      })
    for (const [id, nodeRunId, ts, payload] of [
      [1, 'run-a', 10, 'a-prefix'],
      [2, 'run-a', 20, 'discard-middle'],
      [3, 'run-a', 30, 'a-tail'],
      [4, 'run-b', 40, 'b-prefix'],
      [5, 'run-b', 50, 'b-tail'],
    ] as const)
      await insertOne(h.db, tablesOf(h.db).nodeRunEvents, {
        id,
        nodeRunId,
        ts,
        kind: 'text',
        sessionId: 'session-3',
        parentSessionId: null,
        payload,
      })
    const fake = fixture()

    await expect(
      fake.reads.sessions.find({
        taskId: 'task-3',
        nodeRunId: 'run-a',
        rootPrefixCap: 1,
        tailCap: 1,
      }),
    ).resolves.toEqual({
      status: 'found',
      workflowSnapshot: snapshot,
      run: {
        id: 'run-a',
        taskId: 'task-3',
        nodeId: 'agent-1',
        promptText: 'first',
        promptPath: null,
        startedAt: 10,
        opencodeSessionId: 'session-3',
        retryIndex: 0,
      },
      siblings: [
        {
          id: 'run-a',
          taskId: 'task-3',
          nodeId: 'agent-1',
          promptText: 'first',
          promptPath: null,
          startedAt: 10,
          opencodeSessionId: 'session-3',
          retryIndex: 0,
        },
        {
          id: 'run-b',
          taskId: 'task-3',
          nodeId: 'agent-1',
          promptText: 'second',
          promptPath: null,
          startedAt: 20,
          opencodeSessionId: 'session-3',
          retryIndex: 1,
        },
      ],
      events: [
        {
          id: 1,
          ts: 10,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'a-prefix',
        },
        {
          id: 3,
          ts: 30,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'a-tail',
        },
        {
          id: 4,
          ts: 40,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'b-prefix',
        },
        {
          id: 5,
          ts: 50,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'b-tail',
        },
      ],
    })
    const eventQueries = fake.executions.filter(
      (query) => query.sql.includes('from') && query.sql.includes('"node_run_events"'),
    )
    expect(eventQueries).toHaveLength(4)
    for (const query of eventQueries) expect(query.sql).toContain('"node_run_events"')
  })

  test('transport and filesystem presenter do not import database mechanisms', () => {
    for (const relativePath of [
      'routes/port-artifacts.ts',
      'platform/content/local/rootFileQueries.ts',
      'services/sessionView.ts',
    ]) {
      const source = readFileSync(resolve(import.meta.dir, '..', 'src', relativePath), 'utf8')
      expect(source).not.toMatch(/@\/db|bun:sqlite|drizzle-orm/)
    }
    const route = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'port-artifacts.ts'),
      'utf8',
    )
    expect(route).toContain('taskExecutionReadModels.portArtifacts.find')
  })
})
