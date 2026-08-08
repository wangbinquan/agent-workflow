// RFC-271 T6f2 —— design §1.1c''' 的**三个验证语境**各自定死。
//
// v10 只说「validator 改用同一条 id-hint-first 判据」，那是不够的：
// `loadWorkflowValidationContext` 不收 Actor、查所有同名行，而冻结器按**启动者**
// 的可见性过滤 —— 「validator 与启动绑同一行」跨 actor 时根本不可能成立。
//
//   语境            Actor    数据源                        性质
//   编辑器/保存期   保存者   live DB                       advisory
//   根任务启动      启动者   自己冻结一次，再用同一份校验  权威
//   子任务启动      继承     继承的 closure 子集，不查 live 权威
//
// 三条回归对应三行。② 与 ③ 此前是**真缺陷**：启动流程先从 live 构造 validator
// context、之后才冻结，于是「校验的那一份」与「执行的那一份」是两次独立解析。

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { callEdgeKey } from '../src/services/execution/closure'
import {
  loadWorkflowValidationContext,
  validateWorkflowDef,
} from '../src/services/workflow.validator'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')

type Node = WorkflowDefinition['nodes'][number]
const node = (f: Record<string, unknown>): Node => f as unknown as Node
const edge = (id: string, s: [string, string], t: [string, string]) =>
  ({
    id,
    source: { nodeId: s[0], portName: s[1] },
    target: { nodeId: t[0], portName: t[1] },
  }) as unknown as WorkflowDefinition['edges'][number]
const def = (p: Partial<WorkflowDefinition>): WorkflowDefinition =>
  ({ $schema_version: 4, inputs: [], nodes: [], edges: [], ...p }) as WorkflowDefinition

/** 单入 `inputKey` / 单出 `out` 的子工作流。入端口名是本文件的判别面。 */
const child = (inputKey: string) =>
  def({
    inputs: [{ kind: 'text', key: inputKey, label: inputKey }] as never,
    nodes: [
      node({ id: 'c_in', kind: 'input', inputKey }),
      node({
        id: 'c_out',
        kind: 'output',
        ports: [{ name: 'out', bind: { nodeId: 'c_in', portName: inputKey } }],
      }),
    ],
    edges: [edge('c_e', ['c_in', inputKey], ['c_out', 'out'])],
  })

/** 根：一个 call 节点，喂 `subject` 端口。 */
const rootCalling = (target: { name: string; id?: string }) =>
  def({
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }] as never,
    nodes: [
      node({ id: 'p_in', kind: 'input', inputKey: 'topic' }),
      node({
        id: 'c1',
        kind: 'call-workflow',
        workflowName: target.name,
        ...(target.id !== undefined ? { workflowId: target.id } : {}),
      }),
      node({
        id: 'p_out',
        kind: 'output',
        ports: [{ name: 'r', bind: { nodeId: 'c1', portName: 'out' } }],
      }),
    ],
    edges: [
      edge('e1', ['p_in', 'topic'], ['c1', 'subject']),
      edge('e2', ['c1', 'out'], ['p_out', 'r']),
    ],
  })

const seed = async (db: DbClient, id: string, name: string, d: WorkflowDefinition) => {
  await db.insert(workflows).values({ id, name, definition: JSON.stringify(d) })
}

const ROOT = '01ROOT00000000000000000000'
const W_TOPIC = '01AAAAAAAAAAAAAAAAAAAAAAAA' // 入端口 topic —— 与根的连线不匹配
const W_SUBJECT = '01ZZZZZZZZZZZZZZZZZZZZZZZZ' // 入端口 subject —— 匹配

const errorCodes = (r: { issues: Array<{ code: string; severity?: string }> }) =>
  r.issues.filter((i) => (i.severity ?? 'error') === 'error').map((i) => i.code)

describe('① 编辑器 / 保存期：advisory，走 live，不冻结', () => {
  test('不传冻结闭包 ⇒ 按 live 的名字规则（最老 ULID）解析', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W_TOPIC, 'audit', child('topic'))
    await seed(db, W_SUBJECT, 'audit', child('subject'))

    const d = rootCalling({ name: 'audit' }) // 无 id hint
    const r = validateWorkflowDef(d, await loadWorkflowValidationContext(db, { definition: d }))
    // live 名字规则选中 W_TOPIC（入端口 topic），而边喂的是 subject ⇒ 报错。
    expect(errorCodes(r)).toContain('call-workflow-input-unwired')
  })

  test('保存者与启动者不同是**允许**的：保存期结果与启动绑定可以不一致，且不报错', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W_SUBJECT, 'audit', child('subject'))

    const d = rootCalling({ name: 'audit', id: W_SUBJECT })
    // 保存期（live，无 Actor）：解析得到 W_SUBJECT，干净通过。
    const saveTime = validateWorkflowDef(
      d,
      await loadWorkflowValidationContext(db, { definition: d }),
    )
    expect(errorCodes(saveTime)).toEqual([])

    // 启动期（冻结闭包里换成了另一份定义——模拟启动者只看得见另一行）：
    // 校验按冻结那份走，得到不同结论。**两者都不算 bug**，语境不同而已。
    const frozen = JSON.stringify({
      closureVersion: 2,
      workflows: {
        [callEdgeKey(ROOT, 'c1')]: { id: W_TOPIC, version: 1, definition: child('topic') },
      },
      workgroups: {},
    })
    const launchTime = validateWorkflowDef(
      d,
      await loadWorkflowValidationContext(db, {
        definition: d,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
        frozenClosureJson: frozen,
      }),
    )
    expect(errorCodes(launchTime)).toContain('call-workflow-input-unwired')
  })
})

describe('② 根启动：解析冻结一次，再用同一份 frozen result 校验', () => {
  test('冻结里是 W_SUBJECT ⇒ 校验按它通过，即使 live 的名字规则会选中另一行', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // live 里 W_TOPIC 更老，名字规则会选它 —— 如果校验偷偷查了 live 就会报错。
    await seed(db, W_TOPIC, 'audit', child('topic'))
    await seed(db, W_SUBJECT, 'audit', child('subject'))

    const d = rootCalling({ name: 'audit', id: W_SUBJECT })
    const frozen = JSON.stringify({
      closureVersion: 2,
      workflows: {
        [callEdgeKey(ROOT, 'c1')]: { id: W_SUBJECT, version: 1, definition: child('subject') },
      },
      workgroups: {},
    })
    const r = validateWorkflowDef(
      d,
      await loadWorkflowValidationContext(db, {
        definition: d,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
        frozenClosureJson: frozen,
      }),
    )
    expect(errorCodes(r)).toEqual([])
  })

  test('对照组：库里被清空，校验仍然通过 —— 证明它真的一次 live 都没查', async () => {
    const db = createInMemoryDb(MIGRATIONS) // 一行都不 seed
    const d = rootCalling({ name: 'audit', id: W_SUBJECT })
    const frozen = JSON.stringify({
      closureVersion: 2,
      workflows: {
        [callEdgeKey(ROOT, 'c1')]: { id: W_SUBJECT, version: 1, definition: child('subject') },
      },
      workgroups: {},
    })
    const r = validateWorkflowDef(
      d,
      await loadWorkflowValidationContext(db, {
        definition: d,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
        frozenClosureJson: frozen,
      }),
    )
    expect(errorCodes(r)).toEqual([])
  })
})

describe('③ 子启动：用继承的闭包子集，**禁止**重查 live', () => {
  test('父冻结了 subject 版，随后 live 行被改成 topic 版 ⇒ 子校验仍看冻结的那份', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // live 现在是 topic 版（父冻结之后被人改的）。
    await seed(db, W_SUBJECT, 'audit', child('topic'))

    const d = rootCalling({ name: 'audit', id: W_SUBJECT })
    const inherited = JSON.stringify({
      closureVersion: 2,
      workflows: {
        [callEdgeKey(ROOT, 'c1')]: { id: W_SUBJECT, version: 1, definition: child('subject') },
      },
      workgroups: {},
    })
    const r = validateWorkflowDef(
      d,
      await loadWorkflowValidationContext(db, {
        definition: d,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
        frozenClosureJson: inherited,
      }),
    )
    // 重查 live 的话会按 topic 版校验 ⇒ input-unwired。
    expect(errorCodes(r)).toEqual([])
  })

  test('冻结闭包里缺这条边 ⇒ 照常报 ref-missing（fail closed，不偷偷回退 live）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W_SUBJECT, 'audit', child('subject')) // live 有，但冻结里没有

    const d = rootCalling({ name: 'audit', id: W_SUBJECT })
    const empty = JSON.stringify({ closureVersion: 2, workflows: {}, workgroups: {} })
    const r = validateWorkflowDef(
      d,
      await loadWorkflowValidationContext(db, {
        definition: d,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
        frozenClosureJson: empty,
      }),
    )
    expect(errorCodes(r)).toContain('call-workflow-ref-missing')
  })

  test('v1 存量闭包（name-keyed）同样只读它、不查 live', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, W_SUBJECT, 'audit', child('topic')) // live 已漂移

    const d = rootCalling({ name: 'audit', id: W_SUBJECT })
    const v1 = JSON.stringify({
      workflows: { audit: { id: W_SUBJECT, version: 1, definition: child('subject') } },
      workgroups: {},
    })
    const r = validateWorkflowDef(
      d,
      await loadWorkflowValidationContext(db, {
        definition: d,
        currentWorkflow: { id: ROOT, name: 'root-wf' },
        frozenClosureJson: v1,
      }),
    )
    expect(errorCodes(r)).toEqual([])
  })
})
