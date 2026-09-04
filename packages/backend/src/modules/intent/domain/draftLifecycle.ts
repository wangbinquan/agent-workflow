// RFC-355 T8（RFC-294 W4-E4a）—— 草稿在会话详情里的生命周期判据。
//
// 这三档此前是 `routes/intentSessions.ts` 详情 handler 里的一个三目表达式。它是纯判据：
// 「是不是当前草稿 / 有没有被提交过 / 否则按 resolution 归档」，不碰 IO、不碰 actor。
// 判据留在路由里意味着任何第二个出口（未来的导出、CLI、另一个视图）都要重写一遍。
//
// 档位枚举的事实源是 shared 的 `IntentDraftLifecycleSchema`，这里只做判据、不另立一套。

import type { IntentDraftDto } from '@agent-workflow/shared'

export type IntentDraftLifecycle = IntentDraftDto['lifecycle']

/** `superseded` 是缺省档：既非当前、也没提交过、又没有显式 resolution。 */
export function intentDraftLifecycleOf(input: {
  /** 该草稿是不是会话的 `currentDraftId`。 */
  readonly isCurrent: boolean
  /** 已提交草稿的 commitSeq；`null` = 没提交过。 */
  readonly commitSeq: number | null
  /** 显式记录的收场原因；`undefined` = 没有记录。 */
  readonly resolution: IntentDraftLifecycle | undefined
}): IntentDraftLifecycle {
  if (input.isCurrent) return 'current'
  if (input.commitSeq !== null) return 'committed'
  return input.resolution ?? 'superseded'
}
