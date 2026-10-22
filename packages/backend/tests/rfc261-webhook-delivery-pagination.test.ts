// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
// RFC-261 — 投递审计列表的封套化分页与过滤锁（proposal AC-1..5, AC-9, D9'）。
// 锁定：{items,total,page,pageCount} 封套、(received_at DESC, id DESC) tie-break
// 的跨页无重/漏、四过滤 AND 与 total 一致、参数钳制姿态（catch/coerce 不 422）、
// /repos distinct 选项源（读权限 + PAT 可读）、迁移 0139 索引组与 body 末列、
// 保留天数可配（gcDeliveries 参数化 + PUT /api/config 保存门 body ≤ row）。
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createUser } from './helpers/userFixture'
import { runWebhookDeliveryMaintenanceJob } from '@/platform/background/maintenanceJobRunner'
import { composeIntegrationMaintenanceCommands } from '@/modules/integration/composition/maintenance'
import { createSession } from './helpers/auth/sessionStore'
import { createPat } from './helpers/auth/patStore'
import { createWebhookDeliveryPersistence } from '../src/modules/integration/infrastructure/webhookDeliveryPersistence'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { gcDeliveries } from '../src/services/webhook/deliveryStore'
import type { WebhookDeliveryStatus } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY = 24 * 60 * 60 * 1000

type Envelope = {
  items: Array<Record<string, unknown>>
  total: number
  page: number
  pageCount: number
}

async function harness(scope: ProviderHttpApplicationScope) {
  const db = scope.harness.db
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const user = await createUser(db, {
    username: 'dev',
    displayName: 'dev',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const adminSession = (await createSession({ db, userId: admin.id })).token
  const userSession = (await createSession({ db, userId: user.id })).token
  const userPat = (
    await createPat({ db, userId: user.id, name: 'user-pat', scopes: [], purpose: 'general' })
  ).token
  const app = (await scope.open()).app
  return { db, app, adminSession, userSession, userPat }
}

type H = Awaited<ReturnType<typeof harness>>

function get(app: H['app'], path: string, token: string): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${token}` } }))
}

async function seed(
  db: PersistenceDb,
  row: {
    receivedAt: number
    status?: WebhookDeliveryStatus
    eventType?: string | null
    repoPath?: string | null
    bodyJson?: string | null
  },
): Promise<string> {
  const id = ulid()
  const { webhookDeliveries } = tablesOf(db)
  await insertOne(db, webhookDeliveries, {
    id,
    endpointId: 'ep-1', // soft link，无 FK（schema 注释），列表面不需要端点行
    eventUuid: null,
    status: row.status ?? 'matched',
    eventType: row.eventType === undefined ? 'push' : row.eventType,
    repoPath: row.repoPath === undefined ? 'platform/api' : row.repoPath,
    bodyJson: row.bodyJson ?? null,
    receivedAt: row.receivedAt,
  })
  return id
}

async function listJson(app: H['app'], token: string, qs: string): Promise<Envelope> {
  const res = await get(app, `/api/webhook-deliveries${qs}`, token)
  expect(res.status).toBe(200)
  return (await res.json()) as Envelope
}

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-261 · AC-1/AC-4 封套与参数钳制',
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc261-',
  },
  (scope) => {
    test('默认 page=1/limit=50；封套四字段；越界 page 空 items + 正确 total', async () => {
      const h = await harness(scope)
      for (let i = 0; i < 3; i += 1) await seed(h.db, { receivedAt: 1000 + i })
      const env = await listJson(h.app, h.adminSession, '')
      expect(env.items.length).toBe(3)
      expect(env.total).toBe(3)
      expect(env.page).toBe(1)
      expect(env.pageCount).toBe(1)
      // 列表投影仍不带 body_json（RFC-257 语义不变）
      expect('bodyJson' in env.items[0]!).toBe(false)

      const beyond = await listJson(h.app, h.adminSession, '?page=99')
      expect(beyond.items.length).toBe(0)
      expect(beyond.total).toBe(3)
      expect(beyond.page).toBe(99)

      // 钳制姿态：非数字/0/负数 → page 1；limit 0/非数字 → 50（coerce 不 422）
      for (const bad of ['?page=0', '?page=-3', '?page=abc', '?page=1.9&limit=0']) {
        const env2 = await listJson(h.app, h.adminSession, bad)
        expect(env2.page).toBe(1)
        expect(env2.items.length).toBe(3)
      }

      // 评审门 P1-① 红例矩阵：负数不得放行负 LIMIT（drizzle 吞负值 → 全表 dump）、
      // 小数/±Infinity 不得 500（SQLite datatype mismatch / syntax error）
      const negLimit = await listJson(h.app, h.adminSession, '?limit=-1')
      expect(negLimit.items.length).toBe(3) // -1 → 默认 50
      expect(negLimit.pageCount).toBe(1)
      const negLimitPage2 = await listJson(h.app, h.adminSession, '?limit=-1&page=2')
      expect(negLimitPage2.items.length).toBe(0) // 修复前是 `... offset ?` 无 LIMIT 的 500
      const fracLimit = await listJson(h.app, h.adminSession, '?limit=1.5')
      expect(fracLimit.items.length).toBe(1) // trunc → 1
      expect(fracLimit.pageCount).toBe(3)
      for (const inf of ['?page=Infinity', '?page=1e999', '?page=-Infinity']) {
        const env3 = await listJson(h.app, h.adminSession, inf)
        expect(env3.page).toBe(1)
        expect(env3.items.length).toBe(3)
      }
    })

    test('limit 钳到 200；pageCount 随 limit（AC-1/AC-4）', async () => {
      const h = await harness(scope)
      for (let i = 0; i < 220; i += 1) await seed(h.db, { receivedAt: 5000 })
      const env = await listJson(h.app, h.adminSession, '?limit=999')
      expect(env.items.length).toBe(200)
      expect(env.total).toBe(220)
      expect(env.pageCount).toBe(2)
      const p2 = await listJson(h.app, h.adminSession, '?limit=999&page=2')
      expect(p2.items.length).toBe(20)
    })
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-261 · AC-2 同毫秒 tie 的跨页确定性',
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc261-',
  },
  (scope) => {
    test('120 行同 receivedAt：三页无重叠无缺口，(received_at,id) DESC 全序', async () => {
      const h = await harness(scope)
      const ids: string[] = []
      for (let i = 0; i < 120; i += 1) ids.push(await seed(h.db, { receivedAt: 7777 }))
      const seen = new Set<string>()
      let prev: string | null = null
      for (const page of [1, 2, 3]) {
        const env = await listJson(h.app, h.adminSession, `?page=${page}`)
        expect(env.items.length).toBe(page === 3 ? 20 : 50)
        expect(env.pageCount).toBe(3)
        for (const item of env.items) {
          const id = item['id'] as string
          expect(seen.has(id)).toBe(false) // 无重
          seen.add(id)
          if (prev !== null) expect(id < prev).toBe(true) // id DESC 全序（跨页也单调）
          prev = id
        }
      }
      expect(seen.size).toBe(120) // 无漏
      for (const id of ids) expect(seen.has(id)).toBe(true)
    })
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-261 · AC-3 过滤 AND 与 total 一致',
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc261-',
  },
  (scope) => {
    async function seedMatrix(db: PersistenceDb): Promise<void> {
      await seed(db, { receivedAt: 1, eventType: 'push', repoPath: 'a/x', status: 'matched' })
      await seed(db, { receivedAt: 2, eventType: 'push', repoPath: 'a/x', status: 'ignored' })
      await seed(db, { receivedAt: 3, eventType: 'note', repoPath: 'a/x', status: 'matched' })
      await seed(db, { receivedAt: 4, eventType: 'push', repoPath: 'b/y', status: 'matched' })
      await seed(db, { receivedAt: 5, eventType: null, repoPath: null, status: 'rejected' })
    }

    test('eventType / repoPath / status 单独与组合过滤', async () => {
      const h = await harness(scope)
      await seedMatrix(h.db)
      expect((await listJson(h.app, h.adminSession, '?eventType=push')).total).toBe(3)
      expect((await listJson(h.app, h.adminSession, '?repoPath=a/x')).total).toBe(3)
      expect((await listJson(h.app, h.adminSession, '?status=matched')).total).toBe(3)
      const combo = await listJson(
        h.app,
        h.adminSession,
        '?eventType=push&repoPath=a/x&status=matched',
      )
      expect(combo.total).toBe(1)
      expect(combo.items[0]!['receivedAt']).toBe(1)
      // event_type IS NULL 的行（拒绝/解析失败）经状态过滤触达（D3）
      expect((await listJson(h.app, h.adminSession, '?status=rejected')).total).toBe(1)
    })

    test('非法 eventType 忽略（与 status 的 catch 姿态一致）', async () => {
      const h = await harness(scope)
      await seedMatrix(h.db)
      const env = await listJson(h.app, h.adminSession, '?eventType=bogus')
      expect(env.total).toBe(5)
    })
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-261 · AC-5 /repos distinct 选项源',
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc261-',
  },
  (scope) => {
    test('去重升序、排除 NULL；user session 与 PAT 都可读', async () => {
      const h = await harness(scope)
      // 空库（loose index scan 的递归终止分支）→ []
      const empty = await get(h.app, '/api/webhook-deliveries/repos', h.adminSession)
      expect(empty.status).toBe(200)
      expect((await empty.json()) as string[]).toEqual([])
      await seed(h.db, { receivedAt: 1, repoPath: 'b/y' })
      await seed(h.db, { receivedAt: 2, repoPath: 'a/x' })
      await seed(h.db, { receivedAt: 3, repoPath: 'a/x' })
      await seed(h.db, { receivedAt: 4, repoPath: null })
      const res = await get(h.app, '/api/webhook-deliveries/repos', h.userSession)
      expect(res.status).toBe(200)
      expect((await res.json()) as string[]).toEqual(['a/x', 'b/y'])
      const pat = await get(h.app, '/api/webhook-deliveries/repos', h.userPat)
      expect(pat.status).toBe(200)
      expect((await pat.json()) as string[]).toEqual(['a/x', 'b/y'])
      // 字面量 repos 不得被吃进 /:id（挂载顺序锁）——detail 404 语义仍在
      const missing = await get(h.app, '/api/webhook-deliveries/nope', h.adminSession)
      expect(missing.status).toBe(404)
    })
  },
)

describe('RFC-261 · AC-9 迁移 0139（规模化收口）', () => {
  test('索引组齐备：过滤维度组合索引 + body-retention 部分索引；单列 status 索引已退役', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const rows = rawRows<{ name: string }>(
      db,
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='webhook_deliveries' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    expect(rows.map((r) => r.name)).toEqual([
      'idx_webhook_deliveries_body_retention',
      'idx_webhook_deliveries_dedupe',
      'idx_webhook_deliveries_endpoint_time',
      'idx_webhook_deliveries_event_time',
      'idx_webhook_deliveries_mr_fact',
      'idx_webhook_deliveries_received_at',
      'idx_webhook_deliveries_repo_time',
      'idx_webhook_deliveries_status_time',
    ])
  })

  test('body_json 是末列（列表投影不得穿越大 body 的 overflow 链）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = rawRows<{ name: string }>(db, sql`PRAGMA table_info(webhook_deliveries)`)
    expect(cols[cols.length - 1]!.name).toBe('body_json')
  })
})

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  "RFC-261 · D9' 保留天数可配",
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc261-',
  },
  (scope) => {
    async function configHarness(initialConfig?: Record<string, unknown>) {
      const db = scope.harness.db
      // 打底内置 runtime，避免配置接口测试依赖主机上的 runtime 安装状态。
      const runtimeRegistry = composeRuntimeRegistryOperations(db)
      await runtimeRegistry.seedBuiltinRuntimes()
      await runtimeRegistry.updateRuntime('opencode', { model: 'openai/gpt-5' })
      const adminSession = 'a'.repeat(64) // daemon token（settings:write 全权）
      // 「操作者手写的存量 config.json」经作用域并进应用真正读的那份配置；
      // 自己另建一个 config 文件会被整份绕开（RFC-359 plan §5u 的老坑）。
      const opened = await scope.open(initialConfig === undefined ? {} : { config: initialConfig })
      return { app: opened.app, adminSession }
    }

    function putConfig(
      app: Awaited<ReturnType<typeof configHarness>>['app'],
      token: string,
      patch: unknown,
    ): Promise<Response> {
      return Promise.resolve(
        app.request('/api/config', {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }),
      )
    }

    test('PUT /api/config 保存门：body > row → 422 webhook-retention-invalid', async () => {
      const h = await configHarness()
      const res = await putConfig(h.app, h.adminSession, {
        webhookDeliveryBodyRetentionDays: 120,
        webhookDeliveryRowRetentionDays: 90,
      })
      expect(res.status).toBe(422)
      expect(((await res.json()) as { code: string }).code).toBe('webhook-retention-invalid')
    })

    test('合法值落盘并可回读；零/越界被 schema 拒绝；默认 30/90', async () => {
      const h = await configHarness()
      const fresh = await get(h.app, '/api/config', h.adminSession)
      const freshCfg = (await fresh.json()) as Record<string, number>
      expect(freshCfg['webhookDeliveryBodyRetentionDays']).toBe(30)
      expect(freshCfg['webhookDeliveryRowRetentionDays']).toBe(90)

      const ok = await putConfig(h.app, h.adminSession, {
        webhookDeliveryBodyRetentionDays: 7,
        webhookDeliveryRowRetentionDays: 30,
      })
      expect(ok.status).toBe(200)
      const cfg = (await (await get(h.app, '/api/config', h.adminSession)).json()) as Record<
        string,
        number
      >
      expect(cfg['webhookDeliveryBodyRetentionDays']).toBe(7)
      expect(cfg['webhookDeliveryRowRetentionDays']).toBe(30)

      expect(
        (await putConfig(h.app, h.adminSession, { webhookDeliveryBodyRetentionDays: 0 })).status,
      ).toBe(422)
      expect(
        (await putConfig(h.app, h.adminSession, { webhookDeliveryRowRetentionDays: 4000 })).status,
      ).toBe(422)
    })

    test('存量 config 手写 body>row：无关 PUT 也 422 直至修正（评审门 P2-⑤，禁用分支同等覆盖）', async () => {
      const h = await configHarness({
        webhookDeliveryBodyRetentionDays: 120,
        webhookDeliveryRowRetentionDays: 90,
      })
      // 与保留完全无关的 PUT 也被合并后全量校验拦下（RFC-255 P0 同款姿势）
      const res = await putConfig(h.app, h.adminSession, { maxConcurrentNodes: 4 })
      expect(res.status).toBe(422)
      expect(((await res.json()) as { code: string }).code).toBe('webhook-retention-invalid')
      // 修正组合后同一 PUT 放行
      const fixed = await putConfig(h.app, h.adminSession, {
        maxConcurrentNodes: 4,
        webhookDeliveryBodyRetentionDays: 30,
      })
      expect(fixed.status).toBe(200)
    })
  },
)

describe('RFC-261 · 源码层文本锁（行为等价面的兜底，CLAUDE.md 姿势）', () => {
  const SRC = resolve(import.meta.dir, '..', 'src')

  test('/repos 必须保持 loose index scan（换回朴素 DISTINCT 行为等价、900 万行下性能塌方——P2-③）', () => {
    const persistence = readFileSync(
      join(SRC, 'modules', 'integration', 'infrastructure', 'webhookDeliveryQueries.ts'),
      'utf8',
    )
    const route = readFileSync(join(SRC, 'routes', 'webhookDeliveries.ts'), 'utf8')
    expect(persistence).toContain('WITH RECURSIVE repo_walk')
    // RFC-359 W4-B4：一份中立实现，表与列经 drizzle 引用渲染（PG 侧带 schema 前缀），不再写裸表名。
    expect(persistence).toContain(
      'SELECT (SELECT min(${webhookDeliveries.repoPath}) FROM ${webhookDeliveries}',
    )
    expect(route).toContain('runtime.queries.listRepoPaths()')
    expect(route).not.toContain('@/db/')
  })
})

// RFC-359 AC-6 —— 这一块是**服务层**的（不打 HTTP），必须与上面的注册面**平级**，
// 不能嵌在里面：嵌套两层 provider 注册会交叉积，跑出 `[postgresql] > … > [postgresql]`
// 这种形态（本轮实撞，判据同 pre-flight 的 NESTED-EACHPROVIDER）。
describeEachProvider('RFC-261 delivery retention', (harness) => {
  test('gcDeliveries 按传入 retention 生效（body 清空 / 整行删除分层）', async () => {
    const db = harness.db
    const now = 100 * DAY
    const dead = await seed(db, { receivedAt: now - 25 * DAY, bodyJson: '{"a":1}' })
    const pruned = await seed(db, { receivedAt: now - 15 * DAY, bodyJson: '{"b":2}' })
    const fresh = await seed(db, { receivedAt: now - 5 * DAY, bodyJson: '{"c":3}' })
    const res = await gcDeliveries(createWebhookDeliveryPersistence(db), now, {
      bodyRetentionMs: 10 * DAY,
      rowRetentionMs: 20 * DAY,
    })
    // dead 行先被 body 段清空再被 row 段删除 → bodiesCleared 计 2（既有段序语义）
    expect(res).toEqual({ bodiesCleared: 2, rowsDeleted: 1 })
    const { webhookDeliveries } = tablesOf(db)
    const rows = await db.select().from(webhookDeliveries)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.has(dead)).toBe(false) // 25 天 > row 20 天 → 删行
    expect(byId.get(pruned)!.bodyJson).toBeNull() // 15 天 > body 10 天 → 置空
    expect(byId.get(fresh)!.bodyJson).toBe('{"c":3}') // 5 天 → 不动
  })

  test('分批清理（评审门 P1-②）：小 batchSize 跨批完整、计数正确、不越界', async () => {
    const db = harness.db
    const now = 100 * DAY
    for (let i = 0; i < 25; i += 1) {
      await seed(db, { receivedAt: now - 25 * DAY, bodyJson: `{"i":${i}}` })
    }
    await seed(db, { receivedAt: now - 1 * DAY, bodyJson: '{"keep":1}' })
    const res = await gcDeliveries(
      createWebhookDeliveryPersistence(db),
      now,
      { bodyRetentionMs: 10 * DAY, rowRetentionMs: 20 * DAY },
      10, // 25 行 → 3 批（10/10/5），锁跨批推进与终止条件
    )
    expect(res).toEqual({ bodiesCleared: 25, rowsDeleted: 25 })
    const { webhookDeliveries } = tablesOf(db)
    const left = await db.select().from(webhookDeliveries)
    expect(left.length).toBe(1)
    expect(left[0]!.bodyJson).toBe('{"keep":1}')
  })

  test('maintenance job uses the current retention policy on each sweep', async () => {
    const db = harness.db
    const now = Date.now()
    await seed(db, { receivedAt: now - 50 * DAY, bodyJson: '{"old":1}' })
    let days = { webhookDeliveryBodyRetentionDays: 3650, webhookDeliveryRowRetentionDays: 3650 }
    const commands = composeIntegrationMaintenanceCommands(createWebhookDeliveryPersistence(db))
    const sweep = async () => {
      const counters = { bodiesCleared: 0, rowsDeleted: 0 }
      let cursor: unknown
      do {
        const result = await runWebhookDeliveryMaintenanceJob({
          commands,
          bodyRetentionDays: days.webhookDeliveryBodyRetentionDays,
          rowRetentionDays: days.webhookDeliveryRowRetentionDays,
          now,
          cursor,
        })
        counters.bodiesCleared += result.counters.bodiesCleared ?? 0
        counters.rowsDeleted += result.counters.rowsDeleted ?? 0
        cursor = result.continuation?.cursor
      } while (cursor !== undefined)
      return counters
    }
    expect(await sweep()).toEqual({
      bodiesCleared: 0,
      rowsDeleted: 0,
    })
    // 两次 sweep 之间收缩保留期——不重启、不重建 ticker，直接生效
    days = { webhookDeliveryBodyRetentionDays: 30, webhookDeliveryRowRetentionDays: 40 }
    expect(await sweep()).toEqual({
      bodiesCleared: 1,
      rowsDeleted: 1,
    })
  })
})
