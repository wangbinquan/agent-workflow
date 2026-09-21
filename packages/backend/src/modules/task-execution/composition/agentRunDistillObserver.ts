// RFC-366 —— 把 task-execution 的「agent 运行结束」事实接到 memory 的蒸馏入队上。
//
// 与 `gateContinuationPreDrive.ts` 同形：装配住在 task-execution 的 composition 层，
// 只认 memory 的 exact public participant（`MemoryDistillEnqueuer`），引擎本体一无所知。
//
// `nodeId` 原样转交而不在这里解析 agent —— 解析需要任务的工作流快照，而
// `enqueueDistillJob` 为了准入判定本来就要读那一行任务。在这里再读一次既多一次查询，
// 又会多出一份「什么算可解析的 agent 节点」的判据副本。

import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import type {
  AgentRunSettledEvent,
  AgentRunSettledObserver,
} from '../application/ports/agentRunSettledObserver'

export function composeAgentRunDistillObserver(
  memoryDistillEnqueuer: MemoryDistillEnqueuer,
): AgentRunSettledObserver {
  return Object.freeze({
    async onAgentRunSettled(event: AgentRunSettledEvent) {
      await memoryDistillEnqueuer.enqueue({
        sourceKind: 'agent-run',
        sourceEventId: event.nodeRunId,
        taskId: event.taskId,
        nodeId: event.nodeId,
      })
    },
  })
}
