// RFC-349 — provider-neutral manual-question park command.

import type { OwnershipToken } from '../domain/ownership'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import type { HumanGateTaskLifecycle } from './ports/humanGateTaskLifecycle'

export interface ManualQuestionParkSettleResult {
  readonly parked: boolean
  readonly taskRevision: number | null
  readonly operationIds: readonly string[]
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}

export class ManualQuestionParkRequired extends Error {
  constructor(readonly operationIds: readonly string[]) {
    super(`task has unresolved manual-question park obligations: ${operationIds.join(', ')}`)
    this.name = 'ManualQuestionParkRequired'
  }
}

export async function settleManualQuestionParkObligations(
  persistence: HumanGateTaskLifecycle,
  input: { readonly taskId: string; readonly token?: OwnershipToken; readonly now?: number },
): Promise<ManualQuestionParkSettleResult> {
  return await persistence.settleManualQuestionParks({
    taskId: input.taskId,
    ...(input.token === undefined ? {} : { token: input.token }),
    now: input.now ?? Date.now(),
  })
}
