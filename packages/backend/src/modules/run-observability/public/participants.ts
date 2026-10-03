import type {
  AcceptObservationInvocation,
  AcceptedObservationInvocation,
  ObservationCapturedUsage,
  ObservationSpanOwnerProof,
  ObservationSpanSourceInput,
  ObservationSpanSourcePage,
} from '@agent-workflow/shared'

export type {
  CompleteObservationBuildResult,
  CompleteObservationStoredReport,
} from '../ports/completeObservationReport'

/** Execution supplies frozen facts; bootstrap selects the accounting authority. */
export type ObservationInvocationStart = Omit<AcceptObservationInvocation, 'authority'> & {
  readonly runtime: Extract<AcceptObservationInvocation['authority'], { kind: 'local' }>['runtime']
}

export interface ObservationInvocationParticipant {
  /** Must persist before spawn. A rejection prevents an unrecorded invocation. */
  accept(input: ObservationInvocationStart): Promise<AcceptedObservationInvocation>
  /** Bounded projection of committed evidence; failures leave the durable source pending. */
  reconcile?(nodeRunId?: string): Promise<number>
  /** Frozen creation proofs only; missing capability is explicit partial coverage. */
  spanOwners?(input: {
    readonly invocationId: string
    readonly sourceNamespace: string
    readonly rootSessionId: string
    readonly limit: number
  }): Promise<{
    readonly owners: readonly ObservationSpanOwnerProof[]
    readonly complete: boolean
    readonly issues: readonly string[]
  }>
}

/** The execution owner supplies numeric-only committed facts and delivery acknowledgements. */
export interface ObservationUsageSource {
  spanSources?(input: ObservationSpanSourceInput): Promise<ObservationSpanSourcePage>
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
