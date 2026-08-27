// RFC-333 — one temporary legacy composition bridge. It keeps the old service
// signatures stable while concentrating collaboration wiring in one place.

import {
  composeTaskExecutionHumanGateAdapter as composeTaskExecutionHumanGateAdapterInternal,
  createCollaborationCommandContext as createCollaborationCommandContextInternal,
} from '@/modules/collaboration/composition'
import { parkPreparedHumanGate as parkPreparedHumanGateInternal } from '@/modules/task-execution/public/commands'

export const createCollaborationCommandContext = createCollaborationCommandContextInternal
export const composeTaskExecutionHumanGateAdapter = composeTaskExecutionHumanGateAdapterInternal

export function parkPreparedHumanGate(
  input: Omit<Parameters<typeof parkPreparedHumanGateInternal>[0], 'humanGates'>,
): ReturnType<typeof parkPreparedHumanGateInternal> {
  return parkPreparedHumanGateInternal({
    ...input,
    humanGates: composeTaskExecutionHumanGateAdapterInternal(),
  })
}
