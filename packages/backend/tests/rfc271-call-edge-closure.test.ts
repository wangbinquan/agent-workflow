// RFC-271 T6e（决策 28）—— 冻结闭包按**边**键控的回归。
//
// 三条承重断言，各对应一次设计门 finding：
//
//  ① **同名两个 call 节点各自生效**（R6-P1-3）。此前冻结结果是
//     `Record<name, ref>`，两个节点落到同一条；而工作组分支更彻底——它压根
//     不读 `workgroupId`，只按名取最老可见行，用户在下拉里选的那个被静默丢弃。
//
//  ② **key 必须带 source**（R7-P1-4）。节点 id 只在**单份 definition 内**唯一
//     （validator 只查单份内重复），传递闭包里两个不同工作流都用 `call-1` 是
//     合法的 ⇒ 扁平 `Record<nodeId, ref>` 必有一条被覆盖。
//
//  ③ **v1 存量闭包仍可读**。`tasks.refClosureJson` 里躺着 name-keyed 的 JSON，
//     零迁移是硬要求。

//
// 覆盖验收条款：AC-B2g（边身份契约）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import {
  callEdgeKey,
  childClosureSubset,
  frozenWorkflowFromClosure,
  frozenWorkgroupFromClosure,
  parseCallClosure,
} from '@/services/execution/closure'
import type { WorkflowDefinition } from '@agent-workflow/shared'

const emptyDef = (nodes: unknown[] = []): WorkflowDefinition =>
  ({ $schema_version: 4, inputs: [], nodes, edges: [] }) as unknown as WorkflowDefinition

describe('① 边键：同名两个节点互不覆盖', () => {
  test('两个都叫 audit 的 call 节点，各自拿到自己的冻结项', () => {
    const closure = JSON.stringify({
      closureVersion: 2,
      workflows: {
        [callEdgeKey('W0', 'c1')]: { id: 'W1', version: 1, definition: emptyDef() },
        [callEdgeKey('W0', 'c2')]: { id: 'W2', version: 3, definition: emptyDef() },
      },
      workgroups: {},
    })
    expect(
      frozenWorkflowFromClosure(closure, 'audit', { workflowId: 'W0', nodeId: 'c1' })?.id,
    ).toBe('W1')
    expect(
      frozenWorkflowFromClosure(closure, 'audit', { workflowId: 'W0', nodeId: 'c2' })?.id,
    ).toBe('W2')
  })

  test('工作组侧同理（此前它连 workgroupId 都不读）', () => {
    const closure = JSON.stringify({
      closureVersion: 2,
      workflows: {},
      workgroups: {
        [callEdgeKey('W0', 'g1')]: { id: 'G1', version: 1, group: { members: [] } },
        [callEdgeKey('W0', 'g2')]: { id: 'G2', version: 1, group: { members: [] } },
      },
    })
    expect(
      frozenWorkgroupFromClosure(closure, 'audit', { workflowId: 'W0', nodeId: 'g1' })?.id,
    ).toBe('G1')
    expect(
      frozenWorkgroupFromClosure(closure, 'audit', { workflowId: 'W0', nodeId: 'g2' })?.id,
    ).toBe('G2')
  })
})

describe('② key 必须带 source：跨 definition 的同名 nodeId 不得碰撞', () => {
  test('两个不同工作流都用 call-1 —— 边键让它们分开', () => {
    // 节点 id 只在单份 definition 内唯一，这是合法输入。
    expect(callEdgeKey('W0', 'call-1')).not.toBe(callEdgeKey('W9', 'call-1'))
    const closure = JSON.stringify({
      closureVersion: 2,
      workflows: {
        [callEdgeKey('W0', 'call-1')]: { id: 'A', version: 1, definition: emptyDef() },
        [callEdgeKey('W9', 'call-1')]: { id: 'B', version: 1, definition: emptyDef() },
      },
      workgroups: {},
    })
    expect(
      frozenWorkflowFromClosure(closure, 'x', { workflowId: 'W0', nodeId: 'call-1' })?.id,
    ).toBe('A')
    expect(
      frozenWorkflowFromClosure(closure, 'x', { workflowId: 'W9', nodeId: 'call-1' })?.id,
    ).toBe('B')
  })
})

describe('③ v1 存量闭包零迁移', () => {
  const v1 = JSON.stringify({
    workflows: { audit: { id: 'W1', version: 1, definition: emptyDef() } },
    workgroups: { squad: { id: 'G1', version: 1, group: { members: [] } } },
  })

  test('parse 认得 v1（无 closureVersion）', () => {
    const parsed = parseCallClosure(v1)
    expect(parsed).not.toBeNull()
    expect(parsed?.closureVersion).toBeUndefined()
  })

  test('消费端对 v1 回退按名字取——即使传了 source', () => {
    expect(frozenWorkflowFromClosure(v1, 'audit', { workflowId: 'W0', nodeId: 'c1' })?.id).toBe(
      'W1',
    )
    expect(frozenWorkgroupFromClosure(v1, 'squad', { workflowId: 'W0', nodeId: 'g1' })?.id).toBe(
      'G1',
    )
  })

  test('v2 闭包在**没有** source 时也回退按名字（过渡形态的调用方）', () => {
    const v2 = JSON.stringify({
      closureVersion: 2,
      workflows: { [callEdgeKey('W0', 'c1')]: { id: 'W1', version: 1, definition: emptyDef() } },
      workgroups: {},
    })
    // 名字取不到（key 是边），返回 null 而不是乱给一个——消费点会 fail closed。
    expect(frozenWorkflowFromClosure(v2, 'audit')).toBeNull()
  })
})

describe('childClosureSubset —— 第三个消费者（R6-P1-3 漏掉的那个）', () => {
  const childDef = emptyDef([{ id: 'c1', kind: 'call-workflow', workflowName: 'grand' }])

  test('v2：按边裁剪，用**子工作流自己的 id** 当 source', () => {
    const closure = JSON.stringify({
      closureVersion: 2,
      workflows: {
        [callEdgeKey('CHILD', 'c1')]: { id: 'G', version: 1, definition: emptyDef() },
        [callEdgeKey('OTHER', 'c1')]: { id: 'X', version: 1, definition: emptyDef() },
      },
      workgroups: {},
    })
    const subset = childClosureSubset(closure, childDef, 'CHILD')
    expect(subset).not.toBeNull()
    const parsed = JSON.parse(subset!) as { workflows: Record<string, { id: string }> }
    // 只保留本子工作流可达的那条边；另一个 source 的同 nodeId 不得混进来。
    expect(parsed.workflows[callEdgeKey('CHILD', 'c1')]?.id).toBe('G')
    expect(parsed.workflows[callEdgeKey('OTHER', 'c1')]).toBeUndefined()
  })

  test('v1：不传 source 时按名字裁剪（存量行为逐字不变）', () => {
    const v1closure = JSON.stringify({
      workflows: { grand: { id: 'G', version: 1, definition: emptyDef() } },
      workgroups: {},
    })
    const subset = childClosureSubset(v1closure, childDef)
    expect(subset).not.toBeNull()
    const parsed = JSON.parse(subset!) as { workflows: Record<string, { id: string }> }
    expect(parsed.workflows.grand?.id).toBe('G')
  })

  test('裁剪后为空仍返回 null（既有契约）', () => {
    const closure = JSON.stringify({ closureVersion: 2, workflows: {}, workgroups: {} })
    expect(childClosureSubset(closure, childDef, 'CHILD')).toBeNull()
  })
})
