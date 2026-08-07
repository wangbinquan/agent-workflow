// RFC-270 §7 — 保存路径的回填。
//
// 用户实报：「一旦一个工作流里有一个脚本节点，这个工作流就会变成权限异常。」
// 链路是 —— 编辑器 1s 自动保存把整份定义 PUT 回来，敏感投影与库里对不上就 403，
// 前台又把 403 一律判成「此工作流可能已删除或权限已变化」。RFC-270 让读路径对无
// 权限用户遮蔽特权字段之后，这条链路会**必然**触发（客户端手上的就是 `***`），
// 所以遮蔽与回填必须同批落地：本文件锁的就是「遮了一定填得回来」。
//
// 分寸同样要锁：回填只补**被遮蔽的字段**。新增 / 删除特权节点、改它的入边、改它
// 的 wrapper 归属仍然原样撞门 —— 那些不是被遮的内容，无权限用户本来就不该改。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import type { WorkflowDefinition, WorkflowDetail, WorkflowNode } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createInMemoryDb, type DbClient } from '@/db/client'
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  workflowDraftSnapshotOf,
  type WorkflowWritePrincipal,
} from '@/services/workflow'
import { REDACTED, serializeWorkflowFor, workflowReadLensFor } from '@/services/tokenRedaction'
import { DomainError } from '@/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'u-owner'
const SCRIPT_BODY = 'import os\nprint(os.environ["AW_PORT_DIFF"])\n'

function actorOfRole(role: 'admin' | 'user') {
  return buildActor({
    source: 'session',
    user: { id: OWNER, username: OWNER, displayName: OWNER, role, status: 'active' },
  })
}

function principalOfRole(role: 'admin' | 'user'): WorkflowWritePrincipal {
  return { kind: 'actor', actor: actorOfRole(role) }
}

function seedDefinition(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'context', title: '输入' },
      {
        id: 's1',
        kind: 'script',
        language: 'python',
        script: SCRIPT_BODY,
        dependencies: ['requests==2.31.0'],
        env: { API_TOKEN: 'sk-live-scriptenv' },
        position: { x: 0, y: 0 },
      },
      {
        id: 'c1',
        kind: 'code-host-call',
        provider: 'gitlab',
        action: 'custom',
        params: { project: 'grp/app' },
        request: { method: 'POST', path: '/api/v4/projects/1/notes', body: '{"body":"ok"}' },
      },
    ] as unknown as WorkflowNode[],
    edges: [],
  }
}

async function seed(db: DbClient): Promise<WorkflowDetail> {
  // 建的时候走 system principal（不传 actor）：现实里这份工作流是管理员 / manager
  // 做好后归属给普通用户的，这里只要复现「库里已经有特权节点」这个前提。
  return createWorkflow(
    db,
    { name: `wf-${ulid()}`, description: '', definition: seedDefinition() },
    { ownerUserId: OWNER },
  )
}

/** 普通用户手里实际拿到的那份（特权字段是 `***`）。 */
function asSeenByUser(workflow: WorkflowDetail): WorkflowDefinition {
  return serializeWorkflowFor(workflow, workflowReadLensFor(actorOfRole('user')))
    .definition as WorkflowDefinition
}

function withNodes(
  definition: WorkflowDefinition,
  edit: (nodes: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): WorkflowDefinition {
  const nodes = definition.nodes.map((node) => ({
    ...(node as unknown as Record<string, unknown>),
  }))
  return { ...definition, nodes: edit(nodes) as unknown as WorkflowNode[] }
}

function save(
  db: DbClient,
  workflow: WorkflowDetail,
  definition: WorkflowDefinition,
  principal: WorkflowWritePrincipal,
) {
  return updateWorkflow(
    db,
    workflow.id,
    {
      expectedVersion: workflow.version,
      clientMutationId: ulid(),
      snapshot: { ...workflowDraftSnapshotOf(workflow), definition },
    },
    principal,
  )
}

async function storedDefinition(db: DbClient, id: string): Promise<WorkflowDefinition> {
  const detail = await getWorkflow(db, id)
  if (detail === null) throw new Error('workflow vanished')
  return detail.definition
}

function nodeOf(definition: WorkflowDefinition, id: string): Record<string, unknown> {
  const found = definition.nodes.find((node) => node.id === id)
  if (found === undefined) throw new Error(`no node ${id}`)
  return found as unknown as Record<string, unknown>
}

async function codeOfRejection(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected: ${String(error)}`
  }
}

describe('RFC-270 AC-6 · 无权限用户把脱敏定义原样交回来 → 保存成功且库里一字未改', () => {
  test('改了别的节点的标题 + 挪了脚本节点的位置，都不撞门', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const masked = asSeenByUser(workflow)
    // 前提自检：客户端手上确实是 `***`，否则下面全是空断言。
    expect(nodeOf(masked, 's1').script).toBe(REDACTED)
    expect(nodeOf(masked, 'c1').params).toEqual({ project: REDACTED })

    const edited = withNodes(masked, (nodes) =>
      nodes.map((node) => {
        if (node.id === 'in1') return { ...node, title: '改过的标题' }
        if (node.id === 's1') return { ...node, position: { x: 240, y: 80 } }
        return node
      }),
    )
    await save(db, workflow, edited, principalOfRole('user'))

    const stored = await storedDefinition(db, workflow.id)
    expect(nodeOf(stored, 's1').script).toBe(SCRIPT_BODY)
    expect(nodeOf(stored, 's1').env).toEqual({ API_TOKEN: 'sk-live-scriptenv' })
    expect(nodeOf(stored, 's1').dependencies).toEqual(['requests==2.31.0'])
    expect(nodeOf(stored, 'c1').params).toEqual({ project: 'grp/app' })
    expect(nodeOf(stored, 'c1').request).toEqual({
      method: 'POST',
      path: '/api/v4/projects/1/notes',
      body: '{"body":"ok"}',
    })
    // 用户真正想改的那两处生效了
    expect(nodeOf(stored, 'in1').title).toBe('改过的标题')
    expect(nodeOf(stored, 's1').position).toEqual({ x: 240, y: 80 })
  })

  test('原样交回、什么都没改也不撞门（编辑器 heal-on-open 会打出这一发）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    await save(db, workflow, asSeenByUser(workflow), principalOfRole('user'))
    expect(nodeOf(await storedDefinition(db, workflow.id), 's1').script).toBe(SCRIPT_BODY)
  })
})

describe('RFC-270 AC-7 · 结构性改动仍然撞门', () => {
  test('新增脚本节点 → script-author-forbidden', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const added = withNodes(asSeenByUser(workflow), (nodes) => [
      ...nodes,
      { id: 's2', kind: 'script', language: 'bash', script: 'curl evil.example' },
    ])
    expect(await codeOfRejection(save(db, workflow, added, principalOfRole('user')))).toBe(
      'script-author-forbidden',
    )
  })

  test('删除脚本节点 → script-author-forbidden', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const removed = withNodes(asSeenByUser(workflow), (nodes) =>
      nodes.filter((node) => node.id !== 's1'),
    )
    expect(await codeOfRejection(save(db, workflow, removed, principalOfRole('user')))).toBe(
      'script-author-forbidden',
    )
  })

  test('改脚本节点的入边 → script-author-forbidden（入边决定 AW_PORT_* 取到什么）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const masked = asSeenByUser(workflow)
    const rewired: WorkflowDefinition = {
      ...masked,
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'context' },
          target: { nodeId: 's1', portName: 'diff' },
        },
      ] as unknown as WorkflowDefinition['edges'],
    }
    expect(await codeOfRejection(save(db, workflow, rewired, principalOfRole('user')))).toBe(
      'script-author-forbidden',
    )
  })

  test('把脚本节点塞进 loop → script-author-forbidden（归属决定跑几次）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const wrapped = withNodes(asSeenByUser(workflow), (nodes) => [
      ...nodes,
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['s1'], maxIterations: 50 },
    ])
    expect(await codeOfRejection(save(db, workflow, wrapped, principalOfRole('user')))).toBe(
      'script-author-forbidden',
    )
  })

  test('改代码平台节点的 provider → code-host-author-forbidden（枚举字段不遮，但也不许改）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const flipped = withNodes(asSeenByUser(workflow), (nodes) =>
      nodes.map((node) => (node.id === 'c1' ? { ...node, provider: 'github' } : node)),
    )
    expect(await codeOfRejection(save(db, workflow, flipped, principalOfRole('user')))).toBe(
      'code-host-author-forbidden',
    )
  })

  test('新增代码平台调用节点 → code-host-author-forbidden', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const added = withNodes(asSeenByUser(workflow), (nodes) => [
      ...nodes,
      { id: 'c2', kind: 'code-host-call', provider: 'gitlab', action: 'custom', params: {} },
    ])
    expect(await codeOfRejection(save(db, workflow, added, principalOfRole('user')))).toBe(
      'code-host-author-forbidden',
    )
  })
})

describe('RFC-270 AC-8 · 回填由镜头决定，不由值决定', () => {
  test('admin 把脚本正文真的写成 `***` 就存成 `***`（不被静默还原）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const literal = withNodes(workflow.definition, (nodes) =>
      nodes.map((node) => (node.id === 's1' ? { ...node, script: REDACTED } : node)),
    )
    await save(db, workflow, literal, principalOfRole('admin'))
    expect(nodeOf(await storedDefinition(db, workflow.id), 's1').script).toBe(REDACTED)
  })

  test('admin 的正常编辑照常落库（镜头透明 ⇒ 完全不回填）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const edited = withNodes(workflow.definition, (nodes) =>
      nodes.map((node) => (node.id === 's1' ? { ...node, script: 'print("v2")' } : node)),
    )
    await save(db, workflow, edited, principalOfRole('admin'))
    expect(nodeOf(await storedDefinition(db, workflow.id), 's1').script).toBe('print("v2")')
  })

  test('system principal 走透明镜头（平台搬运已经过门的字节）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db)
    const edited = withNodes(workflow.definition, (nodes) =>
      nodes.map((node) => (node.id === 's1' ? { ...node, script: 'print("sys")' } : node)),
    )
    await save(db, workflow, edited, { kind: 'system', reason: 'rfc270-test' })
    expect(nodeOf(await storedDefinition(db, workflow.id), 's1').script).toBe('print("sys")')
  })
})

describe('RFC-270 · 源码层：落库的是回填后的那份', () => {
  test('prepareWorkflowSave 的字节投影取自 normalizedSnapshot，不取 submittedSnapshot', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services/workflow.ts'), 'utf8')
    // 回填产物叫 normalizedSnapshot；提交原件叫 submittedSnapshot。两条字节投影
    // 必须描述前者，否则「保存回执 / logical-same 短路 / definition 列」会描述一份
    // 从未落库的定义。
    expect(src).toContain('serializeWorkflowEditableSnapshotV1(normalizedSnapshot)')
    expect(src).toContain('serializeWorkflowDefinitionStorageV1(normalizedSnapshot.definition)')
    expect(src).not.toContain('serializeWorkflowEditableSnapshotV1(submittedSnapshot)')
    expect(src).not.toContain('serializeWorkflowDefinitionStorageV1(submittedSnapshot.definition)')
    // 回填发生在两个 author 门之前 —— 顺序反了就等于门在看一份不会落库的定义。
    const rehydrateAt = src.indexOf('rehydratePrivilegedNodes(')
    const scriptGateAt = src.indexOf('assertScriptAuthorAllowed({')
    const codeHostGateAt = src.indexOf('assertCodeHostAuthorAllowed({')
    expect(rehydrateAt).toBeGreaterThan(0)
    expect(rehydrateAt).toBeLessThan(scriptGateAt)
    expect(rehydrateAt).toBeLessThan(codeHostGateAt)
  })
})
