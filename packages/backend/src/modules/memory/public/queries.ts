import type {
  Agent,
  InjectedMemorySnapshot,
  MemoryDistillJob,
  MemoryDistillJobDetail,
  MemoryDistillSessionView,
} from '@agent-workflow/shared'

export interface MemoryDistillQueries {
  listJobs(filter?: { readonly status?: string }): Promise<MemoryDistillJob[]>
  getJobDetail(jobId: string): Promise<MemoryDistillJobDetail>
  getJobSessionView(jobId: string): Promise<MemoryDistillSessionView>
}

export interface MemoryInjectionBudget {
  readonly agent: number
  readonly workflow: number
  readonly repo: number
  readonly repoGroup: number
  readonly global: number
}

export interface MemoryInjectionQueries {
  injectForRun(input: {
    readonly taskId: string
    readonly primaryAgent: Agent
    readonly dependents: readonly Agent[]
    readonly budget?: MemoryInjectionBudget
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
