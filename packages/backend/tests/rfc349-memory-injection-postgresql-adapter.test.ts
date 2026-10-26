import { expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import { DrizzleMemoryInjectionReadStore } from '@/modules/memory/infrastructure/memoryInjectionReadStore'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
} from '@/modules/memory/application/injection/injectMemory'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider } from './helpers/eachProvider'
import { workflowFixture, taskFixture, taskRepoFixture, nodeRunFixture } from './helpers/model'

const primaryAgent = { id: 'agent-1' } as Agent

describeEachProvider('RFC-349 runtime memory injection', (h) => {
  const parent = async () => {
    await workflowFixture(h.db, { id: 'workflow-1', name: 'workflow-1', definition: '{}' })
    await taskFixture(h.db, {
      id: 'task-1',
      workflowId: 'workflow-1',
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: '/worktree',
      baseBranch: 'main',
      branch: 'main',
      cachedRepoId: 'repo-legacy',
      repoGroupId: 'group-1',
      status: 'running',
      inputs: {},
      startedAt: 1,
    })
  }
  test('resolves every active scope and renders the same closed snapshot contract', async () => {
    await parent()
    await insertOne(h.db, tablesOf(h.db).cachedRepos, {
      id: 'repo-1',
      urlHash: 'repo-1',
      localPath: '/cache/repo-1',
      defaultBranch: 'main',
      lastFetchedAt: 1,
      createdAt: 1,
    })
    await taskRepoFixture(h.db, {
      taskId: 'task-1',
      repoIndex: 0,
      repoPath: '/repo',
      branch: 'main',
      cachedRepoId: 'repo-1',
      worktreePath: '/worktree',
    })
    for (const [id, scopeType, scopeId, title] of [
      ['m-agent', 'agent', 'agent-1', 'Agent rule'],
      ['m-workflow', 'workflow', 'workflow-1', 'Workflow rule'],
      ['m-repo', 'repo', 'repo-1', 'Repository rule'],
      ['m-group', 'repo_group', 'group-1', 'Group rule'],
      ['m-global', 'global', null, 'Global rule'],
    ] as const)
      await insertOne(h.db, tablesOf(h.db).memories, {
        id,
        scopeType,
        scopeId,
        title,
        bodyMd: `${title} body`,
        status: 'approved',
        createdAt: 10,
        version: 2,
        tags: '["provider"]',
        sourceKind: 'manual',
        approvedAt: 9,
      })
    const recording = h.recordStatements()
    const fake = {
      store: new DrizzleMemoryInjectionReadStore(h.db),
      executions: recording.statements,
    }

    const result = await injectMemoryForRun({
      store: fake.store,
      taskId: 'task-1',
      primaryAgent,
      dependents: [],
      envelopeNonce: 'N349',
    })

    expect(result.snapshot?.map((item) => item.id)).toEqual([
      'm-agent',
      'm-workflow',
      'm-repo',
      'm-group',
      'm-global',
    ])
    expect(result.block).toContain('<aw-input name="memory:m-global" id="N349">')
    expect(fake.executions.map((entry) => entry.sql).join('\n')).toContain('"memories"')
  })

  test('anchors retry snapshots through PostgreSQL without leaking query mechanics', async () => {
    const snapshot = JSON.stringify([
      {
        id: 'm1',
        version: 1,
        scopeType: 'global',
        scopeId: null,
        title: 'Rule',
        bodyMd: 'Body',
        tags: [],
        sourceKind: 'manual',
        approvedAt: 1,
      },
    ])
    await parent()
    await nodeRunFixture(h.db, {
      id: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      status: 'failed',
      injectedMemories: snapshot,
    })
    await nodeRunFixture(h.db, {
      id: 'run-2',
      taskId: 'task-1',
      nodeId: 'node-1',
      status: 'running',
      retryIndex: 1,
    })
    const fake = { store: new DrizzleMemoryInjectionReadStore(h.db) }

    await expect(
      loadInjectedSnapshotFromFirstAttempt(fake.store, {
        taskId: 'task-1',
        nodeId: 'node-1',
        iteration: 0,
        shardKey: null,
        reviewIteration: 0,
        runId: 'run-2',
      }),
    ).resolves.toMatchObject([{ id: 'm1', title: 'Rule' }])
  })
})
