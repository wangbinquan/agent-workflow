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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { DEFAULT_CONFIG, type Permission } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents } from '../src/db/schema'
import { ALL_TOOLS, describeResource } from '../src/mcp/tools'
import { createCollaborationCommandContext } from '../src/modules/collaboration/composition'
import { composeTaskExecutionRuntime } from '../src/modules/task-execution/composition/taskExecutionRuntime'
import { createApp } from '../src/server'
import { createRouteOperationDispatcher as createDispatcher } from './helpers/routeOperationDispatcher'
import {
  forwardingOperationInvoker,
  mcpTestOperationActor as mcpDispatchActor,
  operationHandlesForInvoker,
  type RecordedOperationCall,
} from './helpers/mcpOperationRecording'
import { createManualCandidate, promoteCandidate } from '../src/services/memory'
import { createUser } from '../src/services/users'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
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

async function harness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const configPath = configFile()
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox: createSecretBoxFromKey(randomBytes(32)),
  })
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
    cleanup: () => rmSync(join(configPath, '..'), { recursive: true, force: true }),
  }
}

async function seedApproved(
  h: Harness,
  input: { scopeType: 'agent' | 'global'; scopeId: string | null; title: string; tags: string[] },
): Promise<string> {
  const row = await createManualCandidate(h.db, {
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    title: input.title,
    bodyMd: `body of ${input.title}`,
    tags: input.tags,
  })
  await promoteCandidate(h.db, row.id, { action: 'approve' }, h.adminId)
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

let h: Harness
beforeEach(async () => {
  resetBroadcastersForTests()
  h = await harness()
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
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'only-api', tags: ['api'] })
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'neither', tags: ['ui'] })

    const any = await get<ListBody>(h, '/api/memories?status=approved&tags=api,db', h.adminToken)
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
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'api-only', tags: ['api'] })
    const legacy = await get<ListBody>(h, '/api/memories?tag=db', h.adminToken)
    expect(legacy.body.items.map((i) => i.title)).toEqual(['both'])
    const merged = await get<ListBody>(h, '/api/memories?tag=api&tags=db&tagMode=all', h.adminToken)
    expect(merged.body.items.map((i) => i.title)).toEqual(['both'])
  })

  test('tagMode 只收 any / all，别的值 422（不是静默忽略）', async () => {
    const bad = await get<{ code: string }>(h, '/api/memories?tagMode=both', h.adminToken)
    expect(bad.status).toBe(422)
  })
})

describe('RFC-327 —— GET /api/memories/facets', () => {
  test('标签计数按 count 降序、同数按标签升序；缺省只统计 approved', async () => {
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'a', tags: ['api', 'db'] })
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'b', tags: ['api'] })
    // 未审的候选不进缺省统计面。
    await createManualCandidate(h.db, {
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
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'g', tags: ['global-tag'] })
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
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'open', tags: ['open-tag'] })

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
    expect((await get(h, '/api/memories/facets?scopeType=bogus', h.adminToken)).status).toBe(422)
  })
})

describe('RFC-327 —— MCP resource_read 的 query 透传与 facets', () => {
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
    const taskExecutionRuntime = composeTaskExecutionRuntime({ db: h.db })
    const dispatch = createDispatcher({
      token: DAEMON_TOKEN,
      configPath: h.configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db: h.db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
      schedulerDriver: taskExecutionRuntime.schedulerDriver,
      taskExecutionReadModels: taskExecutionRuntime.readModels,
      collaborationContext: createCollaborationCommandContext({
        db: h.db,
        taskExecutionReadModels: taskExecutionRuntime.readModels,
      }),
    })
    const actor = mcpDispatchActor(patActor(h, []))
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
    await seedApproved(h, {
      scopeType: 'global',
      scopeId: null,
      title: 'both',
      tags: ['api', 'db'],
    })
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'other', tags: ['ui'] })
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
    await seedApproved(h, { scopeType: 'global', scopeId: null, title: 'a', tags: ['api'] })
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
