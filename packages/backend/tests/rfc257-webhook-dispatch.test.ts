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
  migrateTriggerRowTemplateToV2,
  parseTriggerRow,
  renderWebhookLaunch,
  resolveRepoForEvent,
  type WebhookDispatchDeps,
} from '../src/services/webhook/webhookDispatch'
import type { WebhookEndpointRow } from '../src/services/webhook/dispatcherTypes'

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
  launched: Array<{
    taskId: string
    kind: string
    fireId: string
    payload: unknown
    triggerContext: unknown
  }>
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
        triggerContextJson: JSON.stringify(invoker.triggerContext),
      })
      launched.push({
        taskId,
        kind: rendered.kind,
        fireId: invoker.webhookFireId,
        payload: rendered.payload,
        // RFC-269 regression: the context must already be part of the launch
        // request. A post-launch UPDATE races scheduler's one-time task read.
        triggerContext: (invoker as typeof invoker & { triggerContext?: unknown }).triggerContext,
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
        title: {
          kind: 'template' as const,
          template: 'MR {{trigger.webhook.mr_iid}}: {{trigger.webhook.mr_title}}',
        },
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
        payloadTemplate: {
          description: '修 {{trigger.webhook.repo_path}} 的 !{{trigger.webhook.mr_iid}}',
        },
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

  test('RFC-268：三类目标的 scratch payload 只注入临时空间，不注入事件仓远端字段', () => {
    const cases = [
      {
        launchKind: 'workflow' as const,
        launchRefId: 'wf-1',
        payloadTemplate: {
          inputs: { mr_ref: { kind: 'event-branch' as const } },
          scratch: true as const,
        },
      },
      {
        launchKind: 'agent' as const,
        launchRefId: 'ag-1',
        payloadTemplate: {
          description: '修 {{trigger.webhook.repo_path}}',
          scratch: true as const,
        },
      },
      {
        launchKind: 'workgroup' as const,
        launchRefId: 'wg-1',
        payloadTemplate: { goal: '修 {{trigger.webhook.repo_path}}', scratch: true as const },
      },
    ]
    for (const trigger of cases) {
      const rendered = renderWebhookLaunch(trigger, '临时任务', ev(), { kind: 'scratch' })
      const payload = rendered.payload as unknown as Record<string, unknown>
      expect(payload['scratch']).toBe(true)
      if (rendered.kind === 'workflow') {
        const inputs = payload['inputs'] as Record<string, string>
        expect(JSON.parse(inputs['mr_ref']!)).toEqual({ kind: 'branch', ref: 'feature/x' })
      }
      for (const key of [
        'repoUrl',
        'cachedRepoId',
        'repoGroupId',
        'sourceTaskId',
        'ref',
        'workingBranch',
        'autoCommitPush',
      ]) {
        expect(key in payload).toBe(false)
      }
    }
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
    for (const launch of h.launched) {
      expect(launch.triggerContext).toMatchObject({
        trigger: {
          webhook: {
            repo_path: 'platform/api',
            mr_iid: '42',
          },
        },
      })
      expect(launch.triggerContext).not.toHaveProperty('event_json')
    }
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

  test('RFC-268：scratch 在未缓存事件仓上仍启动；坏行 autoRegister=true 也不得回落仓库解析', async () => {
    const h = await harness()
    let repoResolveCalls = 0
    h.deps.resolveRepo = async () => {
      repoResolveCalls += 1
      throw new Error('scratch must bypass repo resolution')
    }
    const t = await insertTrigger(h, {
      launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
      // 模拟历史/手工篡改坏行：dispatch 的纵深保护仍必须以 scratch 为准。
      autoRegisterRepos: true,
    })
    await dispatchOnce(h, ev())
    expect((await firesOf(h, t))[0]?.outcome).toBe('launched')
    const payload = h.launched[0]?.payload as Record<string, unknown>
    expect(payload['scratch']).toBe(true)
    expect('repoUrl' in payload).toBe(false)
    expect('cachedRepoId' in payload).toBe(false)
    expect('ref' in payload).toBe(false)
    expect(repoResolveCalls).toBe(0)
  })

  test('RFC-268：scratch 继续复用同一 stream 的 supersede 与 circuit', async () => {
    const h = await harness()
    let repoResolveCalls = 0
    h.deps.resolveRepo = async () => {
      repoResolveCalls += 1
      throw new Error('scratch must bypass repo resolution')
    }
    const t = await insertTrigger(h, {
      launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
      autoRegisterRepos: false,
      maxConsecutiveFires: 2,
    })

    await dispatchOnce(h, ev())
    const firstTaskId = h.launched[0]!.taskId
    await dispatchOnce(h, ev())
    await dispatchOnce(h, ev())

    const fires = await firesOf(h, t)
    expect(fires.map((fire) => fire.outcome)).toEqual([
      'launched',
      'launched',
      'skipped-circuit-open',
    ])
    expect(fires.map((fire) => fire.streamKey)).toEqual([
      'platform/api|mr:42',
      'platform/api|mr:42',
      'platform/api|mr:42',
    ])
    expect(fires[1]?.supersededTaskId).toBe(firstTaskId)
    expect(h.canceled).toEqual([firstTaskId])
    expect(repoResolveCalls).toBe(0)
  })

  test('RFC-268：排队期间切换空间不会把旧 payload 与新 auto-register 混成一代', async () => {
    const h = await harness()
    const originalLaunch = h.deps.launch!
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let launchCalls = 0
    h.deps.launch = async (...args) => {
      launchCalls += 1
      if (launchCalls === 1) {
        firstEntered()
        await firstRelease
      }
      return originalLaunch(...args)
    }
    const autoRegisterSeen: boolean[] = []
    h.deps.resolveRepo = async (_db, _box, _event, _endpoint, autoRegister) => {
      autoRegisterSeen.push(autoRegister)
      return { kind: 'url', repoUrl: HTTP_URL }
    }

    await insertTrigger(h, { id: 'tr-snapshot-a', autoRegisterRepos: true })
    const second = await insertTrigger(h, { id: 'tr-snapshot-b', autoRegisterRepos: true })
    const dispatch = dispatchOnce(h, ev())
    await firstBlocked

    // 同一次 dispatch 已把两行 parse 成 matched snapshot；让第二行在队列中
    // 等待时切到 scratch，证明它仍完整执行旧的 event-repo 一代。
    await h.db
      .update(webhookTriggers)
      .set({
        launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
        autoRegisterRepos: false,
      })
      .where(eq(webhookTriggers.id, second))
    releaseFirst()
    await dispatch

    expect(autoRegisterSeen).toEqual([true, true])
    expect(h.launched).toHaveLength(2)
    const secondPayload = h.launched[1]!.payload as Record<string, unknown>
    expect(secondPayload['repoUrl']).toBe(HTTP_URL)
    expect('scratch' in secondPayload).toBe(false)
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

  test('v1 模板读时 CAS 迁移为唯一 canonical v2 语法', async () => {
    const h = await harness()
    const id = await insertTrigger(h, {
      launchPayload: JSON.stringify({
        inputs: {
          prompt: { kind: 'template', template: '{{repo_path}} {{trigger.mr_iid}}' },
        },
      }),
      templateSyntaxVersion: 1,
    })
    const stored = (
      await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, id)).limit(1)
    )[0]!
    const migrated = await migrateTriggerRowTemplateToV2(h.db, stored)
    expect(migrated.templateSyntaxVersion).toBe(2)
    expect(JSON.parse(migrated.launchPayload)).toMatchObject({
      inputs: {
        prompt: {
          kind: 'template',
          template: '{{trigger.webhook.repo_path}} {{trigger.webhook.mr_iid}}',
        },
      },
    })
  })

  test('matched invalid v1/v2 trigger refs produce launch-failed fires with zero launch', async () => {
    const h = await harness()
    const v1 = await insertTrigger(h, {
      launchPayload: JSON.stringify({
        inputs: { prompt: { kind: 'template', template: '{{trigger.nope}}' } },
      }),
      templateSyntaxVersion: 1,
    })
    const v2 = await insertTrigger(h, {
      launchPayload: JSON.stringify({
        inputs: { prompt: { kind: 'template', template: '{{trigger.mr_iid}}' } },
      }),
      templateSyntaxVersion: 2,
    })
    const deliveryId = await dispatchOnce(h, ev({ author: { username: 'dev-a' } }))
    expect(await deliveryStatus(h, deliveryId)).toEqual(['matched', null])
    expect(h.launched).toHaveLength(0)
    for (const triggerId of [v1, v2]) {
      const fire = (await firesOf(h, triggerId))[0]
      expect(fire?.outcome).toBe('launch-failed')
      expect(fire?.error).toContain('payload-invalid')
    }
  })

  test('RFC-303 raw-invalid terminal policy records skipped-trigger-invalid instead of silently disappearing', async () => {
    const h = await harness()
    const triggerId = await insertTrigger(h, {
      eventTypes: JSON.stringify(['mr_opened', 'mr_closed']),
      ignoreUsernames: '[]',
      cancelOnMrTerminal: true,
    })
    const event = ev({
      eventType: 'mr_opened',
      projectId: '77',
      mrIid: '42',
      author: { username: 'human' },
    })
    const deliveryId = await dispatchOnce(h, event)
    expect(h.launched).toHaveLength(0)
    expect(await deliveryStatus(h, deliveryId)).toEqual(['matched', null])
    expect(await firesOf(h, triggerId)).toEqual([
      expect.objectContaining({
        outcome: 'skipped-trigger-invalid',
        error: 'terminal-policy-invalid',
      }),
    ])
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

// RFC-268 实现门 P2（2026-08-09）翻出的 RFC-257 存量归因错：
// `assertScheduledTargetUsable` 同时做「目标可用性」与「渲染后 payload·输入校验」，
// 早期实现把它抛出的**所有**异常记成 skipped-owner-invalid —— 与枚举语义矛盾
// （launch-failed 才是「owner 有效但启动失败（payload-invalid）」），且 skipped-*
// 分支不写 lastStatus/lastError、不推进 consecutiveFailures，于是**配错的触发器
// 永远触不了熔断**。这组测试锁住按错误类别分流后的两侧归属。
describe('RFC-257 · gate 失败归因（launch-failed vs skipped-owner-invalid）', () => {
  /** 必填 git 输入 + 无分支事件 = 渲染出空 ref，`workflow-inputs-invalid`。 */
  async function gitInputWorkflow(h: Harness): Promise<string> {
    const id = ulid()
    await h.db.insert(workflows).values({
      id,
      name: 'git-input-wf',
      description: '',
      definition: JSON.stringify({
        $schema_version: 1,
        inputs: [{ kind: 'git', key: 'repo', label: 'Repo', required: true }],
        nodes: [],
        edges: [],
      }),
      version: 1,
      ownerUserId: h.ownerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    return id
  }

  test('输入校验失败 → launch-failed，并推进 consecutiveFailures（不再伪报 owner 失效）', async () => {
    const h = await harness()
    const t = await insertTrigger(h, {
      launchRefId: await gitInputWorkflow(h),
      launchPayload: JSON.stringify({ inputs: { repo: { kind: 'event-branch' } } }),
    })
    // 无 branch 的事件（GitHub 普通 PR 评论即此形态）：代包渲染出空 ref。
    await dispatchOnce(h, ev({ branch: undefined }))
    const fires = await firesOf(h, t)
    expect(fires.map((f) => f.outcome)).toEqual(['launch-failed'])
    expect(fires[0]?.error ?? '').toContain('launch inputs failed validation')
    expect(h.launched.length).toBe(0)
    const row = (
      await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, t)).limit(1)
    )[0]!
    expect(row.lastStatus).toBe('failed')
    expect(row.consecutiveFailures).toBe(1)
    expect(row.lastError ?? '').toContain('launch inputs failed validation')
  })

  test('目标缺失 / 不可见仍是 skipped-owner-invalid，且不推进失败水位', async () => {
    const h = await harness()
    const t = await insertTrigger(h, { launchRefId: ulid() }) // 不存在的 workflow
    await dispatchOnce(h, ev())
    const fires = await firesOf(h, t)
    expect(fires.map((f) => f.outcome)).toEqual(['skipped-owner-invalid'])
    const row = (
      await h.db.select().from(webhookTriggers).where(eq(webhookTriggers.id, t)).limit(1)
    )[0]!
    expect(row.consecutiveFailures).toBe(0)
  })
})
