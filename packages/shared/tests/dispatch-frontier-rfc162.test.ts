// RFC-162 T1 — dispatch 起跑前沿 oracle `computeDispatchFrontier` 的可断言矩阵。
//
// 语义锁：n ∈ frontier ⟺ handler 组里没有别的节点是 n 的传递 dataflow 祖先。dispatch 只 mint
// 前沿，其余组员由 RFC-074 freshness 级联重跑。覆盖 design/RFC-162 §dispatch + §失败模式：
//   * 黄金锁：默认组（只提问节点）→ 前沿=它自己（与旧「逐个 mint 提问节点」逐字一致）；
//   * 改派上游 → 上游成前沿、提问节点级联（= designer 修订路径）；
//   * 改派下游 → 提问节点仍最前成前沿（用户 2026-07-09「从最前节点开始跑」）；
//   * 并行/多起跑 → 各自成前沿、无漏；
//   * 有界防环：畸形环图不死循环、结果确定（F2）。

import { describe, expect, test } from 'bun:test'
import { computeDispatchFrontier } from '../src/task-questions'

/** 从 dataflow 边表 [{from,to}] 造 `upstreamsOf`（直接上游 = 指向本节点的 from）。 */
function upstreams(edges: ReadonlyArray<{ from: string; to: string }>) {
  const parents = new Map<string, string[]>()
  for (const e of edges) {
    const list = parents.get(e.to)
    if (list) list.push(e.from)
    else parents.set(e.to, [e.from])
  }
  return (n: string): readonly string[] => parents.get(n) ?? []
}

describe('RFC-162 computeDispatchFrontier', () => {
  test('黄金锁：默认组只提问节点 → 前沿=它自己', () => {
    // A 有上游 U（但 U 不在 handler 组里）——前沿仍是 A（与旧逐个 mint 提问节点逐字一致）。
    const up = upstreams([{ from: 'U', to: 'A' }])
    expect(computeDispatchFrontier(['A'], up)).toEqual(['A'])
  })

  test('组内上游存在 → 下游不入前沿（linear A→B→C，组=[C,A]）→ [A]', () => {
    const up = upstreams([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ])
    expect(computeDispatchFrontier(['C', 'A'], up)).toEqual(['A'])
  })

  test('组=[B,C] on A→B→C → 前沿 [B]（B 是 C 的传递祖先）', () => {
    const up = upstreams([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ])
    expect(computeDispatchFrontier(['B', 'C'], up)).toEqual(['B'])
  })

  test('改派上游（designer 修订）：提问节点 A，上游 B（B→A），组=[A,B] → 前沿 [B]（A 级联）', () => {
    const up = upstreams([{ from: 'B', to: 'A' }])
    expect(computeDispatchFrontier(['A', 'B'], up)).toEqual(['B'])
  })

  test('改派下游：提问节点 A，下游 D（A→D），组=[A,D] → 前沿 [A]（A 最前、D 级联）', () => {
    const up = upstreams([{ from: 'A', to: 'D' }])
    expect(computeDispatchFrontier(['A', 'D'], up)).toEqual(['A'])
  })

  test('并行：A→C、B→C，组=[A,B] → 前沿 [A,B]（互不依赖、各自起跑）', () => {
    const up = upstreams([
      { from: 'A', to: 'C' },
      { from: 'B', to: 'C' },
    ])
    expect(computeDispatchFrontier(['A', 'B'], up)).toEqual(['A', 'B'])
  })

  test('多起跑：组=[A,B,D]，A→D、B 独立 → 前沿 [A,B]（D 由 A 级联，不入前沿）', () => {
    const up = upstreams([{ from: 'A', to: 'D' }])
    expect(computeDispatchFrontier(['A', 'B', 'D'], up)).toEqual(['A', 'B'])
  })

  test('保序去重：组=[A,A,B]（并行）→ [A,B]（首现序、去重）', () => {
    const up = upstreams([]) // 无边 = 全并行
    expect(computeDispatchFrontier(['A', 'A', 'B'], up)).toEqual(['A', 'B'])
  })

  test('有界防环：A→B、B→A 两节点环，组=[A,B] → 不死循环、确定返回 []', () => {
    const up = upstreams([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ])
    // 环里两者互为祖先 → 都不入前沿；关键是**有界终止、结果确定**（F2）。
    expect(computeDispatchFrontier(['A', 'B'], up)).toEqual([])
  })

  test('环外节点不受环影响：A↔B 环 + C→D，组=[C,D] → 前沿 [C]（遍历 D 上游不触环、有界）', () => {
    const up = upstreams([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
      { from: 'C', to: 'D' },
    ])
    expect(computeDispatchFrontier(['C', 'D'], up)).toEqual(['C'])
  })

  test('自环不误判：A→A 自环，组=[A] → 前沿 [A]（start 在 seen、不算自己祖先、不死循环）', () => {
    const up = upstreams([{ from: 'A', to: 'A' }])
    expect(computeDispatchFrontier(['A'], up)).toEqual(['A'])
  })

  test('空组 → []', () => {
    expect(computeDispatchFrontier([], upstreams([]))).toEqual([])
  })

  test('深链只取最前：A→B→C→D→E，组=[E,C,A] → [A]（A 是全部的传递祖先）', () => {
    const up = upstreams([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'C', to: 'D' },
      { from: 'D', to: 'E' },
    ])
    expect(computeDispatchFrontier(['E', 'C', 'A'], up)).toEqual(['A'])
  })
})
