// RFC-146 T2 — validator learns wrapper-fanout ports (declaredPorts 单源).
//
// 为什么这条测试存在：validator 的 per-kind 端口 switch（五份 fork 中的第五份）
// 没有 wrapper-fanout case——fanout 出口（聚合器改名端口或隐式 __done__）接普通
// 下游边 / output 绑定 / loop exitCondition 一律 false-error
// （edge-source-port-missing / binding-port-missing 家族），而这些码是 error 级、
// **阻断 createTask 启动**（task.ts 静态校验门）。canvas 一直用
// deriveWrapperFanoutOutputs 正常渲染这些端口——同一 kind 两个真相的典型。
// RFC-146 用 shared declaredPorts 单源后 validator 与 canvas 同源，本文件锁修复。

import type { Agent, Skill, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

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

const EMPTY_SKILLS: Skill[] = []

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes: [], edges: [], ...parts }
}

function codesOf(def: WorkflowDefinition, agents: Agent[] = []): string[] {
  return validateWorkflowDef(def, { agents, skills: EMPTY_SKILLS }).issues.map((i) => i.code)
}

/** fanout（无聚合器 ⇒ 隐式 __done__ 出口）+ 下游 sink。 */
function fanoutWithDownstreamEdge(sourcePort: string): WorkflowDefinition {
  return makeDef({
    nodes: [
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      { id: 'inner', kind: 'agent-single', agentName: 'worker' },
      { id: 'sink', kind: 'agent-single', agentName: 'worker' },
    ] as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'e-down',
        source: { nodeId: 'fan', portName: sourcePort },
        target: { nodeId: 'sink', portName: 'go' },
      },
    ] as WorkflowDefinition['edges'],
  })
}

describe('RFC-146 — fanout 出口对下游边可见（曾 false-error 并阻断启动）', () => {
  test('__done__ 信号出口接普通下游边：不再 edge-source-port-missing', () => {
    const codes = codesOf(fanoutWithDownstreamEdge('__done__'), [agent('worker')])
    expect(codes).not.toContain('edge-source-port-missing')
  })

  test('聚合器改名出口接下游边：通过；未声明端口名依旧报错', () => {
    const agg = agent('agg', {
      role: 'aggregator',
      outputs: ['report'],
      outputWrapperPortNames: { report: 'final_report' },
    } as Partial<Agent>)
    const def = makeDef({
      nodes: [
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner', 'a'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
        { id: 'a', kind: 'agent-single', agentName: 'agg' },
        { id: 'sink', kind: 'agent-single', agentName: 'worker' },
      ] as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e-ok',
          source: { nodeId: 'fan', portName: 'final_report' },
          target: { nodeId: 'sink', portName: 'report' },
        },
        {
          id: 'e-bad',
          source: { nodeId: 'fan', portName: 'no_such_port' },
          target: { nodeId: 'sink', portName: 'x' },
        },
      ] as WorkflowDefinition['edges'],
    })
    const issues = validateWorkflowDef(def, {
      agents: [agent('worker'), agg],
      skills: EMPTY_SKILLS,
    }).issues
    const missing = issues.filter((i) => i.code === 'edge-source-port-missing')
    expect(missing.map((i) => i.pointer)).toEqual(['e-bad'])
  })

  test('output 节点绑定 fanout 出口：不再 binding-port-missing', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'sink',
          kind: 'output',
          ports: [{ name: 'result', bind: { nodeId: 'fan', portName: '__done__' } }],
        },
      ] as WorkflowDefinition['nodes'],
    })
    const codes = codesOf(def, [agent('worker')])
    expect(codes).not.toContain('binding-port-missing')
  })

  test('fanout 声明输入进入 inputPorts 投影（shardSource 边不再无端口可循）', () => {
    // 普通边打进 fanout 声明输入口：target 侧对非 output/wrapper-git/loop 本就
    // 宽容，此处锁的是「不因新增投影而引入新报错」。
    const def = makeDef({
      nodes: [
        { id: 'up', kind: 'agent-single', agentName: 'lister' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
      ] as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e-in',
          source: { nodeId: 'up', portName: 'files' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
      ] as WorkflowDefinition['edges'],
    })
    const codes = codesOf(def, [
      agent('lister', { outputs: ['files'], outputKinds: { files: 'list<path<md>>' } }),
      agent('worker'),
    ])
    expect(codes).not.toContain('edge-target-port-missing')
    expect(codes).not.toContain('edge-source-port-missing')
  })

  test('loop exitCondition 引用 fanout 出口：不再 loop-exit-port-missing 家族', () => {
    const def = makeDef({
      nodes: [
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['fan', 'inner'],
          maxIterations: 2,
          exitCondition: { type: 'port-empty', nodeId: 'fan', portName: '__done__' },
        },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
      ] as WorkflowDefinition['nodes'],
    })
    const issues = validateWorkflowDef(def, {
      agents: [agent('worker')],
      skills: EMPTY_SKILLS,
    }).issues
    // exitCondition 端口存在性检查不应再报（其余 fanout-in-loop 语义警告不在
    // 本锁范围）。
    const exitPortIssues = issues.filter(
      (i) => i.message.includes('exitCondition') && i.message.includes('__done__'),
    )
    expect(exitPortIssues).toEqual([])
  })

  test('review inputSource 指向 fanout 出口：从 missing 降为 not-markdown（语义正确）', () => {
    // 端口存在 ⇒ 不再 review-input-source-missing；但 fanout 不是 agent 上游，
    // markdown kind 无从声明 ⇒ 仍以 review-input-source-not-markdown 拦住。
    const def = makeDef({
      nodes: [
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        { id: 'inner', kind: 'agent-single', agentName: 'worker' },
        { id: 'rev', kind: 'review', inputSource: { nodeId: 'fan', portName: '__done__' } },
      ] as WorkflowDefinition['nodes'],
    })
    const codes = codesOf(def, [agent('worker')])
    expect(codes).not.toContain('review-input-source-missing')
    expect(codes).toContain('review-input-source-not-markdown')
  })
})
