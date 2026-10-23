// RFC-395 II-a A7：跨域读取保持投影、空值、排序和同事务可见性；双 provider 共用 A1 builders。
import { beforeEach, expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { TASK_DEFINITION_HOSTS, TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createTaskGateQueries,
  taskGateOpenCondition,
  taskGateVisibleCondition,
  createNodeOutputQueries,
  createTaskKnowledgeQueries,
  createTaskTriggerQueries,
  listNodeEventContents,
} from '@/modules/task-execution/public/queries'
import {
  createAgentExecutionQueries,
  createWorkflowExecutionQueries,
  workflowNameExpression,
} from '@/modules/resource-catalog/public/queries'
import {
  existingRepositoryIds,
  repositoryExistsExpression,
} from '@/modules/source-control/public/queries'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  workflowFixture,
  agentFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  patchTaskFixture,
  type TaskFixtureSpec,
} from './helpers/model'

const definition = ' { "nodes" : [], "edges": [], "inputs": [] } '

describeEachProvider('RFC-395 II-a A7 owner queries', (harness) => {
  async function task(id: string, extra: Partial<TaskFixtureSpec> = {}) {
    await taskFixture(harness.db, {
      id,
      workflowId: 'workflow',
      workflowSnapshot: definition,
      repoPath: '/repo',
      worktreePath: '/work',
      baseBranch: 'main',
      branch: id,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      ...extra,
    })
  }
  beforeEach(async () => {
    const { users } = tablesOf(harness.db)
    await harness.db
      .insert(users)
      .values({ id: 'owner', username: 'owner', displayName: 'Owner', createdAt: 1, updatedAt: 1 })
    await workflowFixture(harness.db, { id: 'workflow', name: 'Workflow', definition, version: 3 })
  })
  test('gate and dispatch projections retain nulls, frozen bytes and caller writes', async () => {
    await task('gate', {
      ownerUserId: 'owner',
      lifecycleEventRevision: 7,
      sourceTerminationFence: 'merged',
    })
    const queries = createTaskGateQueries(harness.db)
    expect(await queries.listContexts([])).toEqual([])
    expect(await queries.listDefinitionContexts([])).toEqual([])
    expect(await queries.listDispatchContexts(['missing'])).toEqual([])
    const gate = (await queries.listContexts(['gate', 'missing']))[0]!
    // RFC-311 L1-3：列表读取（收件箱轮询等）不得带出整份冻结定义。
    expect(gate).toEqual({
      id: 'gate',
      name: 'task-gate',
      status: 'running',
      ownerUserId: 'owner',
      lifecycleEventRevision: 7,
      sourceTerminationFence: 'merged',
      workflowId: 'workflow',
      worktreePath: '/work',
    })
    expect(await queries.listDefinitionContexts(['gate', 'missing'])).toEqual([
      { ...gate, workflowSnapshot: definition },
    ])
    expect(await queries.listDispatchContexts(['gate'])).toEqual([
      {
        ...gate,
        workflowSnapshot: definition,
        workgroupId: null,
        codeRoundId: null,
        sourceAgentName: null,
        workgroupConfig: null,
      },
    ])
    const rollback = new Error('rollback-gate')
    await expect(
      harness.session.transaction(async (tx) => {
        await patchTaskFixture(tx, { id: 'gate' }, { name: 'inside' })
        expect((await createTaskGateQueries(tx).listContexts(['gate']))[0]?.name).toBe('inside')
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect((await queries.listContexts(['gate']))[0]?.name).toBe('task-gate')
  })
  test('badge semijoins preserve every terminal status, missing tasks, owner and member cases', async () => {
    const { users, taskCollaborators } = tablesOf(harness.db)
    const ids = ['open', 'member', 'hidden', 'missing', ...TERMINAL_TASK_STATUSES]
    await harness.db
      .insert(users)
      .values(ids.map((id) => ({ id, username: id, displayName: id, createdAt: 1, updatedAt: 1 })))
    await task('open', { ownerUserId: 'owner' })
    await task('member')
    await task('hidden')
    for (const status of TERMINAL_TASK_STATUSES)
      await task(status, { status, ownerUserId: 'owner' })
    await harness.db.insert(taskCollaborators).values({
      taskId: 'member',
      userId: 'owner',
      role: 'collaborator',
      addedBy: 'owner',
      addedAt: 1,
    })
    const select = async (includeMissing: boolean) =>
      (
        await harness.db
          .select({ id: users.id })
          .from(users)
          // 迁移会种入 `__system__` 用户；只看本用例造出的身份。
          .where(
            and(
              inArray(users.id, [...ids, 'owner']),
              taskGateOpenCondition(harness.db, users.id, includeMissing),
            ),
          )
      )
        .map((row) => row.id)
        .sort()
    expect(await select(false)).toEqual(['hidden', 'member', 'open'])
    expect(await select(true)).toEqual(['hidden', 'member', 'missing', 'open', 'owner'])
    const visible = async (canReadAllTasks: boolean) =>
      (
        await harness.db
          .select({ id: users.id })
          .from(users)
          .where(
            taskGateVisibleCondition(harness.db, users.id, { userId: 'owner', canReadAllTasks }),
          )
      )
        .map((row) => row.id)
        .sort()
    expect(await visible(false)).toEqual(['open', 'member', ...TERMINAL_TASK_STATUSES].sort())
    expect(await visible(true)).toEqual(ids.filter((id) => id !== 'missing').sort())
  })
  test('output readers keep inactive presence, active-only filtering and deterministic content ordering', async () => {
    await task('outputs')
    await nodeRunFixture(harness.db, [
      { id: 'a', taskId: 'outputs', nodeId: 'a', status: 'done' },
      { id: 'b', taskId: 'outputs', nodeId: 'b', status: 'done' },
    ])
    await nodeRunOutputFixture(harness.db, [
      { nodeRunId: 'a', portName: 'z', content: 'old', active: false },
      {
        nodeRunId: 'a',
        portName: 'a',
        content: 'live',
        kind: 'text',
        archiveJson: ' { "bytes": 1 } ',
      },
      { nodeRunId: 'b', portName: 'b', content: 'second' },
    ])
    const query = createNodeOutputQueries(harness.db)
    expect(await query.readPort('a', 'z')).toMatchObject({ content: 'old' })
    expect(await query.readPort('a', 'z', true)).toBeNull()
    expect(await query.readPort('missing', 'out')).toBeNull()
    expect([...(await query.listPorts('a'))].sort()).toEqual(['a', 'z'])
    expect(await query.listPorts('missing')).toEqual([])
    expect(await query.runsWithOutput(['a', 'b', 'missing'])).toEqual(new Set(['a', 'b']))
    expect(await query.runsWithOutput([])).toEqual(new Set())
    expect(await query.listActiveContents([])).toEqual([])
    expect(await query.listActiveContents(['b', 'a'])).toEqual([
      {
        nodeRunId: 'a',
        portName: 'a',
        content: 'live',
        kind: 'text',
        archiveJson: ' { "bytes": 1 } ',
      },
      { nodeRunId: 'b', portName: 'b', content: 'second', kind: null, archiveJson: null },
    ])
  })
  test('catalog projections preserve canonical definition bytes, host filtering and named candidate order', async () => {
    const host = TASK_DEFINITION_HOSTS.agent.id
    await workflowFixture(harness.db, [
      { id: 'z', name: 'same', definition: '{broken', version: 9 },
      { id: 'a', name: 'same', definition, builtin: true },
      { id: host, name: 'same', definition },
    ])
    const queries = createWorkflowExecutionQueries(harness.db)
    expect(await queries.summaries([])).toEqual([])
    expect(await queries.documents([])).toEqual([])
    expect(await queries.namedDocuments([])).toEqual([])
    expect(await queries.summaries(['workflow'])).toEqual([
      {
        id: 'workflow',
        name: 'Workflow',
        version: 3,
        builtin: false,
        ownerUserId: null,
        visibility: 'public',
      },
    ])
    expect((await queries.documents(['z']))[0]?.definition).toBe('{broken')
    expect(await queries.documents([host], true)).toEqual([])
    expect(await queries.documents([host])).toHaveLength(1)
    expect((await queries.namedDocuments(['same'])).map((row) => row.id)).toEqual(['a', 'z'])
    const { users } = tablesOf(harness.db)
    const name = async (id: string) =>
      (
        await harness.db
          .select({ name: workflowNameExpression(harness.db, sql`${id}`) })
          .from(users)
          .where(eq(users.id, 'owner'))
      )[0]?.name
    expect(await name('workflow')).toBe('Workflow')
    expect(await name(host)).toBeNull()
    expect(await name('missing')).toBeNull()
    await agentFixture(harness.db, [
      {
        id: 'agent',
        name: 'Agent',
        inputs: '["text", {"name":"context"}, 3, null]',
        outputs: '[{"name":"result"}]',
      },
      { id: 'bad', name: 'Bad', inputs: '{broken', outputs: '{}' },
    ])
    const agents = createAgentExecutionQueries(harness.db)
    expect(await agents.read('missing')).toBeNull()
    expect([...(await agents.existingIds(['bad', 'agent', 'missing']))].sort()).toEqual([
      'agent',
      'bad',
    ])
    expect(await agents.existingIds([])).toEqual([])
    expect(await agents.portNames([])).toEqual(new Map())
    expect(await agents.portNames(['agent', 'bad'])).toEqual(
      new Map([
        ['agent', { inputs: ['text', 'context'], outputs: ['result'] }],
        ['bad', { inputs: [], outputs: [] }],
      ]),
    )
    await agentFixture(harness.db, { id: 'readable', name: 'Readable', bodyMd: 'body' })
    expect(await agents.read('readable')).toMatchObject({
      id: 'readable',
      name: 'Readable',
      bodyMd: 'body',
    })
  })
  test('knowledge and repository queries retain subject, mount and missing-repository semantics', async () => {
    const { cachedRepos, users } = tablesOf(harness.db)
    await harness.db.insert(cachedRepos).values({
      id: 'repo',
      urlHash: 'repo-hash',
      localPath: '/repo',
      lastFetchedAt: 1,
      createdAt: 1,
    })
    await task('knowledge', {
      cachedRepoId: 'repo',
      repos: [
        {
          repoIndex: 0,
          cachedRepoId: 'repo',
          repoPath: '/repo',
          branch: 'main',
          worktreePath: '/work',
          mountPath: '',
        },
      ],
    })
    const query = createTaskKnowledgeQueries(harness.db)
    expect(await query.injectionContext('knowledge')).toEqual({
      workflowId: 'workflow',
      cachedRepoId: 'repo',
      repoGroupId: null,
    })
    expect(await query.injectionContext('missing')).toBeNull()
    expect(await query.repositoryIds('knowledge')).toEqual(['repo'])
    expect(await query.repositoryIds('missing')).toEqual([])
    expect(await query.distillationScope('knowledge')).toEqual({
      workflowSnapshot: definition,
      workgroupConfig: null,
      workflowId: 'workflow',
      cachedRepoId: 'repo',
      cachedRepoExists: true,
      launchOrigin: 'manual',
      catalogVisibility: 'public',
      spaceKind: 'remote',
    })
    expect(await query.distillationScope('missing')).toBeNull()
    expect(await query.distillationSources([])).toEqual([])
    expect(await query.distillationSources(['knowledge'])).toEqual([
      {
        id: 'knowledge',
        name: 'task-knowledge',
        status: 'running',
        startedAt: 1,
        finishedAt: null,
        runningMs: 0,
        errorSummary: null,
        errorMessage: null,
        failedNodeId: null,
        inputs: '{}',
        workflowSnapshot: definition,
      },
    ])
    expect(await existingRepositoryIds(harness.db, ['repo', 'missing'])).toEqual(['repo'])
    expect(await existingRepositoryIds(harness.db, [])).toEqual([])
    const exists = async (id: string) =>
      (
        await harness.db
          .select({ exists: repositoryExistsExpression(harness.db, sql`${id}`) })
          .from(users)
          .where(eq(users.id, 'owner'))
      )[0]?.exists
    expect(await exists('repo')).toBe(true)
    expect(await exists('missing')).toBe(false)
  })
  test('trigger queries retain event-origin precedence and workspace status facts', async () => {
    await task('webhook', {
      webhookFireId: 'fire',
      webhookTriggerId: 'trigger',
      spaceKind: 'remote',
      workspacePrunedAt: 8,
    })
    await task('event', {
      eventDeliveryId: 'delivery',
      eventSubscriptionId: 'subscription',
      status: 'done',
    })
    const query = createTaskTriggerQueries(harness.db)
    expect(await query.findByOrigin({ fireId: 'fire' })).toBe('webhook')
    expect(await query.findByOrigin({ fireId: 'fire', eventDeliveryId: 'delivery' })).toBe('event')
    expect(await query.findByOrigin({ fireId: 'fire', eventDeliveryId: 'missing' })).toBeNull()
    expect(await query.workspaceAttribution('event')).toEqual({
      webhookTriggerId: null,
      eventSubscriptionId: 'subscription',
    })
    expect(await query.workspaceAttribution('missing')).toBeNull()
    expect(await query.status('event')).toEqual({ id: 'event', status: 'done' })
    expect(await query.status('missing')).toBeNull()
    expect(await query.terminalWorkspaces([])).toEqual([])
    expect(await query.terminalWorkspaces(['webhook', 'missing'])).toEqual([
      {
        id: 'webhook',
        ownerUserId: null,
        status: 'running',
        spaceKind: 'remote',
        workspacePruningAt: null,
        workspacePrunedAt: 8,
      },
    ])
  })
  test('event contents sort by timestamp then id, retain sessions and omit absent runs', async () => {
    await task('events')
    await nodeRunFixture(harness.db, {
      id: 'run',
      taskId: 'events',
      nodeId: 'node',
      status: 'done',
    })
    const { nodeRunEvents } = tablesOf(harness.db)
    await harness.db.insert(nodeRunEvents).values([
      { nodeRunId: 'run', ts: 20, kind: 'text', payload: 'last' },
      {
        nodeRunId: 'run',
        ts: 10,
        kind: 'text',
        payload: 'first',
        sessionId: 's',
        parentSessionId: 'p',
      },
      { nodeRunId: 'run', ts: 10, kind: 'text', payload: 'second' },
    ])
    const rows = await listNodeEventContents(harness.db, ['run', 'missing'])
    expect(rows.map((row) => row.payload)).toEqual(['first', 'second', 'last'])
    expect(rows[0]).toMatchObject({ sessionId: 's', parentSessionId: 'p' })
    expect(await listNodeEventContents(harness.db, [])).toEqual([])
  })
})
