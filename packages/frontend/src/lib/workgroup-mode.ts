// RFC-191 (T4) — single source of truth for WorkgroupMode → StatusChipKind,
// mirroring lib/task-status.ts#TASK_STATUS_KIND. The gallery card renders the
// mode as a semantic StatusChip (three modes, three colors); future surfaces
// (room header, detail) reuse this map so the colors can never drift.

import type { WorkgroupMode } from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

export const WORKGROUP_MODE_KIND: Record<WorkgroupMode, StatusChipKind> = {
  leader_worker: 'info',
  free_collab: 'neutral',
  dynamic_workflow: 'warn',
}

/**
 * RFC-209 D2 —— 房间是否画「第 X 回合」分隔线。
 *
 * 只有 leader_worker 有真正的全局回合（leader 一轮派活、成员并行、结果回流、下一轮）。
 * free_collab 的成员是**各自异步认领任务**的，不存在全局回合——此前显示的那个数其实是
 * `max_rounds` 的预算计数器（成员 run 累计行数），所以会 0→3→5→8 地跳。它改到右栏
 * 如实显示成「成员发言预算」。dynamic_workflow 没有聊天室。
 *
 * 放在这个文件是有意的：本仓 flag 审计把「同一个 kind 在多处各自派生」列为 P0，
 * 模式派生只留这一个落点。
 */
export function roomShowsRoundDividers(mode: WorkgroupMode): boolean {
  return mode === 'leader_worker'
}
