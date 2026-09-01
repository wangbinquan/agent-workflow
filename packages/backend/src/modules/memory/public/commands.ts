import type { Language, MemoryDistillJob, SourceContextBudget } from '@agent-workflow/shared'

export interface EnqueueMemoryDistillJobInput {
  readonly sourceKind: 'clarify' | 'review' | 'feedback'
  readonly sourceEventId: string
  readonly taskId: string | null
  readonly debounceMs?: number
  readonly outputLang?: Language | null
}

export interface EnqueueMemoryDistillJobResult {
  readonly jobId: string
  readonly debounceKey: string
  readonly nextRunAt: number
}

export interface MemoryDistillCommands {
  enqueue(input: EnqueueMemoryDistillJobInput): Promise<EnqueueMemoryDistillJobResult>
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
