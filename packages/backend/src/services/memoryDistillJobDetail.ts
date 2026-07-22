// RFC-043 T4 — aggregator behind GET /api/memory-distill-jobs/:id.
//
// Gathers everything the admin detail page needs in one round trip:
//   - the job row (with the 5 RFC-043 capture columns)
//   - sibling jobs sharing the same debounce_key (the distiller batched
//     them in one subprocess; admin needs to know what else was merged)
//   - resolved source events (clarify Q&A, review decision, feedback note)
//     with a short summary + deep-link string + deletedOrMissing flag
//   - dedupSnapshot — the approved memories the distiller saw at run time
//     (frozen in job.dedup_snapshot_ids_json so later approve/archive
//     don't change what we display about this historical run)
//   - candidates — memory rows produced by this distill job (joined via
//     memories.distill_job_id which RFC-041 persistCandidate writes)
//
// All sub-fetches are wrapped in best-effort try/catch — a single bad row
// (e.g. legacy job with missing column) yields a fallback empty slice
// rather than 500'ing the whole detail page.

import { and, asc, eq, inArray } from 'drizzle-orm'
import type {
  MemoryDistillCandidateSnapshot,
  MemoryDistillDedupSnapshotEntry,
  MemoryDistillJob,
  MemoryDistillJobDetail,
  MemoryDistillSourceEventEntry,
  MemoryScope,
  MemoryStatus,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { clarifyRounds, docVersions, memories, memoryDistillJobs, taskFeedback } from '@/db/schema'
import { rowToDistillJob } from '@/services/memoryDistiller'
import { NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('memory-distill-job-detail')

export async function getDistillJobDetail(
  db: DbClient,
  jobId: string,
): Promise<MemoryDistillJobDetail> {
  const jobRow = await db
    .select()
    .from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.id, jobId))
    .limit(1)
  const head = jobRow[0]
  if (head === undefined) {
    throw new NotFoundError('distill-job-not-found', `distill job '${jobId}' not found`)
  }

  const siblingRows = await db
    .select()
    .from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.debounceKey, head.debounceKey))
    .orderBy(asc(memoryDistillJobs.createdAt))
  const siblings: MemoryDistillJob[] = siblingRows.map((r) => decorateJob(rowToDistillJob(r), r))
  const job = siblings.find((s) => s.id === jobId) ?? decorateJob(rowToDistillJob(head), head)

  const [sourceEvents, dedupSnapshot, candidates] = await Promise.all([
    safeLoadSourceEvents(db, siblings).catch((err) => {
      log.warn('source-events-load-failed', { jobId, err: String(err) })
      return [] as MemoryDistillSourceEventEntry[]
    }),
    Promise.resolve(parseDedupSnapshot(head.dedupSnapshotIdsJson)),
    safeLoadCandidates(db, jobId).catch((err) => {
      log.warn('candidates-load-failed', { jobId, err: String(err) })
      return [] as MemoryDistillCandidateSnapshot[]
    }),
  ])

  return { job, siblings, sourceEvents, dedupSnapshot, candidates }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MemoryDistillJobRowShape {
  opencodeSessionId: string | null
  userPromptMd: string | null
  exitCode: number | null
  stderrExcerpt: string | null
  outputLang?: string | null
}

function decorateJob(base: MemoryDistillJob, row: MemoryDistillJobRowShape): MemoryDistillJob {
  // RFC-050: surface the per-job output language so the detail page can
  // show a one-line `Output language: <lang>` header. Defensive narrow:
  // unknown / corrupt values come back as null (UI then shows "default").
  const outputLang =
    row.outputLang === 'zh-CN' || row.outputLang === 'en-US' ? row.outputLang : null
  return {
    ...base,
    opencodeSessionId: row.opencodeSessionId,
    userPromptMd: row.userPromptMd,
    exitCode: row.exitCode,
    stderrExcerpt: row.stderrExcerpt,
    outputLang,
  }
}

export function parseDedupSnapshot(raw: string | null): MemoryDistillDedupSnapshotEntry[] {
  if (raw === null || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return []
    const arr = (parsed as { snapshot?: unknown }).snapshot
    if (!Array.isArray(arr)) return []
    const out: MemoryDistillDedupSnapshotEntry[] = []
    for (const item of arr) {
      if (item === null || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o.memoryId !== 'string') continue
      if (typeof o.scopeType !== 'string') continue
      if (!isMemoryScope(o.scopeType)) continue
      if (typeof o.title !== 'string') continue
      const scopeId = typeof o.scopeId === 'string' ? o.scopeId : null
      out.push({
        memoryId: o.memoryId,
        scopeType: o.scopeType,
        scopeId,
        title: o.title,
      })
    }
    return out
  } catch {
    return []
  }
}

function isMemoryScope(s: string): s is MemoryScope {
  return s === 'agent' || s === 'workflow' || s === 'repo' || s === 'global'
}

async function safeLoadSourceEvents(
  db: DbClient,
  siblings: MemoryDistillJob[],
): Promise<MemoryDistillSourceEventEntry[]> {
  const clarifyIds = siblings.filter((s) => s.sourceKind === 'clarify').map((s) => s.sourceEventId)
  const reviewIds = siblings.filter((s) => s.sourceKind === 'review').map((s) => s.sourceEventId)
  const feedbackIds = siblings
    .filter((s) => s.sourceKind === 'feedback')
    .map((s) => s.sourceEventId)

  const [clarifyRows, reviewRows, feedbackRows] = await Promise.all([
    clarifyIds.length > 0
      ? db
          .select()
          .from(clarifyRounds)
          .where(and(eq(clarifyRounds.kind, 'self'), inArray(clarifyRounds.id, clarifyIds)))
      : Promise.resolve([] as Array<typeof clarifyRounds.$inferSelect>),
    reviewIds.length > 0
      ? db.select().from(docVersions).where(inArray(docVersions.id, reviewIds))
      : Promise.resolve([] as Array<typeof docVersions.$inferSelect>),
    feedbackIds.length > 0
      ? db.select().from(taskFeedback).where(inArray(taskFeedback.id, feedbackIds))
      : Promise.resolve([] as Array<typeof taskFeedback.$inferSelect>),
  ])

  const clarifyById = new Map(clarifyRows.map((r) => [r.id, r]))
  const reviewById = new Map(reviewRows.map((r) => [r.id, r]))
  const feedbackById = new Map(feedbackRows.map((r) => [r.id, r]))

  const out: MemoryDistillSourceEventEntry[] = []
  for (const s of siblings) {
    if (s.sourceKind === 'clarify') {
      const row = clarifyById.get(s.sourceEventId)
      if (row === undefined) {
        out.push({
          kind: 'clarify',
          id: s.sourceEventId,
          summary: '',
          deepLink: `/clarify/${s.sourceEventId}`,
          deletedOrMissing: true,
          taskId: s.taskId,
        })
      } else {
        out.push({
          kind: 'clarify',
          id: row.id,
          summary: summarizeClarifyQuestions(row.questionsJson),
          deepLink: `/clarify/${row.id}`,
          deletedOrMissing: false,
          taskId: row.taskId,
        })
      }
    } else if (s.sourceKind === 'review') {
      const row = reviewById.get(s.sourceEventId)
      if (row === undefined) {
        out.push({
          kind: 'review',
          id: s.sourceEventId,
          summary: '',
          deepLink: `/reviews/${s.sourceEventId}`,
          deletedOrMissing: true,
          taskId: s.taskId,
        })
      } else {
        out.push({
          kind: 'review',
          id: row.id,
          summary: `${row.decision} · v${row.versionIndex}`,
          deepLink: `/reviews/${row.id}`,
          deletedOrMissing: false,
          taskId: row.taskId,
        })
      }
    } else {
      const row = feedbackById.get(s.sourceEventId)
      if (row === undefined) {
        out.push({
          kind: 'feedback',
          id: s.sourceEventId,
          summary: '',
          deepLink: `/tasks/${s.taskId ?? ''}#feedback-${s.sourceEventId}`,
          deletedOrMissing: true,
          taskId: s.taskId,
        })
      } else {
        out.push({
          kind: 'feedback',
          id: row.id,
          summary: row.bodyMd.slice(0, 200),
          deepLink: `/tasks/${row.taskId}#feedback-${row.id}`,
          deletedOrMissing: false,
          taskId: row.taskId,
        })
      }
    }
  }
  return out
}

export function summarizeClarifyQuestions(questionsJson: string): string {
  try {
    const parsed = JSON.parse(questionsJson) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return ''
    const first = parsed[0] as Record<string, unknown>
    // ClarifyQuestionSchema (RFC-023) names this `title`; fall back to
    // `questionText` for resilience against older fixtures / future renames.
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

async function safeLoadCandidates(
  db: DbClient,
  jobId: string,
): Promise<MemoryDistillCandidateSnapshot[]> {
  const rows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.distillJobId, jobId)))
    .orderBy(asc(memories.createdAt))
  return rows.map<MemoryDistillCandidateSnapshot>((r) => ({
    memoryId: r.id,
    title: r.title,
    bodyMd: r.bodyMd,
    scopeType: r.scopeType as MemoryScope,
    scopeId: r.scopeId,
    distillAction:
      r.distillAction === 'new' ||
      r.distillAction === 'update_of' ||
      r.distillAction === 'duplicate_of' ||
      r.distillAction === 'conflict_with'
        ? r.distillAction
        : 'new',
    currentStatus: r.status as MemoryStatus,
    referenceMemoryId: r.supersedesId,
    createdAt: r.createdAt,
  }))
}
