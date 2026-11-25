// RFC-587 — memory's operation bundle and the distill worker / distill query / injection query contracts it carries.
// They left `public/` when the task feedback binding stopped taking `MemoryOperations` (it now types the one field it
// passes, the distill commands, by Collaboration's own port); nothing outside this module names them.
import type {
  Agent,
  InjectedMemorySnapshot,
  MemoryDistillJob,
  MemoryDistillJobDetail,
  MemoryDistillSessionView,
  SourceContextBudget,
} from '@agent-workflow/shared'
import type { MemoryDistillCommands } from '../public/commands'
import type { MemoryCatalogOperations } from '../public/operations'

export interface MemoryOperations {
  readonly distillCommands: MemoryDistillCommands
  readonly distillQueries: MemoryDistillQueries
  readonly distillWorker: MemoryDistillWorker
  readonly injectionQueries: MemoryInjectionQueries
  /** Bound once resource-scope authorization has joined the provider composition. */
  readonly catalog?: MemoryCatalogOperations
}

export interface MemoryDistillWorker {
  tick(options?: Omit<MemoryDistillWorkerOptions, 'enabled' | 'intervalMs'>): Promise<{
    picked: number
    succeeded: number
    failed: number
    candidatesCreated: number
  }>
  recoverRunning(): Promise<{ recovered: number }>
  listJobs(filter?: { readonly status?: string }): Promise<MemoryDistillJob[]>
}

export interface MemoryDistillWorkerOptions {
  readonly enabled?: boolean
  readonly intervalMs?: number
  readonly runtimeName?: string | null
  readonly defaultRuntime?: string | null
  readonly model?: string | null
  readonly sourceContextBudget?: SourceContextBudget
  /** config.memoryDistillTimeoutMs — per-run distiller timeout (ms). */
  readonly timeoutMs?: number
}

export interface MemoryDistillQueries {
  listJobs(filter?: { readonly status?: string }): Promise<MemoryDistillJob[]>
  getJobDetail(jobId: string): Promise<MemoryDistillJobDetail>
  getJobSessionView(jobId: string): Promise<MemoryDistillSessionView>
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

export interface MemoryInjectionBudget {
  readonly agent: number
  readonly workflow: number
  readonly repo: number
  readonly repoGroup: number
  readonly global: number
}
