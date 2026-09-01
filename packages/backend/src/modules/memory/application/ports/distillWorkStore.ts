import type { Memory, MemoryDistillJob, ResolvedDistillScope } from '@agent-workflow/shared'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type { MemoryDistillJobRecord } from './distillReadStore'

export interface MemoryDistillTaskScopeRecord {
  readonly workflowSnapshot: string
  readonly workgroupConfigJson: string | null
  readonly workflowId: string | null
  readonly cachedRepoId: string | null
  readonly cachedRepoExists: boolean
}

export interface MemoryDistillClarifyWorkRecord {
  readonly id: string
  readonly taskId: string
  readonly intermediaryNodeId: string
  readonly askingNodeRunId: string | null
  readonly questionsJson: string
  readonly answersJson: string | null
}

export interface MemoryDistillReviewWorkRecord {
  readonly id: string
  readonly taskId: string
  readonly reviewNodeId: string
  readonly decision: string
  readonly bodyPath: string
}

export interface MemoryDistillReviewCommentRecord {
  readonly docVersionId: string
  readonly body: string
  readonly anchorParagraphIdx: number
  readonly selectedText: string
}

export interface MemoryDistillFeedbackWorkRecord {
  readonly id: string
  readonly taskId: string
  readonly bodyMd: string
  readonly createdAt: number
}

export interface MemoryDistillNodeRunRecord {
  readonly id: string
  readonly promptText: string | null
  readonly promptPath: string | null
  readonly startedAt: number | null
  readonly opencodeSessionId: string | null
}

export interface MemoryDistillNodeRunEventRecord {
  readonly id: number
  readonly nodeRunId: string
  readonly ts: number
  readonly kind: string
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

export interface MemoryDistillApprovedMemoryRecord {
  readonly id: string
  readonly title: string
  readonly bodyMd: string
  readonly tagsJson: string
}

export interface MemoryDistillCandidateInsert {
  readonly memory: Memory
}

export interface MemoryDistillFailureUpdate {
  readonly ids: readonly string[]
  readonly attempts: number
  readonly error: string
  readonly now: number
  readonly retryAt: number | null
}

export interface MemoryDistillCaptureInput {
  readonly protocol: RuntimeKind
  readonly rootSessionId: string
  readonly distillJobId: string
  readonly attemptIndex: number
}

/**
 * Provider-neutral persistence boundary for distillation enqueue, execution,
 * retry, and candidate creation.  Every method is asynchronous so the same
 * application workflow runs unchanged against SQLite and PostgreSQL.
 */
export interface MemoryDistillWorkStore {
  findTaskScope(taskId: string): Promise<MemoryDistillTaskScopeRecord | null>
  enqueue(input: {
    readonly id: string
    readonly debounceKey: string
    readonly sourceKind: MemoryDistillJob['sourceKind']
    readonly sourceEventId: string
    readonly taskId: string | null
    readonly scope: ResolvedDistillScope
    readonly nextRunAt: number
    readonly createdAt: number
    readonly outputLang: string | null
  }): Promise<void>

  listDue(now: number, limit: number): Promise<readonly MemoryDistillJobRecord[]>
  listPendingSiblings(debounceKey: string): Promise<readonly MemoryDistillJobRecord[]>
  markRunning(ids: readonly string[], startedAt: number): Promise<void>
  markDone(ids: readonly string[], finishedAt: number): Promise<void>
  markFailed(input: MemoryDistillFailureUpdate): Promise<void>
  recoverRunning(): Promise<number>
  retryFailed(jobId: string, now: number): Promise<MemoryDistillJobRecord | null>
  cancelPending(jobId: string, now: number): Promise<boolean>
  listJobs(status?: string): Promise<readonly MemoryDistillJobRecord[]>

  listClarifySources(ids: readonly string[]): Promise<readonly MemoryDistillClarifyWorkRecord[]>
  listReviewSources(ids: readonly string[]): Promise<readonly MemoryDistillReviewWorkRecord[]>
  listReviewComments(ids: readonly string[]): Promise<readonly MemoryDistillReviewCommentRecord[]>
  listFeedbackSources(ids: readonly string[]): Promise<readonly MemoryDistillFeedbackWorkRecord[]>
  listNodeRuns(ids: readonly string[]): Promise<readonly MemoryDistillNodeRunRecord[]>
  listNodeRunEvents(ids: readonly string[]): Promise<readonly MemoryDistillNodeRunEventRecord[]>
  listApprovedMemories(
    scopeType: 'agent' | 'workflow' | 'repo' | 'global',
    scopeId: string | null,
  ): Promise<readonly MemoryDistillApprovedMemoryRecord[]>

  savePrompt(jobId: string, userPromptMd: string, dedupSnapshotIdsJson: string): Promise<void>
  saveSpawnResult(
    jobId: string,
    input: {
      readonly sessionId: string | null
      readonly exitCode: number | null
      readonly stderrExcerpt: string | null
    },
  ): Promise<void>
  captureSession(input: MemoryDistillCaptureInput): Promise<void>
  insertCandidate(input: MemoryDistillCandidateInsert): Promise<void>
}

export interface MemoryDistillReviewedArtifactReader {
  read(finalPath: string): Promise<string>
}

export interface ResolvedMemoryDistillRuntime {
  readonly protocol: RuntimeKind
  readonly binaryPath: string | null
  readonly model: string | null
  readonly isSandbox: boolean
}

export interface MemoryDistillRuntimeResolver {
  resolve(input: {
    readonly runtimeName?: string | null
    readonly deprecatedModel?: string | null
    readonly defaultRuntime?: string | null
  }): Promise<ResolvedMemoryDistillRuntime>
}
