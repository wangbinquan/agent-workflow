// RFC-359 AC-1（第 14 刀）—— 源终止参与者的**唯一**实现，两个 provider 共用。
//
// 合并之前这里是一对同目录孪生（`sqlite…` 67 行 / `postgresql…` 53 行）。W12 判「不合」，
// 理由写的是「两侧既有的提交后事件 / 停止位置与 SQLite 无 driver 收尾机制」。逐格量完，
// 那三样一样也不是引擎差异：
//
//   ①**发布 / 请求停机相对评审锁的位置**。SQLite 在锁内发布并 `requestStop`、在锁外 `awaitStopped`；
//     PostgreSQL 三样全在锁外。这是**时序选择**，不是引擎强加的。合并取 SQLite 那一半，
//     理由是它严格更强且不多花一分钱：`requestStop` 只是取一张停机票据（非阻塞），放在锁内
//     意味着「状态写入」与「停机请求」相对任务评审 FIFO 是原子的——中间插不进一次评审写入；
//     真正会久等的 `awaitStopped` 两侧本来就在锁外。
//   ②**运行时注册表**。PostgreSQL 收一个参数、SQLite 读模块全局——与第 12 刀同一条处方：
//     它是部署形态，做成参数，两个组合根各绑各的。
//   ③**无 driver 时的工作区收尾**。两侧的收尾器**不是同一个函数**（PostgreSQL 走 source-control
//     的 `finalizeClaimedWorkspace`，SQLite 走 `finishClaimedWebhookWorkspacePrune`），所以它
//     必须是注入的端口；但「要不要收尾」两侧应当一致——两条 boot 都装了同一条 durable 消费者
//     （`nudgeWorkspacePrune`）作为兜底，同步收尾让回执（`no-active-owner`）在返回时就是真的。
import type { ProviderNeutralDatabase } from '@/db/query'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { ConflictError } from '@/util/errors'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
} from '../application/applySourceTerminationEffect'
import { sourceTerminationCapabilityMatches } from '../application/sourceTerminationCapability'
import { executeSourceTermination } from '../application/sourceTerminationExecution'
import { taskExecutionModule } from '../composition'
import type { InMemoryTaskRuntimeRegistry } from './inMemoryTaskRuntimeRegistry'
import { applySourceTerminationTarget } from './sourceTerminationTarget'
import { listSourceTerminationTargets } from './sourceTerminationTargets'

export interface TaskSourceTerminationParticipantInput {
  readonly db: ProviderNeutralDatabase
  /** 停机票据注册表。缺省是进程级单例（单进程部署形态）。 */
  readonly runtimeRegistry?: InMemoryTaskRuntimeRegistry
  /**
   * 没有本地 driver 时的工作区收尾。**两条 boot 各交自己那一份**——PostgreSQL 交
   * source-control 的 `finalizeClaimedWorkspace`，SQLite 交 `finishClaimedWebhookWorkspacePrune`。
   * 不交就只剩 durable 消费者兜底（回执仍是 `no-active-owner`，只是收尾异步发生）。
   */
  readonly finalizeWithoutDriver?: (taskId: string) => Promise<void>
}

export function createTaskSourceTerminationParticipant(
  input: TaskSourceTerminationParticipantInput,
): TaskSourceTerminationParticipant {
  const db = input.db
  const runtimeRegistry = input.runtimeRegistry ?? taskExecutionModule.runtimeRegistry
  return {
    async apply(
      capability: SourceTerminationEffectCapability,
      effect: TaskSourceTerminationEffectInput,
    ) {
      if (!sourceTerminationCapabilityMatches(capability, effect)) {
        throw new ConflictError(
          'source-termination-capability-invalid',
          'source termination capability does not match the claimed durable effect',
        )
      }

      return await executeSourceTermination(
        effect,
        () => listSourceTerminationTargets(db, effect),
        (taskId) =>
          withTaskReviewMutationLock(taskId, async () => {
            const applied = await applySourceTerminationTarget(db, runtimeRegistry, taskId, effect)
            if (applied === null) return null
            // 锁内：发布已提交事件 + 取停机票据（都不阻塞）。
            await publishCommittedEventsAfterCommit(applied.eventRefs)
            return {
              ...applied,
              stopTicket:
                applied.stopToken !== null && applied.stopCause !== null
                  ? runtimeRegistry.requestStop(applied.stopToken, applied.stopCause)
                  : null,
            }
          }),
        // 锁外：真正会久等的那一步。
        async (applied) =>
          applied.stopTicket === null
            ? null
            : await runtimeRegistry.awaitStopped(applied.stopTicket),
        input.finalizeWithoutDriver,
      )
    },
  }
}
