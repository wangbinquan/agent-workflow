// RFC-270 §4.5 — `ancestryUnchanged` 的正反例。
//
// 它是画布 drag-stop 守卫的判据：受保护节点自己已经拖不动，但拖动**包着它的**
// wrapper 仍会让 `resolveMembershipOnDragStop` 按几何重算 `nodeIds`，从而改变它的
// 传递归属；而归属正在两个 author 门的敏感投影里，于是一次纯粹的「挪位置」会变成
// 403 —— 正是 `scriptAuthorGate.ts` 开头承诺「无权限也能移动脚本节点」的反面。
//
// 判据放在 shared 而不是画布里，是为了与门的判据同源；这几条用例锁住它确实跟着
// `wrapperAncestryOf` 的**传递**语义走（RFC-253 impl-gate 1.2：把节点原本那个
// 1 次的循环整个塞进 50 次的循环，直接容器没变但运行次数涨了 50 倍）。

import { describe, expect, it } from 'bun:test'
import { ancestryUnchanged, type WorkflowDefinition } from '../src/index'

function definitionOf(nodes: Array<Record<string, unknown>>): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: nodes as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
}

const script = { id: 'sc1', kind: 'script', language: 'python', script: 'print(1)' }

describe('RFC-270 · ancestryUnchanged', () => {
  it('同一份定义恒为真', () => {
    const def = definitionOf([script, { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'] }])
    expect(ancestryUnchanged(def, def, ['sc1'])).toBe(true)
  })

  it('位置变化不算改动（归属不看坐标）', () => {
    const before = definitionOf([
      { ...script, position: { x: 0, y: 0 } },
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'] },
    ])
    const after = definitionOf([
      { ...script, position: { x: 999, y: 999 } },
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'] },
    ])
    expect(ancestryUnchanged(before, after, ['sc1'])).toBe(true)
  })

  it('被拖进 wrapper ⇒ 假', () => {
    const before = definitionOf([script, { id: 'w1', kind: 'wrapper-loop', nodeIds: [] }])
    const after = definitionOf([script, { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'] }])
    expect(ancestryUnchanged(before, after, ['sc1'])).toBe(false)
  })

  it('被拖出 wrapper ⇒ 假', () => {
    const before = definitionOf([script, { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'] }])
    const after = definitionOf([script, { id: 'w1', kind: 'wrapper-loop', nodeIds: [] }])
    expect(ancestryUnchanged(before, after, ['sc1'])).toBe(false)
  })

  it('循环次数改了 ⇒ 假（跑几次也是执行语义）', () => {
    const before = definitionOf([
      script,
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'], maxIterations: 1 },
    ])
    const after = definitionOf([
      script,
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'], maxIterations: 50 },
    ])
    expect(ancestryUnchanged(before, after, ['sc1'])).toBe(false)
  })

  it('外层 wrapper 把内层整个包进去 ⇒ 假（传递归属，直接容器没变）', () => {
    const before = definitionOf([
      script,
      { id: 'inner', kind: 'wrapper-loop', nodeIds: ['sc1'], maxIterations: 1 },
      { id: 'outer', kind: 'wrapper-loop', nodeIds: [], maxIterations: 50 },
    ])
    const after = definitionOf([
      script,
      { id: 'inner', kind: 'wrapper-loop', nodeIds: ['sc1'], maxIterations: 1 },
      { id: 'outer', kind: 'wrapper-loop', nodeIds: ['inner'], maxIterations: 50 },
    ])
    expect(ancestryUnchanged(before, after, ['sc1'])).toBe(false)
  })

  it('只看点名的那些节点：别的节点归属变了不影响判定', () => {
    const other = { id: 'a1', kind: 'agent-single', agentId: 'ag1' }
    const before = definitionOf([
      script,
      other,
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1'] },
    ])
    const after = definitionOf([
      script,
      other,
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['sc1', 'a1'] },
    ])
    expect(ancestryUnchanged(before, after, ['sc1'])).toBe(true)
    expect(ancestryUnchanged(before, after, ['sc1', 'a1'])).toBe(false)
  })

  it('空 id 列表恒为真（没有受保护节点时守卫不该拦任何东西）', () => {
    const before = definitionOf([{ id: 'w1', kind: 'wrapper-loop', nodeIds: [] }])
    const after = definitionOf([{ id: 'w1', kind: 'wrapper-loop', nodeIds: ['x'] }])
    expect(ancestryUnchanged(before, after, [])).toBe(true)
  })
})
