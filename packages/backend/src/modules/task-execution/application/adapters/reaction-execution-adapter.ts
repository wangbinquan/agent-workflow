// RFC-368 T7 —— TaskExecution 对数字员工 `ReactionExecutionPortV1` 的实现。
//
// 与旧的字符串 participant 相比，逐条都是设计门 r1 或用户裁决的产物：
//
//   · **不再有跨缝 JSON**：`launch` 收 factory-built 的 `PreparedReactionExecutionV1`，plan /
//     attempt 是对象；核心端口也收对象。旧路径的「适配器 stringify → provider parse」随之消失。
//   · **执行身份来自 admission**：`admission.execution` 是在数字员工 claim 事务里预分配的 id，
//     这里拿它当 taskId。已存在就是重放——直接返回，不再建任务。于是「一次 Reaction 起两个
//     任务」在结构上不可能发生，不再需要旧路径那套按 round 推断活性的兜底。
//   · **四个方法全必选**：`inspectHumanReview` 不适用时返回 `not-applicable`。
//   · **失败详情只回 ref**：正文交给数字员工的 diagnostics sink 裁剪存档（G5）。
//   · **取消单列成 `stopped`**（G7）：只有「用户取消」才算；资源上限 / 空闲收割也把任务置成
//     canceled，但它们仍按失败走重试（判据在核心里，见 `composeDigitalEmployeeExecutionCore`）。
//
// `access` 只有 `{operation, executionRef}`（设计 D6）：回执在事务外重建不出来，于是由这里
// 查 TaskExecution 自己的 admission 日志核对两者对得上，不回读数字员工任何东西。
//
// 文件路径是 `application/adapters/*-adapter.ts`：账本据此把对数字员工合同类型的引用判成
// `required-implementation`。核心与日志都经本模块的应用层端口注入，不直接依赖 composition /
// infrastructure（`rfc294-review-module-layer-rules`）。

import { ConflictError } from '@/util/errors'
import type {
  DigitalEmployeeExecutionCore,
  TaskExecutionFailureClass,
} from '../ports/digitalEmployeeExecutionCore'
import type { ReactionAdmissionStore } from '../ports/reactionAdmissionStore'
import type {
  ReactionDiagnosticsSinkV1,
  ReactionExecutionAccessV1,
  ReactionExecutionPortV1,
  ReactionExecutionSnapshotV1,
  ReactionHumanReviewSnapshotV1,
  ReactionRetryFeedbackReaderV1,
  ReactionStopReceiptV1,
  WorkspaceFailureClass,
} from '@/modules/digital-employee/composition/required-ports'

/**
 * 两边的失败类别值集相同。按 TaskExecution 的键建表：provider 侧多出一个类别时这里先编译红，
 * 而不是在运行期把它当成未知类别吞掉。
 */
const FAILURE_CLASS: Readonly<Record<TaskExecutionFailureClass, WorkspaceFailureClass>> = {
  boundary: 'boundary',
  semantic: 'semantic',
  infrastructure: 'infrastructure',
}

function stopReceipt(executionRef: string): ReactionStopReceiptV1 {
  return `stopped:${executionRef}` as ReactionStopReceiptV1
}

export function composeReactionExecutionPortV1(deps: {
  readonly core: DigitalEmployeeExecutionCore
  readonly admissions: ReactionAdmissionStore
  readonly retryFeedback: ReactionRetryFeedbackReaderV1
  readonly diagnostics: ReactionDiagnosticsSinkV1
  readonly now: () => number
}): ReactionExecutionPortV1 {
  async function verified(access: ReactionExecutionAccessV1): Promise<string> {
    const row = await deps.admissions.find(access.operation)
    if (row === null || row.executionRef !== access.executionRef) {
      throw new ConflictError(
        'employee-reaction-access-mismatch',
        `reaction execution ${access.executionRef} is not the one admitted for ${access.operation}`,
      )
    }
    return row.executionRef
  }

  const port: ReactionExecutionPortV1 = {
    async launch(input, admission) {
      if (
        admission.operation !== input.request.operation ||
        admission.requestHash !== input.requestHash
      ) {
        throw new ConflictError(
          'employee-reaction-admission-mismatch',
          `admission ${admission.operation} does not belong to request ${input.request.operation}`,
        )
      }
      const executionRef = admission.execution
      // 重放：这个执行身份的任务已经建过（上一次 launch 返回前崩了，或派发重试）。
      // 直接返回同一个 id——不建第二个任务。
      if (await deps.core.executionExists(executionRef)) {
        await deps.admissions.markLaunched(admission.operation, deps.now())
        return { executionRef }
      }
      const { retryFeedback } = input.request.attempt
      const previousError =
        retryFeedback.kind === 'artifact' ? await deps.retryFeedback.read(retryFeedback.ref) : null
      const launched = await deps.core.launch({
        plan: input.request.plan,
        attempt: {
          ordinal: input.request.attempt.ordinal,
          mode: input.request.attempt.mode,
          previousError,
        },
        taskId: executionRef,
      })
      if (launched.executionRef !== executionRef) {
        throw new ConflictError(
          'employee-reaction-launch-identity-drift',
          `launch returned ${launched.executionRef}, expected the admitted ${executionRef}`,
        )
      }
      await deps.admissions.markLaunched(admission.operation, deps.now())
      return { executionRef }
    },

    async inspect(access): Promise<ReactionExecutionSnapshotV1> {
      const executionRef = await verified(access)
      const snapshot = await deps.core.inspect(executionRef)
      switch (snapshot.kind) {
        case 'pending':
          return { kind: 'pending' }
        case 'completed':
          return { kind: 'completed', outputJson: snapshot.outputJson, metering: snapshot.metering }
        case 'stopped':
          return {
            kind: 'stopped',
            receipt: stopReceipt(executionRef),
            metering: snapshot.metering,
          }
        case 'failed':
          return {
            kind: 'failed',
            errorClass: FAILURE_CLASS[snapshot.errorClass],
            errorCode: snapshot.errorCode,
            diagnostics: await deps.diagnostics.put({
              errorCode: snapshot.errorCode,
              errorDetail: snapshot.errorDetail,
              workspaceRoot: snapshot.workspaceRoot,
            }),
            metering: snapshot.metering,
          }
      }
    },

    async inspectHumanReview(access): Promise<ReactionHumanReviewSnapshotV1> {
      const executionRef = await verified(access)
      return { kind: await deps.core.inspectHumanReview(executionRef) }
    },

    async cancel(access) {
      const executionRef = await verified(access)
      await deps.core.cancel(executionRef)
      return stopReceipt(executionRef)
    },
  }
  return Object.freeze(port)
}
