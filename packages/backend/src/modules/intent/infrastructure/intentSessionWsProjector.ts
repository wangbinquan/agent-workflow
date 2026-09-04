// RFC-355 T4b（RFC-294 W4-E4a）—— intent 会话事件投到进程内 WS 广播面。
//
// 端口在 `ports/intentSessionEvents.ts`，实现只有这一处：把 intent 声明的六种事件原样播到
// `intent-sessions` 频道。intent 的 application / inbound 此前各自 import `@/ws/broadcaster`
// （四条 `legacy-outbound` 例外），现在只剩这一个专职投影文件——与本仓既有形态一致
// （`task-execution/infrastructure/taskLifecycleWsProjector.ts`、
// `collaboration/infrastructure/collaborationClarifyDraftEventPublisher.ts`）。
//
// wire 面逐字不变：频道键与 payload 字段与迁位前完全相同，前端一行不用改。

import { INTENT_SESSIONS_CHANNEL, intentSessionsBroadcaster } from '@/ws/broadcaster'
import type { IntentSessionEvent, IntentSessionEventPublisher } from '../ports/intentSessionEvents'

export function createIntentSessionWsPublisher(): IntentSessionEventPublisher {
  return Object.freeze({
    publish(event: IntentSessionEvent): void {
      intentSessionsBroadcaster.broadcast(INTENT_SESSIONS_CHANNEL, event)
    },
  })
}
