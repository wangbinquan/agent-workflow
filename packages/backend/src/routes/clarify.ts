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
import { desc, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import { clarifyRounds, nodeRuns, tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { sealRoundQuestions } from '@/services/clarifySeal'
import { submitClarifyDecision } from '@/modules/collaboration/public/commands'
import { createClarifyDecisionCommandContext } from '@/services/clarifyDecisionComposition'
import {
  countAwaitingClarifyRounds,
  getClarifyRoundDetail,
  listClarifyRoundSummaries,
  saveClarifyDraft,
} from '@/services/clarifyRounds'
import { canViewTask, requireTaskMember } from '@/services/taskCollab'
import { visibleTaskIdsOf } from '@/services/taskAuthorization'
import { NotFoundError, ValidationError } from '@/util/errors'

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

/** RFC-099 (D5) — read gate: clarify inherits task visibility. RFC-285 B1: non-viewers get a 404 shaped like a missing session. */
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
    // RFC-285 B1：不可见 ≡ 不存在。不能用 task-not-found——那等于确认「这个
    // session 存在且绑着某个任务」。同形基准是**detail 端点对真缺失产出的
    // 形态**（byte-oracle 实测）：clarify-round-not-found + 带 id 文案——本门
    // 放行缺失行（return）后端点自己就抛这个；不可见分支逐字节镜像之。
    throw new NotFoundError(
      'clarify-round-not-found',
      `no clarify_round for intermediary node_run ${intermediaryNodeRunId}`,
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
  // RFC-311: one indexed membership query instead of one collaborator lookup
  // per task (this ran on the 15s badge poll — audit L1-10).
  const visible = await visibleTaskIdsOf(deps.db, actor, taskIds)
  return rows.filter((r) => visible.has(r.taskId))
}

export function mountClarifyRoutes(app: Hono, deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/clarify',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List clarify gates the caller can act on',
    },
    async (c) => {
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
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/clarify/pending-count',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Count of pending clarify gates',
    },
    async (c) => {
      // RFC-099: badge counts only rounds on tasks visible to the actor.
      // RFC-202 T6: terminal tasks' rounds stay out of the count.
      // RFC-311: one indexed count(*) — the previous shape materialized every
      // clarify_rounds row (questions/answers JSON included) plus two full
      // tasks-table scans in its helpers, on a 15s × per-tab poll.
      return c.json({ count: await countAwaitingClarifyRounds(deps.db, actorOf(c)) })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/clarify/:nodeRunId',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Get one clarify gate',
    },
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      await ensureClarifyVisible(deps, nodeRunId, actorOf(c))
      // RFC-058 T14: single ClarifyRound shape; `kind` discriminator
      // distinguishes self vs cross. The keying by intermediary node_run id
      // works for both because dual-write already mints the matching
      // clarify_rounds row at session creation time.
      const detail = await getClarifyRoundDetail(deps.db, nodeRunId)
      return c.json(detail)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/clarify/:nodeRunId/answers',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Submit clarify answers (advances the task)',
    },
    async (c) => {
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
      // RFC-136 — the re-answer declaration is control-channel-only for the same reason:
      // the quick channel is seal-exactly-once (its seal→dispatch must never overwrite).
      if (parsed.data.resubmitQuestionIds !== undefined && parsed.data.defer !== true) {
        throw new ValidationError(
          'clarify-resubmit-requires-defer',
          'resubmitQuestionIds is only honored with defer=true (the centralized answer pane); the quick channel cannot re-answer',
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
          // RFC-128 (用户 2026-07-01) — AUTO-STAGE: the centralized-answer control channel seals a
          // question straight into 待下发 (staged) so the board's "批量下发全下" (dispatchTaskQuestions
          // = ALL staged) can pick it up, instead of leaving it in 待指派 (pending) needing a manual
          // 移入待下发. Only THIS branch opts in; autoDispatchClarifyRound (P5-D) never passes it.
          autoStage: true,
          // RFC-136 (Codex 实现门 P2 fold) — the control channel may RE-answer a sealed 待指派
          // question, but ONLY the ones the client explicitly DECLARED (the pane showed the
          // committed answer and the user edited it). Forwarding the declaration (instead of a
          // route-level boolean) closes the cross-channel race with a quick submit's
          // seal→dispatch window; the quick channel stays exactly-once (see
          // SealRoundQuestionsArgs.allowResealFor).
          ...(parsed.data.resubmitQuestionIds !== undefined
            ? { allowResealFor: parsed.data.resubmitQuestionIds }
            : {}),
          // RFC-128 P2 (Codex P2-2): thread the round directive so the control channel matches
          // quick-path stop semantics (no designer entries + directive persisted; 'continue'
          // also satisfies the §18 designer park). Schema defaults it to 'continue'.
          directive: parsed.data.directive,
          // RFC-162: per-question scope removed.
          // RFC-099: audit-only setter id — NEVER enters an agent prompt.
          sealedBy: actor.user.id,
        })
        // NB: no resumeTask — the whole point of defer is to NOT advance execution; the
        // user dispatches later from the board. A full seal's node + collaboration frames
        // are projected from the same-transaction RFC-341 committed-event group.
        return c.json({ ok: true, kind: 'seal' as const, ...sealResult })
      }

      // RFC-132 PR-B (universal deferred model, §6) — EVERY quick-channel answer (defer=false) seals
      // the round + AUTO-triggers the SAME per-question dispatch the board's 批量下发 uses
      // (autoDispatchClarifyRound). `defer` only chooses AUTO (here) vs MANUAL (the centralized-answer
      // pane, defer=true) triggering of the ONE dispatch path — never a second delivery path. The legacy
      // immediate-mint branches (submitClarifyAnswers / submitCrossClarifyAnswers / triggerDesignerRerun)
      // are no longer reached from the route (§4). Kind-agnostic: autoDispatchClarifyRound reads
      // round.kind internally + dispatches the round's self/questioner AND designer entries (designer
      // aggregates its siblings; multi-source not-ready parks 等齐 until the last sibling answers).
      {
        const commandContext = createClarifyDecisionCommandContext({
          db: deps.db,
          actor,
          role,
        })
        const auto = await submitClarifyDecision(commandContext, {
          nodeRunId,
          answers: parsed.data.answers,
          directive: parsed.data.directive,
          // RFC-023 optimistic lock — same If-Match the immediate path honors (/clarify page sends it).
          ...(ifMatch !== undefined ? { ifMatchIteration: ifMatch } : {}),
          ...(c.req.header('Idempotency-Key') === undefined
            ? {}
            : { idempotencyKey: c.req.header('Idempotency-Key')! }),
        })
        return c.json({
          ok: true,
          kind: 'autodispatch' as const,
          taskId: auto.taskId,
          receipt: auto.receipt,
          roundKind: auto.roundKind,
          sealedQuestionIds: auto.sealedQuestionIds,
          roundFullySealed: auto.roundFullySealed,
          reruns: auto.reruns,
          dispatchedEntryIds: auto.dispatchedEntryIds,
          deferred: auto.deferred,
          // Codex round-5: set when the answer WAS sealed but auto-dispatch was deferred to the board
          // (a post-seal dispatch conflict, e.g. a same-home in-flight rerun). The answer is saved +
          // parked; the user dispatches it from the board. The request still succeeds (not a failure).
          ...(auto.dispatchDeferredReason !== undefined
            ? { dispatchDeferredReason: auto.dispatchDeferredReason }
            : {}),
        })
      }
    },
  )

  // RFC-099 (D8/D14) — collaborative answer draft, one question per call,
  // per-question last-write-wins. Members only; the editor's identity + role
  // are recorded per question and broadcast to other open forms via the
  // task channel ('clarify.draft.updated').
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/clarify/:nodeRunId/draft',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Save a collaborative clarify draft',
    },
    async (c) => {
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
    },
  )
}
