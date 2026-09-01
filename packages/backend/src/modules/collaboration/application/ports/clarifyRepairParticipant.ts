/**
 * Collaboration-owned repair command consumed by Task Execution's lifecycle
 * repair coordinator. Only business identity and the observed closed state
 * cross the boundary; the selected provider retains the clarify-table CAS.
 */
export interface ClarifyRepairParticipant {
  hasOpenForNodeRun(input: {
    readonly taskId: string
    readonly nodeRunId: string
  }): Promise<boolean>
  latestClosedForNodeRun(input: { readonly taskId: string; readonly nodeRunId: string }): Promise<{
    readonly roundId: string
    readonly status: 'answered' | 'canceled' | 'abandoned'
  } | null>
  reopen(input: {
    readonly taskId: string
    readonly roundId: string
    readonly expectedStatus: 'answered' | 'canceled' | 'abandoned'
    readonly occurredAt: number
  }): Promise<boolean>
}
