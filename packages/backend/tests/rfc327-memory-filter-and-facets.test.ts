// RFC-327 —— 按 scope / 标签检索知识的 REST 与 MCP 面。
//
// 为什么这些测试存在：用户问「有没有增加知识的 MCP/API，有没有按 scope、标签过滤的
// MCP/API」，源码对账的答案是「写有、筛半有」：REST 的 `GET /api/memories` 只收单个
// `tag`，MCP 的 `resource_read` 一个查询参数都不收（`{kind, method, id}`），于是本地
// 代理要按 scope / 标签找知识只能全量拉回来自己筛。这一批锁三件事：
//   1. 多标签过滤（any / all）在 REST 上成立，且 legacy 单值 `tag` 继续工作；
//   2. `GET /api/memories/facets` 只在**调用者可见**的记忆上聚合标签——否则标签名
//      本身就泄露了私有 scope 里有哪些记忆存在（这是本 RFC 唯一不可商量的约束）；
//   3. MCP `resource_read` 的 query 真的透传到路由，`method:'facets'` 打到 facets 端点。

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { rmSync } from 'node:fs'
import type { ProviderNeutralDatabase } from '@/db/query'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { DEFAULT_CONFIG, type Permission } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createSession } from './helpers/auth/sessionStore'
import { agents } from '../src/db/schema'
import { ALL_TOOLS, describeResource } from '../src/mcp/tools'
import { createCollaborationCommandContext } from '../src/modules/collaboration/composition'
import {
  createReviewDecisionCommand,
  createQuestionDispatchCommand,
  createClarifyDecisionCommand,
} from '@/modules/collaboration/composition/decisionCommands'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { composeMemoryOperationsFor } from '@/modules/memory/composition'
import { Paths } from '@/util/paths'
import { composeTaskExecutionTestRuntime } from './helpers/taskExecutionTestTopology'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createRouteOperationDispatcher as createDispatcher } from './helpers/routeOperationDispatcher'
import {
  forwardingOperationInvoker,
  mcpTestOperationActor as mcpDispatchActor,
  operationHandlesForInvoker,
  type RecordedOperationCall,
} from './helpers/mcpOperationRecording'
import { memoryCatalogOf } from './helpers/memoryCatalog'
import { createUser } from '../src/services/users'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness<TDb = ProviderNeutralDatabase> {
  db: TDb
  app: Hono
  configPath: string
  adminId: string
  adminToken: string
  outsiderToken: string
  outsiderId: string
  cleanup: () => void
}

function configFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-rfc327-')), 'config.json')
  writeFileSync(path, JSON.stringify(DEFAULT_CONFIG))
  return path
}

/** 两条路共用的种子：建两个用户、发两枚会话票。 */
async function seedHarness<TDb extends ProviderNeutralDatabase>(
  db: TDb,
  app: Hono,
  configPath: string,
  cleanup: () => void,
): Promise<Harness<TDb>> {
  const admin = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const outsider = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  return {
    db,
    app,
    configPath,
    adminId: admin.id,
    adminToken: (await createSession({ db, userId: admin.id })).token,
    outsiderId: outsider.id,
    outsiderToken: (await createSession({ db, userId: outsider.id })).token,
    cleanup,
  }
}

/** 双引擎那条路：库、应用、app home 都取作用域现建的。 */
async function harness(scope: ProviderHttpApplicationScope): Promise<Harness> {
  const opened = await scope.open()
  // 临时目录归作用域所有（`afterEach` 还原环境变量并删掉），用例不再自己删。
  return seedHarness(scope.harness.db, opened.app, join(opened.appHome, 'config.json'), () => {})
}

/** 单引擎那条路：只服务下面那一组还没法双跑的 MCP 用例。 */
async function nativeHarness(): Promise<Harness<DbClient>> {
  const configPath = configFile()
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox: createSecretBoxFromKey(randomBytes(32)),
  })
  return seedHarness(db, app, configPath, () =>
    rmSync(join(configPath, '..'), { recursive: true, force: true }),
  )
}

async function seedApproved(
  h: Harness,
  input: { scopeType: 'agent' | 'global'; scopeId: string | null; title: string; tags: string[] },
): Promise<string> {
  const row = await memoryCatalogOf(h.db).commands.createManual({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    title: input.title,
    bodyMd: `body of ${input.title}`,
    tags: input.tags,
  })
  await memoryCatalogOf(h.db).commands.promote(row.id, { action: 'approve' }, h.adminId)
  return row.id
}

async function get<T>(
  h: Harness,
  path: string,
  token: string,
): Promise<{ status: number; body: T }> {
  const res = await h.app.fetch(
    new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${token}` } }),
  )
  return { status: res.status, body: (await res.json()) as T }
}

interface ListBody {
  items: Array<{ id: string; title: string; tags: string[] }>
}
interface FacetsBody {
  status: string
  scopeType: string | null
  scopeId: string | null
  total: number
  tags: Array<{ tag: string; count: number }>
}

// RFC-359 AC-6：两个引擎各跑一遍。模块级 `let h` + 模块级 beforeEach 看不到 `scope`，
// 所以夹具整体上提进注册面（这是 pre-flight 的 MODULE-LEVEL-HARNESS 那一类）。
describeEachProviderHttpApplication(
  'RFC-327 —— 按 scope / 标签检索知识',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: null,
    dbVersion: 1,
    tempPrefix: 'aw-rfc327-',
  },
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      resetBroadcastersForTests()
      h = await harness(scope)
    })
    afterEach(() => h?.cleanup())

    describe('RFC-327 —— GET /api/memories 的多标签过滤', () => {
      test('tags=a,b 缺省 any：命中任一即返回；tagMode=all 要求全部命中', async () => {
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'both',
          tags: ['api', 'db'],
        })
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'only-api',
          tags: ['api'],
        })
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'neither',
          tags: ['ui'],
        })

        const any = await get<ListBody>(
          h,
          '/api/memories?status=approved&tags=api,db',
          h.adminToken,
        )
        expect(any.status).toBe(200)
        expect(any.body.items.map((i) => i.title).sort()).toEqual(['both', 'only-api'])

        const all = await get<ListBody>(
          h,
          '/api/memories?status=approved&tags=api,db&tagMode=all',
          h.adminToken,
        )
        expect(all.body.items.map((i) => i.title)).toEqual(['both'])
      })

      test('重复的 ?tags= 与逗号写法等价，空串等于没给', async () => {
        await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'x', tags: ['api'] })
        const repeated = await get<ListBody>(h, '/api/memories?tags=api&tags=db', h.adminToken)
        expect(repeated.body.items.map((i) => i.title)).toEqual(['x'])
        const empty = await get<ListBody>(h, '/api/memories?tags=', h.adminToken)
        expect(empty.body.items.length).toBe(1)
      })

      test('legacy 单值 tag 仍然工作，并与 tags 合并', async () => {
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'both',
          tags: ['api', 'db'],
        })
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'api-only',
          tags: ['api'],
        })
        const legacy = await get<ListBody>(h, '/api/memories?tag=db', h.adminToken)
        expect(legacy.body.items.map((i) => i.title)).toEqual(['both'])
        const merged = await get<ListBody>(
          h,
          '/api/memories?tag=api&tags=db&tagMode=all',
          h.adminToken,
        )
        expect(merged.body.items.map((i) => i.title)).toEqual(['both'])
      })

      test('tagMode 只收 any / all，别的值 422（不是静默忽略）', async () => {
        const bad = await get<{ code: string }>(h, '/api/memories?tagMode=both', h.adminToken)
        expect(bad.status).toBe(422)
      })
    })

    describe('RFC-327 —— GET /api/memories/facets', () => {
      test('标签计数按 count 降序、同数按标签升序；缺省只统计 approved', async () => {
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'a',
          tags: ['api', 'db'],
        })
        await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'b', tags: ['api'] })
        // 未审的候选不进缺省统计面。
        await memoryCatalogOf(h.db).commands.createManual({
          scopeType: 'global',
          scopeId: null,
          title: 'candidate',
          bodyMd: 'x',
          tags: ['secret-candidate-tag'],
        })
        const res = await get<FacetsBody>(h, '/api/memories/facets', h.adminToken)
        expect(res.status).toBe(200)
        expect(res.body.status).toBe('approved')
        expect(res.body.total).toBe(2)
        expect(res.body.tags).toEqual([
          { tag: 'api', count: 2 },
          { tag: 'db', count: 1 },
        ])
      })

      test('按 scope 收窄：只统计那个 scope 下的记忆', async () => {
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'g',
          tags: ['global-tag'],
        })
        await h.db.insert(agents).values({
          id: 'agt_1',
          name: 'a1',
          ownerUserId: h.adminId,
          visibility: 'public',
        })
        await seedApproved(h, {
          scopeType: 'agent',
          scopeId: 'agt_1',
          title: 'a',
          tags: ['agent-tag'],
        })
        const scoped = await get<FacetsBody>(
          h,
          '/api/memories/facets?scopeType=agent&scopeId=agt_1',
          h.adminToken,
        )
        expect(scoped.body.scopeType).toBe('agent')
        expect(scoped.body.tags).toEqual([{ tag: 'agent-tag', count: 1 }])
      })

      test('看不见的 scope 的标签不出现在 facets 里（标签名本身也是泄露）', async () => {
        await h.db.insert(agents).values({
          id: 'agt_private',
          name: 'private-agent',
          ownerUserId: h.adminId,
          visibility: 'private',
        })
        await seedApproved(h, {
          scopeType: 'agent',
          scopeId: 'agt_private',
          title: 'secret',
          tags: ['secret-tag'],
        })
        await seedApproved(h, {
          scopeType: 'global',
          scopeId: null,
          title: 'open',
          tags: ['open-tag'],
        })

        const owner = await get<FacetsBody>(h, '/api/memories/facets', h.adminToken)
        expect(owner.body.tags.map((t) => t.tag).sort()).toEqual(['open-tag', 'secret-tag'])

        const outsider = await get<FacetsBody>(h, '/api/memories/facets', h.outsiderToken)
        expect(outsider.body.tags.map((t) => t.tag)).toEqual(['open-tag'])
        expect(outsider.body.total).toBe(1)
      })

      test('facets 路由排在 /api/memories/:id 之前（否则 facets 会被当成一个 id）', async () => {
        const res = await get<FacetsBody>(h, '/api/memories/facets', h.adminToken)
        expect(res.status).toBe(200)
        expect(res.body).toHaveProperty('tags')
      })

      test('非法 status / scopeType ⇒ 422', async () => {
        expect((await get(h, '/api/memories/facets?status=bogus', h.adminToken)).status).toBe(422)
        expect((await get(h, '/api/memories/facets?scopeType=bogus', h.adminToken)).status).toBe(
          422,
        )
      })
    })
  },
)

// RFC-359 AC-6 —— 这一组**暂时**留在单引擎：它在夹具外面自建
// `composeTaskExecutionTestRuntime(db)`（bun:sqlite 专有：吃 `DbClient`），
// 为的是拿 `schedulerDriver` 去拼一个 route operation dispatcher。共用夹具今天交出的是
// 读模型与协作上下文（plan §5ar），还没交出 dispatcher / schedulerDriver。
// 等那层也暴露出来再接双引擎——别为了账本硬塞，那只会让它看起来双跑、实际仍只测 SQLite。
describe('RFC-327 —— MCP resource_read 的 query 透传与 facets', () => {
  // 钩子必须**在 describe 里面**：放在模块级会对文件里每一条用例都跑一遍，
  // 于是双引擎那半在 PostgreSQL 轮次里也去建一个 SQLite 应用，
  // 当场 `no such table: agent_workflow.users`（本轮实撞，判据同 pre-flight 的
  // MODULE-LEVEL-HARNESS）。
  let native: Harness<DbClient>
  beforeEach(async () => {
    resetBroadcastersForTests()
    native = await nativeHarness()
  })
  afterEach(() => native?.cleanup())

  function patActor(h: Harness, scopes: ReadonlyArray<Permission>): Actor {
    return buildActor({
      user: {
        id: h.adminId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patScopes: scopes,
      patPurpose: 'mcp_only',
    })
  }

  async function callResourceRead(args: Record<string, unknown>): Promise<{
    seen: Array<{ path: string; query: unknown }>
    value: unknown
  }> {
    const taskExecutionRuntime = composeTaskExecutionTestRuntime(native.db)
    const appHome = Paths.root
    const memoryOperations = composeMemoryOperationsFor({
      db: native.db,
      reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(native.db, appHome),
    })
    const dispatch = createDispatcher({
      token: DAEMON_TOKEN,
      configPath: native.configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db: native.db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
      schedulerDriver: taskExecutionRuntime.schedulerDriver,
      taskExecutionReadModels: taskExecutionRuntime.readModels,
      collaborationContext: createCollaborationCommandContext({
        db: native.db,
        taskExecutionReadModels: taskExecutionRuntime.readModels,
        reviewDecisions: createReviewDecisionCommand({ db: native.db, appHome }),
        questionDispatches: createQuestionDispatchCommand(native.db),
        clarifyDecisions: createClarifyDecisionCommand(native.db, memoryOperations.distillCommands),
      }),
    })
    const actor = mcpDispatchActor(patActor(native, []))
    const seen: Array<{ path: string; query: unknown }> = []
    const recorded: RecordedOperationCall[] = []
    const tool = ALL_TOOLS.find((t) => t.name === 'resource_read')!
    const ctx = {
      actor,
      operations: operationHandlesForInvoker(
        'resource_read',
        forwardingOperationInvoker(recorded, (call) => {
          seen.push({ path: call.path, query: call.query })
          return dispatch(call, actor)
        }),
      ),
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof tool.handler>[1]
    const value = await tool.handler(args, ctx)
    return { seen, value }
  }

  test('list 带 query：过滤真的到达路由（不是被丢掉）', async () => {
    await seedApproved(native, {
      scopeType: 'global',
      scopeId: null,
      title: 'both',
      tags: ['api', 'db'],
    })
    await seedApproved(native, { scopeType: 'global', scopeId: null, title: 'other', tags: ['ui'] })
    const { seen, value } = await callResourceRead({
      kind: 'memory',
      method: 'list',
      query: { status: 'approved', tags: 'api,db', tagMode: 'all' },
    })
    expect(seen[0]?.query).toEqual({ status: 'approved', tags: 'api,db', tagMode: 'all' })
    const items = (value as { items: Array<{ title: string }> }).items
    expect(items.map((i) => i.title)).toEqual(['both'])
  })

  test('method:facets 打到 facets 端点并返回标签计数', async () => {
    await seedApproved(native, { scopeType: 'global', scopeId: null, title: 'a', tags: ['api'] })
    const { seen, value } = await callResourceRead({ kind: 'memory', method: 'facets' })
    expect(seen[0]?.path).toBe('/api/memories/facets')
    expect((value as { tags: Array<{ tag: string; count: number }> }).tags).toEqual([
      { tag: 'api', count: 1 },
    ])
  })

  test('没有 facets 的 kind 明确报错，而不是悄悄退回 list', async () => {
    await expect(callResourceRead({ kind: 'agents', method: 'facets' })).rejects.toThrow(
      /has no facets/,
    )
  })

  test('describe_resource 报出 facets 操作与 query 契约（模型不用猜参数名）', () => {
    const d = describeResource('memory')
    expect(d.operations.find((o) => o.operation === 'facets')).toEqual({
      operation: 'facets',
      method: 'GET',
      path: '/api/memories/facets',
      permission: null,
    })
    const q = JSON.stringify(d.querySchema)
    for (const key of ['scopeType', 'scopeId', 'status', 'search', 'tags', 'tagMode']) {
      expect(q, `query 契约应当包含 ${key}`).toContain(key)
    }
    // 没有 query 契约的 kind 不该凭空长出一个。
    expect(describeResource('agents').querySchema).toBeUndefined()
  })
})
