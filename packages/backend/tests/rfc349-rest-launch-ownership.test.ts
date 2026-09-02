// RFC-349 回归防护 —— REST 直接启动必须把**发起人**记成任务 owner。
//
// 为什么这条测试存在：RFC-349 把 `/api/agents/:id/tasks` 与
// `/api/workgroups/:id/tasks` 的启动依赖从「路由每次请求现建
// `buildStartTaskDeps(…, actor.user.id, …)`」改成了 bootstrap 冻结的一份
// `routeLaunch.execution = taskStartDepsFor(SYSTEM_USER_ID)`。`StartTaskDeps
// .actorUserId` 正是 `startTask` 写进 `tasks.owner_user_id` 的值（也是 RFC-320
// 取创建者 Git 身份的入口），于是每一条经 REST 启动的代理 / 工作组任务都变成
// **无主**：发起人自己 `GET /api/tasks/:id` 吃 404 `task-not-found`，
// `PUT /api/tasks/:id/members` 吃 403，前台看不见自己刚起的任务。
//
// 既有测试没红，是因为它们几乎都用 admin（`tasks:read:all` 绕开归属判据）或
// 直接调 service 层。这里显式用一个普通用户走完整 HTTP 面。
// 对应 e2e：rfc319-agent-delete-and-refs (AGENT-11) /
// rfc319-workgroup-launch-and-config (WG-41) 等 @nightly 用例。

import { afterEach, beforeEach, expect, test, describe } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createUser } from '../src/services/users'
import { createApp } from '../src/server'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const AGENT_FIELDS = {
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: 'do the thing',
}

describe('RFC-349 REST launch ownership', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let appHome: string
  let agentId: string
  let bobId: string
  let bobToken: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-launch-owner-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    app = createApp({
      token: 'b'.repeat(64),
      configPath: join(appHome, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const bob = await createUser(db, {
      username: 'bob',
      email: 'bob@example.test',
      displayName: 'bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    bobId = bob.id
    bobToken = (await createSession({ db, userId: bob.id })).token
    agentId = (await createAgent(db, { ...AGENT_FIELDS, name: 'owned-launch' })).id
    await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, agentId))
  })

  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const req = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${bobToken}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return await app.request(path, { ...init, headers })
  }

  test('an agent launch stamps the launching user as owner and stays readable to them', async () => {
    const launched = await req(`/api/agents/${agentId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'owned by bob',
        description: 'launch and read back',
        scratch: true,
        allowClarify: false,
      }),
    })
    expect(launched.status, await launched.clone().text()).toBe(201)
    const task = (await launched.json()) as { id: string }

    // 归属列是判据的**唯一事实源**；先直接对账，再走用户可见行为。
    const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get()
    expect(row?.ownerUserId, 'REST 启动没有把发起人写进 tasks.owner_user_id').toBe(bobId)

    const readBack = await req(`/api/tasks/${task.id}`)
    expect(readBack.status, `发起人读不回自己刚起的任务：${await readBack.clone().text()}`).toBe(
      200,
    )

    // 成员管理只对 owner 开放；无主任务会在这里吃 403。
    const members = await req(`/api/tasks/${task.id}/members`, {
      method: 'PUT',
      body: JSON.stringify({ members: [] }),
    })
    expect(members.status, await members.clone().text()).toBeLessThan(400)
  })

  // RFC-287 G7 只把**JSON `/api/tasks`** 的仓库准备推迟到任务行落库之后
  //（见 `sqliteTaskRouteOperations`）；代理 / 工作组启动保持同步语义。RFC-349 的
  // `routeLaunch` 组装把 `deferRepoPreparation: true` 一并加了上去，于是解析不出的
  // ref 不再当场 422 带服务端原话与可用引用，而是先铸一行注定失败的任务
  //（e2e `rfc319-task-wizard` TASK-06 两条断言同时红）。
  test('the Agent/Workgroup route launch keeps its synchronous repo-preparation contract', () => {
    const source = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
    const routeLaunch = /routeLaunch: \{[\s\S]*?\n {6}\},/.exec(source)?.[0]
    expect(routeLaunch, 'routeLaunch 组装块没找到（结构变了？）').toBeDefined()
    expect(routeLaunch).toContain('executionFor')
    // 只看**赋值**，别被解释这条裁决的注释绊倒。
    expect(
      routeLaunch,
      '代理 / 工作组启动又推迟了仓库准备 ⇒ 非法 ref 不再当场被拒，而是留下一行必然失败的任务',
    ).not.toMatch(/deferRepoPreparation\s*:/)
  })
})
