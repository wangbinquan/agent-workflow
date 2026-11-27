// RFC-616 §9 — text-theme analyses: a small queue worked by a background job.
//
//   request  → a pending row (or the one already queued for this subject and scope)
//   runNext  → claim, collect the text, ask the model, group, store the result
//   view     → the newest finished result of the viewer's scope, and what is in flight
//
// Scope is fixed when the analysis is requested: an account that may read every
// task analyses every unit and shares the result with accounts like it; any
// other account analyses the units it can see and is the only one to see the
// result. The job rebuilds the viewer from that stored scope, so what the model
// reads is exactly what the requester could read.

import {
  PROCESS_SUBJECT_KINDS,
  PROCESS_TEXT_SOURCES,
  type ProcessInsightAccepted,
  type ProcessInsightQuery,
  type ProcessInsightSchedule,
  type ProcessInsightView,
  type ProcessSubjectKind,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { ProcessViewer } from '@/platform/contracts/processFacts'
import {
  buildInsightPrompt,
  groupThemes,
  prepareInsightItems,
  type PreparedInsight,
} from '../../domain/process/themes'
import type { InsightRunner } from './ports/insightRunner'
import {
  INSIGHT_KEEP,
  type InsightAnalysis,
  type InsightInput,
  type InsightScope,
  type InsightStore,
  type InsightSubject,
} from './ports/insightStore'
import { canReadTasks, viewerOf } from './processQueries'
import type { ProcessTextCollection, ProcessTexts } from './processTexts'

const DAY = 86_400_000
/** A scheduled analysis looks at the last 30 days and repeats after 7. */
export const INSIGHT_SCHEDULE_WINDOW_MS = 30 * DAY
export const INSIGHT_SCHEDULE_EVERY_MS = 7 * DAY
/** Subjects queued by one scheduling pass. */
export const INSIGHT_SCHEDULE_BATCH = 5
/** How often the background job looks at the schedule. */
export const INSIGHT_SCHEDULE_CHECK_MS = 3_600_000

const CORRECTION =
  'Your previous answer was not the requested document. Answer with exactly one JSON object of the shape ' +
  '{"groups":[{"source":"…","themes":[{"name":"…","itemIds":["…"],"advice":"…"}]}]} and nothing else.'

export interface InsightSubjectActivity {
  readonly subjectId: string | null
  readonly name: string | null
  /** Start of the subject's newest unit in the window. */
  readonly newestUnitAt: number
}

export interface InsightAnalyses {
  view(
    actor: Actor,
    kind: ProcessSubjectKind,
    subjectId: string | null,
    query: ProcessInsightQuery,
  ): Promise<ProcessInsightView>
  request(
    actor: Actor,
    kind: ProcessSubjectKind,
    subjectId: string | null,
    query: ProcessInsightQuery,
  ): Promise<ProcessInsightAccepted>
  /** Work one queued analysis; false when the queue is empty. */
  runNext(): Promise<boolean>
  /** One beat of the background job: check the schedule at most hourly, then work one analysis. */
  tick(): Promise<void>
  /** Queue the analyses the schedule asks for; returns how many were queued. */
  scheduleDue(): Promise<number>
  /** Analyses left running by a previous daemon can no longer finish. */
  repairInterrupted(): Promise<number>
}

class InsightFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function scopeOf(viewer: ProcessViewer): InsightScope {
  return viewer.canReadAll ? { kind: 'all' } : { kind: 'user', userId: viewer.userId }
}

function inputOf(prepared: PreparedInsight): InsightInput {
  return {
    sources: PROCESS_TEXT_SOURCES.flatMap((source) => {
      const items = prepared.items.filter((item) => item.source === source).length
      return items === 0 ? [] : [{ source, items, truncated: prepared.truncated.has(source) }]
    }),
    newestAt: prepared.newestAt,
  }
}

export function createInsightAnalyses(deps: {
  readonly store: InsightStore
  readonly runner: InsightRunner
  readonly texts: ProcessTexts
  readonly schedule: () => Promise<ProcessInsightSchedule>
  /** Subjects with units in the window, across every unit. */
  readonly activity: (
    kind: ProcessSubjectKind,
    window: { readonly from: number; readonly to: number },
  ) => Promise<readonly InsightSubjectActivity[]>
  readonly clock?: () => number
}): InsightAnalyses {
  const clock = deps.clock ?? Date.now
  let scheduleCheckedAt: number | null = null

  const collect = (
    viewer: ProcessViewer,
    subject: InsightSubject,
    window: { readonly from: number; readonly to: number },
  ): Promise<ProcessTextCollection> => deps.texts.collect(viewer, subject.kind, subject.id, window)

  async function analyse(analysis: InsightAnalysis): Promise<void> {
    const viewer: ProcessViewer =
      analysis.scope.kind === 'all'
        ? { userId: analysis.requestedBy ?? '', canReadAll: true }
        : { userId: analysis.scope.userId, canReadAll: false }
    let input: InsightInput | null = null
    try {
      const collected = await collect(viewer, analysis.subject, {
        from: analysis.windowFrom,
        to: analysis.windowTo,
      })
      const prepared = prepareInsightItems(collected.items)
      input = inputOf(prepared)
      if (prepared.items.length === 0) {
        await deps.store.finish(
          analysis.id,
          { status: 'done', input, result: { groups: [], stageLabels: {} } },
          clock(),
        )
        return
      }
      const subjectName = collected.subjectName ?? analysis.subject.name ?? analysis.subject.kind
      const prompt = buildInsightPrompt(prepared, subjectName)
      const ask = (attempt: number, text: string) =>
        deps.runner.run({
          analysisId: analysis.id,
          attempt,
          prompt: text,
          ownerUserId: analysis.requestedBy,
          subjectName,
        })
      let run = await ask(1, prompt)
      let groups = run.ok ? groupThemes(run.answer, prepared) : null
      if (run.ok && groups === null) {
        // One more try with the correction appended; a second unreadable answer fails the analysis.
        run = await ask(2, `${prompt}\n\n${CORRECTION}`)
        groups = run.ok ? groupThemes(run.answer, prepared) : null
      }
      if (!run.ok) throw new InsightFailure(run.code, run.message)
      if (groups === null) {
        throw new InsightFailure(
          'invalid-output',
          'The model did not return the requested document',
        )
      }
      const used = new Set(groups.flatMap((group) => group.themes.flatMap((theme) => theme.stages)))
      await deps.store.finish(
        analysis.id,
        {
          status: 'done',
          input,
          result: {
            groups,
            stageLabels: Object.fromEntries(
              Object.entries(collected.stageLabels).filter(([key]) => used.has(key)),
            ),
          },
        },
        clock(),
      )
    } catch (error) {
      await deps.store.finish(
        analysis.id,
        {
          status: 'failed',
          input,
          errorCode: error instanceof InsightFailure ? error.code : 'analysis-failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        clock(),
      )
    }
  }

  const analyses: InsightAnalyses = {
    async view(actor, kind, subjectId, query) {
      const asOf = clock()
      const viewer = viewerOf(actor)
      const scope = scopeOf(viewer)
      const schedule = await deps.schedule()
      const empty: ProcessInsightView = {
        asOf,
        scope: viewer.canReadAll ? 'all' : 'own',
        schedule,
        result: null,
        active: null,
        failure: null,
        stale: false,
      }
      if (!canReadTasks(actor)) return empty
      const subject: InsightSubject = { kind, id: subjectId, name: null }
      const recent = await deps.store.recent(subject, scope, INSIGHT_KEEP)
      // Read on its own: it may lie behind any number of later attempts that failed.
      const lastDone = await deps.store.lastDone(subject, scope)
      const done = lastDone !== null && lastDone.result !== null ? lastDone : undefined
      const active = recent.find((item) => item.status === 'pending' || item.status === 'running')
      const newest = recent[0]
      let stale = false
      if (done !== undefined && active === undefined) {
        // New text since the result was made? Read the current text once; the page asks for this
        // only when someone opens the analysis, and never while one is running.
        const current = prepareInsightItems((await collect(viewer, subject, query)).items)
        stale = current.newestAt !== null && current.newestAt > (done.input?.newestAt ?? 0)
      }
      return {
        ...empty,
        result:
          done === undefined || done.result === null
            ? null
            : {
                id: done.id,
                trigger: done.trigger,
                windowFrom: done.windowFrom,
                windowTo: done.windowTo,
                finishedAt: done.finishedAt ?? done.createdAt,
                groups: done.result.groups,
                stageLabels: done.result.stageLabels,
              },
        active:
          active === undefined
            ? null
            : {
                id: active.id,
                status: active.status === 'running' ? 'running' : 'pending',
                requestedAt: active.createdAt,
              },
        failure:
          newest !== undefined && newest.status === 'failed'
            ? {
                code: newest.errorCode ?? 'analysis-failed',
                message: newest.errorMessage ?? '',
                at: newest.finishedAt ?? newest.createdAt,
              }
            : null,
        stale,
      }
    },

    async request(actor, kind, subjectId, query) {
      if (!canReadTasks(actor)) return { id: '', status: 'empty' }
      const viewer = viewerOf(actor)
      const scope = scopeOf(viewer)
      const subject: InsightSubject = { kind, id: subjectId, name: null }
      const active = await deps.store.active(subject, scope)
      if (active !== null) {
        return { id: active.id, status: active.status === 'running' ? 'running' : 'pending' }
      }
      // Nothing to read means nothing to queue: no model call is made for an empty input.
      const collected = await collect(viewer, subject, query)
      if (prepareInsightItems(collected.items).items.length === 0)
        return { id: '', status: 'empty' }
      const id = ulid()
      await deps.store.insert({
        id,
        subject: { ...subject, name: collected.subjectName },
        scope,
        windowFrom: query.from,
        windowTo: query.to,
        trigger: 'manual',
        requestedBy: actor.user.id,
        createdAt: clock(),
      })
      await deps.store.prune(subject, scope)
      return { id, status: 'pending' }
    },

    async runNext() {
      const analysis = await deps.store.claimNext(clock())
      if (analysis === null) return false
      await analyse(analysis)
      return true
    },

    async scheduleDue() {
      if ((await deps.schedule()) !== 'weekly') return 0
      const now = clock()
      const window = { from: now - INSIGHT_SCHEDULE_WINDOW_MS, to: now }
      const scope: InsightScope = { kind: 'all' }
      let queued = 0
      for (const kind of PROCESS_SUBJECT_KINDS) {
        if (queued >= INSIGHT_SCHEDULE_BATCH) break
        const last = await deps.store.lastScheduled(kind)
        for (const subject of await deps.activity(kind, window)) {
          if (queued >= INSIGHT_SCHEDULE_BATCH) break
          const previous = last.get(subject.subjectId ?? '')
          // Due when never analysed, or a week has passed and a unit started since.
          if (previous !== undefined) {
            if (now - previous < INSIGHT_SCHEDULE_EVERY_MS) continue
            if (subject.newestUnitAt <= previous) continue
          }
          const target: InsightSubject = { kind, id: subject.subjectId, name: subject.name }
          if ((await deps.store.active(target, scope)) !== null) continue
          await deps.store.insert({
            id: ulid(),
            subject: target,
            scope,
            windowFrom: window.from,
            windowTo: window.to,
            trigger: 'scheduled',
            requestedBy: null,
            createdAt: now,
          })
          await deps.store.prune(target, scope)
          queued++
        }
      }
      return queued
    },

    async tick() {
      const now = clock()
      if (scheduleCheckedAt === null || now - scheduleCheckedAt >= INSIGHT_SCHEDULE_CHECK_MS) {
        scheduleCheckedAt = now
        await analyses.scheduleDue()
      }
      await analyses.runNext()
    },

    repairInterrupted() {
      return deps.store.failRunning(
        'daemon-restarted',
        'The daemon restarted while this analysis was running',
        clock(),
      )
    },
  }
  return analyses
}
