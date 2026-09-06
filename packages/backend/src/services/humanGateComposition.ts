// RFC-333 — one temporary legacy composition bridge. It keeps the old service
// signatures stable while concentrating collaboration wiring in one place.

import {
  GitWorkspaceRollbackSnapshotInspector,
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  createCollaborationCommandContext as createCollaborationCommandContextInternal,
  decodeClarifyDecisionManifest,
  decodeClarifyDecisionReceipt,
  decodeCollaborationCommittedEvent,
  decodeQuestionDispatchManifest,
  decodeQuestionDispatchReceipt,
  decodeReviewDecisionManifest,
  decodeReviewDecisionReceipt,
  deriveHumanGateCompatibilityKey,
  encodeClarifyDecisionManifest,
  encodeClarifyDecisionReceipt,
  encodeQuestionDispatchManifest,
  encodeQuestionDispatchReceipt,
  encodeReviewDecisionManifest,
  encodeReviewDecisionReceipt,
  gateDecisionReceipt,
  prepareWorkspaceRollbackPlan as prepareWorkspaceRollbackPlanInternal,
} from '@/modules/collaboration/composition'
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
