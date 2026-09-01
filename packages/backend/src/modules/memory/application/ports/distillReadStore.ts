export interface MemoryDistillJobRecord {
  readonly id: string
  readonly debounceKey: string
  readonly sourceKind: 'clarify' | 'review' | 'feedback'
  readonly sourceEventId: string
  readonly taskId: string | null
  readonly scopeResolvedJson: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  readonly attempts: number
  readonly nextRunAt: number
  readonly lastError: string | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly opencodeSessionId: string | null
  readonly userPromptMd: string | null
  readonly exitCode: number | null
  readonly stderrExcerpt: string | null
  readonly dedupSnapshotIdsJson: string | null
  readonly outputLang: string | null
}

export interface MemoryDistillEventRecord {
  readonly id: number
  readonly attemptIndex: number
  readonly sessionId: string
  readonly parentSessionId: string | null
  readonly ts: number
  readonly kind: string
  readonly payload: string
}

export interface MemoryDistillClarifySourceRecord {
  readonly id: string
  readonly taskId: string
  readonly questionsJson: string
}

export interface MemoryDistillReviewSourceRecord {
  readonly id: string
  readonly taskId: string
  readonly decision: string
  readonly versionIndex: number
}

export interface MemoryDistillFeedbackSourceRecord {
  readonly id: string
  readonly taskId: string
  readonly bodyMd: string
}

export interface MemoryDistillCandidateRecord {
  readonly id: string
  readonly title: string
  readonly bodyMd: string
  readonly scopeType: string
  readonly scopeId: string | null
  readonly distillAction: string | null
  readonly status: string
  readonly supersedesId: string | null
  readonly createdAt: number
}

/** Provider-neutral read port for the memory distillation monitoring surface. */
export interface MemoryDistillReadStore {
  listJobs(status?: string): Promise<readonly MemoryDistillJobRecord[]>
  findJob(jobId: string): Promise<MemoryDistillJobRecord | null>
  listSiblingJobs(debounceKey: string): Promise<readonly MemoryDistillJobRecord[]>
  listEvents(jobId: string): Promise<readonly MemoryDistillEventRecord[]>
  listClarifySources(ids: readonly string[]): Promise<readonly MemoryDistillClarifySourceRecord[]>
  listReviewSources(ids: readonly string[]): Promise<readonly MemoryDistillReviewSourceRecord[]>
  listFeedbackSources(ids: readonly string[]): Promise<readonly MemoryDistillFeedbackSourceRecord[]>
  listCandidates(jobId: string): Promise<readonly MemoryDistillCandidateRecord[]>
}
