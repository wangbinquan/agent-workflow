import {
  parseSessionTree,
  type MemoryDistillCandidateSnapshot,
  type MemoryDistillDedupSnapshotEntry,
  type MemoryDistillJob,
  type MemoryDistillJobDetail,
  type MemoryDistillSessionAttempt,
  type MemoryDistillSessionView,
  type MemoryDistillSourceEventEntry,
  type MemoryScope,
  type MemoryStatus,
  type ParseSessionInputEvent,
  type ResolvedDistillScope,
} from '@agent-workflow/shared'

import { DISTILL_CAPTURE_FAILED_KIND } from '@/modules/runtime-management/public/types'
import { NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import type {
  MemoryDistillCandidateRecord,
  MemoryDistillEventRecord,
  MemoryDistillJobRecord,
  MemoryDistillReadStore,
} from './ports/distillReadStore'
import type { MemoryDistillQueries } from '../public/queries'

const log = createLogger('memory-distill-queries')

export const DISTILLER_PRIMARY_AGENT_NAME = 'aw-memory-distiller'

function jobOf(row: MemoryDistillJobRecord): MemoryDistillJob {
  let scopeResolved: ResolvedDistillScope = {
    agentIds: [],
    workflowId: null,
    repoId: null,
    includeGlobal: true,
  }
  try {
    const parsed = JSON.parse(row.scopeResolvedJson) as Partial<ResolvedDistillScope>
    if (parsed && typeof parsed === 'object') {
      scopeResolved = {
        agentIds: Array.isArray(parsed.agentIds)
          ? parsed.agentIds.filter((item): item is string => typeof item === 'string')
          : [],
        workflowId: typeof parsed.workflowId === 'string' ? parsed.workflowId : null,
        repoId: typeof parsed.repoId === 'string' ? parsed.repoId : null,
        includeGlobal: parsed.includeGlobal !== false,
      }
    }
  } catch {
    // Legacy or corrupt scope snapshots degrade to the original default scope.
  }
  return {
    id: row.id,
    debounceKey: row.debounceKey,
    sourceKind: row.sourceKind,
    sourceEventId: row.sourceEventId,
    taskId: row.taskId,
    scopeResolved,
    status: row.status,
    attempts: row.attempts,
    nextRunAt: row.nextRunAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    opencodeSessionId: row.opencodeSessionId,
    userPromptMd: row.userPromptMd,
    exitCode: row.exitCode,
    stderrExcerpt: row.stderrExcerpt,
    outputLang: row.outputLang === 'zh-CN' || row.outputLang === 'en-US' ? row.outputLang : null,
  }
}

export function parseDedupSnapshot(raw: string | null): MemoryDistillDedupSnapshotEntry[] {
  if (raw === null || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return []
    const snapshot = (parsed as { snapshot?: unknown }).snapshot
    if (!Array.isArray(snapshot)) return []
    const out: MemoryDistillDedupSnapshotEntry[] = []
    for (const item of snapshot) {
      if (item === null || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (
        typeof row.memoryId !== 'string' ||
        typeof row.scopeType !== 'string' ||
        !isMemoryScope(row.scopeType) ||
        typeof row.title !== 'string'
      ) {
        continue
      }
      out.push({
        memoryId: row.memoryId,
        scopeType: row.scopeType,
        scopeId: typeof row.scopeId === 'string' ? row.scopeId : null,
        title: row.title,
      })
    }
    return out
  } catch {
    return []
  }
}

function isMemoryScope(value: string): value is MemoryScope {
  return value === 'agent' || value === 'workflow' || value === 'repo' || value === 'global'
}

export function summarizeClarifyQuestions(questionsJson: string): string {
  try {
    const parsed = JSON.parse(questionsJson) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return ''
    const first = parsed[0] as Record<string, unknown>
    const text =
      typeof first.title === 'string'
        ? first.title
        : typeof first.questionText === 'string'
          ? first.questionText
          : ''
    return text.slice(0, 200)
  } catch {
    return ''
  }
}

function candidateOf(row: MemoryDistillCandidateRecord): MemoryDistillCandidateSnapshot {
  return {
    memoryId: row.id,
    title: row.title,
    bodyMd: row.bodyMd,
    scopeType: row.scopeType as MemoryScope,
    scopeId: row.scopeId,
    distillAction:
      row.distillAction === 'new' ||
      row.distillAction === 'update_of' ||
      row.distillAction === 'duplicate_of' ||
      row.distillAction === 'conflict_with'
        ? row.distillAction
        : 'new',
    currentStatus: row.status as MemoryStatus,
    referenceMemoryId: row.supersedesId,
    createdAt: row.createdAt,
  }
}

async function sourceEventsOf(
  store: MemoryDistillReadStore,
  siblings: readonly MemoryDistillJob[],
): Promise<MemoryDistillSourceEventEntry[]> {
  const clarifyIds = siblings
    .filter((job) => job.sourceKind === 'clarify')
    .map((job) => job.sourceEventId)
  const reviewIds = siblings
    .filter((job) => job.sourceKind === 'review')
    .map((job) => job.sourceEventId)
  const feedbackIds = siblings
    .filter((job) => job.sourceKind === 'feedback')
    .map((job) => job.sourceEventId)
  const [clarifyRows, reviewRows, feedbackRows] = await Promise.all([
    store.listClarifySources(clarifyIds),
    store.listReviewSources(reviewIds),
    store.listFeedbackSources(feedbackIds),
  ])
  const clarifyById = new Map(clarifyRows.map((row) => [row.id, row]))
  const reviewById = new Map(reviewRows.map((row) => [row.id, row]))
  const feedbackById = new Map(feedbackRows.map((row) => [row.id, row]))

  return siblings.map((job): MemoryDistillSourceEventEntry => {
    if (job.sourceKind === 'clarify') {
      const row = clarifyById.get(job.sourceEventId)
      return row === undefined
        ? {
            kind: 'clarify',
            id: job.sourceEventId,
            summary: '',
            deepLink: `/clarify/${job.sourceEventId}`,
            deletedOrMissing: true,
            taskId: job.taskId,
          }
        : {
            kind: 'clarify',
            id: row.id,
            summary: summarizeClarifyQuestions(row.questionsJson),
            deepLink: `/clarify/${row.id}`,
            deletedOrMissing: false,
            taskId: row.taskId,
          }
    }
    if (job.sourceKind === 'review') {
      const row = reviewById.get(job.sourceEventId)
      return row === undefined
        ? {
            kind: 'review',
            id: job.sourceEventId,
            summary: '',
            deepLink: `/reviews/${job.sourceEventId}`,
            deletedOrMissing: true,
            taskId: job.taskId,
          }
        : {
            kind: 'review',
            id: row.id,
            summary: `${row.decision} · v${row.versionIndex}`,
            deepLink: `/reviews/${row.id}`,
            deletedOrMissing: false,
            taskId: row.taskId,
          }
    }
    const row = feedbackById.get(job.sourceEventId)
    return row === undefined
      ? {
          kind: 'feedback',
          id: job.sourceEventId,
          summary: '',
          deepLink: `/tasks/${job.taskId ?? ''}#feedback-${job.sourceEventId}`,
          deletedOrMissing: true,
          taskId: job.taskId,
        }
      : {
          kind: 'feedback',
          id: row.id,
          summary: row.bodyMd.slice(0, 200),
          deepLink: `/tasks/${row.taskId}#feedback-${row.id}`,
          deletedOrMissing: false,
          taskId: row.taskId,
        }
  })
}

export function createMemoryDistillQueries(store: MemoryDistillReadStore): MemoryDistillQueries {
  return Object.freeze({
    async listJobs(filter: { readonly status?: string } = {}): Promise<MemoryDistillJob[]> {
      return (await store.listJobs(filter.status)).map(jobOf)
    },
    async getJobDetail(jobId: string): Promise<MemoryDistillJobDetail> {
      const head = await store.findJob(jobId)
      if (head === null) {
        throw new NotFoundError('distill-job-not-found', `distill job '${jobId}' not found`)
      }
      const siblingRows = await store.listSiblingJobs(head.debounceKey)
      const siblings = siblingRows.map(jobOf)
      const job = siblings.find((candidate) => candidate.id === jobId) ?? jobOf(head)
      const [sourceEvents, candidates] = await Promise.all([
        sourceEventsOf(store, siblings).catch((error) => {
          log.warn('source-events-load-failed', { jobId, err: String(error) })
          return [] as MemoryDistillSourceEventEntry[]
        }),
        store
          .listCandidates(jobId)
          .then((rows) => rows.map(candidateOf))
          .catch((error) => {
            log.warn('candidates-load-failed', { jobId, err: String(error) })
            return [] as MemoryDistillCandidateSnapshot[]
          }),
      ])
      return {
        job,
        siblings,
        sourceEvents,
        dedupSnapshot: parseDedupSnapshot(head.dedupSnapshotIdsJson),
        candidates,
      }
    },

    async getJobSessionView(jobId: string): Promise<MemoryDistillSessionView> {
      if ((await store.findJob(jobId)) === null) {
        throw new NotFoundError('distill-job-not-found', `distill job '${jobId}' not found`)
      }
      const rows = await store.listEvents(jobId)
      const byAttempt = new Map<number, MemoryDistillEventRecord[]>()
      for (const row of rows) {
        const bucket = byAttempt.get(row.attemptIndex)
        if (bucket === undefined) byAttempt.set(row.attemptIndex, [row])
        else bucket.push(row)
      }
      const attempts: MemoryDistillSessionAttempt[] = []
      for (const attemptIndex of [...byAttempt.keys()].sort((left, right) => left - right)) {
        const bucket = byAttempt.get(attemptIndex)!
        const captureFailed = bucket.some((row) => row.kind === DISTILL_CAPTURE_FAILED_KIND)
        const firstReal = bucket.find((row) => row.kind !== DISTILL_CAPTURE_FAILED_KIND)
        const rootSessionId = (firstReal ?? bucket[0])?.sessionId ?? null
        const events: ParseSessionInputEvent[] = bucket
          .filter((row) => row.kind !== DISTILL_CAPTURE_FAILED_KIND)
          .map((row) => ({
            id: row.id,
            ts: row.ts,
            kind: row.kind,
            sessionId: row.sessionId,
            parentSessionId: row.parentSessionId,
            payload: row.payload,
          }))
        let tree: ReturnType<typeof parseSessionTree> | null = null
        if (events.length > 0 && rootSessionId !== null) {
          try {
            tree = parseSessionTree({
              rootSessionId,
              promptText: null,
              startedAt: bucket[0]?.ts ?? null,
              primaryAgentName: DISTILLER_PRIMARY_AGENT_NAME,
              events,
            })
          } catch {
            tree = null
          }
        }
        attempts.push({
          attemptIndex,
          rootSessionId,
          startedAt: bucket[0]?.ts ?? null,
          finishedAt: bucket[bucket.length - 1]?.ts ?? null,
          captureFailed,
          tree,
        })
      }
      return { attempts }
    },
  })
}
