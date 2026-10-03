import type { ObservationSpanFact } from '@agent-workflow/shared'

/** The original creation pointer remains immutable; JSON rows carry no in-memory Set. */
export interface CompleteProjectedSpan {
  readonly creation: ObservationSpanFact
  fact: ObservationSpanFact
  readonly sourceRowId: number
  readonly itemIndex: number
  readonly nodeRunId: string
  issues: string[]
}
export interface CompleteSpanProjection {
  readonly spansNamespace: string
  readonly capturesNamespace: string
  readonly repairsNamespace: string
  readonly issues: readonly string[]
}
