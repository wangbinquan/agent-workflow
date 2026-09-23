// RFC-368 —— 把数字员工的产物存档装成跨缝合同上的三个视图：
//   · `ReactionRetryFeedbackReaderV1`  —— TaskExecution 消费：反馈 ref → 正文，拼进提示词；
//   · `ReactionDiagnosticsSinkV1`      —— TaskExecution 消费：失败详情交给数字员工裁剪存档，只回 ref；
//   · `ReactionDiagnosticsReaderV1`    —— 数字员工自己消费：诊断 ref → 正文，落结算输出。
// 裁剪规则（R1–R5）只在 `domain/reactionArtifacts.ts` 一处，provider 不知道也不需要知道。

import type { ReactionArtifactPersistence } from '../application/ports/reactionArtifacts'
import { sanitizeReactionText } from '../domain/reactionArtifacts'
import type {
  ReactionDiagnosticsReaderV1,
  ReactionDiagnosticsRef,
  ReactionDiagnosticsSinkV1,
  ReactionRetryFeedbackReaderV1,
} from './required-ports'

export interface ReactionArtifactPortsV1 {
  readonly retryFeedback: ReactionRetryFeedbackReaderV1
  readonly diagnostics: ReactionDiagnosticsReaderV1
  readonly diagnosticsSink: ReactionDiagnosticsSinkV1
}

export function composeReactionArtifactPorts(
  persistence: ReactionArtifactPersistence,
  now: () => number,
): ReactionArtifactPortsV1 {
  const retryFeedback: ReactionRetryFeedbackReaderV1 = { read: (ref) => persistence.read(ref) }
  const diagnostics: ReactionDiagnosticsReaderV1 = { read: (ref) => persistence.read(ref) }
  const diagnosticsSink: ReactionDiagnosticsSinkV1 = {
    async put(input) {
      const ref = await persistence.put('diagnostics', sanitizeReactionText(input), now())
      return ref as ReactionDiagnosticsRef
    },
  }
  return Object.freeze({
    retryFeedback: Object.freeze(retryFeedback),
    diagnostics: Object.freeze(diagnostics),
    diagnosticsSink: Object.freeze(diagnosticsSink),
  })
}
