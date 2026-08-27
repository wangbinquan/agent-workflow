// RFC-333 — one temporary legacy composition bridge. It keeps the old service
// signatures stable while concentrating collaboration wiring in one place.

import {
  GitWorkspaceRollbackSnapshotInspector,
  SqliteHumanGateOperationStore,
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  composeTaskExecutionHumanGateAdapter as composeTaskExecutionHumanGateAdapterInternal,
  createCollaborationCommandContext as createCollaborationCommandContextInternal,
  decodeClarifyDecisionManifest,
  decodeClarifyDecisionReceipt,
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
import type { DbTxSync } from '@/db/txSync'
import { transitionHumanGateTaskTx } from '@/services/lifecycle'

export const humanGateComposition = {
  createCollaborationCommandContext: createCollaborationCommandContextInternal,
  composeTaskExecutionHumanGateAdapter: composeTaskExecutionHumanGateAdapterInternal,
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  deriveHumanGateCompatibilityKey,
  gateDecisionReceipt,
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
  createHumanGateOperationStore() {
    return new SqliteHumanGateOperationStore()
  },
  prepareWorkspaceRollbackPlan(
    input: Omit<Parameters<typeof prepareWorkspaceRollbackPlanInternal>[0], 'inspector'>,
  ) {
    return prepareWorkspaceRollbackPlanInternal({
      ...input,
      inspector: new GitWorkspaceRollbackSnapshotInspector(),
    })
  },
  bindTaskDecisionParticipantInTx(tx: DbTxSync) {
    return bindTaskDecisionParticipantInTxInternal(tx, {
      transitionTx: transitionHumanGateTaskTx,
    })
  },
  parkPreparedHumanGate(
    input: Omit<Parameters<typeof parkPreparedHumanGateInternal>[0], 'humanGates'>,
  ): ReturnType<typeof parkPreparedHumanGateInternal> {
    return parkPreparedHumanGateInternal({
      ...input,
      humanGates: composeTaskExecutionHumanGateAdapterInternal(),
    })
  },
}

export type HumanGateOperationStoreBridge = ReturnType<
  typeof humanGateComposition.createHumanGateOperationStore
>
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
