// RFC-353 T4（RFC-294 W4-E3）—— fusion 聚合的状态机（纯，零 IO）。
//
// 从 `services/fusion.ts` 逐字平移，**一个转移都没改**。
// RFC-294 `design.md §10`：knowledge-evolution 唯一拥有 fusion aggregate 与它的
// iteration / 最终 approve/reject 状态机——所以这张表的家在这里，不在 legacy services。

import type { FusionStatus } from '@agent-workflow/shared'

/**
 * `rejected` 是保留态：v1 里拒绝会重新进入 `running`（带反馈重跑），
 * 终态 `rejected` 从未被写入。保留它是为了让状态集合与 wire 上的枚举保持一致。
 */
const FUSION_TRANSITIONS: Record<FusionStatus, readonly FusionStatus[]> = {
  running: ['awaiting_approval', 'failed', 'canceled'],
  awaiting_approval: ['applying', 'running', 'canceled', 'failed'],
  applying: ['done', 'failed'],
  done: [],
  rejected: [],
  canceled: [],
  failed: [],
}

export function isValidFusionTransition(from: FusionStatus, to: FusionStatus): boolean {
  return FUSION_TRANSITIONS[from]?.includes(to) ?? false
}
