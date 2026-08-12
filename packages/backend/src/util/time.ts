// RFC-284 T7（2026-08-12 审计 N20）——单调 updatedAt 的唯一拼写。
//
// 此前 `Math.max(Date.now(), prev + 1)` 内联 8 处 + plugin.ts 一份具名局部。
// 语义：行更新时间戳必须严格递增（同毫秒双写/时钟回拨下仍 +1 前进），
// OCC/展示排序依赖它。`resourceOperationCoordinator` 带 floors 的变体
// 用途不同（多源下限聚合），刻意不收。

export function monotonicNow(prev: number): number {
  return Math.max(Date.now(), prev + 1)
}
