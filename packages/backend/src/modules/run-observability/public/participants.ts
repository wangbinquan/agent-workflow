import type {
  AcceptObservationInvocation,
  AcceptedObservationInvocation,
} from '@agent-workflow/shared'

/** Execution supplies frozen facts; bootstrap selects the accounting authority. */
export type ObservationInvocationStart = Omit<AcceptObservationInvocation, 'authority'> & {
  readonly runtime: Extract<AcceptObservationInvocation['authority'], { kind: 'local' }>['runtime']
}

export interface ObservationInvocationParticipant {
  /** Must persist before spawn. A rejection prevents an unrecorded invocation. */
  accept(input: ObservationInvocationStart): Promise<AcceptedObservationInvocation>
}
