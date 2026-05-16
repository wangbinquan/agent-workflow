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
import type { Hono } from 'hono'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import {
  countPendingClarifications,
  getClarifyDetail,
  listClarifySummaries,
  submitClarifyAnswers,
} from '@/services/clarify'
import { resumeTask } from '@/services/task'
import { Paths } from '@/util/paths'
import { ValidationError } from '@/util/errors'

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
    const filter: {
      status?: typeof q.data.status
      taskId?: string
      limit?: number
    } = {}
    if (q.data.status !== undefined) filter.status = q.data.status
    if (q.data.taskId !== undefined) filter.taskId = q.data.taskId
    if (q.data.limit !== undefined) filter.limit = q.data.limit
    const out = await listClarifySummaries(deps.db, filter)
    return c.json(out)
  })

  app.get('/api/clarify/pending-count', async (c) => {
    const count = await countPendingClarifications(deps.db)
    return c.json({ count })
  })

  app.get('/api/clarify/:nodeRunId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const detail = await getClarifyDetail(deps.db, nodeRunId)
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
    const result = await submitClarifyAnswers({
      db: deps.db,
      clarifyNodeRunId: nodeRunId,
      answers: parsed.data.answers,
      ...(ifMatch !== undefined ? { ifMatchIteration: ifMatch } : {}),
    })
    // Re-enter the scheduler so the freshly minted rerun node_run starts.
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const resumeDeps: Parameters<typeof resumeTask>[2] = {
      db: deps.db,
      appHome: Paths.root,
      ...(opencodeCmd ? { opencodeCmd } : {}),
    }
    void resumeTask(deps.db, result.session.taskId, resumeDeps).catch(() => {
      /* errors land in task.errorMessage via failTask */
    })
    return c.json({ ok: true, ...result })
  })
}
