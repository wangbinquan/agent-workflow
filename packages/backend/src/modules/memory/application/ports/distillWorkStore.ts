import type { Memory, MemoryDistillJob, ResolvedDistillScope } from '@agent-workflow/shared'
import type { DistillTaskFacts } from '@/modules/memory/domain/distillAdmission'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type { MemoryDistillJobRecord } from './distillReadStore'
import type { SystemAgentEventSinkV1 } from '@/services/sessionEventSink'

export interface MemoryDistillTaskScopeRecord {
  readonly workflowSnapshot: string
  readonly workgroupConfigJson: string | null
  readonly workflowId: string | null
  readonly cachedRepoId: string | null
  readonly cachedRepoExists: boolean
  // RFC-366: the admission facts. They ride along on the scope read instead of
  // getting their own query — the gate and the scope resolution both need the
  // same task row, and a second SELECT would race the first.
  readonly launchOrigin: DistillTaskFacts['launchOrigin']
  readonly catalogVisibility: DistillTaskFacts['catalogVisibility']
  readonly spaceKind: DistillTaskFacts['spaceKind']
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

// RFC-366 —— agent 运行结束源要读的东西。
//
// 拆成三条批量读而不是一条大 join：三张表的行数关系是 1:N:M（run / 输出端口 /
// 注入记忆快照在 run 行上），join 出来的笛卡尔积要在内存里再拆一遍，而批量读本来
// 就是这个 store 里其余六个 list* 方法的形状。
export interface MemoryDistillAgentRunWorkRecord {
  /** node_run id —— 同时是这条蒸馏 job 的 sourceEventId。 */
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  /** 只会是 'done' | 'failed'（终态过滤在执行引擎侧做）。 */
  readonly status: string
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly errorMessage: string | null
  readonly failureCode: string | null
  readonly promptText: string | null
  readonly promptPath: string | null
  readonly opencodeSessionId: string | null
  /** RFC-046 注入快照 JSON；本次运行已经知道哪些记忆，用于去重判定。 */
  readonly injectedMemoriesJson: string | null
}

export interface MemoryDistillNodeRunOutputRecord {
  readonly nodeRunId: string
  readonly portName: string
  readonly content: string
  readonly kind: string | null
}

// RFC-366 —— 任务结束源要读的东西。
export interface MemoryDistillTaskRunWorkRecord {
  /** task id —— 同时是这条蒸馏 job 的 sourceEventId。 */
  readonly id: string
  readonly name: string
  readonly status: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly runningMs: number
  readonly errorSummary: string | null
  readonly errorMessage: string | null
  readonly failedNodeId: string | null
  readonly inputs: string
  readonly workflowSnapshot: string
}

/** 每个节点在本任务里最新一行 node_run 的终态。 */
export interface MemoryDistillTaskNodeStatusRecord {
  readonly taskId: string
  readonly nodeId: string
  /** 那一行的 id —— 任务结束源据此去取 output 节点的端口值。 */
  readonly nodeRunId: string
  readonly status: string
  readonly retryIndex: number
  readonly finishedAt: number | null
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

export interface MemoryDistillSessionSinkInput {
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
  /** RFC-366 agent-run 源。 */
  listAgentRunSources(ids: readonly string[]): Promise<readonly MemoryDistillAgentRunWorkRecord[]>
  listNodeRunOutputs(ids: readonly string[]): Promise<readonly MemoryDistillNodeRunOutputRecord[]>
  /** RFC-366 task-run 源。 */
  listTaskRunSources(ids: readonly string[]): Promise<readonly MemoryDistillTaskRunWorkRecord[]>
  listTaskNodeStatuses(
    taskIds: readonly string[],
  ): Promise<readonly MemoryDistillTaskNodeStatusRecord[]>
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
  /**
   * RFC-367 — the auxiliary session record for one attempt. The distiller hands
   * this sink to `runSystemAgent`, so the conversation tab and the candidate
   * parse are fed by ONE normalized event stream. It replaces the post-run
   * `captureSession` SQLite walk, whose separate parse of the same output
   * drifted from the candidate parser twice (RFC-117, then 2026-09-21).
   *
   * Observation only: the contract in `services/sessionEventSink.ts` forbids
   * letting persistence here decide the agent's business result.
   */
  eventSinkFor(input: MemoryDistillSessionSinkInput): SystemAgentEventSinkV1
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
