// RFC-359 W7 —— collaboration 的运行期机制（`CollaborationRuntimeMechanics`）：
// **一份实现，两个 provider 共用**。
//
// 合一前这一对是本文件（81 行纯转发，逐方法打到 `legacySqlite*` 的实现上）与
// `postgresqlCollaborationRuntimeMechanics.ts`（1747 行把同一批语义用原生 drizzle 重写了一遍）。
// 9 个方法一一对应、**没有能力缺口**；正典是被转发的那批实现——它们的写事务已经跑在
// `databaseSessionFor` / `withTaskExecutionWrite` 上（RFC-359 W1-T2a/b/c 合一决定 / 派发 /
// 快速澄清三条命令链路时就是这么做的），本刀补上剩下的三处 bun:sqlite 独有面：
//   · `collaborationWorkgroupClarify.ts` 的 `dbTxSync` + 同步 `setNodeRunStatusTx`；
//   · `clarify/service.ts` 的两处同步 `.get()` 与短路 stop 的同步 `withOwnedTaskTx`；
//   · `review.ts` 里那一处 defensive park 的同步 `transitionNodeRunStatus`。
//
// 合一顺带抹平的实测差异（2026-09-07 双引擎对拍）：PG 那份把 cross-clarify 短路的诊断标签写成
// `'cross-clarify-stop'`，SQLite 侧是 `'cross-clarify-persistent-stop'`；统一取后者。
//
// 保留惰性 import：评审 / 澄清域经 `services/humanGateComposition` 绕回 collaboration 的
// composition barrel，静态 import 会形成值环。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { CollaborationRuntimeMechanics } from '../application/ports/collaborationRuntimeMechanics'
import {
  dismissOpenClarifyParksForAutonomous,
  isTaskClarifySuppressed,
} from './collaborationWorkgroupClarify'

export function createCollaborationRuntimeMechanics(
  db: ProviderNeutralDatabase,
): CollaborationRuntimeMechanics {
  return Object.freeze({
    async dispatchReviewNode(input) {
      const { dispatchReviewNode } = await import('./review')
      return dispatchReviewNode({ db, ...input })
    },
    async inspectCrossClarify(input) {
      const { dispatchCrossClarifyNode } = await import('./clarify/service')
      return dispatchCrossClarifyNode({ db, ...input })
    },
    async openAgentClarify(input) {
      const { createClarifyRound } = await import('./clarify/service')
      const common = {
        db,
        taskId: input.taskId,
        askingNodeId: input.askingNodeId,
        askingNodeRunId: input.askingNodeRunId,
        containerRunId: input.frame?.containerRunId ?? null,
        intermediaryNodeId: input.intermediaryNodeId,
        questions: [...input.questions],
        ...(input.executionContext === undefined
          ? {}
          : { executionContext: input.executionContext }),
        ...(input.truncationWarnings === undefined
          ? {}
          : { truncationWarnings: [...input.truncationWarnings] }),
      }
      const result =
        input.kind === 'self'
          ? await createClarifyRound({
              ...common,
              kind: 'self',
              askingShardKey: input.askingShardKey,
              iteration: input.iteration,
              // RFC-354: the park row's round inside its frame.
              ...(input.frame === undefined ? {} : { frameIteration: input.frame.iteration }),
              ...(input.parentNodeRunId === undefined
                ? {}
                : { parentNodeRunId: input.parentNodeRunId }),
            })
          : await createClarifyRound({
              ...common,
              kind: 'cross',
              targetConsumerNodeId: input.targetConsumerNodeId,
              loopIter: input.loopIter,
            })
      return { intermediaryNodeRunId: result.intermediaryNodeRunId }
    },
    async resolveBorrowForNode(input) {
      const { resolveBorrowForNode } = await import('./taskQuestionDispatch')
      return resolveBorrowForNode(db, input.taskId, input.nodeId, input.iteration, input.definition)
    },
    async buildReviewPromptContext(input) {
      const { buildReviewPromptContext } = await import('./review')
      return buildReviewPromptContext(
        db,
        input.appHome,
        input.upstreamNodeId,
        input.taskId,
        input.iteration,
      )
    },
    async getNodeClarifyDirective(input) {
      const { getNodeClarifyDirective } = await import('./taskClarifyDirective')
      return getNodeClarifyDirective(db, input.taskId, input.nodeId, input.shardKey)
    },
    async buildClarifyQueueContext(input) {
      const { buildClarifyQueueContext } = await import('./clarify/queue')
      return buildClarifyQueueContext({ db, ...input })
    },
    isTaskClarifySuppressed: (input) => isTaskClarifySuppressed(db, input),
    dismissOpenClarifyParksForAutonomous: (input) =>
      dismissOpenClarifyParksForAutonomous(db, input),
  } satisfies CollaborationRuntimeMechanics)
}
