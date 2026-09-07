// RFC-333 — one temporary legacy composition bridge. It keeps the old service
// signatures stable while concentrating collaboration wiring in one place.
//
// RFC-359 W8 —— 这里**不走** `@/modules/collaboration/composition` 那个 barrel，逐个从定义模块取。
// 不是风格偏好，是它闭掉了 9 条 `no-circular`：W7 把合一后的 `collaborationRouteOperations` /
// `collaborationRuntimeMechanics` 挂上 barrel 之后，barrel 的成员（`legacySqliteReview` /
// `legacySqliteTaskQuestions` / `legacySqliteTaskQuestionDispatch` / `legacySqliteClarify/seal`）
// 经本文件绕回 barrel 闭合：
//   composition.ts → collaborationRouteOperations.ts → legacySqliteReview.ts
//     → services/humanGateComposition.ts → composition.ts
// 本文件要的全是 collaboration 的 domain / application 纯函数与一个 inspector，一条都不需要
// 那些 legacy sqlite 实现——经 barrel 取用只是把整个 context 的实现面一起拖进依赖图。
// ⚠️ 别把这些 import 「整理」回 barrel：`scripts/depcheck.ts` 会当场红 9 条 no-circular。
// 实测过，**一个符号**改回 barrel 就够（变异验证：`gateDecisionReceipt` 单独改回去 ⇒ 9 条全红）。
//
// 存过一条错误的判断，记下来免得有人再走一遍：`a630ef625` 把闭合点记成
// `nodeRunLifecycleTransition.ts → @/services/lifecycle`，据此给 9 条 KNOWN_VIOLATIONS 开了
// 「下沉那两个中立异步孪生」的 removeWhen。那条边**根本不在任何环上**——把它改成直取定义处，
// `depcheck` 一条不少（当时 17/17）。同一封 commit message 自己也记着这个实验「环照旧」。

import { prepareWorkspaceRollbackPlan as prepareWorkspaceRollbackPlanInternal } from '@/modules/collaboration/application/prepareWorkspaceRollbackPlan'
import { createCollaborationCommandContext as createCollaborationCommandContextInternal } from '@/modules/collaboration/composition/commandContext'
import {
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  deriveHumanGateCompatibilityKey,
} from '@/modules/collaboration/domain/canonicalGateRequest'
import {
  decodeClarifyDecisionManifest,
  decodeClarifyDecisionReceipt,
  encodeClarifyDecisionManifest,
  encodeClarifyDecisionReceipt,
} from '@/modules/collaboration/domain/clarifyDecision'
import { decodeCollaborationCommittedEvent } from '@/modules/collaboration/domain/collaborationCommittedEvent'
import { gateDecisionReceipt } from '@/modules/collaboration/domain/gateReceipt'
import {
  decodeQuestionDispatchManifest,
  decodeQuestionDispatchReceipt,
  encodeQuestionDispatchManifest,
  encodeQuestionDispatchReceipt,
} from '@/modules/collaboration/domain/questionDispatchDecision'
import {
  decodeReviewDecisionManifest,
  decodeReviewDecisionReceipt,
  encodeReviewDecisionManifest,
  encodeReviewDecisionReceipt,
} from '@/modules/collaboration/domain/reviewDecision'
import { GitWorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/infrastructure/gitWorkspaceRollbackSnapshotInspector'
import { parkPreparedHumanGate as parkPreparedHumanGateInternal } from '@/modules/task-execution/public/commands'
import { bindTaskDecisionParticipantInTx as bindTaskDecisionParticipantInTxInternal } from '@/modules/task-execution/public/participants'

export const humanGateComposition = {
  createCollaborationCommandContext: createCollaborationCommandContextInternal,
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  deriveHumanGateCompatibilityKey,
  gateDecisionReceipt,
  decodeCollaborationCommittedEvent,
  decodeClarifyDecisionManifest,
  decodeClarifyDecisionReceipt,
  encodeClarifyDecisionManifest,
  encodeClarifyDecisionReceipt,
  decodeQuestionDispatchManifest,
  decodeQuestionDispatchReceipt,
  encodeQuestionDispatchManifest,
  encodeQuestionDispatchReceipt,
  decodeReviewDecisionManifest,
  decodeReviewDecisionReceipt,
  encodeReviewDecisionManifest,
  encodeReviewDecisionReceipt,
  prepareWorkspaceRollbackPlan(
    input: Omit<Parameters<typeof prepareWorkspaceRollbackPlanInternal>[0], 'inspector'>,
  ) {
    return prepareWorkspaceRollbackPlanInternal({
      ...input,
      inspector: new GitWorkspaceRollbackSnapshotInspector(),
    })
  },
  bindTaskDecisionParticipantInTx(
    tx: Parameters<typeof bindTaskDecisionParticipantInTxInternal>[0],
  ) {
    return bindTaskDecisionParticipantInTxInternal(tx)
  },
  parkPreparedHumanGate(
    input: Parameters<typeof parkPreparedHumanGateInternal>[0],
  ): ReturnType<typeof parkPreparedHumanGateInternal> {
    return parkPreparedHumanGateInternal(input)
  },
}

export type ClarifyDecisionManifestBridge = ReturnType<
  typeof humanGateComposition.decodeClarifyDecisionManifest
>
export type ClarifyDecisionReceiptEnvelopeBridge = ReturnType<
  typeof humanGateComposition.decodeClarifyDecisionReceipt
>
export type QuestionDispatchManifestBridge = ReturnType<
  typeof humanGateComposition.decodeQuestionDispatchManifest
>
export type QuestionDispatchReceiptEnvelopeBridge = ReturnType<
  typeof humanGateComposition.decodeQuestionDispatchReceipt
>
export type ReviewDecisionManifestBridge = ReturnType<
  typeof humanGateComposition.decodeReviewDecisionManifest
>
export type ReviewDecisionReceiptEnvelopeBridge = ReturnType<
  typeof humanGateComposition.decodeReviewDecisionReceipt
>
export type ValidatedWorkspaceRollbackPlanBridge = Awaited<
  ReturnType<typeof humanGateComposition.prepareWorkspaceRollbackPlan>
>
