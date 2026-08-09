// RFC-271 T19/T20/T22 —— 导出闭包遍历与四道门。
//
// 用户给的原则决定了这几道门长什么样：
//   「这个人具备整颗树权限就可以导出……遇到自己没权限的资源就整体不能导出」
//   「你能看见别人的资源，你就拥有这个资源的权限了……可见即有读权限」
//
// 于是：**行级可见性**是唯一的读侧判据（含传递），而**类型级 `*:read` 不是门**
// ——最后一条用**反向锁**钉住（可见但缺该类型权限点 ⇒ 必须导出成功），防止未来
// 有人以「补齐权限校验」为由把它加回去。

//
// 覆盖验收条款：AC-2b（同名重复门）/ AC-7b / AC-7c / AC-7d（反向锁） / AC-8（特权节点按轴判定）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, workflows } from '../src/db/schema'
import {
  assertNoDuplicateNames,
  assertPrivilegedNodesExportable,
  directRefsOf,
  walkExportClosure,
} from '../src/services/resourcePackage/closure'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ⚠️ **直接构造** Actor 而不是走 `buildActor`：后者按**角色**算权限、忽略调用方
// 传的集合，于是「一个权限点都没有」这种形态根本构造不出来——而 AC-7d 的反向锁
// 恰恰需要它。这几道门是纯函数，手工构造身份是最诚实的做法。
const actorOf = (id: string, permissions: string[] = []): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set(permissions),
  }) as unknown as Actor

const defn = (nodes: unknown[]): WorkflowDefinition =>
  ({ $schema_version: 4, inputs: [], nodes, edges: [] }) as unknown as WorkflowDefinition

async function seedAgent(
  db: DbClient,
  owner: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = ulid()
  await db
    .insert(agents)
    .values({
      id,
      name,
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: owner,
      visibility: 'private',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...extra,
    } as never)
    .run()
  return id
}

async function seedMcp(db: DbClient, owner: string, name: string): Promise<string> {
  const id = ulid()
  await db
    .insert(mcps)
    .values({
      id,
      name,
      description: '',
      type: 'remote',
      config: JSON.stringify({ url: 'https://x.test/mcp' }),
      enabled: true,
      ownerUserId: owner,
      visibility: 'private',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
    .run()
  return id
}

async function seedWorkflow(
  db: DbClient,
  owner: string,
  name: string,
  definition: WorkflowDefinition,
): Promise<string> {
  const id = ulid()
  await db
    .insert(workflows)
    .values({
      id,
      name,
      description: '',
      definition: JSON.stringify(definition),
      ownerUserId: owner,
      visibility: 'private',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
    .run()
  return id
}

describe('directRefsOf —— 每类的引用出边', () => {
  test('agent：managed 技能 / dependsOn / mcp / plugins', () => {
    const refs = directRefsOf('agent', {
      skills: JSON.stringify([
        { kind: 'managed', skillId: 'S1' },
        { kind: 'project', name: 'repo-helper' },
      ]),
      dependsOn: JSON.stringify(['A1']),
      mcp: JSON.stringify(['M1']),
      plugins: JSON.stringify(['P1']),
    })
    expect(refs).toEqual([
      { type: 'skill', id: 'S1' },
      { type: 'agent', id: 'A1' },
      { type: 'mcp', id: 'M1' },
      { type: 'plugin', id: 'P1' },
    ])
  })

  test('**project 技能不进闭包** —— 它没有行、没有 ACL', () => {
    const refs = directRefsOf('agent', {
      skills: JSON.stringify([{ kind: 'project', name: 'repo-helper' }]),
    })
    // 把它当资源去查，必然查不到，然后被判成「不可见」而整包拒绝——那是假阳性。
    expect(refs).toEqual([])
  })

  test('workflow：节点上的 agentId', () => {
    const refs = directRefsOf('workflow', {
      definition: JSON.stringify(defn([{ id: 'n1', kind: 'agent-single', agentId: 'A9' }])),
    })
    expect(refs).toEqual([{ type: 'agent', id: 'A9' }])
  })
})

describe('① 行级可见性（含传递）', () => {
  test('自己的工作流 → 自己的 agent → 自己的 MCP：整棵树导出成功', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const mcp = await seedMcp(db, 'u1', 'tools')
    const agent = await seedAgent(db, 'u1', 'auditor', { mcp: JSON.stringify([mcp]) })
    const wf = await seedWorkflow(
      db,
      'u1',
      'audit',
      defn([{ id: 'n1', kind: 'agent-single', agentId: agent }]),
    )
    const closure = await walkExportClosure(db, actorOf('u1'), { type: 'workflow', id: wf })
    expect(closure.resources.map((r) => r.type).sort()).toEqual(['agent', 'mcp', 'workflow'])
    expect(closure.root.id).toBe(wf)
  })

  test('**传递**依赖不可见 ⇒ 整体拒绝，并点名是谁引用了它', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const foreignMcp = await seedMcp(db, 'u-other', 'secret-tools')
    const agent = await seedAgent(db, 'u1', 'auditor', { mcp: JSON.stringify([foreignMcp]) })
    const wf = await seedWorkflow(
      db,
      'u1',
      'audit',
      defn([{ id: 'n1', kind: 'agent-single', agentId: agent }]),
    )
    const err = await walkExportClosure(db, actorOf('u1'), { type: 'workflow', id: wf }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    )
    expect(err?.code).toBe('package-export-ref-unavailable')
    expect(err?.message).toContain(`agent:${agent}`)
  })

  test('「不存在」与「存在但不可见」**同形** —— 不给存在性预言机', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const hidden = await seedMcp(db, 'u-other', 'hidden')
    const ghost = ulid()
    const messages: string[] = []
    for (const mcpId of [hidden, ghost]) {
      const agent = await seedAgent(db, 'u1', `a-${mcpId.slice(-4)}`, {
        mcp: JSON.stringify([mcpId]),
      })
      const err = await walkExportClosure(db, actorOf('u1'), { type: 'agent', id: agent }).then(
        () => null,
        (e: unknown) => e as { message?: string },
      )
      // 只保留结构，剔除各自的 id —— 两条必须逐字同形。
      messages.push((err?.message ?? '').replace(mcpId, '<ID>').replace(agent, '<FROM>'))
    }
    expect(messages[0]).toBe(messages[1]!)
  })

  test('别人的 public 资源可见 ⇒ 可以导出（可见即有读权限）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const mcp = await seedMcp(db, 'u-other', 'shared')
    await db.update(mcps).set({ visibility: 'public' }).where(eq(mcps.id, mcp)).run()
    const agent = await seedAgent(db, 'u1', 'auditor', { mcp: JSON.stringify([mcp]) })
    const closure = await walkExportClosure(db, actorOf('u1'), { type: 'agent', id: agent })
    expect(closure.resources.some((r) => r.id === mcp)).toBe(true)
  })
})

describe('AC-7d 反向锁 · **不得**有类型级 *:read 门', () => {
  test('actor 一个权限点都没有，但资源行级可见 ⇒ 导出成功', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const mcp = await seedMcp(db, 'u1', 'tools')
    const agent = await seedAgent(db, 'u1', 'auditor', { mcp: JSON.stringify([mcp]) })
    // permissions 为空集：没有 mcps:read、没有 agents:read……
    const closure = await walkExportClosure(db, actorOf('u1', []), { type: 'agent', id: agent })
    expect(closure.resources).toHaveLength(2)
    // 这条**故意**是反向锁：将来有人以「补齐权限校验」为由加一道 `mcps:read` 门，
    // 它会立刻红，并把用户拍板的原则（可见即有读权限）摆到那个人面前。
  })
})

describe('④ 同名重复门', () => {
  test('闭包里两个同 (类型,名字) ⇒ 422，点名各自被谁引用', () => {
    const err = (() => {
      try {
        assertNoDuplicateNames([
          { type: 'plugin', id: 'P-alice', name: 'lint', row: {}, referencedBy: ['agent:A'] },
          { type: 'plugin', id: 'P-bob', name: 'lint', row: {}, referencedBy: ['agent:B'] },
        ])
        return null
      } catch (e) {
        return e as { code?: string; message?: string }
      }
    })()
    expect(err?.code).toBe('package-duplicate-resource-name')
    expect(err?.message).toContain('P-alice')
    expect(err?.message).toContain('agent:A')
    expect(err?.message).toContain('P-bob')
    expect(err?.message).toContain('agent:B')
  })

  test('同名但**不同类型**不冲突（名字唯一性是按类型分的）', () => {
    expect(() =>
      assertNoDuplicateNames([
        { type: 'plugin', id: 'P', name: 'lint', row: {}, referencedBy: [] },
        { type: 'skill', id: 'S', name: 'lint', row: {}, referencedBy: [] },
      ]),
    ).not.toThrow()
  })
})

describe('② 特权节点门（分轴）', () => {
  const scriptWf = {
    type: 'workflow' as const,
    id: 'W',
    name: 'w',
    row: { definition: JSON.stringify(defn([{ id: 'n', kind: 'script' }])) },
    referencedBy: [],
  }
  const codeHostWf = {
    type: 'workflow' as const,
    id: 'W',
    name: 'w',
    row: { definition: JSON.stringify(defn([{ id: 'n', kind: 'code-host-call' }])) },
    referencedBy: [],
  }

  test('缺 scripts:author ⇒ 含脚本节点的工作流不能导出', () => {
    expect(() => assertPrivilegedNodesExportable(actorOf('u1', []), [scriptWf])).toThrow()
  })

  test('**分轴**：有 scripts:author 但缺 code-host-calls:author，脚本可导、代码平台不可', () => {
    const actor = actorOf('u1', ['scripts:author'])
    expect(() => assertPrivilegedNodesExportable(actor, [scriptWf])).not.toThrow()
    expect(() => assertPrivilegedNodesExportable(actor, [codeHostWf])).toThrow()
  })

  test('两轴都有 ⇒ 都可导出', () => {
    const actor = actorOf('u1', ['scripts:author', 'code-host-calls:author'])
    expect(() => assertPrivilegedNodesExportable(actor, [scriptWf, codeHostWf])).not.toThrow()
  })

  test('不含特权节点的工作流，缺权限也照常导出', () => {
    const plain = {
      type: 'workflow' as const,
      id: 'W',
      name: 'w',
      row: { definition: JSON.stringify(defn([{ id: 'n', kind: 'agent-single', agentId: 'A' }])) },
      referencedBy: [],
    }
    expect(() => assertPrivilegedNodesExportable(actorOf('u1', []), [plain])).not.toThrow()
  })
})
