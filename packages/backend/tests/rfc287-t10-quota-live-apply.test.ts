// RFC-287 T10（G4-C9）—— 三项配额的**即时生效**修复。
//
// 起因：并发/配额共 6 项，设置页此前只露 3 项。补齐前先修后端——第二轮设计门核实
// 出「不是前端补三个输入框就完事」，三项里只有代码平台池真的即时生效：
//
//   ① `maxActiveChildTasks`：`ensureChildTaskBudget` 只在 singleton 为 null 时用
//      调用方传来的 capacity 闭包，之后**永远**读第一个启动任务捕获的 opts。设置页
//      改完要等 daemon 重启才生效，而它在页面上和旁边三项长得一模一样。
//   ② 三个节点池：`getNodePoolSemaphore` 是 resize-on-read，每个 runTask 都把
//      daemon 级池改成**自己 opts 的值**。子任务继承父任务 opts，于是「配置改成 9
//      → 父任务在跑 → 派生一个子任务」这条日常路径上，用户的调整被静默撤销。

import { describe, expect, test } from 'bun:test'
import { getNodePoolSemaphore, resizeAllNodePools } from '../src/services/processNodeConcurrency'
import { SETTINGS_NUMERIC_BOUNDS } from '@agent-workflow/shared'

describe('RFC-287 T10 ① — 任务启动只播种、不改写 daemon 级池', () => {
  test("'seed-only' 在池已存在时不改容量（子任务带旧 opts 也撤销不了配置）", () => {
    const daemon = {}
    // 冷启动：第一个任务播种 4。
    expect(getNodePoolSemaphore(daemon, 'agent', 4, 'seed-only').capacity).toBe(4)
    // 用户在设置页改成 9（走 PUT /api/config 的热应用路径）。
    resizeAllNodePools(daemon, { agent: 9, script: 4, 'code-host': 8 })
    expect(getNodePoolSemaphore(daemon, 'agent', 9, 'seed-only').capacity).toBe(9)
    // 现在一个**带旧 opts** 的子任务启动——修复前这里会把池改回 4。
    expect(getNodePoolSemaphore(daemon, 'agent', 4, 'seed-only').capacity).toBe(9)
  })

  test("默认 'set' 语义保留（配置写入点仍要能改）", () => {
    const daemon = {}
    getNodePoolSemaphore(daemon, 'script', 4)
    expect(getNodePoolSemaphore(daemon, 'script', 2).capacity).toBe(2)
  })

  test('实例永不被替换（换实例 = 预算分裂）', () => {
    const daemon = {}
    const first = getNodePoolSemaphore(daemon, 'code-host', 8, 'seed-only')
    resizeAllNodePools(daemon, { agent: 4, script: 4, 'code-host': 3 })
    expect(getNodePoolSemaphore(daemon, 'code-host', 8, 'seed-only')).toBe(first)
    expect(first.capacity).toBe(3)
  })
})

describe('RFC-287 T10 ② — 六项配额全部可配且有范围', () => {
  const QUOTA_SETTINGS = [
    'maxConcurrentNodes',
    'maxConcurrentScriptNodes',
    'multiProcessSubprocessConcurrency',
    'maxConcurrentCodeHostCalls',
    'maxActiveChildTasks',
    'maxInvocationDepth',
  ] as const

  test('每一项都有数值范围（缺了 rangeHint 就渲染不出来）', () => {
    for (const key of QUOTA_SETTINGS) {
      const bound = (SETTINGS_NUMERIC_BOUNDS as Record<string, { min: number; max: number }>)[key]
      expect(bound, `${key} 缺少 SETTINGS_NUMERIC_BOUNDS 条目`).toBeDefined()
      expect(bound.min).toBeGreaterThanOrEqual(1)
      expect(bound.max).toBeGreaterThan(bound.min)
    }
  })

  test('上界按语义分档，不是一律 256', () => {
    const b = SETTINGS_NUMERIC_BOUNDS as Record<string, { min: number; max: number }>
    // 嵌套深度是防环护栏，越大一次环路烧掉的时间越长。
    expect(b['maxInvocationDepth']?.max).toBeLessThanOrEqual(16)
    // 每个活跃子任务都会再撑开一整套节点池占用。
    expect(b['maxActiveChildTasks']?.max).toBeLessThanOrEqual(64)
  })
})
