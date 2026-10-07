import type { OwnershipToken } from '../../domain/ownership'
import type { TaskHostAdmittedWork } from '../taskHostAdmission'
import type { TaskHostFailedClaim } from './taskHostClaimFailure'

/** Original driver work outlives the process-local runtime registry. */
export interface TaskDriverFinalizations {
  attached(input: {
    readonly taskId: string
    readonly token: OwnershipToken
    readonly controller: AbortController
    readonly work: TaskHostAdmittedWork
  }): void
  failedClaim(claim: TaskHostFailedClaim): Promise<void>
  pendingForTask(taskId: string): Promise<void> | undefined
  retryPending(): Promise<void>
  drain(): Promise<void>
  snapshot(): readonly {
    readonly taskId: string | undefined
    readonly phase: 'active' | 'pending'
    readonly error: unknown
  }[]
}
