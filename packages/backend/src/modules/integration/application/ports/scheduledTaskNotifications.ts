// RFC-438 — 定时任务的变更通知端口。原服务与节拍直接调用 WS 广播；application 不碰传输层，composition 用 WS 广播连接。
// 事件就是共享的 `ScheduledTaskWsMessage`（created / updated / deleted / fired，各带 id 与 ownerUserId），形状与原广播逐字相同。
import type { ScheduledTaskWsMessage } from '@agent-workflow/shared'

export interface ScheduledTaskNotifications {
  notify(change: ScheduledTaskWsMessage): void
}
