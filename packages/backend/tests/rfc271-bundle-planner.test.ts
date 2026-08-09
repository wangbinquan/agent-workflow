// RFC-271 T12b —— 依赖规划器与 pending seams（承重不变量 I4 / I5）。
//
// I4 的类型序**照抄** `resolveChangeset.ts:651-665`，不是自己重排：
//   skills → mcps → plugins → agents(dependsOn 拓扑) → wf/wg
// 方向由引用关系决定——agent 引用技能/MCP/插件，工作流与工作组引用 agent。排错了
// 不是「顺序不好看」，是被引用方还没落库、preflight 直接报引用不存在。
//
// I5 的要害在**时机**：预铸 id 必须早于 preflight。`pendingBundleIds` 的元素是
// 预铸的**资源 id**（不是名字），各 prepare* 内核靠它接受「同 bundle 内尚未落库
// 的目标」。晚于 preflight 预铸，一个引用同包新建 agent 的工作组必然报错。

//
// 覆盖验收条款：AC-B4c（dependency planner + pending seams）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import type { BundleOp } from '@agent-workflow/shared'
import {
  BundleCycleError,
  localSlugOf,
  opAction,
  opSlug,
  pendingSeamsFor,
  planBundleOps,
  resourceTypeOfOp,
} from '../src/services/bundle/provider'

const create = (kind: string, slug: string, payload: Record<string, unknown> = {}): BundleOp =>
  ({ opId: 'op-1', kind, slug, payload: { name: slug, ...payload } }) as unknown as BundleOp

const update = (kind: string, token: string): BundleOp =>
  ({
    opId: 'op-2',
    kind,
    target: `external:${token}`,
    expect: { expectedVersion: 1 },
    payload: { name: token },
  }) as unknown as BundleOp

const slugsOf = (ops: BundleOp[]): string[] => ops.map((o) => opSlug(o) ?? `ext:${o.opId}`)

describe('op 的三个投影', () => {
  test('kind → 资源类型 / 动作 / slug', () => {
    expect(resourceTypeOfOp(create('agent-create', 'a'))).toBe('agent')
    expect(resourceTypeOfOp(update('workgroup-update', 'g'))).toBe('workgroup')
    expect(opAction(create('skill-create', 's'))).toBe('create')
    expect(opAction(update('mcp-update', 'm'))).toBe('update')
    // update op 没有 slug —— 它的目标已经在库里。
    expect(opSlug(update('mcp-update', 'm'))).toBeNull()
  })

  test('localSlugOf 只认 `local:`，其余三种形态一律 null', () => {
    expect(localSlugOf('local:my-agent')).toBe('my-agent')
    expect(localSlugOf('external:01ABC')).toBeNull()
    expect(localSlugOf('project:repo-helper')).toBeNull()
    expect(localSlugOf('name:workflow/audit')).toBeNull()
  })
})

describe('I4 · 类型序', () => {
  test('六类按 skill → mcp → plugin → agent → wf/wg 出场', () => {
    // ⚠️ 工作流与工作组**同秩**（`resolveChangeset.ts` 的 `: 4`），所以它们之间
    // 由声明序决定，不存在「wf 一定在 wg 前」这回事——本用例把 w 声明在 g 前，
    // 断言里的 `w,g` 是稳定序的结果而不是秩的结果（下一条专门锁这件事）。
    const ops = [
      create('workflow-create', 'w'),
      create('workgroup-create', 'g'),
      create('agent-create', 'a'),
      create('plugin-create', 'p'),
      create('mcp-create', 'm'),
      create('skill-create', 's'),
    ]
    expect(slugsOf(planBundleOps(ops))).toEqual(['s', 'm', 'p', 'a', 'w', 'g'])
  })

  test('工作流与工作组同秩，按原始声明序稳定（两者互不引用）', () => {
    const ops = [create('workgroup-create', 'g1'), create('workflow-create', 'w1')]
    expect(slugsOf(planBundleOps(ops))).toEqual(['g1', 'w1'])
  })

  test('create 与 update 混排只看类型，不看动作', () => {
    const ops = [update('agent-update', 'A'), create('skill-create', 's')]
    expect(resourceTypeOfOp(planBundleOps(ops)[0]!)).toBe('skill')
  })
})

describe('I4 · agent 组内的 dependsOn 拓扑', () => {
  test('被依赖的 agent 排在依赖方之前', () => {
    const ops = [
      create('agent-create', 'top', { dependsOn: ['local:mid'] }),
      create('agent-create', 'mid', { dependsOn: ['local:leaf'] }),
      create('agent-create', 'leaf'),
    ]
    expect(slugsOf(planBundleOps(ops))).toEqual(['leaf', 'mid', 'top'])
  })

  test('只统计**同 bundle 内**的依赖：external 指向库里既有行，不构成排序约束', () => {
    const ops = [
      create('agent-create', 'a', { dependsOn: ['external:01ALREADY', 'project:x'] }),
      create('agent-create', 'b'),
    ]
    // a 无同包依赖 ⇒ 深度 0 ⇒ 保持声明序。
    expect(slugsOf(planBundleOps(ops))).toEqual(['a', 'b'])
  })

  test('钻石依赖：两条路径的共同底座只出现一次且最先', () => {
    const ops = [
      create('agent-create', 'top', { dependsOn: ['local:l', 'local:r'] }),
      create('agent-create', 'l', { dependsOn: ['local:base'] }),
      create('agent-create', 'r', { dependsOn: ['local:base'] }),
      create('agent-create', 'base'),
    ]
    const order = slugsOf(planBundleOps(ops))
    expect(order[0]).toBe('base')
    expect(order.indexOf('l')).toBeLessThan(order.indexOf('top'))
    expect(order.indexOf('r')).toBeLessThan(order.indexOf('top'))
    expect(order.filter((s) => s === 'base')).toHaveLength(1)
  })

  test('闭环给出**确定**的拒绝点（同一输入永远同一条错误信息）', () => {
    const ops = [
      create('agent-create', 'b', { dependsOn: ['local:a'] }),
      create('agent-create', 'a', { dependsOn: ['local:b'] }),
    ]
    const runs = [0, 1, 2].map(() => {
      try {
        planBundleOps(ops)
        return null
      } catch (err) {
        return err instanceof BundleCycleError ? err.cycle.join('→') : `other:${String(err)}`
      }
    })
    expect(runs[0]).not.toBeNull()
    expect(new Set(runs).size).toBe(1) // 确定性：三次同一条
    expect(runs[0]).toContain('a')
    expect(runs[0]).toContain('b')
  })

  test('自依赖也是环', () => {
    const ops = [create('agent-create', 'a', { dependsOn: ['local:a'] })]
    expect(() => planBundleOps(ops)).toThrow(BundleCycleError)
  })

  test('非 agent 的 `dependsOn` 字段不参与拓扑（只有 agent 有这个语义）', () => {
    const ops = [
      create('workflow-create', 'w', { dependsOn: ['local:x'] }),
      create('workflow-create', 'x'),
    ]
    expect(slugsOf(planBundleOps(ops))).toEqual(['w', 'x'])
  })

  test('排序稳定：同秩同深度保持原始声明序', () => {
    const ops = ['s3', 's1', 's2'].map((s) => create('skill-create', s))
    expect(slugsOf(planBundleOps(ops))).toEqual(['s3', 's1', 's2'])
    expect(planBundleOps([])).toEqual([])
  })
})

describe('I5 · pending seams', () => {
  const idOf = (slug: string) => `01ID-${slug}`

  test('元素是**预铸 id**，不是名字', () => {
    const ops = [create('agent-create', 'auditor', { name: 'Auditor' })]
    const seams = pendingSeamsFor(ops, idOf)
    expect([...seams.pendingBundleIds]).toEqual(['01ID-auditor'])
    // 名字单独走 agent 那张表（工作组成员按名字挂载）。
    expect(seams.pendingAgentNames.get('01ID-auditor')).toBe('Auditor')
  })

  test('update op 不进 pending —— 它的目标已经在库里', () => {
    const seams = pendingSeamsFor([update('agent-update', 'A')], idOf)
    expect(seams.pendingBundleIds.size).toBe(0)
    expect(seams.pendingAgentNames.size).toBe(0)
  })

  test('只有 agent 进名字表；其余类型只进 id 集合', () => {
    const ops = [create('skill-create', 's'), create('agent-create', 'a')]
    const seams = pendingSeamsFor(ops, idOf)
    expect(seams.pendingBundleIds.size).toBe(2)
    expect([...seams.pendingAgentNames.keys()]).toEqual(['01ID-a'])
  })
})
