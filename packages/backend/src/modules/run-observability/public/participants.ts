import type {
  AcceptObservationInvocation,
  AcceptedObservationInvocation,
  ObservationCapturedUsage,
} from '@agent-workflow/shared'

/** Execution supplies frozen facts; bootstrap selects the accounting authority. */
export type ObservationInvocationStart = Omit<AcceptObservationInvocation, 'authority'> & {
  readonly runtime: Extract<AcceptObservationInvocation['authority'], { kind: 'local' }>['runtime']
}

export interface ObservationInvocationParticipant {
  /** Must persist before spawn. A rejection prevents an unrecorded invocation. */
  accept(input: ObservationInvocationStart): Promise<AcceptedObservationInvocation>
  /** Bounded projection of committed evidence; failures leave the durable source pending. */
  reconcile?(nodeRunId?: string): Promise<number>
}

/** The execution owner supplies numeric-only committed facts and delivery acknowledgements. */
export interface ObservationUsageSource {
  pending(input: {
    readonly limit: number
    readonly nodeRunId?: string
    readonly afterNodeRunId?: string
  }): Promise<
    readonly {
      readonly id: number
      readonly taskId: string
      readonly nodeRunId: string
      readonly evidence: ObservationCapturedUsage
    }[]
  >
  acknowledge(ids: readonly number[]): Promise<void>
}
