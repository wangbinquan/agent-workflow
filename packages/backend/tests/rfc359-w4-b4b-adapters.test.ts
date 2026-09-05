// RFC-359 W4-B4 批 b —— integration 四对适配器合一，两个引擎各跑一遍：代码托管事件响应目录、webhook 派发持久化、
// 投递审计 / 回放读模型（含 loose index scan 的仓库路径枚举）、MR 启动守卫与终态 effect 持久化（统一事务 +
// 引擎能力矩阵的 advisory lock）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  tasks,
  users,
  webhookDeliveries,
  webhookEndpoints,
  webhookMrControlEffects,
  webhookMrControlTargets,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
  webhookTriggers,
  workflows,
} from '@/db/schema'
import { createCodeHostEventResponseDirectory } from '@/modules/integration/infrastructure/codeHostEventResponseDirectory'
import {
  createMrLaunchGuardPersistence,
  createMrTerminalEffectPersistence,
} from '@/modules/integration/infrastructure/mrTerminalControlPersistence'
import { createWebhookDeliveryQueries } from '@/modules/integration/infrastructure/webhookDeliveryQueries'
import { createWebhookDispatchPersistence } from '@/modules/integration/infrastructure/webhookDispatchPersistence'
import { ConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedUser(db: ProviderNeutralDatabase, role: 'admin' | 'user' = 'user') {
  const id = `u_b4b_${ulid()}`
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

async function seedTask(
  db: ProviderNeutralDatabase,
  owner: string,
  extra: Partial<typeof tasks.$inferInsert> = {},
) {
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
    ...extra,
  })
  return id
}

async function seedEndpoint(db: ProviderNeutralDatabase) {
  const id = `ep_${ulid()}`
  await db.insert(webhookEndpoints).values({
    id,
    name: 'gl',
    provider: 'gitlab',
    urlToken: `aw_whk_${ulid()}`,
    secretEnc: 'sealed',
    enabled: true,
  })
  return id
}

async function seedTrigger(
  db: ProviderNeutralDatabase,
  endpointId: string,
  owner: string,
  extra: Partial<typeof webhookTriggers.$inferInsert> = {},
) {
  const id = `tr_${ulid()}`
  await db.insert(webhookTriggers).values({
    id,
    name: `trigger ${id.slice(-4)}`,
    endpointId,
    ownerUserId: owner,
    repoScope: JSON.stringify({ kind: 'all' }),
    eventTypes: JSON.stringify(['pipeline_failed']),
    ignoreUsernames: '[]',
    launchKind: 'workflow',
    launchRefId: 'wf_1',
    launchPayload: JSON.stringify({ v: 2 }),
    autoRegisterRepos: false,
    ...extra,
  })
  return id
}

async function seedDelivery(
  db: ProviderNeutralDatabase,
  endpointId: string,
  extra: Partial<typeof webhookDeliveries.$inferInsert> = {},
) {
  const id = `dl_${ulid()}`
  await db.insert(webhookDeliveries).values({
    id,
    endpointId,
    eventUuid: null,
    status: 'matched',
    bodyJson: '{"object_kind":"push"}',
    ...extra,
  })
  return id
}

describeEachProvider('RFC-359 W4-B4b —— 事件响应目录与派发持久化', (harness) => {
  test('目录：列表 / 存在性；派发：触发器读写、fire 记录、流状态 upsert、MR fact、最近启动任务、启动结果标记', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const endpointId = await seedEndpoint(db)
    const enabled = await seedTrigger(db, endpointId, owner)
    const paused = await seedTrigger(db, endpointId, owner, { enabled: false })

    const directory = createCodeHostEventResponseDirectory(db)
    const listed = await directory.list()
    expect(listed.find((row) => row.id === paused)?.state).toBe('paused')
    expect(listed.find((row) => row.id === enabled)?.endpointId).toBe(endpointId)
    expect(await directory.has(enabled)).toBe(true)
    expect(await directory.has('missing')).toBe(false)

    const dispatch = createWebhookDispatchPersistence(db)
    expect(await dispatch.triggerEnabled(enabled)).toBe(true)
    expect(await dispatch.triggerEnabled(paused)).toBe(false)
    expect(await dispatch.triggerEnabled('missing')).toBeNull()
    expect((await dispatch.getTrigger(enabled))?.id).toBe(enabled)
    expect(await dispatch.getTrigger('missing')).toBeNull()
    expect((await dispatch.listEnabledTriggers(endpointId)).map((row) => row.id)).toEqual([enabled])

    // 模板迁移：v1 + 期望 payload 匹配才改；不匹配时回读当前行。
    const legacy = await seedTrigger(db, endpointId, owner, {
      templateSyntaxVersion: 1,
      launchPayload: '{"v":1}',
    })
    const stale = await dispatch.migrateTriggerTemplate({
      triggerId: legacy,
      expectedLaunchPayload: 'someone-else',
      launchPayload: '{"v":2}',
      now: 5,
    })
    expect(stale).toMatchObject({ id: legacy, templateSyntaxVersion: 1 })
    const migrated = await dispatch.migrateTriggerTemplate({
      triggerId: legacy,
      expectedLaunchPayload: '{"v":1}',
      launchPayload: '{"v":2}',
      now: 6,
    })
    expect(migrated).toMatchObject({
      id: legacy,
      templateSyntaxVersion: 2,
      launchPayload: '{"v":2}',
    })

    const deliveryId = await seedDelivery(db, endpointId, {
      mrStreamKey: 'gitlab:77:9',
      mrStreamRevision: 3,
      mrStateAfter: 'open',
    })
    expect(await dispatch.getDeliveryMrFact(deliveryId)).toEqual({
      streamKey: 'gitlab:77:9',
      revision: 3,
      stateAfter: 'open',
    })
    expect(await dispatch.getDeliveryMrFact('missing')).toBeNull()

    const fireId = `fire_${ulid()}`
    const launchedTask = await seedTask(db, owner, { webhookFireId: fireId })
    await dispatch.recordFire({
      fireId,
      deliveryId,
      triggerId: enabled,
      streamKey: 's',
      outcome: 'launched',
      taskId: launchedTask,
    })
    expect(await dispatch.fireExists(deliveryId, enabled)).toBe(true)
    expect(await dispatch.fireExists(deliveryId, paused)).toBe(false)
    expect(await dispatch.findTaskByOrigin({ fireId })).toBe(launchedTask)
    expect(await dispatch.findTaskByOrigin({ fireId: 'missing' })).toBeNull()
    expect(await dispatch.findLatestLaunchedTask(enabled, 's')).toEqual({
      id: launchedTask,
      status: 'running',
    })
    expect(await dispatch.findLatestLaunchedTask(enabled, 'other')).toBeNull()

    expect(await dispatch.getTriggerStream(enabled, 's')).toBeNull()
    await dispatch.putTriggerStream({
      triggerId: enabled,
      streamKey: 's',
      consecutiveFires: 1,
      lastFireAt: 7,
    })
    await dispatch.putTriggerStream({ triggerId: enabled, streamKey: 's', consecutiveFires: 2 })
    expect(await dispatch.getTriggerStream(enabled, 's')).toEqual({
      consecutiveFires: 2,
      lastFireAt: 7,
    })

    await dispatch.markTriggerLaunchFailed(enabled, 'boom', 8)
    await dispatch.markTriggerLaunchFailed(enabled, 'boom', 9)
    expect(await dispatch.getTrigger(enabled)).toMatchObject({
      lastStatus: 'failed',
      lastError: 'boom',
      consecutiveFailures: 2,
    })
    await dispatch.markTriggerLaunched({ triggerId: enabled, taskId: launchedTask, now: 10 })
    expect(await dispatch.getTrigger(enabled)).toMatchObject({
      lastStatus: 'launched',
      lastError: null,
      lastTaskId: launchedTask,
      consecutiveFailures: 0,
      lastFiredAt: 10,
    })

    const envelope = await dispatch.subscriptionEnvelope(deliveryId)
    expect(envelope?.endpoint.id).toBe(endpointId)
    expect(envelope?.delivery.bodyJson).toBe('{"object_kind":"push"}')
    expect(await dispatch.subscriptionEnvelope('missing')).toBeNull()

    const effectId = `effect_${ulid()}`
    await db.insert(webhookMrControlEffects).values({
      id: effectId,
      deliveryId,
      endpointId,
      streamKey: 'gitlab:77:9',
      binding: 'binding-1',
      revision: 2,
      observedEventType: 'mr_closed',
      kind: 'fence-closed',
      status: 'succeeded',
      nextAttemptAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const replay = await seedDelivery(db, endpointId, { replayedFromDeliveryId: deliveryId })
    expect(await dispatch.deliveryControlEffectId(deliveryId)).toBe(effectId)
    expect(await dispatch.deliveryControlEffectId(replay)).toBe(effectId)
    expect(await dispatch.deliveryControlEffectId('missing')).toBeNull()
  })
})

describeEachProvider('RFC-359 W4-B4b —— 投递审计读模型', (harness) => {
  test('分页计数是 number；仓库路径 loose index scan 两引擎同一句；终态控制按 actor 可见性裁剪', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const stranger = await seedUser(db)
    const admin = await seedUser(db, 'admin')
    const endpointId = await seedEndpoint(db)
    for (const [repoPath, receivedAt] of [
      ['g/b', 3],
      ['g/a', 2],
      ['g/b', 1],
      [null, 0],
    ] as const) {
      await seedDelivery(db, endpointId, { repoPath, receivedAt, eventType: 'push' })
    }
    const queries = createWebhookDeliveryQueries(db)
    const page = await queries.page({ endpointId, page: 1, limit: 2 })
    expect(typeof page.total).toBe('number')
    expect(page).toMatchObject({ total: 4, page: 1, pageCount: 2 })
    expect(page.items.map((row) => row.receivedAt)).toEqual([3, 2])
    expect((await queries.page({ endpointId, repoPath: 'g/b', page: 1, limit: 10 })).total).toBe(2)
    expect((await queries.page({ endpointId, page: 9, limit: 10 })).items).toEqual([])
    expect(await queries.listRepoPaths()).toEqual(['g/a', 'g/b'])
    const first = page.items[0]!
    expect((await queries.get(first.id))?.id).toBe(first.id)
    expect(await queries.get('missing')).toBeNull()

    const deliveryId = first.id
    expect(await queries.hasTerminalControlEffect(deliveryId)).toBe(false)
    expect(await queries.terminalControl(deliveryId, actorFor(owner))).toBeNull()
    const visibleTask = await seedTask(db, owner)
    const hiddenTask = await seedTask(db, stranger)
    const effectId = `effect_${ulid()}`
    await db.insert(webhookMrControlEffects).values({
      id: effectId,
      deliveryId,
      endpointId,
      streamKey: 'gitlab:77:9',
      binding: 'binding-1',
      revision: 2,
      observedEventType: 'mr_closed',
      kind: 'fence-closed',
      status: 'succeeded',
      nextAttemptAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    for (const taskId of [visibleTask, hiddenTask]) {
      await db.insert(webhookMrControlTargets).values({
        effectId,
        taskId,
        priorStatus: 'running',
        fenceOutcome: 'fenced-closed',
        cancelOutcome: 'canceled',
        releaseOutcome: 'released',
        updatedAt: 1,
      })
    }
    expect(await queries.hasTerminalControlEffect(deliveryId)).toBe(true)
    const asOwner = await queries.terminalControl(deliveryId, actorFor(owner))
    expect(asOwner).toMatchObject({
      kind: 'fence-closed',
      totalTargetCount: 2,
      hiddenTargetCount: 1,
    })
    expect(asOwner?.targets.map((target) => target.taskId)).toEqual([visibleTask])
    expect(asOwner?.targets[0]?.workspace).toEqual({ spaceKind: 'remote', state: 'retained' })
    const asAdmin = await queries.terminalControl(deliveryId, actorFor(admin, 'admin'))
    expect(asAdmin?.hiddenTargetCount).toBe(0)
    expect(asAdmin?.targets.map((target) => target.taskId).sort()).toEqual(
      [visibleTask, hiddenTask].sort(),
    )
  })
})

describeEachProvider('RFC-359 W4-B4b —— MR 启动守卫与终态 effect', (harness) => {
  test('守卫：预留 / 状态推进 / 终态拒绝 / 启动屏障 / 开机对账；effect：按流认领、回执 upsert、收尾', async () => {
    const db = harness.db
    const endpointId = await seedEndpoint(db)
    const streamKey = `gitlab:77:${ulid()}`
    await db.insert(webhookMrStreamStates).values({
      endpointId,
      streamKey,
      projectId: '77',
      mrIid: '9',
      state: 'open',
      revision: 1,
      lastDeliveryId: 'delivery-open',
      updatedAt: 1,
    })
    const guards = createMrLaunchGuardPersistence(db)
    const reservation = {
      ownerKey: 'owner-1',
      endpointId,
      streamKey,
      binding: `${endpointId}:${streamKey}`,
      launchRevision: 1,
      deliveryId: 'delivery-open',
      fireId: 'fire-1',
      triggerId: 'trigger-1',
      triggerName: 'Fixture trigger',
      createdAt: 100,
    }
    const guardId = `guard_${ulid()}`
    await guards.reserve({ ...reservation, guardId, fireId: `fire_${ulid()}` })
    expect(await guards.hasLaunchBarrier(reservation.binding, 2)).toBe(true)
    expect(await guards.hasLaunchBarrier(reservation.binding, 1)).toBe(false)
    await guards.markLaunching(guardId, 101)
    expect(await guards.assertCanCommit({ guardId, launchRevision: 1 })).toBe(true)
    await guards.markTaskCommitted(guardId, 'task-1', 102)
    await guards.markLaunchSettled(guardId, 'task-1', 103)
    expect(await guards.hasLaunchBarrier(reservation.binding, 2)).toBe(false)
    expect(await guards.assertCanCommit({ guardId, launchRevision: 1 })).toBe(false)
    // settled 的守卫不会被 markFailed 改写。
    await guards.markFailed(guardId, 'late failure', 104)
    const settled = (
      await db.select().from(webhookMrLaunchGuards).where(eq(webhookMrLaunchGuards.id, guardId))
    )[0]
    expect(settled).toMatchObject({
      status: 'launch-settled',
      taskId: 'task-1',
      launchOwnerKey: null,
    })

    const failing = `guard_${ulid()}`
    await guards.reserve({ ...reservation, guardId: failing, fireId: `fire_${ulid()}` })
    await guards.markFailed(failing, 'Boom! Bad/code', 105)
    expect(
      (
        await db.select().from(webhookMrLaunchGuards).where(eq(webhookMrLaunchGuards.id, failing))
      )[0],
    ).toMatchObject({ status: 'failed', error: 'Boom--Bad-code' })

    // 流已终态 ⇒ 预留被拒。
    await db
      .update(webhookMrStreamStates)
      .set({ state: 'closed', revision: 2, lastTerminalRevision: 2 })
      .where(eq(webhookMrStreamStates.streamKey, streamKey))
    await expect(
      guards.reserve({ ...reservation, guardId: `guard_${ulid()}`, fireId: `fire_${ulid()}` }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(
      (
        await db
          .select()
          .from(webhookMrLaunchGuards)
          .where(eq(webhookMrLaunchGuards.streamKey, streamKey))
      ).length,
    ).toBe(2)

    // 开机对账：revoking-terminal → aborted-terminal；reserved → failed；task-committed 带 taskId → settled。
    const revoking = `guard_${ulid()}`
    const restartReserved = `guard_${ulid()}`
    const committed = `guard_${ulid()}`
    for (const [id, status, taskId] of [
      [revoking, 'revoking-terminal', null],
      [restartReserved, 'reserved', null],
      [committed, 'task-committed', 'task-9'],
    ] as const) {
      await db.insert(webhookMrLaunchGuards).values({
        id,
        endpointId,
        streamKey,
        binding: 'binding-boot',
        launchRevision: 1,
        deliveryId: 'delivery-open',
        fireId: `fire-${id}`,
        triggerId: 'trigger-1',
        triggerNameSnapshot: 'Fixture trigger',
        launchOwnerKey: 'owner-boot',
        status,
        taskId,
        createdAt: 1,
        updatedAt: 1,
      })
    }
    expect(await guards.listRevokingGuardIds()).toEqual([revoking])
    await guards.reconcileStaleOnBoot(200)
    const byId = new Map(
      (
        await db
          .select()
          .from(webhookMrLaunchGuards)
          .where(eq(webhookMrLaunchGuards.binding, 'binding-boot'))
      ).map((row) => [row.id, row] as const),
    )
    expect(byId.get(revoking)).toMatchObject({ status: 'aborted-terminal', launchOwnerKey: null })
    expect(byId.get(restartReserved)).toMatchObject({
      status: 'failed',
      error: 'daemon-restart-before-task-commit',
    })
    expect(byId.get(committed)).toMatchObject({ status: 'launch-settled', taskId: 'task-9' })
    expect(await guards.listRevokingGuardIds()).toEqual([])

    const effects = createMrTerminalEffectPersistence(db)
    const older = `effect_${ulid()}`
    const newer = `effect_${ulid()}`
    for (const [id, revision, createdAt] of [
      [older, 1, 10],
      [newer, 2, 11],
    ] as const) {
      await db.insert(webhookMrControlEffects).values({
        id,
        deliveryId: `delivery-${id}`,
        endpointId,
        streamKey,
        binding: reservation.binding,
        revision,
        observedEventType: 'mr_closed',
        kind: 'fence-closed',
        status: 'pending',
        nextAttemptAt: 0,
        createdAt,
        updatedAt: createdAt,
      })
    }
    // 同一条流上更早的 revision 没成功之前，新的 effect 不能被认领。
    const claimed = await effects.claimNextDue({ now: 20, workerId: 'w1', leaseMs: 1000 })
    expect(claimed).toMatchObject({ id: older, revision: 1, attemptCount: 1 })
    expect(await effects.claimNextDue({ now: 21, workerId: 'w2', leaseMs: 1000 })).toBeNull()
    await effects.recordReceipts(
      older,
      [
        {
          taskId: 'task-1',
          priorStatus: 'running',
          fenceOutcome: 'fenced-closed',
          cancelOutcome: 'canceled',
          releaseOutcome: 'pending',
          errorCode: null,
        },
      ],
      22,
    )
    await effects.recordReceipts(
      older,
      [
        {
          taskId: 'task-1',
          priorStatus: 'running',
          fenceOutcome: 'fenced-closed',
          cancelOutcome: 'canceled',
          releaseOutcome: 'released',
          errorCode: null,
        },
      ],
      23,
    )
    expect(await effects.listReleaseOutcomes(older)).toEqual(['released'])
    // 只有租约持有者能收尾。
    await effects.finishAttempt({
      effectId: older,
      workerId: 'w2',
      status: 'succeeded',
      nextAttemptAt: 0,
      lastError: null,
      now: 24,
    })
    expect(
      (
        await db.select().from(webhookMrControlEffects).where(eq(webhookMrControlEffects.id, older))
      )[0]?.status,
    ).toBe('leased')
    await effects.finishAttempt({
      effectId: older,
      workerId: 'w1',
      status: 'succeeded',
      nextAttemptAt: 0,
      lastError: null,
      now: 25,
    })
    expect(await effects.claimNextDue({ now: 30, workerId: 'w1', leaseMs: 1000 })).toMatchObject({
      id: newer,
      revision: 2,
    })
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'integration', 'infrastructure')
  for (const stem of [
    'CodeHostEventResponseDirectory',
    'WebhookDispatchPersistence',
    'WebhookDeliveryQueries',
    'MrTerminalControlPersistence',
  ]) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})
