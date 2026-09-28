import type {
  AcceptObservationInvocation,
  AcceptedObservationInvocation,
} from '@agent-workflow/shared'

export interface ObservationInvocationStore {
  /** First acceptance freezes the price-book head and timestamp in the same transaction. */
  accept(input: AcceptObservationInvocation): Promise<AcceptedObservationInvocation>
  get(invocationId: string): Promise<AcceptedObservationInvocation | undefined>
}
