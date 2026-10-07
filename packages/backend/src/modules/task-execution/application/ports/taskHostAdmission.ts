import type { TaskHostWriteCapture } from '../taskHostWriteCapture'

export type TaskHostStopReason = 'authority-loss' | 'handoff' | 'shutdown'

/** Task owns this admission boundary; host identities and transactions stay outside. */
export interface TaskHostNewWorkAdmission {
  acquire():
    | {
        readonly kind: 'admitted'
        readonly lease: {
          readonly capture: TaskHostWriteCapture
          readonly stopped: Promise<TaskHostStopReason>
          complete(): void
        }
      }
    | { readonly kind: 'unavailable'; readonly reason: string }
}
