// RFC-359 W4-B4 批 a —— identity-access / memory / integration 七对只差客户端类型的适配器合一，两个引擎各跑一遍：
// owner 身份批量查询、记忆蒸馏读存储、记忆注入读存储、终态工作区归属、webhook 端点管理、webhook 触发器管理、
// webhook 派发执行运行时装配。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  memories,
  memoryDistillEvents,
  memoryDistillJobs,
  nodeRuns,
  taskFeedback,
  taskRepos,
  tasks,
  users,
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggerStreams,
  workflows,
} from '@/db/schema'
import { DrizzleOwnerIdentityPersistence } from '@/modules/identity-access/infrastructure/ownerIdentityQueries'
import { createWebhookTerminalWorkspaceAttributionQueries } from '@/modules/integration/infrastructure/terminalWorkspaceAttribution'
import {
  createWebhookDispatchOrchestrationRuntime,
  createWebhookLaunchAdmission,
} from '@/modules/integration/infrastructure/webhookDispatchRuntime'
import { createWebhookEndpointAdministration } from '@/modules/integration/infrastructure/webhookEndpointAdministration'
import { createWebhookTriggerAdministration } from '@/modules/integration/infrastructure/webhookTriggerAdministration'
import { DrizzleMemoryDistillReadStore } from '@/modules/memory/infrastructure/memoryDistillReadStore'
import { DrizzleMemoryInjectionReadStore } from '@/modules/memory/infrastructure/memoryInjectionReadStore'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_b4a_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: `name-${id}`,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

async function seedTask(db: ProviderNeutralDatabase, owner: string): Promise<string> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ownerUserId: owner,
  })
  return id
}

describeEachProvider('RFC-359 W4-B4a —— owner 身份与记忆读存储', (harness) => {
  test('listByIds 只回存在的 id；蒸馏读存储的 job / 事件 / 候选 / 来源查询', async () => {
    const db = harness.db
    const a = await seedUser(db)
    const b = await seedUser(db)
    const identities = new DrizzleOwnerIdentityPersistence(db)
    expect(await identities.listByIds([])).toEqual([])
    const rows = await identities.listByIds([a, b, 'missing'])
    expect(rows.map((row) => row.id).sort()).toEqual([a, b].sort())
    expect(rows.find((row) => row.id === a)).toEqual({
      id: a,
      username: a,
      displayName: `name-${a}`,
    })

    const taskId = await seedTask(db, a)
    const debounceKey = `k_${ulid()}`
    const job1 = `job_${ulid()}`
    const job2 = `job_${ulid()}`
    await db.insert(memoryDistillJobs).values([
      {
        id: job1,
        debounceKey,
        sourceKind: 'feedback',
        sourceEventId: `evt_${job1}`,
        taskId: null,
        scopeResolvedJson: '{"agentIds":[],"workflowId":null,"repoId":null,"includeGlobal":true}',
        status: 'pending',
        attempts: 0,
        nextRunAt: 10,
        createdAt: 10,
      },
      {
        id: job2,
        debounceKey,
        sourceKind: 'feedback',
        sourceEventId: `evt_${job2}`,
        taskId: null,
        scopeResolvedJson: '{"agentIds":[],"workflowId":null,"repoId":null,"includeGlobal":true}',
        status: 'done',
        attempts: 1,
        nextRunAt: 20,
        createdAt: 20,
      },
    ])
    await db.insert(memoryDistillEvents).values([
      {
        distillJobId: job1,
        attemptIndex: 1,
        sessionId: 's2',
        parentSessionId: null,
        ts: 5,
        kind: 'text',
        payload: '{}',
      },
      {
        distillJobId: job1,
        attemptIndex: 0,
        sessionId: 's1',
        parentSessionId: null,
        ts: 9,
        kind: 'text',
        payload: '{}',
      },
    ])
    const memoryId = `m_${ulid()}`
    await db.insert(memories).values({
      id: memoryId,
      scopeType: 'global',
      scopeId: null,
      title: 'candidate',
      bodyMd: 'body',
      tags: '[]',
      status: 'candidate',
      sourceKind: 'feedback',
      sourceEventId: `evt_${job1}`,
      sourceTaskId: null,
      distillJobId: job1,
      distillAction: 'new',
      supersedesId: null,
      supersededById: null,
      createdAt: 30,
    })
    const feedbackId = `fb_${ulid()}`
    await db.insert(taskFeedback).values({
      id: feedbackId,
      taskId,
      authorUserId: a,
      bodyMd: 'feedback body',
      createdAt: 3,
      distilled: 0,
    })

    const distill = new DrizzleMemoryDistillReadStore(db)
    expect((await distill.findJob(job1))?.id).toBe(job1)
    expect(await distill.findJob('missing')).toBeNull()
    expect((await distill.listSiblingJobs(debounceKey)).map((row) => row.id)).toEqual([job1, job2])
    expect((await distill.listEvents(job1)).map((row) => row.sessionId)).toEqual(['s1', 's2'])
    expect((await distill.listCandidates(job1)).map((row) => row.id)).toEqual([memoryId])
    expect(await distill.listClarifySources([])).toEqual([])
    expect(await distill.listReviewSources(['missing'])).toEqual([])
    expect(await distill.listFeedbackSources([feedbackId, 'missing'])).toEqual([
      { id: feedbackId, taskId, bodyMd: 'feedback body' },
    ])
    expect((await distill.listJobs('pending')).some((row) => row.id === job1)).toBe(true)
    expect((await distill.listJobs('pending')).some((row) => row.id === job2)).toBe(false)
    expect((await distill.listJobs()).some((row) => row.id === job2)).toBe(true)
  })
})

describeEachProvider('RFC-359 W4-B4a —— 记忆注入读存储与终态工作区归属', (harness) => {
  test('任务上下文 / 仓库 id / 已批准记忆 / run 记录；工作区归属只回 webhook 与订阅列', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const taskId = await seedTask(db, owner)
    const repoId = `cr_${ulid()}`
    await db.insert(cachedRepos).values({
      id: repoId,
      urlHash: `h_${repoId}`,
      urlRedacted: 'https://example.invalid/repo.git',
      urlEnc: null,
      localPath: `/tmp/mirror/${repoId}`,
      lastFetchedAt: 1,
      createdAt: 1,
    })
    await db.insert(taskRepos).values([
      {
        taskId,
        repoIndex: 0,
        repoPath: '/tmp/wt/0',
        branch: 'agent-workflow/x',
        worktreePath: '/tmp/wt/0',
        worktreeDirName: '0',
      },
      {
        taskId,
        repoIndex: 1,
        repoPath: '/tmp/wt/1',
        branch: 'agent-workflow/x',
        worktreePath: '/tmp/wt/1',
        worktreeDirName: '1',
        cachedRepoId: repoId,
      },
    ])
    const approved = `m_${ulid()}`
    const scopeId = `agent_${ulid()}`
    await db.insert(memories).values([
      {
        id: approved,
        scopeType: 'agent',
        scopeId,
        title: 'approved',
        bodyMd: 'body',
        tags: '["x"]',
        status: 'approved',
        sourceKind: 'manual',
        sourceEventId: null,
        sourceTaskId: null,
        distillJobId: null,
        distillAction: null,
        supersedesId: null,
        supersededById: null,
        approvedByUserId: owner,
        approvedAt: 9,
        createdAt: 8,
      },
      {
        id: `m_${ulid()}`,
        scopeType: 'agent',
        scopeId,
        title: 'still candidate',
        bodyMd: 'body',
        tags: '[]',
        status: 'candidate',
        sourceKind: 'manual',
        sourceEventId: null,
        sourceTaskId: null,
        distillJobId: null,
        distillAction: null,
        supersedesId: null,
        supersededById: null,
        createdAt: 8,
      },
    ])
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'n',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      injectedMemoriesJson: '[]',
    })

    const injection = new DrizzleMemoryInjectionReadStore(db)
    expect(await injection.findTaskContext(taskId)).toEqual({
      workflowId: expect.any(String),
      cachedRepoId: null,
      repoGroupId: null,
    })
    expect(await injection.findTaskContext('missing')).toBeNull()
    expect(await injection.listTaskRepositoryIds(taskId)).toEqual([repoId])
    expect(await injection.filterExistingRepositoryIds([])).toEqual([])
    expect(await injection.filterExistingRepositoryIds([repoId, 'missing'])).toEqual([repoId])
    expect(await injection.listApprovedMemories({ scopeType: 'agent', scopeIds: [] })).toEqual([])
    const approvedRows = await injection.listApprovedMemories({
      scopeType: 'agent',
      scopeIds: [scopeId],
    })
    expect(approvedRows.map((row) => row.id)).toEqual([approved])
    expect(approvedRows[0]).toMatchObject({ tagsJson: '["x"]', approvedAt: 9, version: 1 })
    const runs = await injection.listRunRecords({
      taskId,
      nodeId: 'n',
      iteration: 0,
      shardKey: null,
      reviewIteration: 0,
    })
    expect(runs).toEqual([{ id: runId, status: 'done', injectedMemoriesJson: '[]' }])

    const attribution = createWebhookTerminalWorkspaceAttributionQueries(db)
    expect(await attribution.load(taskId)).toEqual({
      webhookTriggerId: null,
      eventSubscriptionId: null,
    })
    expect(await attribution.load('missing')).toBeNull()
  })
})

describeEachProvider('RFC-359 W4-B4a —— webhook 端点与触发器管理', (harness) => {
  test('端点：建 / 重复建为 null / 读 / 改 / 引用判定 / 删；触发器：建 / 列 / 条件更新 / fires / 流重置 / 删', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const endpoints = createWebhookEndpointAdministration(db)
    const endpointId = `ep_${ulid()}`
    const urlToken = `aw_whk_${ulid()}`
    const created = await endpoints.tryCreate({
      id: endpointId,
      name: 'gl',
      provider: 'gitlab',
      urlToken,
      secretEnc: 'sealed',
      preferredCloneProtocol: 'http',
    })
    expect(created?.id).toBe(endpointId)
    expect(
      await endpoints.tryCreate({
        id: endpointId,
        name: 'dup',
        provider: 'gitlab',
        urlToken: `aw_whk_${ulid()}`,
        secretEnc: 'sealed',
        preferredCloneProtocol: 'http',
      }),
    ).toBeNull()
    expect((await endpoints.list()).some((row) => row.id === endpointId)).toBe(true)
    expect((await endpoints.get(endpointId))?.urlToken).toBe(urlToken)
    expect(await endpoints.get('missing')).toBeNull()
    expect((await endpoints.getByUrlToken(urlToken))?.id).toBe(endpointId)
    expect((await endpoints.update(endpointId, { name: 'renamed', updatedAt: 2 }))?.name).toBe(
      'renamed',
    )
    expect(await endpoints.update('missing', { name: 'x', updatedAt: 2 })).toBeNull()
    expect(await endpoints.hasTriggerReferences(endpointId)).toBe(false)

    const triggers = createWebhookTriggerAdministration(db)
    expect(await triggers.endpointExists(endpointId)).toBe(true)
    expect(await triggers.endpointExists('missing')).toBe(false)
    const triggerId = `tr_${ulid()}`
    const trigger = await triggers.create({
      id: triggerId,
      name: 'pipeline watch',
      endpointId,
      ownerUserId: owner,
      repoScope: JSON.stringify({ kind: 'all' }),
      eventTypes: JSON.stringify(['pipeline_failed']),
      ignoreUsernames: '[]',
      launchKind: 'workflow',
      launchRefId: 'wf_1',
      launchPayload: JSON.stringify({ v: 2 }),
      enabled: true,
      branchFilter: null,
      commandPrefix: null,
      templateSyntaxVersion: 2,
      maxConsecutiveFires: 3,
      autoRegisterRepos: false,
      cancelOnMrTerminal: false,
    })
    expect(trigger.id).toBe(triggerId)
    expect(await endpoints.hasTriggerReferences(endpointId)).toBe(true)
    expect((await triggers.list()).some((row) => row.id === triggerId)).toBe(true)
    expect((await triggers.get(triggerId))?.name).toBe('pipeline watch')
    expect(await triggers.get('missing')).toBeNull()
    expect(
      (
        await triggers.update({
          triggerId,
          patch: { name: 'renamed', templateSyntaxVersion: 2, updatedAt: 4 },
        })
      )?.name,
    ).toBe('renamed')
    const expected = {
      templateSyntaxVersion: trigger.templateSyntaxVersion,
      launchRefId: trigger.launchRefId,
      launchPayload: trigger.launchPayload,
      eventTypes: trigger.eventTypes,
      autoRegisterRepos: trigger.autoRegisterRepos,
      cancelOnMrTerminal: trigger.cancelOnMrTerminal,
    }
    expect(
      await triggers.update({
        triggerId,
        patch: { name: 'stale', templateSyntaxVersion: 2, updatedAt: 5 },
        expectedLaunchConfiguration: { ...expected, launchRefId: 'someone-else' },
      }),
    ).toBeNull()
    expect(
      (
        await triggers.update({
          triggerId,
          patch: { name: 'fresh', templateSyntaxVersion: 2, updatedAt: 6 },
          expectedLaunchConfiguration: expected,
        })
      )?.name,
    ).toBe('fresh')

    await db.insert(webhookTriggerFires).values([
      {
        id: `fire_${ulid()}`,
        deliveryId: 'd1',
        triggerId,
        streamKey: 's',
        outcome: 'launched',
        firedAt: 10,
      },
      {
        id: `fire_${ulid()}`,
        deliveryId: 'd2',
        triggerId,
        streamKey: 's',
        outcome: 'launched',
        firedAt: 20,
      },
    ])
    expect((await triggers.listFires(triggerId, 10)).map((row) => row.firedAt)).toEqual([20, 10])
    expect((await triggers.listFires(triggerId, 1)).map((row) => row.firedAt)).toEqual([20])
    await db
      .insert(webhookTriggerStreams)
      .values({ triggerId, streamKey: 's', consecutiveFires: 2 })
    await triggers.resetStream({ triggerId, streamKey: 's', resetAt: 30, resetBy: owner })
    const stream = (
      await db
        .select()
        .from(webhookTriggerStreams)
        .where(eq(webhookTriggerStreams.triggerId, triggerId))
    )[0]
    expect(stream).toMatchObject({ consecutiveFires: 0, resetAt: 30, resetBy: owner })

    await db.delete(webhookTriggerStreams).where(eq(webhookTriggerStreams.triggerId, triggerId))
    await db.delete(webhookTriggerFires).where(eq(webhookTriggerFires.triggerId, triggerId))
    await triggers.delete(triggerId)
    expect(await triggers.get(triggerId)).toBeNull()
    expect(await endpoints.hasTriggerReferences(endpointId)).toBe(false)
    expect(await endpoints.delete(endpointId)).toBe(true)
    expect(await endpoints.delete(endpointId)).toBe(false)
    expect(
      (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId))).length,
    ).toBe(0)
  })
})

test('派发运行时装配只是对中立执行运行时的两种绑定', () => {
  const runtime = createWebhookDispatchOrchestrationRuntime({
    taskExecutions: {
      async launch() {
        throw new Error('unused')
      },
      async cancel() {},
    },
  })
  expect(typeof runtime.launch).toBe('function')
  expect(typeof runtime.cancel).toBe('function')
  expect(typeof createWebhookLaunchAdmission).toBe('function')
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const modules = resolve(import.meta.dir, '..', 'src', 'modules')
  const stems = [
    ['identity-access', 'OwnerIdentityQueries'],
    ['memory', 'MemoryDistillReadStore'],
    ['memory', 'MemoryInjectionReadStore'],
    ['integration', 'TerminalWorkspaceAttribution'],
    ['integration', 'WebhookEndpointAdministration'],
    ['integration', 'WebhookTriggerAdministration'],
    ['integration', 'WebhookDispatchRuntime'],
  ] as const
  for (const [context, stem] of stems) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(modules, context, 'infrastructure', `${provider}${stem}.ts`))).toBe(
        false,
      )
    }
  }
})
