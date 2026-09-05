// RFC-359 W4-B3 批 a —— collaboration 六对只差客户端类型 / 事务原语的适配器合一，两个引擎各跑一遍：
// 任务反馈存储、评审人存储（替换走统一事务）、协作侧任务可见性 / 角色、评审侧任务关系、
// 人工门 continuation 恢复查询、任务终态清扫（挂起 run 取消 + node-statuses committed event）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  taskCollaborators,
  taskExecutionIntents,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { createCollaborationTaskAccessPort } from '@/modules/collaboration/infrastructure/collaborationTaskAccess'
import { createHumanGateContinuationRecoveryQueries } from '@/modules/collaboration/infrastructure/humanGateContinuationRecovery'
import { createHumanGateTerminalSweepCommand } from '@/modules/collaboration/infrastructure/humanGateTerminalSweep'
import { DrizzleReviewNodeReviewerStore } from '@/modules/collaboration/infrastructure/reviewNodeReviewerStore'
import { createReviewTaskAccessPort } from '@/modules/collaboration/infrastructure/reviewTaskAccess'
import { DrizzleTaskFeedbackStore } from '@/modules/collaboration/infrastructure/taskFeedbackStore'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedUser(
  db: ProviderNeutralDatabase,
  role: 'admin' | 'user' = 'user',
): Promise<string> {
  const id = `u_b3a_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

function actorFor(userId: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id: userId, username: userId, displayName: userId, role, status: 'active' },
    source: 'session',
  })
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

describeEachProvider('RFC-359 W4-B3a —— 任务反馈与评审人存储', (harness) => {
  test('反馈：插入 / 单读 / 按任务与最近列表 / 蒸馏标记；评审人：替换 / 指派判定 / 列表', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const reviewer = await seedUser(db)
    const taskId = await seedTask(db, owner)
    const feedback = new DrizzleTaskFeedbackStore(db)
    expect(await feedback.loadTaskIdentity(taskId)).toEqual({ id: taskId, ownerUserId: owner })
    expect(await feedback.loadTaskIdentity('missing')).toBeNull()
    const fid = `fb_${ulid()}`
    await feedback.insert({ id: fid, taskId, authorUserId: owner, bodyMd: 'hello', createdAt: 5 })
    expect((await feedback.getById(fid))?.distilled).toBe(false)
    expect((await feedback.listByTask(taskId)).map((row) => row.id)).toEqual([fid])
    expect((await feedback.listRecent(50)).some((row) => row.id === fid)).toBe(true)
    await feedback.markDistilled(fid, 'job-1')
    expect(await feedback.getById(fid)).toMatchObject({ distilled: true, distillJobId: 'job-1' })

    const reviewers = new DrizzleReviewNodeReviewerStore(db)
    await reviewers.replaceTask(
      taskId,
      [{ reviewNodeId: 'review', reviewerUserId: reviewer }],
      owner,
      6,
    )
    expect(await reviewers.isAssigned(taskId, 'review', reviewer)).toBe(true)
    expect(await reviewers.isAssigned(taskId, 'review', owner)).toBe(false)
    expect(await reviewers.listAssignedKeys(reviewer, [taskId])).toEqual(
      new Set([`${taskId}\u0000review`]),
    )
    expect((await reviewers.listForTask(taskId)).map((row) => row.user.id)).toEqual([reviewer])
    expect(await reviewers.activeUserIds([reviewer, 'missing'])).toEqual(new Set([reviewer]))
    await reviewers.replaceTask(taskId, [], owner, 7)
    expect(await reviewers.listForTask(taskId)).toEqual([])
  })
})

describeEachProvider('RFC-359 W4-B3a —— 任务可见性与关系解析', (harness) => {
  test('owner / 协作者 / 陌生人 / 管理员的可见性与角色；node run 与问题条目回溯到任务', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const collaborator = await seedUser(db)
    const stranger = await seedUser(db)
    const admin = await seedUser(db, 'admin')
    const taskId = await seedTask(db, owner)
    await db.insert(taskCollaborators).values({
      taskId,
      userId: collaborator,
      role: 'collaborator',
      addedBy: owner,
      addedAt: 1,
    })
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'n',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
    })
    const access = createCollaborationTaskAccessPort(db)
    expect((await access.resolveTask(actorFor(owner), taskId)).visible).toBe(true)
    expect((await access.resolveTask(actorFor(collaborator), taskId)).visible).toBe(true)
    expect((await access.resolveTask(actorFor(stranger), taskId)).visible).toBe(false)
    expect((await access.resolveTask(actorFor(admin, 'admin'), taskId)).visible).toBe(true)
    expect(await access.resolveTask(actorFor(owner), 'missing')).toEqual({
      task: null,
      visible: false,
      actorRole: null,
    })
    expect(await access.resolveNodeRunTask(actorFor(owner), runId)).toMatchObject({
      nodeRunExists: true,
      taskId,
      visible: true,
    })
    expect((await access.resolveNodeRunTask(actorFor(owner), 'missing')).nodeRunExists).toBe(false)
    expect(await access.visibleTaskIds(actorFor(stranger), [taskId, 'missing'])).toEqual(new Set())
    expect(await access.visibleTaskIds(actorFor(collaborator), [taskId])).toEqual(new Set([taskId]))
    expect(await access.questionTaskId('missing')).toBeNull()

    const review = createReviewTaskAccessPort(db)
    expect(review.canManageReviewers(actorFor(owner), owner)).toBe(true)
    expect(review.canManageReviewers(actorFor(stranger), owner)).toBe(false)
    expect(await review.resolveRelationship(actorFor(collaborator), taskId, owner)).toMatchObject({
      taskVisible: true,
    })
    expect((await review.resolveRelationship(actorFor(stranger), taskId, owner)).taskVisible).toBe(
      false,
    )
    expect(await review.visibleTaskIds(actorFor(owner), [taskId])).toEqual(new Set([taskId]))
  })
})

describeEachProvider('RFC-359 W4-B3a —— continuation 恢复与终态清扫', (harness) => {
  test('listPending 只列 pending 的 gate-continuation；清扫把挂起 run 取消并记 committed event', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const taskId = await seedTask(db, owner)
    const intentId = `intent_${ulid()}`
    await db.insert(taskExecutionIntents).values({
      id: intentId,
      taskId,
      kind: 'gate-continuation',
      state: 'pending',
      source: 'rest',
      requestHash: `h_${intentId}`,
      payloadJson: JSON.stringify({ v: 2, gateRef: 'g', operationId: 'op' }),
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:gate`,
      slotPathJson: '[]',
      expectedTaskRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const recovery = createHumanGateContinuationRecoveryQueries(db)
    const pending = await recovery.listPending()
    expect(pending.some((row) => row.taskId === taskId && row.continuationRef === intentId)).toBe(
      true,
    )

    const parked = ulid()
    const done = ulid()
    await db.insert(nodeRuns).values([
      { id: parked, taskId, nodeId: 'gate', status: 'awaiting_human', retryIndex: 0, iteration: 0 },
      { id: done, taskId, nodeId: 'x', status: 'done', retryIndex: 0, iteration: 0 },
    ])
    const sweep = createHumanGateTerminalSweepCommand(db)
    const result = await sweep.run({ taskId, cause: 'task-canceled', now: 9 })
    expect(result.canceledRuns).toEqual([{ nodeRunId: parked, nodeId: 'gate' }])
    expect(result.sealedSelfRounds).toBe(0)
    const rows = await db
      .select({ id: nodeRuns.id, status: nodeRuns.status, errorMessage: nodeRuns.errorMessage })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
    expect(rows.find((row) => row.id === parked)).toMatchObject({
      status: 'canceled',
      errorMessage: 'task-canceled',
    })
    expect(rows.find((row) => row.id === done)?.status).toBe('done')
    // 再扫一次：无事。
    expect((await sweep.run({ taskId, cause: 'task-canceled', now: 10 })).canceledRuns).toEqual([])
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'collaboration', 'infrastructure')
  for (const stem of [
    'TaskFeedbackStore',
    'HumanGateContinuationRecovery',
    'ReviewNodeReviewerStore',
    'CollaborationTaskAccess',
    'HumanGateTerminalSweep',
    'ReviewTaskAccess',
  ]) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})
