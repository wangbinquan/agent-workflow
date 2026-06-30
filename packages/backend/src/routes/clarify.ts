// RFC-023 PR-B T13 — REST endpoints for the clarify feature.
//
//   GET    /api/clarify                       list (filter: status / taskId)
//   GET    /api/clarify/pending-count         { count: N } for left-nav badge
//   GET    /api/clarify/:nodeRunId            session detail (questions + answers JSON)
//   POST   /api/clarify/:nodeRunId/answers    submit user answers
//
// Auth: token middleware applies via createApp's app.use('/api/*', ...).
//
// Optimistic locking: POST honors either an `If-Match` header (integer) or
// the `ifMatchIteration` body field — both translate to ConflictError code
// `clarify-iteration-mismatch` when stale. (Hono auto-maps DomainError to
// 409, not 412; we keep 409 to match the rest of the API surface.)

import {
  ClarifyDraftSaveBodySchema,
  ListClarifyQuerySchema,
  SubmitClarifyAnswersSchema,
  type TaskActorRole,
} from '@agent-workflow/shared'
import { desc, eq, inArray } from 'drizzle-orm'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import { loadConfig } from '@/config'
import { clarifyRounds, nodeRuns, tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import { countPendingClarifications, submitClarifyAnswers } from '@/services/clarify'
import { submitCrossClarifyAnswers } from '@/services/crossClarify'
import { sealRoundQuestions } from '@/services/clarifySeal'
import { autoDispatchClarifyRound } from '@/services/clarifyAutoDispatch'
import {
  getClarifyRoundDetail,
  listClarifyRoundSummaries,
  saveClarifyDraft,
} from '@/services/clarifyRounds'
import { canViewTask, requireTaskMember } from '@/services/taskCollab'
import { resumeTask } from '@/services/task'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { Paths } from '@/util/paths'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('clarify-route')

function resolveOpencodeCmd(configPath: string): string[] | undefined {
  if (configPath === '') return undefined
  try {
    const cfg = loadConfig(configPath)
    if (typeof cfg.opencodePath === 'string' && cfg.opencodePath.length > 0) {
      return [cfg.opencodePath]
    }
  } catch {
    /* nothing */
  }
  return undefined
}

/**
 * RFC-099 (D5/D7) — answer-rights gate for clarify writes: any task member
 * (owner or collaborator) or an admin. Replaces the RFC-036 assigned-
 * clarify_target triple (node assignments are removed). Keyed off
 * clarify_rounds (the RFC-058 authoritative table — every legacy session has
 * a dual-written round). Returns the role snapshot to record.
 */
async function ensureClarifyMember(
  deps: AppDeps,
  intermediaryNodeRunId: string,
  actor: Actor,
): Promise<TaskActorRole> {
  const rounds = await deps.db
    .select({ taskId: clarifyRounds.taskId })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
    .orderBy(desc(clarifyRounds.createdAt))
    .limit(1)
  const round = rounds[0]
  if (!round) {
    // No round → keep the legacy 404 shape (after confirming the node_run
    // itself is absent too; an existing run without a round is a service bug
    // the detail endpoint reports consistently).
    const runs = await deps.db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, intermediaryNodeRunId))
      .limit(1)
    if (!runs[0]) {
      throw new NotFoundError('clarify-session-not-found', 'clarify session not found')
    }
    throw new NotFoundError('clarify-round-not-found', 'clarify round not found')
  }
  const taskRow = (
    await deps.db.select().from(tasksTable).where(eq(tasksTable.id, round.taskId)).limit(1)
  )[0]
  if (!taskRow) {
    throw new NotFoundError('task-not-found', `task '${round.taskId}' not found`)
  }
  return requireTaskMember(deps.db, actor, taskRow)
}

/** RFC-099 (D5) — read gate: clarify inherits task visibility (403 mirror of task routes). */
async function ensureClarifyVisible(
  deps: AppDeps,
  intermediaryNodeRunId: string,
  actor: Actor,
): Promise<void> {
  const rounds = await deps.db
    .select({ taskId: clarifyRounds.taskId })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
    .limit(1)
  const round = rounds[0]
  if (!round) return // detail endpoint produces its own 404
  const taskRow = (
    await deps.db.select().from(tasksTable).where(eq(tasksTable.id, round.taskId)).limit(1)
  )[0]
  if (!taskRow) return
  if (!(await canViewTask(deps.db, actor, taskRow))) {
    throw new ForbiddenError(
      'task-not-visible',
      `task '${taskRow.id}' is not visible to this actor`,
    )
  }
}

/** RFC-099 (D5) — list filter by task visibility (admin shortcut). */
async function filterRoundsByTaskVisibility<T extends { taskId: string }>(
  deps: AppDeps,
  actor: Actor,
  rows: readonly T[],
): Promise<T[]> {
  if (actor.permissions.has('tasks:read:all')) return [...rows]
  const taskIds = [...new Set(rows.map((r) => r.taskId))]
  if (taskIds.length === 0) return []
  const taskRows = await deps.db
    .select({ id: tasksTable.id, ownerUserId: tasksTable.ownerUserId })
    .from(tasksTable)
    .where(inArray(tasksTable.id, taskIds))
  const visible = new Set<string>()
  for (const t of taskRows) {
    if (await canViewTask(deps.db, actor, t)) visible.add(t.id)
  }
  return rows.filter((r) => visible.has(r.taskId))
}

/** RFC-056: extract a node's `kind` field from a serialized
 *  WorkflowDefinition snapshot. Returns `undefined` when the JSON is
 *  malformed or the node id is absent (the caller falls through to
 *  RFC-023 self-clarify path by default). */
function nodeKindFromSnapshot(snapshotJson: string, nodeId: string): string | undefined {
  try {
    const snap = JSON.parse(snapshotJson) as { nodes?: Array<{ id?: unknown; kind?: unknown }> }
    const nodes = snap?.nodes
    if (!Array.isArray(nodes)) return undefined
    for (const n of nodes) {
      if (n?.id === nodeId && typeof n.kind === 'string') return n.kind
    }
  } catch {
    return undefined
  }
  return undefined
}

export function mountClarifyRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/clarify', async (c) => {
    const q = ListClarifyQuerySchema.safeParse({
      status: c.req.query('status') ?? undefined,
      taskId: c.req.query('taskId') ?? c.req.query('task_id') ?? undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    })
    if (!q.success) {
      throw new ValidationError('clarify-list-query-invalid', 'invalid clarify list query', {
        issues: q.error.issues,
      })
    }
    // RFC-058 T14: single ClarifyRoundSummary[] from unified clarify_rounds.
    // Replaces the kind-tagged ClarifySession|CrossClarifySession union the
    // route used to emit; `entry.kind` discriminator lives on the row itself.
    const filter: {
      status?: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned' | 'all'
      taskId?: string
      limit?: number
    } = {}
    if (q.data.status !== undefined) filter.status = q.data.status
    if (q.data.taskId !== undefined) filter.taskId = q.data.taskId
    if (q.data.limit !== undefined) filter.limit = q.data.limit
    const summaries = await listClarifyRoundSummaries(deps.db, filter)
    return c.json(await filterRoundsByTaskVisibility(deps, actorOf(c), summaries))
  })

  app.get('/api/clarify/pending-count', async (c) => {
    // RFC-099: badge counts only rounds on tasks visible to the actor.
    const actor = actorOf(c)
    if (actor.permissions.has('tasks:read:all')) {
      return c.json({ count: await countPendingClarifications(deps.db) })
    }
    const pending = await listClarifyRoundSummaries(deps.db, { status: 'awaiting_human' })
    const visible = await filterRoundsByTaskVisibility(deps, actor, pending)
    return c.json({ count: visible.length })
  })

  app.get('/api/clarify/:nodeRunId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    await ensureClarifyVisible(deps, nodeRunId, actorOf(c))
    // RFC-058 T14: single ClarifyRound shape; `kind` discriminator
    // distinguishes self vs cross. The keying by intermediary node_run id
    // works for both because dual-write already mints the matching
    // clarify_rounds row at session creation time.
    const detail = await getClarifyRoundDetail(deps.db, nodeRunId)
    return c.json(detail)
  })

  app.post('/api/clarify/:nodeRunId/answers', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = SubmitClarifyAnswersSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('clarify-answers-invalid', 'invalid clarify answers body', {
        issues: parsed.error.issues,
      })
    }
    // Header-based optimistic lock; body field takes precedence if both set.
    let ifMatch = parsed.data.ifMatchIteration
    if (ifMatch === undefined) {
      const header = c.req.header('If-Match')
      if (header !== undefined && /^-?\d+$/.test(header)) {
        ifMatch = Number.parseInt(header, 10)
      }
    }
    // RFC-099 (D5/D7): any task member (or admin); capture the role snapshot.
    const actor = actorOf(c)
    const role = await ensureClarifyMember(deps, nodeRunId, actor)

    // RFC-128 P2 (Codex P2-1) — `questionIds` (a subset cap) is ONLY meaningful for the
    // defer/control channel. On the quick channel it would silently drop questions while
    // submitClarifyAnswers/submitCrossClarifyAnswers still finalize the WHOLE round (status
    // answered + rerun mint), permanently stranding the dropped questions. Reject the combo
    // instead of filtering-then-falling-through to the quick path.
    if (parsed.data.questionIds !== undefined && parsed.data.defer !== true) {
      throw new ValidationError(
        'clarify-question-ids-requires-defer',
        'questionIds is only honored with defer=true (the control channel); a quick-channel submit answers the whole round',
      )
    }

    // RFC-128 P2 (T6) — defer routing. defer=true → CONTROL channel: seal the answered
    // subset (sealRoundQuestions, P1) WITHOUT minting a rerun or resuming the task; the
    // sealed question(s) enter 待指派 for the centralized-answer pane / batch dispatch. The
    // seal primitive is kind-agnostic (reads round.kind internally + dual-writes the legacy
    // session), so no self/cross branch is needed here. defer=false (the default, and the
    // value when omitted) falls through to the unchanged quick channel below — which keeps
    // using `parsed.data.answers` verbatim (golden lock).
    if (parsed.data.defer) {
      // Subset cap (T5): seal only answers whose questionId is in `questionIds` (when set).
      const subsetIds = parsed.data.questionIds
      const sealAnswers =
        subsetIds !== undefined
          ? parsed.data.answers.filter((a) => subsetIds.includes(a.questionId))
          : parsed.data.answers
      const sealResult = await sealRoundQuestions({
        db: deps.db,
        originNodeRunId: nodeRunId,
        answers: sealAnswers,
        // RFC-128 P5-0 stranding guard, NARROWED by P5-BC (§5.2.1): the route still opts in, but
        // the guard now only fires on a NON-deferred task (no self/questioner park source → a
        // self/questioner full seal would strand). On a DEFERRED task P5-BC's park + dispatch path
        // IS the release path, so the seal is ALLOWED — sealRoundQuestions lifts the guard for
        // deferred tasks (the sealed entry parks its home until board dispatch mints the
        // continuation). PARTIAL seals and DESIGNER-only cross CONTINUE full seals (the §18-parked
        // P3 mainline) pass through unchanged.
        rejectSelfQuestionerFullSeal: true,
        // RFC-128 P2 (Codex P2-2): thread the round directive so the control channel matches
        // quick-path stop semantics (no designer entries + directive persisted; 'continue'
        // also satisfies the §18 designer park). Schema defaults it to 'continue'.
        directive: parsed.data.directive,
        // Per-question scope is chosen when a (cross) question is answered; harmless for
        // self rounds (reconcile never derives a designer entry from scope there). Mirror
        // the quick channel — forward questionScopes only when the client sent it.
        ...(parsed.data.questionScopes !== undefined ? { scopes: parsed.data.questionScopes } : {}),
        // RFC-099: audit-only setter id — NEVER enters an agent prompt.
        sealedBy: actor.user.id,
      })
      // NB: no resumeTask — the whole point of defer is to NOT advance execution; the
      // user dispatches later from the board (P3 designer 借壳 / P5 self·questioner rerun).
      return c.json({ ok: true, kind: 'seal' as const, ...sealResult })
    }

    // RFC-056: branch by node kind. Cross-clarify routes through
    // submitCrossClarifyAnswers which knows the 'continue' (submit) +
    // 'stop' (reject) directives.
    const nrRow = (
      await deps.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
    )[0]
    const ownerTask = nrRow
      ? (await deps.db.select().from(tasksTable).where(eq(tasksTable.id, nrRow.taskId)).limit(1))[0]
      : undefined
    const nodeKind =
      nrRow && ownerTask
        ? nodeKindFromSnapshot(ownerTask.workflowSnapshot, nrRow.nodeId)
        : undefined

    // RFC-128 P5-D (§5.2.7 P5b single-path) — the quick channel (defer=false) on a DEFERRED task
    // does NOT mint an immediate continuation. It seals the round + AUTO-triggers the SAME
    // per-question dispatch the board's 批量下发 uses (autoDispatchClarifyRound). `defer` only chooses
    // AUTO (here) vs MANUAL (the centralized-answer pane, defer=true) triggering of the ONE dispatch
    // path — never a second delivery path. A NON-deferred task falls through to the legacy immediate
    // mint below (submitClarifyAnswers / submitCrossClarifyAnswers, BYTE-FOR-BYTE unchanged —
    // golden-lock). Kind-agnostic: autoDispatchClarifyRound reads round.kind internally + dispatches
    // the round's self/questioner entries (designer entries keep the §18 manual board dispatch).
    if (ownerTask?.deferredQuestionDispatch === true) {
      const auto = await autoDispatchClarifyRound({
        db: deps.db,
        originNodeRunId: nodeRunId,
        answers: parsed.data.answers,
        directive: parsed.data.directive,
        ...(parsed.data.questionScopes !== undefined ? { scopes: parsed.data.questionScopes } : {}),
        actor: { userId: actor.user.id, role },
      })
      // Release the gate so the freshly-minted self/questioner reruns dispatch — mirroring the
      // manual dispatch route + the legacy quick path. Best-effort: a `running` deferred task'
      // live loop picks up the pending reruns (task-not-resumable logged at info, not surfaced).
      const opencodeCmdAuto = resolveOpencodeCmd(deps.configPath)
      const resumeDepsAuto: Parameters<typeof resumeTask>[2] = {
        db: deps.db,
        appHome: Paths.root,
        ...(opencodeCmdAuto ? { opencodeCmd: opencodeCmdAuto } : {}),
        ...resolveLaunchRuntimeConfig(deps.configPath),
      }
      void resumeTask(deps.db, auto.taskId, resumeDepsAuto).catch((err) => {
        if (err instanceof ConflictError && err.code === 'task-not-resumable') {
          log.info('clarify autodispatch resume deferred — live loop picks up the pending reruns', {
            taskId: auto.taskId,
          })
          return
        }
        log.warn('clarify autodispatch resume threw', {
          taskId: auto.taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return c.json({
        ok: true,
        kind: 'autodispatch' as const,
        roundKind: auto.kind,
        sealedQuestionIds: auto.sealedQuestionIds,
        roundFullySealed: auto.roundFullySealed,
        reruns: auto.dispatch.reruns,
        dispatchedEntryIds: auto.dispatch.dispatchedEntryIds,
        deferred: auto.dispatch.deferred,
      })
    }

    if (nodeKind === 'clarify-cross-agent') {
      const ccResult = await submitCrossClarifyAnswers({
        db: deps.db,
        crossClarifyNodeRunId: nodeRunId,
        answers: parsed.data.answers,
        directive: parsed.data.directive,
        answeredBy: actor.user.id,
        submittedByRole: role,
        ...(ifMatch !== undefined ? { ifMatchIteration: ifMatch } : {}),
        // RFC-059: per-question scope mapping. Self-clarify branch below
        // intentionally does NOT receive this field (the asking agent is
        // itself the consumer, so there's no designer/questioner split).
        ...(parsed.data.questionScopes !== undefined
          ? { questionScopes: parsed.data.questionScopes }
          : {}),
      })
      const opencodeCmdCC = resolveOpencodeCmd(deps.configPath)
      const resumeDepsCC: Parameters<typeof resumeTask>[2] = {
        db: deps.db,
        appHome: Paths.root,
        ...(opencodeCmdCC ? { opencodeCmd: opencodeCmdCC } : {}),
        // RFC-108 T4 (Codex re-review P2): the cross-clarify resume branch must
        // thread the per-node timeout floor too, else a parked cross-clarify
        // task resumes with unbounded nodes under the default config.
        ...resolveLaunchRuntimeConfig(deps.configPath),
      }
      void resumeTask(deps.db, ccResult.session.taskId, resumeDepsCC).catch((err) => {
        if (err instanceof ConflictError && err.code === 'task-not-resumable') {
          log.info('cross-clarify resume deferred', { taskId: ccResult.session.taskId })
          return
        }
        log.warn('cross-clarify resume threw', {
          taskId: ccResult.session.taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return c.json({ ok: true, kind: 'cross' as const, ...ccResult })
    }

    const result = await submitClarifyAnswers({
      db: deps.db,
      clarifyNodeRunId: nodeRunId,
      answers: parsed.data.answers,
      directive: parsed.data.directive,
      answeredBy: actor.user.id,
      submittedByRole: role,
      ...(ifMatch !== undefined ? { ifMatchIteration: ifMatch } : {}),
    })
    // Re-enter the scheduler so the freshly minted rerun node_run starts.
    //
    // RFC-023 bug 13 / RFC-092 (audit S-1, S-26): when the task is still
    // `running` at submit time (parallel branches keep the scheduler busy
    // while the user answers), `resumeTask` throws `task-not-resumable` and
    // that is EXPECTED — the live dispatch loop picks the fresh pending rerun
    // row up on its next tick via deriveFrontier's pending-anchor release
    // (scheduler.ts, RFC-092; the rescanScopeForNewPendingRows mechanism this
    // comment used to cite was deleted in RFC-076, which made the swallow
    // unsafe until RFC-092 restored a pickup path). So this resume is
    // best-effort:
    //   - We still TRY to resume in case the task is already paused
    //     (awaiting_human / awaiting_review / failed / interrupted), which
    //     covers the single-branch / parked path.
    //   - `task-not-resumable` is logged at info — not silent — so the
    //     deferral is visible in the daemon log if anyone needs to debug.
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const resumeDeps: Parameters<typeof resumeTask>[2] = {
      db: deps.db,
      appHome: Paths.root,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      // RFC-108 T4 (Codex impl gate P2): a parked-clarify answer resumes the
      // task; thread the per-node timeout floor (+commit&push/concurrency) so
      // the continued nodes are not unbounded.
      ...resolveLaunchRuntimeConfig(deps.configPath),
    }
    void resumeTask(deps.db, result.session.taskId, resumeDeps).catch((err) => {
      if (err instanceof ConflictError && err.code === 'task-not-resumable') {
        log.info('clarify resume deferred — live dispatch loop picks up the pending rerun', {
          taskId: result.session.taskId,
          rerunNodeRunId: result.rerunNodeRunId,
        })
        return
      }
      log.warn('clarify resume threw', {
        taskId: result.session.taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return c.json({ ok: true, ...result })
  })

  // RFC-099 (D8/D14) — collaborative answer draft, one question per call,
  // per-question last-write-wins. Members only; the editor's identity + role
  // are recorded per question and broadcast to other open forms via the
  // task channel ('clarify.draft.updated').
  app.put('/api/clarify/:nodeRunId/draft', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = ClarifyDraftSaveBodySchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('clarify-draft-invalid', 'invalid clarify draft body', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const role = await ensureClarifyMember(deps, nodeRunId, actor)
    const result = await saveClarifyDraft({
      db: deps.db,
      intermediaryNodeRunId: nodeRunId,
      roundId: parsed.data.roundId,
      questionId: parsed.data.questionId,
      value: {
        selectedOptionIndices: parsed.data.selectedOptionIndices,
        customText: parsed.data.customText,
      },
      editor: { userId: actor.user.id, displayName: actor.user.displayName, role },
    })
    return c.json({ ok: true, ...result })
  })
}
