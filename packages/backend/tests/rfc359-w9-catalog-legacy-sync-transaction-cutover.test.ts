// RFC-359 W9 —— resource-catalog legacy（agent / workflow / workgroup）的**删除 / 改名面**
// 从 bun:sqlite 独有的同步 `dbTxSync` 切到中立事务原语之后的行为锁。
//
// # 为什么这些用例存在
//
// 这是**行为改动**，不是纯搬运。切换本身要求把事务体里的每一条语句改成 `await`，而漏掉 await
// 有三档、后两档只在 PostgreSQL 上现形（本波实撞收窄出来的准确版本）：
//
//   ① 既不 `.run()` 也不 `await`（惰性 `QueryPromise`）→ 语句**两个引擎都不发生** ⇒ 双引擎全红。
//   ② `.all()` / `.get()` 不 await → **只有 PG 红**：拿到的是 Promise 而不是行数组。
//      毒性最大的形态就在这一档：删除面的**守卫读**若不 await，`rows.length` 恒为 undefined、
//      `refs.length > 0` 恒假 ⇒ **守卫静默失效，删除照做**。所以下面每一条「守卫拒绝 + 行还在」
//      的用例在 PG 上都是这一档的探针，而不只是错误码回归。
//   ③ `.run()` 不 await → **只有 PG 红且静默**：`changes` 恒为 `undefined`，CAS 判据失真。
//      本刀正是把改名的 CAS 判据从 `.run().changes` 换成中立的 `affectedRows`，
//      于是「带围栏的改名要成功」这一条就是③的探针：旧形态在 PG 上会把一次合法改名判成 stale。
//
// # 为什么两个引擎各跑一遍
//
// 切换后这几条路径整体 provider 中立：读一律 `await …limit(1)` / `await …`（不用 `.get()` /
// `.all()`），写一律 `await`，CAS 走 `affectedRows`，事务边界走 `databaseSessionFor(db).transaction`。
// SQLite 是同步驱动，drizzle 的 thenable 在微任务里当场 resolve——漏 await 时 SQLite 往往照样绿，
// **只有 PG 才炸**。双引擎因此是判据的一半，不是锦上添花。
//
// # 关于「回滚」
//
// 本刀转掉的六个站点**都是「若干守卫读 + 一条写」**的形状：写是事务体的最后一条语句，之后没有
// 任何可能抛错的判据。也就是说这里不存在「写了一半再回滚」的可达路径——事务在这里买到的是
// **「守卫与写看同一个快照」**（RFC-165 F17-r3 的原话：check-then-await-then-write 会让引用在
// 检查与删除之间落进来）。因此下面的失败路径判据统一写成「拒绝 + 零副作用（行原样还在、
// 版本 / 名字未动）」，而不是假装去锁一条不存在的半写回滚。这一点在报告里也照实写了。
//
// # 种数据为什么不走 createAgent / createWorkflow
//
// 那几条 create 路径仍钉在 `dbTxSync` 上（体内的提交臂被 aggregateAdapters 的
// `(tx: DbTxSync, …) => …` 参与者契约共用），在 PostgreSQL 客户端上 `dbTxSync` 拿到的是
// sqlite-proxy 的**异步** `transaction`，返回一个没人 await 的 Promise ⇒ 写既不落库也不报错。
// 所以夹具一律直接 `insert`，不借用尚未切换的写路径。

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  resourceGrants,
  scheduledTasks,
  tasks,
  users,
  workflows,
  workgroupTaskState,
  workgroups,
} from '@/db/schema'
import { deleteAgent, renameAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { deleteWorkflow } from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import { deleteWorkgroup } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import {
  casGateStatus,
  ensureWorkgroupTaskStateRow,
  loadWorkgroupTaskState,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroup/state'
import { ConflictError, ForbiddenError, NotFoundError } from '@/util/errors'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = 'user_rfc359_w9_catalog_owner'
const OTHER = 'user_rfc359_w9_catalog_other'

function actorFor(id: string, role: 'user' | 'admin' = 'user'): Actor {
  return {
    user: {
      id,
      username: id,
      displayName: id,
      role,
      status: 'active',
    },
    source: 'session',
    // `resource-acl:private` 是「我的资源默认私有」的能力位，不是 ACL bypass。
    permissions: new Set(['resource-acl:private']),
  } as unknown as Actor
}

const owner = actorFor(OWNER)
const stranger = actorFor(OTHER)

async function seedUser(harness: ProviderHarness, id: string): Promise<void> {
  const now = Date.now()
  await harness.db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof users.$inferInsert)
}

interface SeededAgent {
  id: string
  name: string
  updatedAt: number
  aclRevision: number
}

async function seedAgent(
  harness: ProviderHarness,
  overrides: Partial<typeof agents.$inferInsert> = {},
): Promise<SeededAgent> {
  const now = Date.now()
  const row = {
    id: ulid(),
    name: `agent-${ulid()}`,
    description: '',
    outputs: '[]',
    inputs: '[]',
    syncOutputsOnIterate: true,
    runtime: null,
    permission: '{}',
    skills: '[]',
    dependsOn: '[]',
    mcp: '[]',
    plugins: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    ownerUserId: OWNER,
    visibility: 'private' as const,
    aclRevision: 0,
    builtin: false,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  await harness.db.insert(agents).values(row as typeof agents.$inferInsert)
  return {
    id: row.id,
    name: row.name,
    updatedAt: row.updatedAt,
    aclRevision: row.aclRevision,
  }
}

async function seedWorkflow(
  harness: ProviderHarness,
  overrides: Partial<typeof workflows.$inferInsert> = {},
): Promise<{ id: string; version: number }> {
  const now = Date.now()
  const row = {
    id: ulid(),
    name: `wf-${ulid()}`,
    description: '',
    definition: JSON.stringify({ $schema_version: 1, nodes: [], edges: [] }),
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private' as const,
    aclRevision: 0,
    builtin: false,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  await harness.db.insert(workflows).values(row as typeof workflows.$inferInsert)
  return { id: row.id, version: row.version }
}

async function seedWorkgroup(
  harness: ProviderHarness,
  overrides: Partial<typeof workgroups.$inferInsert> = {},
): Promise<{ id: string; version: number }> {
  const now = Date.now()
  const row = {
    id: ulid(),
    name: `wg-${ulid()}`,
    description: '',
    instructions: '',
    mode: 'leader_worker' as const,
    outputContract: 'files' as const,
    leaderMemberId: null,
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private' as const,
    aclRevision: 0,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  await harness.db.insert(workgroups).values(row as typeof workgroups.$inferInsert)
  return { id: row.id, version: row.version }
}

/** 一行非终态任务；`workflowId` 必填，按被测的引用面挂 sourceAgentId / workgroupId。 */
async function seedRunningTask(
  harness: ProviderHarness,
  overrides: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await harness.db.insert(tasks).values({
    id,
    name: 'running task',
    workflowId: overrides.workflowId ?? ulid(),
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as typeof tasks.$inferInsert)
  return id
}

async function seedSchedule(
  harness: ProviderHarness,
  launchKind: 'agent' | 'workflow' | 'workgroup',
  payload: Record<string, string>,
): Promise<void> {
  const now = Date.now()
  await harness.db.insert(scheduledTasks).values({
    id: ulid(),
    name: 'nightly',
    ownerUserId: OWNER,
    launchKind,
    launchPayload: JSON.stringify(payload),
    scheduleSpec: '{"kind":"interval"}',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  } as typeof scheduledTasks.$inferInsert)
}

async function grantView(
  harness: ProviderHarness,
  type: 'agent' | 'workflow' | 'workgroup',
  resourceId: string,
  userId: string,
): Promise<void> {
  await harness.db.insert(resourceGrants).values({
    resourceType: type,
    resourceId,
    userId,
    level: 'read',
    addedBy: OWNER,
    addedAt: Date.now(),
  } as typeof resourceGrants.$inferInsert)
}

async function agentRow(
  harness: ProviderHarness,
  id: string,
): Promise<typeof agents.$inferSelect | undefined> {
  return (await harness.db.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
}

async function workflowExists(harness: ProviderHarness, id: string): Promise<boolean> {
  return (await harness.db.select().from(workflows).where(eq(workflows.id, id)).limit(1)).length > 0
}

async function workgroupExists(harness: ProviderHarness, id: string): Promise<boolean> {
  return (
    (await harness.db.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)).length > 0
  )
}

/** 断言 reject 且带上期望的领域错误码；顺带把「什么都没抛」这一档也报得清楚。 */
async function expectDomainError(
  run: () => Promise<unknown>,
  ctor: new (...args: never[]) => Error,
  code: string,
): Promise<void> {
  let thrown: unknown
  try {
    await run()
  } catch (error) {
    thrown = error
  }
  expect(thrown, `期望抛 ${ctor.name}(${code})，但调用正常返回了`).toBeInstanceOf(ctor)
  expect((thrown as { code?: string }).code).toBe(code)
}

// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W9 —— catalog legacy 删除 / 改名面的中立事务切换', (harness) => {
  beforeEach(async () => {
    await seedUser(harness, OWNER)
    await seedUser(harness, OTHER)
  })

  const db = (): DbClient => harness.db as DbClient

  // ── deleteAgent ───────────────────────────────────────────────────────────

  describe('deleteAgent', () => {
    test('无围栏删除：行确实消失（写漏 await 时两个引擎都会留下这一行）', async () => {
      const agent = await seedAgent(harness)

      await deleteAgent(db(), agent.id, owner)

      expect(await agentRow(harness, agent.id)).toBeUndefined()
    })

    test('工作流定义引用 ⇒ agent-in-use，且 agent 行原样还在', async () => {
      const agent = await seedAgent(harness)
      await seedWorkflow(harness, {
        definition: JSON.stringify({
          $schema_version: 1,
          nodes: [{ id: 'n1', kind: 'agent-single', agentId: agent.id }],
          edges: [],
        }),
      })

      // 守卫读（workflows 全表）漏 await 时，PG 上 `wfRows` 是个 Promise、
      // `workflowsUsingAgentIn` 迭代不出任何东西 ⇒ 这一删会**静默成功**。
      await expectDomainError(
        () => deleteAgent(db(), agent.id, owner),
        ConflictError,
        'agent-in-use',
      )
      expect(await agentRow(harness, agent.id)).toBeDefined()
    })

    test('别的 agent 的 dependsOn 引用 ⇒ agent-dependency-still-referenced，行还在', async () => {
      const agent = await seedAgent(harness)
      await seedAgent(harness, { dependsOn: JSON.stringify([agent.id]) })

      await expectDomainError(
        () => deleteAgent(db(), agent.id, owner),
        ConflictError,
        'agent-dependency-still-referenced',
      )
      expect(await agentRow(harness, agent.id)).toBeDefined()
    })

    test('非终态单 agent 任务引用 ⇒ agent-tasks-active，行还在', async () => {
      const agent = await seedAgent(harness)
      await seedRunningTask(harness, { sourceAgentId: agent.id })

      await expectDomainError(
        () => deleteAgent(db(), agent.id, owner),
        ConflictError,
        'agent-tasks-active',
      )
      expect(await agentRow(harness, agent.id)).toBeDefined()
    })

    test('定时任务指向该 agent ⇒ agent-scheduled-referenced，行还在', async () => {
      const agent = await seedAgent(harness)
      await seedSchedule(harness, 'agent', { agentId: agent.id })

      await expectDomainError(
        () => deleteAgent(db(), agent.id, owner),
        ConflictError,
        'agent-scheduled-referenced',
      )
      expect(await agentRow(harness, agent.id)).toBeDefined()
    })

    test('带围栏删除：围栏对得上就删掉', async () => {
      const agent = await seedAgent(harness)

      await deleteAgent(db(), agent.id, owner, {
        expectedUpdatedAt: agent.updatedAt,
        expectedAclRevision: agent.aclRevision,
      })

      expect(await agentRow(harness, agent.id)).toBeUndefined()
    })

    test('带围栏删除：updatedAt 过期 ⇒ stale 409，行还在', async () => {
      const agent = await seedAgent(harness)

      await expectDomainError(
        () =>
          deleteAgent(db(), agent.id, owner, {
            expectedUpdatedAt: agent.updatedAt - 1,
            expectedAclRevision: agent.aclRevision,
          }),
        ConflictError,
        'resource-operation-stale',
      )
      expect(await agentRow(harness, agent.id)).toBeDefined()
    })

    test('带围栏删除：只有只读授权的人 ⇒ 403 govern-owner-only，行还在', async () => {
      const agent = await seedAgent(harness)
      await grantView(harness, 'agent', agent.id, OTHER)

      await expectDomainError(
        () =>
          deleteAgent(db(), agent.id, stranger, {
            expectedUpdatedAt: agent.updatedAt,
            expectedAclRevision: agent.aclRevision,
          }),
        ForbiddenError,
        'resource-govern-owner-only',
      )
      expect(await agentRow(harness, agent.id)).toBeDefined()
    })

    test('带围栏删除：完全看不见的人拿到 404（不是 403），行还在', async () => {
      const agent = await seedAgent(harness)

      await expectDomainError(
        () =>
          deleteAgent(db(), agent.id, stranger, {
            expectedUpdatedAt: agent.updatedAt,
            expectedAclRevision: agent.aclRevision,
          }),
        NotFoundError,
        'agent-not-found',
      )
      expect(await agentRow(harness, agent.id)).toBeDefined()
    })
  })

  // ── renameAgent ───────────────────────────────────────────────────────────

  describe('renameAgent', () => {
    test('无围栏改名：名字换掉、updatedAt 前进', async () => {
      const agent = await seedAgent(harness)

      const renamed = await renameAgent(db(), agent.id, { newName: 'renamed-plain' })

      expect(renamed.name).toBe('renamed-plain')
      const row = await agentRow(harness, agent.id)
      expect(row?.name).toBe('renamed-plain')
      expect(row?.updatedAt).toBeGreaterThan(agent.updatedAt - 1)
    })

    test('带围栏改名成功 —— CAS 判据走 affectedRows（`.run().changes` 在 PG 上恒 undefined）', async () => {
      const agent = await seedAgent(harness)

      const renamed = await renameAgent(
        db(),
        agent.id,
        { newName: 'renamed-fenced' },
        {
          actor: owner,
          expectedUpdatedAt: agent.updatedAt,
          expectedAclRevision: agent.aclRevision,
        },
      )

      // 旧形态（`changesOf(tx.update(...).run())`）在 PG 上 `changes` 恒为 undefined ⇒ 判成 0 ⇒
      // 这一条合法改名会被误判成 stale。它绿着，说明判据换成中立的 affectedRows 之后确实生效。
      expect(renamed.name).toBe('renamed-fenced')
      expect((await agentRow(harness, agent.id))?.name).toBe('renamed-fenced')
    })

    test('带围栏改名：aclRevision 过期 ⇒ stale 409，名字没动', async () => {
      const agent = await seedAgent(harness)

      await expectDomainError(
        () =>
          renameAgent(
            db(),
            agent.id,
            { newName: 'should-not-land' },
            {
              actor: owner,
              expectedUpdatedAt: agent.updatedAt,
              expectedAclRevision: agent.aclRevision + 1,
            },
          ),
        ConflictError,
        'resource-operation-stale',
      )
      expect((await agentRow(harness, agent.id))?.name).toBe(agent.name)
    })

    test('同 owner 下重名 ⇒ agent-name-in-use，名字没动', async () => {
      const agent = await seedAgent(harness)
      const taken = await seedAgent(harness)

      await expectDomainError(
        () => renameAgent(db(), agent.id, { newName: taken.name }),
        ConflictError,
        'agent-name-in-use',
      )
      expect((await agentRow(harness, agent.id))?.name).toBe(agent.name)
    })

    test('名字没变的 no-op 改名照样过治理围栏：围栏过期 ⇒ stale 409', async () => {
      const agent = await seedAgent(harness)

      await expectDomainError(
        () =>
          renameAgent(
            db(),
            agent.id,
            { newName: agent.name },
            {
              actor: owner,
              expectedUpdatedAt: agent.updatedAt - 1,
              expectedAclRevision: agent.aclRevision,
            },
          ),
        ConflictError,
        'resource-operation-stale',
      )
      expect((await agentRow(harness, agent.id))?.name).toBe(agent.name)
    })

    test('名字没变的 no-op 改名：围栏对得上就原样返回，行不动', async () => {
      const agent = await seedAgent(harness)

      const same = await renameAgent(
        db(),
        agent.id,
        { newName: agent.name },
        {
          actor: owner,
          expectedUpdatedAt: agent.updatedAt,
          expectedAclRevision: agent.aclRevision,
        },
      )

      expect(same.name).toBe(agent.name)
      expect((await agentRow(harness, agent.id))?.updatedAt).toBe(agent.updatedAt)
    })

    test('名字没变的 no-op 改名：只读授权的人 ⇒ 403（这条门不能被 no-op 绕过）', async () => {
      const agent = await seedAgent(harness)
      await grantView(harness, 'agent', agent.id, OTHER)

      await expectDomainError(
        () =>
          renameAgent(
            db(),
            agent.id,
            { newName: agent.name },
            {
              actor: stranger,
              expectedUpdatedAt: agent.updatedAt,
              expectedAclRevision: agent.aclRevision,
            },
          ),
        ForbiddenError,
        'resource-govern-owner-only',
      )
    })
  })

  // ── deleteWorkflow ────────────────────────────────────────────────────────

  describe('deleteWorkflow', () => {
    const del = (id: string, expectedVersion: number, actor: Actor = owner) =>
      deleteWorkflow(
        db(),
        id,
        { expectedVersion, clientMutationId: ulid() },
        { kind: 'actor', actor },
      )

    test('版本对得上 ⇒ 删掉（DELETE … RETURNING 在两个引擎上都要 await）', async () => {
      const wf = await seedWorkflow(harness)

      await del(wf.id, wf.version)

      expect(await workflowExists(harness, wf.id)).toBe(false)
    })

    test('删除受众（resource_grants）与 DELETE 同事务读走：有授权行时删除照常完成', async () => {
      const wf = await seedWorkflow(harness)
      await grantView(harness, 'workflow', wf.id, OTHER)

      // `new Set(await listResourceGrantUserIdsForTx(...))` —— 漏掉 await 时 `new Set(Promise)`
      // 直接抛（Promise 不可迭代），两个引擎都红；这一条绿即那次读真的落在事务里。
      await del(wf.id, wf.version)

      expect(await workflowExists(harness, wf.id)).toBe(false)
    })

    test('版本不符 ⇒ stale 409，行还在', async () => {
      const wf = await seedWorkflow(harness)

      await expectDomainError(
        () => del(wf.id, wf.version + 1),
        ConflictError,
        'resource-operation-stale',
      )
      expect(await workflowExists(harness, wf.id)).toBe(true)
    })

    test('非终态任务引用 ⇒ workflow-in-use，行还在', async () => {
      const wf = await seedWorkflow(harness)
      await seedRunningTask(harness, { workflowId: wf.id })

      await expectDomainError(() => del(wf.id, wf.version), ConflictError, 'workflow-in-use')
      expect(await workflowExists(harness, wf.id)).toBe(true)
    })

    test('定时任务指向该工作流 ⇒ workflow-scheduled-referenced，行还在', async () => {
      const wf = await seedWorkflow(harness)
      await seedSchedule(harness, 'workflow', { workflowId: wf.id })

      await expectDomainError(
        () => del(wf.id, wf.version),
        ConflictError,
        'workflow-scheduled-referenced',
      )
      expect(await workflowExists(harness, wf.id)).toBe(true)
    })

    test('只读授权的人 ⇒ 403 govern-owner-only，行还在', async () => {
      const wf = await seedWorkflow(harness)
      await grantView(harness, 'workflow', wf.id, OTHER)

      await expectDomainError(
        () => del(wf.id, wf.version, stranger),
        ForbiddenError,
        'resource-govern-owner-only',
      )
      expect(await workflowExists(harness, wf.id)).toBe(true)
    })

    test('完全看不见的人 ⇒ 404，行还在', async () => {
      const wf = await seedWorkflow(harness)

      await expectDomainError(
        () => del(wf.id, wf.version, stranger),
        NotFoundError,
        'workflow-not-found',
      )
      expect(await workflowExists(harness, wf.id)).toBe(true)
    })
  })

  // ── deleteWorkgroup ───────────────────────────────────────────────────────

  describe('deleteWorkgroup', () => {
    const del = (id: string, expectedVersion: number, actor: Actor = owner) =>
      deleteWorkgroup(
        db(),
        id,
        { expectedVersion, clientMutationId: ulid() },
        { kind: 'actor', actor },
      )

    test('版本对得上 ⇒ 删掉', async () => {
      const wg = await seedWorkgroup(harness)

      await del(wg.id, wg.version)

      expect(await workgroupExists(harness, wg.id)).toBe(false)
    })

    test('删除受众与 DELETE 同事务读走：有授权行时删除照常完成', async () => {
      const wg = await seedWorkgroup(harness)
      await grantView(harness, 'workgroup', wg.id, OTHER)

      await del(wg.id, wg.version)

      expect(await workgroupExists(harness, wg.id)).toBe(false)
    })

    test('版本不符 ⇒ stale 409，行还在', async () => {
      const wg = await seedWorkgroup(harness)

      await expectDomainError(
        () => del(wg.id, wg.version + 1),
        ConflictError,
        'resource-operation-stale',
      )
      expect(await workgroupExists(harness, wg.id)).toBe(true)
    })

    test('非终态任务引用 ⇒ workgroup-in-use，行还在', async () => {
      const wg = await seedWorkgroup(harness)
      await seedRunningTask(harness, { workgroupId: wg.id })

      await expectDomainError(() => del(wg.id, wg.version), ConflictError, 'workgroup-in-use')
      expect(await workgroupExists(harness, wg.id)).toBe(true)
    })

    test('定时任务指向该工作组 ⇒ workgroup-scheduled-referenced，行还在', async () => {
      const wg = await seedWorkgroup(harness)
      await seedSchedule(harness, 'workgroup', { workgroupId: wg.id })

      await expectDomainError(
        () => del(wg.id, wg.version),
        ConflictError,
        'workgroup-scheduled-referenced',
      )
      expect(await workgroupExists(harness, wg.id)).toBe(true)
    })

    test('只读授权的人 ⇒ 403 govern-owner-only，行还在', async () => {
      const wg = await seedWorkgroup(harness)
      await grantView(harness, 'workgroup', wg.id, OTHER)

      await expectDomainError(
        () => del(wg.id, wg.version, stranger),
        ForbiddenError,
        'resource-govern-owner-only',
      )
      expect(await workgroupExists(harness, wg.id)).toBe(true)
    })

    test('完全看不见的人 ⇒ 404，行还在', async () => {
      const wg = await seedWorkgroup(harness)

      await expectDomainError(
        () => del(wg.id, wg.version, stranger),
        NotFoundError,
        'workgroup-not-found',
      )
      expect(await workgroupExists(harness, wg.id)).toBe(true)
    })
  })

  // ── casGateStatus（事务整个去掉，单语句 CAS） ─────────────────────────────

  describe('casGateStatus', () => {
    test('from 命中 ⇒ true 且状态 / 摘要都落库', async () => {
      const taskId = await seedRunningTask(harness)
      await ensureWorkgroupTaskStateRow(db(), taskId)

      const ok = await casGateStatus(db(), taskId, {
        from: ['idle', 'rejected'],
        to: 'declared',
        summary: 'done',
      })

      expect(ok).toBe(true)
      const state = await loadWorkgroupTaskState(db(), taskId)
      expect(state.gateStatus).toBe('declared')
      expect(state.gateSummary).toBe('done')
    })

    test('from 不命中 ⇒ false 且一个字段都没动（RETURNING 的行数就是 swap 结果）', async () => {
      const taskId = await seedRunningTask(harness)
      await ensureWorkgroupTaskStateRow(db(), taskId)

      // 迁移合法（declared → awaiting_confirmation），但当前行是 idle ⇒ WHERE 不命中。
      const ok = await casGateStatus(db(), taskId, {
        from: ['declared'],
        to: 'awaiting_confirmation',
      })

      expect(ok).toBe(false)
      const state = await loadWorkgroupTaskState(db(), taskId)
      expect(state.gateStatus).toBe('idle')
      expect(state.gateSummary).toBeNull()
    })

    test('非法迁移在发语句之前就抛（转移表判据没有随事务一起丢掉）', async () => {
      const taskId = await seedRunningTask(harness)
      await ensureWorkgroupTaskStateRow(db(), taskId)

      await expect(
        casGateStatus(db(), taskId, { from: ['idle'], to: 'approved' }),
      ).rejects.toBeInstanceOf(Error)
      expect((await loadWorkgroupTaskState(db(), taskId)).gateStatus).toBe('idle')
    })

    test('行不存在 ⇒ false，不抛也不凭空造行', async () => {
      const ok = await casGateStatus(db(), 'task_does_not_exist', {
        from: ['idle'],
        to: 'declared',
      })

      expect(ok).toBe(false)
      const rows = await harness.db
        .select()
        .from(workgroupTaskState)
        .where(eq(workgroupTaskState.taskId, 'task_does_not_exist'))
      expect(rows).toHaveLength(0)
    })
  })
})
