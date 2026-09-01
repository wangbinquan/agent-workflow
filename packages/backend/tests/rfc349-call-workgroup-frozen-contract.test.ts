// RFC-349 回归防护 —— 冻结闭包里的工作组载荷与 call-workgroup 子启动的校验必须
// 是同一份合同。
//
// 为什么这条测试存在：RFC-345 把冻结快照收窄成
// `TaskExecutionWorkgroupSnapshot`（只留启动相关字段，不含 `schemaVersion` /
// `createdAt` / `updatedAt` 这三列行元数据），而 RFC-349 新写的两个
// child-launch adapter 却用**整行** `WorkgroupSchema.parse` 去校验它。于是每一次
// `call-workgroup` 子启动都在三条 "Required" 上炸掉，父任务以
// `child-launch-failed` 收场——改造前那里是一次纯 `as` cast，没有运行期校验，所以
// 收窄没有立刻显形。e2e `rfc319-workgroup-dynamic-and-calls` 的 WG-42 是同一条路径。
//
// 这里锁两端：①真实启动冻出来的载荷确实不带行元数据（收窄合同还在）；
// ②子启动的校验（`FrozenWorkgroupGroupSchema`）接受它，而整行 schema 会拒绝它。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { WorkgroupSchema } from '@agent-workflow/shared'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks } from '../src/db/schema'
import { createUser } from '../src/services/users'
import { createApp } from '../src/server'
import { FrozenWorkgroupGroupSchema } from '../src/modules/task-execution/infrastructure/legacyCallClosure'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-349 call-workgroup frozen closure contract', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let appHome: string
  let token: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-callwg-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    app = createApp({
      token: 'c'.repeat(64),
      configPath: join(appHome, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const admin = await createUser(db, {
      username: 'callwg_admin',
      email: 'callwg-admin@example.test',
      displayName: 'callwg admin',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    token = (await createSession({ db, userId: admin.id })).token
  })

  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const req = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return await app.request(path, { ...init, headers })
  }

  test('the frozen workgroup payload a real launch stores is exactly what the child launch validates', async () => {
    const agentResponse = await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc349-callwg-lead',
        description: '',
        outputs: [],
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        permission: {},
        bodyMd: 'lead the group',
      }),
    })
    expect(agentResponse.status, await agentResponse.clone().text()).toBe(201)
    const agent = (await agentResponse.json()) as { id: string }

    const groupResponse = await req('/api/workgroups', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc349-callwg-group',
        description: '',
        instructions: 'charter',
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 3,
        completionGate: false,
        clarifyBudget: 0,
        fanOut: false,
        members: [
          {
            memberType: 'agent',
            agentId: agent.id,
            displayName: 'lead',
            roleDesc: 'coordinate',
          },
        ],
      }),
    })
    expect(groupResponse.status, await groupResponse.clone().text()).toBe(201)
    const group = (await groupResponse.json()) as { id: string; name: string }

    const workflowResponse = await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc349-callwg-parent',
        description: '',
        definition: {
          $schema_version: 5,
          inputs: [{ kind: 'text', key: 'req', label: 'Requirement' }],
          nodes: [
            { id: 'pin', kind: 'input', position: { x: 0, y: 0 }, inputKey: 'req' },
            {
              id: 'call_wg',
              kind: 'call-workgroup',
              position: { x: 220, y: 0 },
              goalTemplate: 'GOAL::{{req}}',
              workgroupId: group.id,
              workgroupName: group.name,
            },
          ],
          edges: [
            {
              id: 'e1',
              source: { nodeId: 'pin', portName: 'req' },
              target: { nodeId: 'call_wg', portName: 'req' },
            },
          ],
        },
      }),
    })
    expect(workflowResponse.status, await workflowResponse.clone().text()).toBe(201)
    const workflow = (await workflowResponse.json()) as { id: string }

    const launch = await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow.id,
        name: 'rfc349 call-workgroup parent',
        scratch: true,
        inputs: { req: 'ship it' },
      }),
    })
    expect(launch.status, await launch.clone().text()).toBe(201)
    const task = (await launch.json()) as { id: string }

    const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get()
    const closure = JSON.parse(row?.refClosureJson ?? 'null') as {
      workgroups: Record<string, { id: string; version: number; group: Record<string, unknown> }>
    } | null
    const frozen = Object.values(closure?.workgroups ?? {})[0]
    expect(frozen, 'call-workgroup 节点没有冻结进闭包 ⇒ 子启动无从取花名册').toBeDefined()

    // ① 收窄合同：冻结载荷不带行元数据。若哪天它又带上了，说明快照回退成整行，
    //    RFC-345 的公共合同被绕过。
    expect(Object.keys(frozen!.group)).not.toContain('schemaVersion')
    expect(Object.keys(frozen!.group)).not.toContain('createdAt')
    expect(Object.keys(frozen!.group)).not.toContain('updatedAt')

    // ② 子启动读的就是这一份：它必须接受，而整行 schema 必须拒绝——后者正是回归时
    //    抛出的那三条 "Required"。
    const parsed = FrozenWorkgroupGroupSchema.parse(frozen!.group)
    expect(parsed.id).toBe(group.id)
    expect(WorkgroupSchema.safeParse(frozen!.group).success).toBe(false)
  }, 30_000)
})
