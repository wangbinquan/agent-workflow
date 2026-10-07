import type { WorkerIdentity } from '../../domain/ownership'
import type { TaskHostAdmittedWork } from '../taskHostAdmission'

/** This is the original failed call, never a successful claim or execution token. */
export interface TaskHostFailedClaim {
  readonly work: TaskHostAdmittedWork
  readonly intentId: string
  taskId(): string | undefined
  acknowledge(): Promise<void>
}

export interface TaskHostClaimFailures {
  capture(input: {
    readonly intentId: string
    readonly identity: WorkerIdentity
    readonly work: TaskHostAdmittedWork
  }): TaskHostFailedClaim
}
