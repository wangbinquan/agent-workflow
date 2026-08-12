// RFC-291 面 E —— call 边在 dump 里可映射到 handle，且回写不丢绑定（AC-18 / AC-19）。
//
// 设计门 P1-a：dump 此前对非 agent-single 节点原样返回，于是 call 节点连同
// `workflowId`（canonical ULID）一起进了模型上下文——既违反「模型永远看不到
// ULID」（manifest.ts §handles），又解决不了真正的问题：**同名两行时，模型无法
// 判断这条边指向 mounted/ 里的哪个 handle**。
//
// 更坏的是「修一半」：若为满足隔离直接抹掉 id，模型把工作流回写后缓存就没了，
// 下次启动按名字回落到「最老可见 ULID」——用户以为在改被调用的那个工作流，
// 平台却跑了另一个。所以这一面必须是**双向**的：dump 出 handle，resolve 回
// canonical id。
//
// 注意一条刻意的不对称（RFC-243 §5.3）：`*Ref` 是**可选**的精确形式，按名字
// 建边仍然合法且 dangle-tolerant——把它做成必填会静默废掉 intentDoc 一直教给
// 模型的那条路径（本 RFC 实现时真踩过，19 条既有用例因此转红）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { parseIntentChangeset } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users, workflows, workgroups } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { buildIntentDump } from '../src/services/intent/dumpBuilder'
import { resolveIntentBundle } from '../src/services/intent/resolveChangeset'
import type { IntentContextManifest } from '../src/services/intent/manifest'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc291e_000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(),
}

async function seedWorkflow(name: string, nodes: unknown[], forcedId?: string): Promise<string> {
  const id = forcedId ?? ulid()
  const now = Date.now()
  await db.insert(workflows).values({
    id,
    name,
    description: '',
    definition: JSON.stringify({ $schema_version: 4, inputs: [], nodes, edges: [] }),
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof workflows.$inferInsert)
  return id
}

async function seedWorkgroup(name: string): Promise<string> {
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
  return id
}

const callWorkflowNode = (nodeId: string, name: string, id?: string) => ({
  id: nodeId,
  kind: 'call-workflow',
  workflowName: name,
  ...(id === undefined ? {} : { workflowId: id }),
})

beforeEach(async () => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc291-e-'))
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

/** The dumped YAML of a mounted workflow, as the model would read it. */
async function dumpParentDoc(
  parentId: string,
): Promise<{ doc: string; manifest: IntentContextManifest }> {
  const dump = await buildIntentDump({
    db,
    actor,
    appHome,
    mounts: [{ resourceType: 'workflow', resourceId: parentId }],
  })
  const entry = dump.manifest.find((e) => e.resourceId === parentId)
  const base = `mounted/${entry?.handle.replace(/#/g, '.')}`
  const file = dump.seedFiles.find((f) => f.path === `${base}.yaml`)
  return { doc: file?.content ?? '', manifest: dump.manifest }
}

describe('dump 侧：call 边带 handle、不带 canonical id（AC-18）', () => {
  test('workflowId 被剥离，替换为指向真实目标的 workflowRef', async () => {
    const child = await seedWorkflow('child-flow', [])
    const parent = await seedWorkflow('parent-flow', [callWorkflowNode('c1', 'child-flow', child)])

    const { doc, manifest } = await dumpParentDoc(parent)
    const childHandle = manifest.find((e) => e.resourceId === child)?.handle

    expect(childHandle).toBeDefined()
    expect(doc).toContain('workflowRef')
    expect(doc).toContain(childHandle!)
    // canonical ULID 一个字符都不该进模型上下文
    expect(doc).not.toContain(child)
    expect(doc).not.toContain('workflowId')
    // 权威选择器（名字）保留——它是平台持久化并导出到 YAML 的字段
    expect(doc).toContain('child-flow')
  })

  test('call-workgroup 同构', async () => {
    const squad = await seedWorkgroup('audit-squad')
    const parent = await seedWorkflow('parent-flow', [
      {
        id: 'c1',
        kind: 'call-workgroup',
        workgroupName: 'audit-squad',
        goalTemplate: 'go',
        workgroupId: squad,
      },
    ])
    const { doc, manifest } = await dumpParentDoc(parent)
    const squadHandle = manifest.find((e) => e.resourceId === squad)?.handle
    expect(doc).toContain('workgroupRef')
    expect(doc).toContain(squadHandle!)
    expect(doc).not.toContain(squad)
    expect(doc).not.toContain('workgroupId')
  })

  test('同名两行 + id 缓存指向较新那个 → dump 出的 handle 就是较新那行', async () => {
    // 这正是名字表达不了、而缺陷会让模型改错对象的场景。
    await seedWorkflow('build', [], '01AAAAAAAAAAAAAAAAAAAAAAAA')
    const newer = await seedWorkflow('build', [], '01ZZZZZZZZZZZZZZZZZZZZZZZZ')
    const parent = await seedWorkflow('parent-flow', [callWorkflowNode('c1', 'build', newer)])

    const { doc, manifest } = await dumpParentDoc(parent)
    const newerHandle = manifest.find((e) => e.resourceId === newer)?.handle
    expect(doc).toContain(newerHandle!)
  })

  test('目标不可解析 → 标记隐藏，不泄漏 id', async () => {
    const parent = await seedWorkflow('parent-flow', [callWorkflowNode('c1', 'ghost-flow')])
    const { doc } = await dumpParentDoc(parent)
    expect(doc).toContain('workflowRefHidden')
    expect(doc).not.toContain('workflowId')
  })
})

describe('resolve 侧：回写不丢绑定（AC-19）', () => {
  test('把 dump 出的 ref 原样回传 → 落库的 workflowId 是 dump 所示的那一行', async () => {
    // 「修一半」的失败路径：只抹 id 不给 ref，模型回写后缓存丢失，下次启动
    // 按名字回落到最老可见行——用户以为改的是被调用的那个，平台跑的是另一个。
    await seedWorkflow('build', [], '01AAAAAAAAAAAAAAAAAAAAAAAA')
    const newer = await seedWorkflow('build', [], '01ZZZZZZZZZZZZZZZZZZZZZZZZ')
    const parent = await seedWorkflow('parent-flow', [callWorkflowNode('c1', 'build', newer)])

    const dump = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [{ resourceType: 'workflow', resourceId: parent }],
    })
    const parentEntry = dump.manifest.find((e) => e.resourceId === parent)
    const newerHandle = dump.manifest.find((e) => e.resourceId === newer)?.handle

    // 模型把这条边原样回传（handle 形式），只改了别的字段
    const changeset = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'update',
            resourceType: 'workflow',
            target: parentEntry?.handle,
            payload: {
              name: 'parent-flow',
              description: 'edited',
              definition: {
                $schema_version: 5,
                inputs: [],
                nodes: [
                  {
                    id: 'c1',
                    kind: 'call-workflow',
                    workflowName: 'build',
                    workflowRef: newerHandle,
                  },
                ],
                edges: [],
              },
            },
          },
        ],
      }),
    )
    if (!changeset.ok) throw new Error(changeset.errors.join('; '))

    const bundle = resolveIntentBundle({
      manifest: dump.manifest,
      changeset: changeset.changeset,
      decisions: [],
      occupiedNames: new Map(),
    })
    const resolvedDef = (
      bundle.ops[0]?.payload as { definition: { nodes: Array<Record<string, unknown>> } }
    ).definition
    const callNode = resolvedDef.nodes.find((n) => n.kind === 'call-workflow')

    // handle 变回 canonical id，且是 dump 所示的那一行（不是「最老可见」）
    expect(callNode?.workflowId).toBe(newer)
    expect(callNode?.workflowRef).toBeUndefined()
    // 名字随节点一起保留
    expect(callNode?.workflowName).toBe('build')
  })

  test('按名字建边（无 ref）仍然合法——RFC-243 §5.3 的 dangle-tolerant 路径不变', async () => {
    // 刻意的不对称：把 *Ref 做成必填会静默废掉 intentDoc 一直教的那条路径。
    const changeset = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:wf',
            payload: {
              name: 'caller-flow',
              description: '',
              definition: {
                $schema_version: 5,
                inputs: [],
                nodes: [{ id: 'c1', kind: 'call-workflow', workflowName: 'some-target' }],
                edges: [],
              },
            },
          },
        ],
      }),
    )
    expect(changeset.ok).toBe(true)
  })

  test('模型给 canonical id → 被拒（它看不到也不该发明 ULID）', async () => {
    const changeset = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:wf',
            payload: {
              name: 'caller-flow',
              description: '',
              definition: {
                $schema_version: 5,
                inputs: [],
                nodes: [
                  {
                    id: 'c1',
                    kind: 'call-workflow',
                    workflowName: 'target',
                    workflowId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
                  },
                ],
                edges: [],
              },
            },
          },
        ],
      }),
    )
    expect(changeset.ok).toBe(false)
    if (!changeset.ok) expect(changeset.errors.join(' ')).toContain('call-id-forbidden')
  })
})
