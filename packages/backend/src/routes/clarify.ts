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

import { ListClarifyQuerySchema, SubmitClarifyAnswersSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import { loadConfig } from '@/config'
import { clarifySessions, crossClarifySessions, nodeRuns, tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import { countPendingClarifications, submitClarifyAnswers } from '@/services/clarify'
import { submitCrossClarifyAnswers } from '@/services/crossClarify'
import { getClarifyRoundDetail, listClarifyRoundSummaries } from '@/services/clarifyRounds'
import { isAssignedClarifyTarget } from '@/services/taskCollab'
import { resumeTask } from '@/services/task'
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

async function ensureClarifyAnswerAuth(
  deps: AppDeps,
  clarifyNodeRunId: string,
  actor: Actor,
): Promise<void> {
  if (actor.permissions.has('tasks:read:all')) return
  // RFC-023: lookup self-clarify session first.
  const sess = await deps.db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    .limit(1)
  if (sess[0]) {
    const taskRow = (
      await deps.db.select().from(tasksTable).where(eq(tasksTable.id, sess[0].taskId)).limit(1)
    )[0]
    if (!taskRow) {
      throw new NotFoundError('task-not-found', `task '${sess[0].taskId}' not found`)
    }
    if (taskRow.ownerUserId === actor.user.id) return
    if (
      await isAssignedClarifyTarget(deps.db, sess[0].taskId, sess[0].clarifyNodeId, actor.user.id)
    ) {
      return
    }
    throw new ForbiddenError(
      'not-clarify-target',
      'only the assigned clarify target, task owner, or admin can submit this answer',
    )
  }
  // RFC-056: cross-clarify session auth fallback. Same shape as RFC-023 —
  // owner / assigned clarify_target / admin only.
  const xc = await deps.db
    .select()
    .from(crossClarifySessions)
    .where(eq(crossClarifySessions.crossClarifyNodeRunId, clarifyNodeRunId))
    .limit(1)
  if (xc[0]) {
    const taskRow = (
      await deps.db.select().from(tasksTable).where(eq(tasksTable.id, xc[0].taskId)).limit(1)
    )[0]
    if (!taskRow) {
      throw new NotFoundError('task-not-found', `task '${xc[0].taskId}' not found`)
    }
    if (taskRow.ownerUserId === actor.user.id) return
    if (
      await isAssignedClarifyTarget(deps.db, xc[0].taskId, xc[0].crossClarifyNodeId, actor.user.id)
    ) {
      return
    }
    throw new ForbiddenError(
      'not-clarify-target',
      'only the assigned clarify target, task owner, or admin can submit this answer',
    )
  }
  // Neither — let the service path produce the 404.
  const runs = await deps.db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.id, clarifyNodeRunId))
    .limit(1)
  if (!runs[0]) {
    throw new NotFoundError('clarify-session-not-found', 'clarify session not found')
  }
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
    return c.json(summaries)
  })

  app.get('/api/clarify/pending-count', async (c) => {
    const count = await countPendingClarifications(deps.db)
    return c.json({ count })
  })

  app.get('/api/clarify/:nodeRunId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
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
    // RFC-036: clarify_target / task owner / admin only.
    const actor = actorOf(c)
    await ensureClarifyAnswerAuth(deps, nodeRunId, actor)

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
    if (nodeKind === 'clarify-cross-agent') {
      const ccResult = await submitCrossClarifyAnswers({
        db: deps.db,
        crossClarifyNodeRunId: nodeRunId,
        answers: parsed.data.answers,
        directive: parsed.data.directive,
        answeredBy: actor.user.id,
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
      ...(ifMatch !== undefined ? { ifMatchIteration: ifMatch } : {}),
    })
    // Re-enter the scheduler so the freshly minted rerun node_run starts.
    //
    // RFC-023 bug 13: when the task is still `running` / `pending` at submit
    // time (typical when there are multiple parallel branches and the user
    // answers one clarify while another branch keeps the scheduler busy),
    // `resumeTask` throws `task-not-resumable`. That used to be swallowed
    // silently and the freshly minted rerun row sat orphaned. Now:
    //   - The scheduler's per-batch rescan (services/scheduler.ts
    //     `rescanScopeForNewPendingRows`) will pick up the new pending row
    //     on its next iteration. So this resume is best-effort.
    //   - We still TRY to resume in case the task is already paused
    //     (awaiting_human / awaiting_review / failed / interrupted), which
    //     covers the single-branch happy path.
    //   - `task-not-resumable` is now logged at info — not silent — so the
    //     deferral is visible in the daemon log if anyone needs to debug.
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const resumeDeps: Parameters<typeof resumeTask>[2] = {
      db: deps.db,
      appHome: Paths.root,
      ...(opencodeCmd ? { opencodeCmd } : {}),
    }
    void resumeTask(deps.db, result.session.taskId, resumeDeps).catch((err) => {
      if (err instanceof ConflictError && err.code === 'task-not-resumable') {
        log.info('clarify resume deferred — scheduler will rescan mid-batch', {
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
}
