// RFC-291 面 D —— 依赖闭包补齐 call 边 + agent 边收口 + 复杂度（AC-12..AC-16）。
//
// 缺陷：`expandClosure` 的 workflow 分支只走 `agent-single` 节点，`call-workflow`
// / `call-workgroup` 引用的子工作流与工作组**完全不进闭包**。于是挂载一个父工作
// 流去改它时，它调用的子工作流拿不到详情——模型既看不到内容，也不能把它作为
// update 目标（`intent-target-not-mounted`）。
//
// 最关键的一条是 **freeze/dump 同解**：启动期冻结决定实际执行哪一行，dump 决定
// 模型看到哪个 handle。两者若选出不同的行，用户改的是 W1、平台跑的是 W2，而且
// 各自内部自洽、下游无从发现。RFC-291 把裁决收进 `pickCallTarget` 单点，这里用
// **同一份 DB 夹具**对拍两侧结果。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, users, workflows, workgroups, workgroupMembers } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { buildIntentDumpForTest as buildIntentDump } from './helpers/intentResourceCatalogBinding'
import { freezeCallClosure, parseCallClosure } from '../src/services/execution/closure'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc291d_000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

async function seedAgent(name: string): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(agents).values({
    id,
    name,
    description: name,
    outputs: JSON.stringify(['out']),
    ownerUserId: OWNER,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof agents.$inferInsert)
  return id
}

/** A workflow row; `id` can be forced so ULID ordering (= age) is testable. */
async function seedWorkflow(
  name: string,
  definition: Record<string, unknown>,
  forcedId?: string,
): Promise<string> {
  const id = forcedId ?? ulid()
  const now = Date.now()
  await db.insert(workflows).values({
    id,
    name,
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof workflows.$inferInsert)
  return id
}

async function seedWorkgroup(name: string, agentId: string): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(workgroups).values({
    id,
    name,
    description: '',
    instructions: 'work',
    mode: 'leader_worker',
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof workgroups.$inferInsert)
  await db.insert(workgroupMembers).values({
    id: ulid(),
    workgroupId: id,
    memberType: 'agent',
    agentId,
    displayName: 'lead',
    roleDesc: '',
    position: 0,
    createdAt: now,
  } as typeof workgroupMembers.$inferInsert)
  return id
}

const agentNode = (nodeId: string, agentId: string) => ({
  id: nodeId,
  kind: 'agent-single',
  agentId,
  promptTemplate: 'go',
})
const callWorkflowNode = (nodeId: string, workflowName: string, workflowId?: string) => ({
  id: nodeId,
  kind: 'call-workflow',
  workflowName,
  ...(workflowId === undefined ? {} : { workflowId }),
})
const callWorkgroupNode = (nodeId: string, workgroupName: string) => ({
  id: nodeId,
  kind: 'call-workgroup',
  workgroupName,
  goalTemplate: 'do it',
})
const defOf = (nodes: unknown[]) => ({ $schema_version: 4, inputs: [], nodes, edges: [] })

const dumpMounting = (resourceType: 'workflow', resourceId: string) =>
  buildIntentDump({ db, actor, appHome, mounts: [{ resourceType, resourceId }] })

beforeEach(async () => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc291-d-'))
  db = createInMemoryDb(MIGRATIONS)
  await db.insert(users).values({
    id: OWNER,
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

describe('call-workflow / call-workgroup 进入闭包（AC-12 / AC-13）', () => {
  test('父工作流 call 子工作流 → 子工作流进 mounted/ 详情，可作 update 目标', async () => {
    const childAgent = await seedAgent('child-agent')
    const child = await seedWorkflow('child-flow', defOf([agentNode('n1', childAgent)]))
    const parent = await seedWorkflow('parent-flow', defOf([callWorkflowNode('c1', 'child-flow')]))

    const dump = await dumpMounting('workflow', parent)

    const childEntry = dump.manifest.find((e) => e.resourceId === child)
    expect(childEntry, 'child workflow missing from manifest').toBeDefined()
    // detail:true + fence 就是「可作 update 目标」的判据
    expect(childEntry?.detail).toBe(true)
    expect(childEntry?.fence?.kind).toBe('workflow')
    expect(childEntry?.root).toBe(false) // 它是闭包成员，不是显式根
    // 子工作流引用的 agent 继续沿边展开
    expect(dump.manifest.find((e) => e.resourceId === childAgent)?.detail).toBe(true)
  })

  test('递归：父 → 子 → 孙 全部进详情', async () => {
    const grand = await seedWorkflow('grand-flow', defOf([]))
    const child = await seedWorkflow('child-flow', defOf([callWorkflowNode('c1', 'grand-flow')]))
    const parent = await seedWorkflow('parent-flow', defOf([callWorkflowNode('c1', 'child-flow')]))

    const dump = await dumpMounting('workflow', parent)
    expect(dump.manifest.find((e) => e.resourceId === child)?.detail).toBe(true)
    expect(dump.manifest.find((e) => e.resourceId === grand)?.detail).toBe(true)
  })

  test('call-workgroup → 工作组进详情，其 agent 成员继续展开（AC-13）', async () => {
    const memberAgent = await seedAgent('squad-agent')
    const squad = await seedWorkgroup('audit-squad', memberAgent)
    const parent = await seedWorkflow(
      'parent-flow',
      defOf([callWorkgroupNode('c1', 'audit-squad')]),
    )

    const dump = await dumpMounting('workflow', parent)
    expect(dump.manifest.find((e) => e.resourceId === squad)?.detail).toBe(true)
    expect(dump.manifest.find((e) => e.resourceId === memberAgent)?.detail).toBe(true)
  })

  test('环（A call B call A）收敛，不死循环', async () => {
    const a = await seedWorkflow('flow-a', defOf([callWorkflowNode('c1', 'flow-b')]))
    const b = await seedWorkflow('flow-b', defOf([callWorkflowNode('c1', 'flow-a')]))
    const dump = await dumpMounting('workflow', a)
    expect(dump.manifest.find((e) => e.resourceId === b)?.detail).toBe(true)
    expect(dump.manifest.filter((e) => e.resourceId === a)).toHaveLength(1)
  })

  test('call 目标不存在 → 计入 hiddenDependencies，不抛错、不泄漏名字（AC-15）', async () => {
    const parent = await seedWorkflow('parent-flow', defOf([callWorkflowNode('c1', 'ghost-flow')]))
    const dump = await dumpMounting('workflow', parent)
    // 不炸；且 dump 产物里不出现被引用但不可解析的名字之外的任何身份信息
    expect(dump.manifest.find((e) => e.resourceId === parent)?.detail).toBe(true)
    expect(JSON.stringify(dump.hiddenDependencies)).not.toContain('ghost-flow')
  })
})

describe('freeze / dump 同解（AC-14，同一份 DB 夹具对拍）', () => {
  test('同名两行 + id 缓存指向较新那个 → 两侧选出同一行', async () => {
    // 名字不唯一是合法状态；缓存记录了用户在下拉里的选择。
    // 较老的那行只需存在（制造同名歧义），测试断言的是「没被选中」
    await seedWorkflow('build', defOf([]), '01AAAAAAAAAAAAAAAAAAAAAAAA')
    const newer = await seedWorkflow('build', defOf([]), '01ZZZZZZZZZZZZZZZZZZZZZZZZ')
    const parentDef = defOf([callWorkflowNode('c1', 'build', newer)])
    const parent = await seedWorkflow('parent-flow', parentDef)

    // freeze 侧
    const closureJson = await freezeCallClosure(
      db,
      { id: parent, definition: parentDef as never },
      actor,
    )
    const frozen = parseCallClosure(closureJson)
    const frozenIds = Object.values(frozen?.workflows ?? {}).map((r) => r.id)

    // dump 侧
    const dump = await dumpMounting('workflow', parent)
    const dumpedIds = dump.manifest
      .filter((e) => e.resourceType === 'workflow' && e.detail && e.resourceId !== parent)
      .map((e) => e.resourceId)

    expect(frozenIds).toEqual([newer])
    expect(dumpedIds).toEqual([newer]) // 不是 older —— 缓存被两侧同等尊重
    expect(dumpedIds).toEqual(frozenIds)
  })

  test('无 id 缓存的同名两行 → 两侧都取最老 ULID', async () => {
    const older = await seedWorkflow('build', defOf([]), '01AAAAAAAAAAAAAAAAAAAAAAAA')
    await seedWorkflow('build', defOf([]), '01ZZZZZZZZZZZZZZZZZZZZZZZZ')
    const parentDef = defOf([callWorkflowNode('c1', 'build')])
    const parent = await seedWorkflow('parent-flow', parentDef)

    const frozen = parseCallClosure(
      await freezeCallClosure(db, { id: parent, definition: parentDef as never }, actor),
    )
    const dump = await dumpMounting('workflow', parent)

    expect(Object.values(frozen?.workflows ?? {}).map((r) => r.id)).toEqual([older])
    expect(
      dump.manifest
        .filter((e) => e.resourceType === 'workflow' && e.detail && e.resourceId !== parent)
        .map((e) => e.resourceId),
    ).toEqual([older])
  })
})

describe('复杂度与收口（AC-16 / 设计门 P2-c）', () => {
  test('多根共享同一子图：邻接展开被 memo 复用，结果仍正确', async () => {
    const shared = await seedWorkflow('shared-flow', defOf([]))
    const roots: string[] = []
    for (let i = 0; i < 8; i++) {
      roots.push(await seedWorkflow(`root-${i}`, defOf([callWorkflowNode('c1', 'shared-flow')])))
    }
    const dump = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: roots.map((id) => ({ resourceType: 'workflow' as const, resourceId: id })),
    })
    // 共享子图只出现一条清单条目（去重），且是详情
    const sharedEntries = dump.manifest.filter((e) => e.resourceId === shared)
    expect(sharedEntries).toHaveLength(1)
    expect(sharedEntries[0]?.detail).toBe(true)
    for (const r of roots) {
      expect(dump.manifest.find((e) => e.resourceId === r)?.root).toBe(true)
    }
  })

  test('闭包展开不再手写 agent 节点 walker（AC-16 口径已收窄）', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'intent', 'dumpBuilder.ts'),
      'utf8',
    )
    // 闭包侧必须调权威提取器
    expect(src).toContain('extractWorkflowAgentRefs')
    // ⚠️ 断言口径：dump RENDERER 仍必须识别该字面量（它要把 agentId 改写成
    // handle），所以这里不能断言「文件里不出现 agent-single」——那会把正确实现
    // 判红（设计门 P2-d）。只断言闭包侧不再有自己的 node.kind 判定即可。
    const closureSection = src.slice(
      src.indexOf('function outEdgesOf'),
      src.indexOf('export async function buildIntentDump'),
    )
    expect(closureSection).not.toContain("kind !== 'agent-single'")
    expect(closureSection).not.toContain("kind === 'agent-single'")
  })
})
