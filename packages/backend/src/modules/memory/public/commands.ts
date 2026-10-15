import type {
  DistillSourceKind,
  Language,
  MemoryDistillJob,
  SourceContextBudget,
} from '@agent-workflow/shared'

export interface EnqueueMemoryDistillJobInput {
  readonly sourceKind: DistillSourceKind
  readonly sourceEventId: string
  readonly taskId: string | null
  /** RFC-366 (`agent-run` only): the workflow node whose run settled. */
  readonly nodeId?: string
  readonly debounceMs?: number
  readonly outputLang?: Language | null
}

export interface EnqueueMemoryDistillJobResult {
  readonly jobId: string
  readonly debounceKey: string
  readonly nextRunAt: number
}

export interface MemoryDistillCommands {
  /**
   * RFC-366: `null` means the RFC-366 admission gate declined this event (source
   * switched off, task launch origin not whitelisted, or an internal task). It
   * is an ordinary outcome, never an error — callers just produce no job.
   */
  enqueue(input: EnqueueMemoryDistillJobInput): Promise<EnqueueMemoryDistillJobResult | null>
  retryFailed(jobId: string): Promise<boolean>
  cancelPending(jobId: string): Promise<boolean>
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

export interface MemoryDistillWorker {
  tick(options?: Omit<MemoryDistillWorkerOptions, 'enabled' | 'intervalMs'>): Promise<{
    picked: number
    succeeded: number
    failed: number
    candidatesCreated: number
  }>
  start(options?: MemoryDistillWorkerOptions): { stop(): void }
  recoverRunning(): Promise<{ recovered: number }>
  listJobs(filter?: { readonly status?: string }): Promise<MemoryDistillJob[]>
}
