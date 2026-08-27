// RFC-333 — one temporary legacy composition bridge. It keeps the old service
// signatures stable while concentrating collaboration wiring in one place.

import {
  composeTaskExecutionHumanGateAdapter as composeTaskExecutionHumanGateAdapterInternal,
  createCollaborationCommandContext as createCollaborationCommandContextInternal,
} from '@/modules/collaboration/composition'
import { parkPreparedHumanGate as parkPreparedHumanGateInternal } from '@/modules/task-execution/public/commands'
import { bindTaskDecisionParticipantInTx as bindTaskDecisionParticipantInTxInternal } from '@/modules/task-execution/public/participants'
import type { DbTxSync } from '@/db/txSync'
import { transitionHumanGateTaskTx } from '@/services/lifecycle'

export const humanGateComposition = {
  createCollaborationCommandContext: createCollaborationCommandContextInternal,
  composeTaskExecutionHumanGateAdapter: composeTaskExecutionHumanGateAdapterInternal,
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
