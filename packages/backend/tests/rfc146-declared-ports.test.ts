// RFC-146 T2 — shared declaredPorts 表契约（端口声明层单源）。
//
// 为什么这条测试存在：端口推导曾有五份 fork（canvas computePorts / validator
// switch / loop 候选 / 控制流 kind / 拖放 inputs），互相欠维护已漂移成 bug
// （fanout 只有两份认识、clarify 在 canvas「靠边补」而 validator「硬编码」）。
// declaredPorts 收敛后，本文件逐 kind 锁表值——任何一维变化都必须显式改这里，
// 五个消费面同时受影响（这正是单源的意义）。

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { NODE_KIND, declaredPorts, resolveReviewInputKind } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

function agent(name: string, fields: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: ['out'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  }
}

function defOf(nodes: unknown[]): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [],
  } as unknown as WorkflowDefinition
}

const names = (ports: Array<{ name: string }>): string[] => ports.map((p) => p.name)

describe('declaredPorts — 逐 kind 表值锁', () => {
  test('input：dataOutputs = [inputKey]，缺失时容错 out', () => {
    const node = { id: 'i', kind: 'input', inputKey: 'topic' }
    const d = declaredPorts(node as never, defOf([node]), new Map())
    expect(names(d.dataOutputs)).toEqual(['topic'])
    expect(d.dataInputs).toEqual([])
    expect(d.systemInputs).toEqual([])
    expect(d.systemOutputs).toEqual([])
    const bare = { id: 'i2', kind: 'input' }
    expect(names(declaredPorts(bare as never, defOf([bare]), new Map()).dataOutputs)).toEqual([
      'out',
    ])
  })

  test('output：dataInputs = ports[].name', () => {
    const node = {
      id: 'o',
      kind: 'output',
      ports: [
        { name: 'report', bind: { nodeId: 'x', portName: 'y' } },
        { name: 'meta', bind: { nodeId: 'x', portName: 'z' } },
      ],
    }
    const d = declaredPorts(node as never, defOf([node]), new Map())
    expect(names(d.dataInputs)).toEqual(['report', 'meta'])
    expect(d.dataOutputs).toEqual([])
  })

  test('agent-single：dataOutputs 带 outputKinds kind；系统口三件套恒在', () => {
    const a = agent('writer', {
      outputs: ['doc', 'sig'],
      outputKinds: { doc: 'path<md>', sig: 'signal' },
    })
    const node = { id: 'w', kind: 'agent-single', agentName: 'writer' }
    const d = declaredPorts(node as never, defOf([node]), new Map([[a.name, a]]))
    expect(d.dataOutputs).toEqual([
      { name: 'doc', kind: 'path<md>' },
      { name: 'sig', kind: 'signal' },
    ])
    expect(names(d.systemOutputs)).toEqual(['__clarify__'])
    expect(names(d.systemInputs)).toEqual(['__clarify_response__', '__external_feedback__'])
    // agent 不在册 ⇒ 数据口为空（渲染由调用点的边容错兜底），系统口仍在。
    const orphan = { id: 'w2', kind: 'agent-single', agentName: 'ghost' }
    const d2 = declaredPorts(orphan as never, defOf([orphan]), new Map())
    expect(d2.dataOutputs).toEqual([])
    expect(names(d2.systemOutputs)).toEqual(['__clarify__'])
  })

  test('wrapper-git / wrapper-loop：git_diff 常量与 outputBindings 投影', () => {
    const git = { id: 'g', kind: 'wrapper-git', nodeIds: [] }
    expect(names(declaredPorts(git as never, defOf([git]), new Map()).dataOutputs)).toEqual([
      'git_diff',
    ])
    const loop = {
      id: 'l',
      kind: 'wrapper-loop',
      nodeIds: [],
      outputBindings: [{ name: 'final', bind: { nodeId: 'x', portName: 'y' } }],
    }
    expect(names(declaredPorts(loop as never, defOf([loop]), new Map()).dataOutputs)).toEqual([
      'final',
    ])
  })

  test('wrapper-fanout：无聚合器 ⇒ __done__/signal；有聚合器 ⇒ 改名出口；声明输入带 kind', () => {
    const worker = agent('worker')
    const fan = {
      id: 'f',
      kind: 'wrapper-fanout',
      nodeIds: ['in1'],
      inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
    }
    const inner = { id: 'in1', kind: 'agent-single', agentName: 'worker' }
    const d = declaredPorts(fan as never, defOf([fan, inner]), new Map([[worker.name, worker]]))
    expect(d.dataOutputs).toEqual([{ name: '__done__', kind: 'signal' }])
    expect(d.dataInputs).toEqual([{ name: 'docs', kind: 'list<path<md>>' }])

    const agg = agent('agg', {
      role: 'aggregator',
      outputs: ['report'],
      outputKinds: { report: 'path<md>' },
      outputWrapperPortNames: { report: 'final_report' },
    } as Partial<Agent>)
    const fan2 = { ...fan, id: 'f2', nodeIds: ['in1', 'a1'] }
    const aggNode = { id: 'a1', kind: 'agent-single', agentName: 'agg' }
    const d2 = declaredPorts(
      fan2 as never,
      defOf([fan2, inner, aggNode]),
      new Map([
        [worker.name, worker],
        [agg.name, agg],
      ]),
    )
    expect(d2.dataOutputs).toEqual([{ name: 'final_report', kind: 'path<md>' }])
  })

  test('review：approved 出口名随输入 kind（多文档 accepted / 单文档 approved_doc）+ approval_meta', () => {
    const writer = agent('writer', {
      outputs: ['docs', 'doc'],
      outputKinds: { docs: 'list<path<md>>', doc: 'path<md>' },
    })
    const up = { id: 'up', kind: 'agent-single', agentName: 'writer' }
    const multi = { id: 'r1', kind: 'review', inputSource: { nodeId: 'up', portName: 'docs' } }
    const single = { id: 'r2', kind: 'review', inputSource: { nodeId: 'up', portName: 'doc' } }
    const defn = defOf([up, multi, single])
    const agents = new Map([[writer.name, writer]])
    expect(names(declaredPorts(multi as never, defn, agents).dataOutputs)).toEqual([
      'accepted',
      'approval_meta',
    ])
    expect(names(declaredPorts(single as never, defn, agents).dataOutputs)).toEqual([
      'approved_doc',
      'approval_meta',
    ])
    // resolveReviewInputKind 单独可用（曾是三份漂移拷贝）。
    expect(resolveReviewInputKind(multi as never, defn, agents)).toBe('list<path<md>>')
    expect(resolveReviewInputKind(single as never, defn, agents)).toBe('path<md>')
  })

  test('clarify / clarify-cross-agent：固定形状全部落系统组（canvas 靠边补语义显式化）', () => {
    const c = { id: 'c', kind: 'clarify' }
    const dc = declaredPorts(c as never, defOf([c]), new Map())
    expect(dc.dataInputs).toEqual([])
    expect(dc.dataOutputs).toEqual([])
    expect(names(dc.systemInputs)).toEqual(['questions'])
    expect(names(dc.systemOutputs)).toEqual(['answers'])
    const x = { id: 'x', kind: 'clarify-cross-agent' }
    const dx = declaredPorts(x as never, defOf([x]), new Map())
    expect(names(dx.systemInputs)).toEqual(['questions'])
    expect(names(dx.systemOutputs)).toEqual(['to_designer', 'to_questioner'])
  })

  test('未知 kind（脏快照）⇒ 四组全空，调用点边容错兜底', () => {
    const weird = { id: 'z', kind: 'agent-multi' }
    const d = declaredPorts(weird as never, defOf([weird]), new Map())
    expect(d).toEqual({ dataInputs: [], dataOutputs: [], systemInputs: [], systemOutputs: [] })
  })

  test('穷举保障：每个 NODE_KIND 都能取到声明（satisfies 之外的运行时冒烟）', () => {
    for (const kind of NODE_KIND) {
      const node = { id: `n-${kind}`, kind, nodeIds: [], inputs: [], ports: [] }
      const d = declaredPorts(node as never, defOf([node]), new Map())
      expect(Array.isArray(d.dataInputs)).toBe(true)
      expect(Array.isArray(d.dataOutputs)).toBe(true)
      expect(Array.isArray(d.systemInputs)).toBe(true)
      expect(Array.isArray(d.systemOutputs)).toBe(true)
    }
  })
})
