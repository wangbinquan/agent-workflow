// RFC-559 (RFC-294 S9 step 14): Task Execution's own memory injection port — the target DAG's `TaskMemoryInjectionPort`
// (memory implements it; the assembly root hands memory's injection queries, which satisfy it structurally). Only the
// two methods a task run uses; types come from the shared contracts, not from memory.
import type { Agent, InjectedMemorySnapshot } from '@agent-workflow/shared'

/** Per-scope injection budget (characters). */
export interface TaskMemoryInjectionBudget {
  readonly agent: number
  readonly workflow: number
  readonly repo: number
  readonly repoGroup: number
  readonly global: number
}

export interface TaskMemoryInjectionPort {
  injectForRun(input: {
    readonly taskId: string
    readonly primaryAgent: Agent
    readonly dependents: readonly Agent[]
    readonly budget?: TaskMemoryInjectionBudget
    readonly envelopeNonce?: string
  }): Promise<{
    readonly block: string | null
    readonly snapshot: InjectedMemorySnapshot[] | null
  }>
  loadFirstAttemptSnapshot(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly iteration: number
    readonly shardKey: string | null
    readonly reviewIteration: number
    readonly runId: string
  }): Promise<InjectedMemorySnapshot[] | null>
}
