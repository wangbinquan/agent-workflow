// RFC-271 T6e（决策 28）—— **同名双 id** 时 validator 必须按各自的 id hint 解析。
//
// design §1.1c''' 点名的两条回归，都建立在同一个合法形态上：`workflows.name`
// **不唯一**（`db/schema.ts` 上没有 name 的 unique 约束），所以 W1/W2 可以同叫
// `audit`；根 R 里两个 call 节点分别 hint 了 W1 与 W2（用户在下拉里挑的）。
//
//  ① **端口不同**：W1 收 `topic` / 出 `old`，W2 收 `subject` / 出 `new`。按裸名字
//     解析时两个节点被推成同一份端口 ⇒ 其中一个的入端口喂不上，报
//     `call-workflow-input-unwired`（硬错误），而启动（按 id 冻结）跑的正是 W2。
//  ② **成环**：W2 回调 R，W1 不回调。按裸名字解析只看得见 W1 那支 ⇒ **真实的环
//     被放过**，一路跑到运行时才炸。
//
// 第三条锁的是名字守卫：id hint 指向的行**改了名**之后，hint 作废、回退名字规则
// ——否则 rename + recreate 会让节点被 stale id 静默重绑（这正是前端解析器原来
// 写死 name 优先想防的那件事，决策 28 用守卫保住它、同时修掉它的代价）。

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import {
  loadWorkflowValidationContext,
  validateWorkflowDef,
} from '../src/services/workflow.validator'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')

type Node = WorkflowDefinition['nodes'][number]
type Edge = WorkflowDefinition['edges'][number]
const node = (fields: Record<string, unknown>): Node => fields as unknown as Node
const edge = (id: string, source: [string, string], target: [string, string]): Edge => ({
  id,
  source: { nodeId: source[0], portName: source[1] },
  target: { nodeId: target[0], portName: target[1] },
})
const def = (partial: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
  ...partial,
})

const seed = async (
  db: DbClient,
  id: string,
  name: string,
  definition: WorkflowDefinition,
): Promise<void> => {
  await db.insert(workflows).values({ id, name, definition: JSON.stringify(definition) })
}

/** 单入 `inputKey` / 单出 `portName` 的子工作流。两个同名行的**入端口名不同**是
 *  本文件的判别面：喂错了就是 `call-workflow-input-unwired` 硬错误。 */
const childWith = (inputKey: string, portName: string, extraNodes: Node[] = []) =>
  def({
    inputs: [{ kind: 'text', key: inputKey, label: inputKey }],
    nodes: [
      node({ id: 'c_in', kind: 'input', inputKey }),
      node({
        id: 'c_out',
        kind: 'output',
        ports: [{ name: portName, bind: { nodeId: 'c_in', portName: inputKey } }],
      }),
      ...extraNodes,
    ],
    edges: [edge('c_e1', ['c_in', inputKey], ['c_out', portName])],
  })

// 两行同名。**W1 必须在字典序上更小**——名字规则是「最老 ULID 胜」，只有当名字
// 规则铁定选 W1 时，「c2 绑到了 W2」才能证明 id hint 真的赢过了名字。
// ⚠️ 别用 `01OLDER…` / `01NEWER…` 这种见字知意的假 ULID：`01N` < `01O`，名字规则
// 反而会选中「NEWER」那行，三条断言会全部空转成假绿（本文件初版就踩过）。
const W1 = '01AAAAAAAAAAAAAAAAAAAAAAAA'
const W2 = '01ZZZZZZZZZZZZZZZZZZZZZZZZ'

const parentWithTwoCalls = () =>
  def({
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
    nodes: [
      node({ id: 'p_in', kind: 'input', inputKey: 'topic' }),
      node({ id: 'c1', kind: 'call-workflow', workflowName: 'audit', workflowId: W1 }),
      node({ id: 'c2', kind: 'call-workflow', workflowName: 'audit', workflowId: W2 }),
      node({
        id: 'p_out',
        kind: 'output',
        ports: [
          { name: 'a', bind: { nodeId: 'c1', portName: 'old' } },
          { name: 'b', bind: { nodeId: 'c2', portName: 'new' } },
        ],
      }),
    ],
    edges: [
      edge('e1', ['p_in', 'topic'], ['c1', 'topic']),
      edge('e2', ['p_in', 'topic'], ['c2', 'subject']),
      edge('e3', ['c1', 'old'], ['p_out', 'a']),
      edge('e4', ['c2', 'new'], ['p_out', 'b']),
    ],
  })

describe('① 同名双 id · 端口不同', () => {
  test('两个节点各按自己的 id hint 推端口，两条边都合法', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W1, 'audit', childWith('topic', 'old'))
    await seed(db, W2, 'audit', childWith('subject', 'new'))

    const definition = parentWithTwoCalls()
    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    const codes = r.issues.map((i) => i.code)
    // 按裸名字解析时，c2 的 `new` 端口不存在于 W1 ⇒ 这里会冒出边 / 绑定类错误。
    expect(codes).not.toContain('call-workflow-ref-missing')
    expect(codes).not.toContain('call-workflow-input-unwired')
    expect(r.issues.filter((i) => (i.severity ?? 'error') === 'error').map((i) => i.code)).toEqual(
      [],
    )
    expect(r.ok).toBe(true)
  })

  test('去掉 c2 的 id hint 后回退名字规则（最老 ULID = W1），`new` 就真的解析不到了', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W1, 'audit', childWith('topic', 'old'))
    await seed(db, W2, 'audit', childWith('subject', 'new'))

    const definition = parentWithTwoCalls()
    const c2 = definition.nodes.find((n) => (n as unknown as { id: string }).id === 'c2')
    delete (c2 as unknown as Record<string, unknown>).workflowId

    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    // 这条不是「期望的行为」，是**对照组**：它证明上一条的绿不是因为校验太松。
    // c2 退回 W1（入端口叫 `topic`），而边喂的是 `subject` ⇒ 硬错误。
    expect(r.issues.map((i) => i.code)).toContain('call-workflow-input-unwired')
    expect(r.ok).toBe(false)
  })
})

describe('② 同名双 id · 其中一支成环', () => {
  const ROOT = '01ROOT00000000000000000000'

  test('只有 W2 回调根 —— 按边解析看得见这个环', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W1, 'audit', childWith('topic', 'old'))
    // W2 与 W1 同名，但它自己 call 回根。
    await seed(
      db,
      W2,
      'audit',
      childWith('subject', 'new', [
        node({ id: 'c_back', kind: 'call-workflow', workflowName: 'root-wf', workflowId: ROOT }),
      ]),
    )
    const rootDef = parentWithTwoCalls()
    await seed(db, ROOT, 'root-wf', rootDef)

    const r = validateWorkflowDef(
      rootDef,
      await loadWorkflowValidationContext(db, {
        definition: rootDef,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
      }),
    )
    const cycles = r.issues.filter((i) => i.code === 'workflow-call-cycle')
    expect(cycles.length).toBeGreaterThan(0)
    // RFC-099 回显纪律：环里只出现资源 id，绝不出现名字。
    expect(cycles[0]?.message).toContain(ROOT)
    expect(cycles[0]?.message).toContain(W2)
    expect(cycles[0]?.message).not.toContain('audit')
  })

  test('对照组：把 c2 的 hint 也指向 W1（不回调）⇒ 无环', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W1, 'audit', childWith('topic', 'old'))
    await seed(
      db,
      W2,
      'audit',
      childWith('subject', 'new', [
        node({ id: 'c_back', kind: 'call-workflow', workflowName: 'root-wf', workflowId: ROOT }),
      ]),
    )
    const rootDef = parentWithTwoCalls()
    const c2 = rootDef.nodes.find((n) => (n as unknown as { id: string }).id === 'c2')
    ;(c2 as unknown as Record<string, unknown>).workflowId = W1
    await seed(db, ROOT, 'root-wf', rootDef)

    const r = validateWorkflowDef(
      rootDef,
      await loadWorkflowValidationContext(db, {
        definition: rootDef,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
      }),
    )
    expect(r.issues.filter((i) => i.code === 'workflow-call-cycle')).toEqual([])
  })
})

describe('③ 名字守卫：hint 指向的行改了名 ⇒ hint 作废', () => {
  test('c2 hint 的 W2 已被改名 renamed-audit ⇒ 回退名字规则绑到 W1', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W1, 'audit', childWith('topic', 'old'))
    // W2 还在，但它现在叫别的名字 —— 节点里的 id 是 stale cache。
    await seed(db, W2, 'renamed-audit', childWith('subject', 'new'))

    const definition = parentWithTwoCalls()
    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    // c2 退回 W1（入端口 `topic`），而边喂的是 `subject` ⇒ 硬错误。
    // 这正是「rename + recreate 不得被 stale id 静默重绑」——守卫在起作用。
    expect(r.issues.map((i) => i.code)).toContain('call-workflow-input-unwired')
    expect(r.ok).toBe(false)
  })
})
