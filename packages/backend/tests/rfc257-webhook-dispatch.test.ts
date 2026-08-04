// RFC-257 T6 — 分流服务集成锁：fan-out（AC-7）/ supersede 与并发互斥（AC-9/
// AC-11）/ 熔断三重置源（AC-10）/ owner 每次触发重校验（AC-13）/ repo 解析含
// unseal 复核（AC-8）/ 行级容错。launch/cancel 经测试接缝注入（真默认 =
// startExecution/cancelExecution 门面，CALL_FACES 源码锁另行覆盖）；
// assertScheduledTargetUsable 走真实现（目标 workflow 建真行）。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { CodeHostEvent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createUser } from '../src/services/users'
import {
  cachedRepos,
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
  webhookTriggerStreams,
  workflows,
} from '../src/db/schema'
import {
  createWebhookDispatcher,
  parseTriggerRow,
  renderWebhookLaunch,
  resolveRepoForEvent,
  type WebhookDispatchDeps,
} from '../src/services/webhook/webhookDispatch'
import type { WebhookEndpointRow } from '../src/routes/webhooks'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 9))

const HTTP_URL = 'https://gitlab.example.com/platform/api.git'
const SSH_URL = 'git@gitlab.example.com:platform/api.git'

function ev(overrides: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: ulid(),
    eventType: 'pipeline_failed',
    repoPath: 'platform/api',
    repoHttpUrl: HTTP_URL,
    repoSshUrl: SSH_URL,
    branch: 'feature/x',
    mrIid: '42',
    author: { username: 'aw-bot' },
    pipelineStatus: 'failed',
    raw: { object_kind: 'pipeline' },
    ...overrides,
  }
}

type Harness = {
  db: DbClient
  deps: WebhookDispatchDeps
  /** daemon 单例语义（start.ts 只创建一次）：互斥队列在实例内，跨 dispatch 共享。 */
  dispatcher: ReturnType<typeof createWebhookDispatcher>
  endpoint: WebhookEndpointRow
  ownerId: string
  workflowId: string
  launched: Array<{ taskId: string; kind: string; fireId: string; payload: unknown }>
  canceled: string[]
  launchError: { current: Error | null }
}

async function harness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const owner = await createUser(db, {
    username: 'owner-a',
    displayName: 'Owner A',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'audit-wf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
    ownerUserId: owner.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'gitlab',
    provider: 'gitlab',
    urlToken: 'aw_whk_tok1',
    secretEnc: box.seal('s'),
    enabled: true,
  })
  const endpoint = (
    await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, 'ep-1')).limit(1)
  )[0]!
  const launched: Harness['launched'] = []
  const canceled: string[] = []
  const launchError: Harness['launchError'] = { current: null }
  const deps: WebhookDispatchDeps = {
    db,
    configPath: '/nonexistent/config.json',
    secretBox: box,
    getDefaultRuntime: async () => null,
    launch: async (actor, rendered, invoker) => {
      if (launchError.current) throw launchError.current
      if (invoker.type !== 'webhook') throw new Error('expected webhook invoker')
      const taskId = ulid()
      // supersede 查询依赖真实 tasks 行（running），fake launch 落一行。
      await db.insert(tasks).values({
        id: taskId,
        name: 'fired',
        workflowId,
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: `/wt/${taskId}`,
        baseBranch: 'main',
        branch: `aw/${taskId}`,
        status: 'running',
        ownerUserId: actor.user.id,
        inputs: '{}',
        startedAt: Date.now(),
        webhookTriggerId: invoker.webhookTriggerId,
        webhookFireId: invoker.webhookFireId,
      })
      launched.push({
        taskId,
        kind: rendered.kind,
        fireId: invoker.webhookFireId,
        payload: rendered.payload,
      })
      return taskId
    },
    cancel: async (taskId) => {
      canceled.push(taskId)
      await db.update(tasks).set({ status: 'canceled' }).where(eq(tasks.id, taskId))
    },
  }
  return {
    db,
    deps,
    dispatcher: createWebhookDispatcher(deps),
    endpoint,
    ownerId: owner.id,
    workflowId,
    launched,
    canceled,
    launchError,
  }
}

async function insertTrigger(
  h: Harness,
  overrides: Partial<typeof webhookTriggers.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? ulid()
  await h.db.insert(webhookTriggers).values({
    id,
    name: overrides.name ?? '修到绿',
    endpointId: 'ep-1',
    ownerUserId: h.ownerId,
    repoScope: JSON.stringify({ kind: 'prefix', prefix: 'platform/' }),
    eventTypes: JSON.stringify(['pipeline_failed']),
    ignoreUsernames: JSON.stringify(['aw-bot']),
    launchKind: 'workflow',
    launchRefId: h.workflowId,
    launchPayload: JSON.stringify({ inputs: {} }),
    ...overrides,
  })
  return id
}

async function insertReceivedDelivery(h: Harness, event: CodeHostEvent): Promise<string> {
  const id = ulid()
  await h.db.insert(webhookDeliveries).values({
    id,
    endpointId: 'ep-1',
    eventUuid: event.eventUuid,
    status: 'received',
    eventType: event.eventType,
    repoPath: event.repoPath,
  })
  return id
}

async function dispatchOnce(h: Harness, event: CodeHostEvent): Promise<string> {
  const deliveryId = await insertReceivedDelivery(h, event)
  await h.dispatcher.dispatch({ deliveryId, endpoint: h.endpoint, event })
  return deliveryId
}

async function firesOf(h: Harness, triggerId?: string) {
  return h.db
    .select()
    .from(webhookTriggerFires)
    .where(triggerId ? eq(webhookTriggerFires.triggerId, triggerId) : undefined)
}

async function deliveryStatus(h: Harness, id: string) {
  const row = (
    await h.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1)
  )[0]
  return [row?.status, row?.statusReason] as const
}

describe('RFC-257 T6 · renderWebhookLaunch（纯装配）', () => {
  const trigger = {
    launchKind: 'workflow' as const,
    launchRefId: 'wf-1',
    payloadTemplate: {
      inputs: {
        mr_ref: { kind: 'event-branch' as const },
        title: { kind: 'template' as const, template: 'MR {{mr_iid}}: {{mr_title}}' },
      },
    },
  }
  test('workflow：git kind 代包 packed JSON、text 模板渲染、repo/ref/name 注入', () => {
    const r = renderWebhookLaunch(trigger, '审计', ev({ mrTitle: 'Fix NPE' }), {
      kind: 'cached',
      cachedRepoId: 'repo-1',
    })
    expect(r.kind).toBe('workflow')
    const p = r.payload as Record<string, unknown>
    expect(p['workflowId']).toBe('wf-1')
    expect(p['name']).toBe('[审计] platform/api!42')
    expect(p['cachedRepoId']).toBe('repo-1')
    expect(p['ref']).toBe('feature/x')
    const inputs = p['inputs'] as Record<string, string>
    expect(JSON.parse(inputs['mr_ref']!)).toEqual({ kind: 'branch', ref: 'feature/x' })
    expect(inputs['title']).toBe('MR 42: Fix NPE')
  })
  test('agent：description 插值 + expected 防 ABA 由 launch 层补', () => {
    const r = renderWebhookLaunch(
      {
        launchKind: 'agent',
        launchRefId: 'ag-1',
        payloadTemplate: { description: '修 {{repo_path}} 的 !{{mr_iid}}' },
      },
      '修复员',
      ev(),
      { kind: 'url', repoUrl: HTTP_URL },
    )
    const p = r.payload as Record<string, unknown>
    expect(p['agentId']).toBe('ag-1')
    expect(p['description']).toBe('修 platform/api 的 !42')
    expect(p['repoUrl']).toBe(HTTP_URL)
  })
})

describe('RFC-257 T6 · resolveRepoForEvent（AC-8）', () => {
  async function seedCached(db: DbClient, url: string, id = 'cr-1'): Promise<void> {
    const { createHash } = await import('node:crypto')
    const { parseGitUrl, gitUrlCacheKeyWith } = await import('@agent-workflow/shared')
    const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')
    const key = gitUrlCacheKeyWith(parseGitUrl(url)!, sha1)
    await db.insert(cachedRepos).values({
      id,
      urlHash: key.hash,
      url: '',
      urlEnc: box.seal(url),
      urlRedacted: url,
      localPath: `/repos/${id}`,
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
  }
  test('http 导入的仓命中 http 事件；ssh 导入的仓命中同一事件（双 key）', async () => {
    const h = await harness()
    await seedCached(h.db, HTTP_URL)
    expect(await resolveRepoForEvent(h.db, box, ev(), h.endpoint, true)).toEqual({
      kind: 'cached',
      cachedRepoId: 'cr-1',
    })
    const h2 = await harness()
    await seedCached(h2.db, SSH_URL, 'cr-2')
    expect(await resolveRepoForEvent(h2.db, box, ev(), h2.endpoint, true)).toEqual({
      kind: 'cached',
      cachedRepoId: 'cr-2',
    })
  })
  test('哈希桶碰撞：unseal 复核 canonical 不等 → 不采纳，落自动注册', async () => {
    const h = await harness()
    const { createHash } = await import('node:crypto')
    const { parseGitUrl, gitUrlCacheKeyWith } = await import('@agent-workflow/shared')
    const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')
    const key = gitUrlCacheKeyWith(parseGitUrl(HTTP_URL)!, sha1)
    // 伪造碰撞行：hash 与事件仓相同，但封存的真身是另一个仓
    await h.db.insert(cachedRepos).values({
      id: 'cr-evil',
      urlHash: key.hash,
      url: '',
      urlEnc: box.seal('https://gitlab.example.com/other/repo.git'),
      urlRedacted: 'x',
      localPath: '/repos/cr-evil',
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    const r = await resolveRepoForEvent(h.db, box, ev(), h.endpoint, true)
    expect(r).toEqual({ kind: 'url', repoUrl: HTTP_URL })
  })
  test('未缓存：autoRegister off → unregistered；on → 按端点偏好选 URL', async () => {
    const h = await harness()
    expect(await resolveRepoForEvent(h.db, box, ev(), h.endpoint, false)).toEqual({
      kind: 'unregistered',
    })
    expect(
      await resolveRepoForEvent(h.db, box, ev(), { preferredCloneProtocol: 'ssh' }, true),
    ).toEqual({ kind: 'url', repoUrl: SSH_URL })
  })
})

describe('RFC-257 T6 · dispatch 集成', () => {
  test('fan-out：两触发器命中 → 两 launched fires、fireId 与 tasks 行对上、delivery=matched（AC-7）', async () => {
    const h = await harness()
    const t1 = await insertTrigger(h)
    const t2 = await insertTrigger(h, { name: '第二个' })
    const deliveryId = await dispatchOnce(h, ev())
    expect(await deliveryStatus(h, deliveryId)).toEqual(['matched', null])
    const fires = await firesOf(h)
    expect(fires.map((f) => f.outcome)).toEqual(['launched', 'launched'])
    expect(new Set(fires.map((f) => f.triggerId))).toEqual(new Set([t1, t2]))
    expect(h.launched.length).toBe(2)
    // invoker 的 fireId = fires 行 id；tasks 行 stamped（AC-18 归属链）
    for (const fire of fires) {
      const task = (
        await h.db.select().from(tasks).where(eq(tasks.webhookFireId, fire.id)).limit(1)
      )[0]
      expect(task?.webhookTriggerId).toBe(fire.triggerId)
      expect(fire.taskId).toBe(task?.id ?? '')
    }
  })

  test('零命中 → ignored(no-trigger-matched)；异 endpoint 触发器不参与', async () => {
    const h = await harness()
    await h.db.insert(webhookEndpoints).values({
      id: 'ep-2',
      name: 'other',
      provider: 'gitlab',
      urlToken: 'aw_whk_tok2',
      secretEnc: box.seal('s2'),
      enabled: true,
    })
    await insertTrigger(h, { endpointId: 'ep-2' }) // 别的端点
    await insertTrigger(h, { eventTypes: JSON.stringify(['push']) }) // 类型不符
    const deliveryId = await dispatchOnce(h, ev())
    expect(await deliveryStatus(h, deliveryId)).toEqual(['ignored', 'no-trigger-matched'])
    expect((await firesOf(h)).length).toBe(0)
  })

  test('supersede：同流旧任务未终态 → cancel + supersededTaskId；跨流不误杀（AC-9）', async () => {
    const h = await harness()
    const t = await insertTrigger(h)
    await dispatchOnce(h, ev()) // !42 第一轮 → task A
    const taskA = h.launched[0]!.taskId
    // 手动把 A 恢复成 running（fake cancel 会置 canceled；此时还没被 cancel）
    await dispatchOnce(h, ev({ mrIid: '43' })) // 不同 MR：不同流，不得取消 A
    expect(h.canceled).toEqual([])
    await dispatchOnce(h, ev()) // !42 第二轮 → 取消 A
    expect(h.canceled).toEqual([taskA])
    const fires = await firesOf(h, t)
    const secondRound = fires.filter((f) => f.streamKey === 'platform/api|mr:42')
    expect(secondRound.map((f) => f.supersededTaskId)).toEqual([null, taskA])
  })

  test('熔断：bot 连发达到上限 → skipped-circuit-open；人类事件重置（AC-10）', async () => {
    const h = await harness()
    const t = await insertTrigger(h, { maxConsecutiveFires: 2 })
    await dispatchOnce(h, ev()) // 1
    await dispatchOnce(h, ev()) // 2 = 上限
    const d3 = await dispatchOnce(h, ev()) // 第 3 次 → open
    expect(await deliveryStatus(h, d3)).toEqual(['matched', null]) // fire 记录在 fires
    let fires = await firesOf(h, t)
    expect(fires.map((f) => f.outcome)).toEqual(['launched', 'launched', 'skipped-circuit-open'])
    // 人类作者的同流事件 → 清零重计 → launched
    await dispatchOnce(h, ev({ author: { username: 'dev-a' } }))
    fires = await firesOf(h, t)
    expect(fires[3]?.outcome).toBe('launched')
    const stream = (
      await h.db
        .select()
        .from(webhookTriggerStreams)
        .where(
          and(
            eq(webhookTriggerStreams.triggerId, t),
            eq(webhookTriggerStreams.streamKey, 'platform/api|mr:42'),
          ),
        )
    )[0]
    expect(stream?.consecutiveFires).toBe(1) // 清零后 +1
  })

  test('同流并发：两 dispatch 并发 → 互斥串行，后到者 supersede 先到者（AC-11）', async () => {
    const h = await harness()
    await insertTrigger(h)
    const [d1, d2] = await Promise.all([dispatchOnce(h, ev()), dispatchOnce(h, ev())])
    expect(await deliveryStatus(h, d1)).toEqual(['matched', null])
    expect(await deliveryStatus(h, d2)).toEqual(['matched', null])
    const fires = await firesOf(h)
    expect(fires.map((f) => f.outcome)).toEqual(['launched', 'launched'])
    // 串行化下第二个 fire 必须看见并取消第一个的任务 —— 无互斥时两者都查不到
    // 对方（check-then-act 交错），此断言红。
    expect(h.canceled).toEqual([h.launched[0]!.taskId])
    const alive = await h.db.select().from(tasks).where(eq(tasks.status, 'running'))
    expect(alive.length).toBe(1) // 每流至多一个活任务
  })

  test('owner 失效 → skipped-owner-invalid；目标 workflow 不可用同码（AC-13）', async () => {
    const h = await harness()
    const t = await insertTrigger(h)
    await h.db.run(
      (await import('drizzle-orm')).sql`UPDATE users SET status='disabled' WHERE id=${h.ownerId}`,
    )
    await dispatchOnce(h, ev())
    let fires = await firesOf(h, t)
    expect(fires[0]?.outcome).toBe('skipped-owner-invalid')
    // 恢复 owner、指向不存在的 workflow → assertScheduledTargetUsable 拒绝
    await h.db.run(
      (await import('drizzle-orm')).sql`UPDATE users SET status='active' WHERE id=${h.ownerId}`,
    )
    const t2 = await insertTrigger(h, { launchRefId: 'missing-wf', name: '坏目标' })
    await dispatchOnce(h, ev())
    fires = await firesOf(h, t2)
    expect(fires[0]?.outcome).toBe('skipped-owner-invalid')
    expect(fires[0]?.error).toBeTruthy()
  })

  test('autoRegister off + 未缓存 → skipped-repo-unregistered', async () => {
    const h = await harness()
    const t = await insertTrigger(h, { autoRegisterRepos: false })
    await dispatchOnce(h, ev())
    expect((await firesOf(h, t))[0]?.outcome).toBe('skipped-repo-unregistered')
  })

  test('launch 抛错 → launch-failed + 观测列 consecutive_failures 累加', async () => {
    const h = await harness()
    const t = await insertTrigger(h)
    h.launchError.current = new Error('repo-fetch-failed: gateway down')
    await dispatchOnce(h, ev())
    expect((await firesOf(h, t))[0]?.outcome).toBe('launch-failed')
    const row = (
      await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, t)).limit(1)
    )[0]
    expect(row?.lastStatus).toBe('failed')
    expect(row?.consecutiveFailures).toBe(1)
    expect(row?.lastError).toContain('repo-fetch-failed')
    // 恢复后成功 → 清零
    h.launchError.current = null
    await dispatchOnce(h, ev({ author: { username: 'dev-a' } }))
    const row2 = (
      await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, t)).limit(1)
    )[0]
    expect(row2?.lastStatus).toBe('launched')
    expect(row2?.consecutiveFailures).toBe(0)
  })

  test('坏 JSON 触发器行被跳过，好行照常（行级容错）', async () => {
    const h = await harness()
    await insertTrigger(h, { repoScope: '{not-json', name: '坏行' })
    const good = await insertTrigger(h, { name: '好行' })
    const deliveryId = await dispatchOnce(h, ev())
    expect(await deliveryStatus(h, deliveryId)).toEqual(['matched', null])
    const fires = await firesOf(h)
    expect(fires.length).toBe(1)
    expect(fires[0]?.triggerId).toBe(good)
  })

  test('parseTriggerRow：四列逐列容错原因', async () => {
    const h = await harness()
    const id = await insertTrigger(h)
    const row = (
      await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, id)).limit(1)
    )[0]!
    expect(parseTriggerRow(row).ok).toBe(true)
    expect(parseTriggerRow({ ...row, repoScope: 'x' })).toEqual({
      ok: false,
      reason: 'repo-scope-invalid',
    })
    expect(parseTriggerRow({ ...row, eventTypes: '[]' })).toEqual({
      ok: false,
      reason: 'event-types-invalid',
    })
    expect(parseTriggerRow({ ...row, launchPayload: '{"repoUrl":"x"}' })).toEqual({
      ok: false,
      reason: 'launch-payload-invalid',
    })
  })
})
