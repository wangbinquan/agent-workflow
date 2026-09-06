// RFC-359 W4-D19c —— 工作组回合的测试驱动入口。
//
// 合一之前这些套件直接调 legacy engine 的 `runWorkgroupEngine`——也就是说它们锁的是**那一份**
// 实现，而生产上 PostgreSQL 跑的是另一份（中立的 `workgroupTurnsDriver`），后者几乎没有行为覆盖。
// 这个 shim 保持 `runWorkgroupEngine` 的调用形状（db + taskId + log + hooks），把它接到两个 provider
// 真正在跑的那条路上，于是同一批断言在两个引擎上各跑一遍。

import type { ProviderNeutralDatabase } from '@/db/query'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import { composeWorkgroupTurnsOperations } from '@/modules/resource-catalog/composition/workgroupTurns'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import { broadcastNodeStatus } from '@/modules/task-execution/composition/nodeMechanics'
import type { NodeRunStatus } from '@agent-workflow/shared'
import type {
  WorkgroupTurnHostRequest,
  WorkgroupTurnHostResult,
  WorkgroupTurnLogger,
  WorkgroupTurnsOutcome,
} from '@/modules/task-execution/public/commands'

export interface WorkgroupTurnsTestHooks {
  runHostNode: (request: WorkgroupTurnHostRequest) => Promise<WorkgroupTurnHostResult>
  broadcastNodeStatus?: (nodeRunId: string, nodeId: string, status: string) => void
  getCanonicalFilesChanged?: () => Promise<number>
}

/** 两个 provider 都用的回合操作；装配与两个 bootstrap 完全同一条。 */
export function composeTestWorkgroupTurns(db: ProviderNeutralDatabase) {
  return composeWorkgroupTurnsOperations(
    db,
    composeWorkgroupHostLedgerParticipantFactory({
      collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
    }),
    createWorkgroupClarifyAskGate(db),
  )
}

/** 与 legacy `runWorkgroupEngine(args)` 同形的调用面，跑的是中立回合驱动。 */
export async function runWorkgroupTurns(args: {
  db: ProviderNeutralDatabase
  taskId: string
  log: WorkgroupTurnLogger
  signal?: AbortSignal
  hooks: WorkgroupTurnsTestHooks
}): Promise<WorkgroupTurnsOutcome> {
  return await composeTestWorkgroupTurns(args.db).drive({
    taskId: args.taskId,
    log: args.log,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    host: {
      runHost: (request) => args.hooks.runHostNode(request),
      // 默认接的是**生产**那一条广播（`buildWorkgroupEngineSupport` 用的同一个函数）：
      // 合一前 legacy 引擎自己直连 `taskBroadcaster`，套件不给这个 hook 也能收到帧；中立驱动把
      // 广播收成了宿主的可选能力，测试要照生产形态接上，断言才还锁得住「每次真 mint 一帧 pending」。
      broadcastNodeStatus:
        args.hooks.broadcastNodeStatus ??
        ((nodeRunId, nodeId, status) =>
          broadcastNodeStatus(args.taskId, nodeRunId, nodeId, status as NodeRunStatus)),
      ...(args.hooks.getCanonicalFilesChanged === undefined
        ? {}
        : { getCanonicalFilesChanged: args.hooks.getCanonicalFilesChanged }),
    },
  })
}
