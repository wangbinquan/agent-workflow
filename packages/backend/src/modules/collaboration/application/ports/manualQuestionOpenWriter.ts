// RFC-333 — exact persistence port for a manual question and its park obligation.

import type { HumanGateOperationSnapshot } from '../../domain/humanGateOperation'
import type { ManualQuestionOpenManifest } from '../../domain/manualQuestionOpen'

export interface CreateManualQuestionOpenInput {
  readonly taskId: string
  readonly title: string
  readonly body: string
  readonly targetNodeId: string
  readonly actorUserId: string
  readonly now?: number
}

export interface CreatedManualQuestionOpen {
  readonly id: string
  readonly operation: HumanGateOperationSnapshot
  readonly manifest: ManualQuestionOpenManifest
}

export interface ManualQuestionOpenWriter {
  create(input: CreateManualQuestionOpenInput): CreatedManualQuestionOpen
}
