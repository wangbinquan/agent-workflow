// RFC-588 — the task workspace-insight endpoints: structural diff, AI change narrative (read and trigger), file content,
// file symbols, code intelligence and call targets. Moved verbatim from the task routes (formerly `routes/tasks.ts`, now
// task-execution's `inbound/http/taskRoutes.ts`) because they are workspace-insight's capabilities and the task routes may
// not take this module (the DAG has workspace-insight -> task-execution only).
//
// Mount order is load-bearing: the task routes register the RFC-036 visibility middleware for `/api/tasks/:id/*`, and Hono
// chains handlers in registration order, so the assembly root mounts this binding right AFTER `mountTaskRoutes` (the same
// `tasks` step in `server.ts`). Every endpoint here assumes the task is already visible to the actor.

import type { Hono } from 'hono'
import { structuralScopeSchema, type Config } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { NotFoundError, ValidationError } from '@/platform/errors/domainErrors'
import { safeJsonOrEmpty } from '@/platform/http/requestParsing'
import type { TaskRouteOperations } from '@/modules/task-execution/public/commands'
import type {
  CodeIntelQuery,
  FileSymbolsQuery,
  TaskFileContentQuery,
  TaskWorkspaceInsight,
} from '../../application/ports/taskWorkspaceInsight'
import type { ResolvedDeepConfig } from '../../domain/deep/deepIndexing'

type TaskWorkspaceInsightSettings = Pick<
  Config,
  'structuralDeepIndexers' | 'structuralDeepTimeoutMs' | 'changeNarrativeRuntime' | 'defaultRuntime'
>

/**
 * The settings these endpoints read from the daemon configuration (the configuration query satisfies it; the assembly
 * root passes that object unchanged).
 */
export interface TaskWorkspaceInsightConfiguration {
  read(): TaskWorkspaceInsightSettings | Promise<TaskWorkspaceInsightSettings>
}

/** RFC-083: resolve deep-mode indexer path overrides + timeout from settings.
 *  Unreadable config → PATH lookup + default timeout. */
async function resolveStructuralDeepConfig(
  configuration: TaskWorkspaceInsightConfiguration,
): Promise<ResolvedDeepConfig> {
  try {
    const cfg = await configuration.read()
    return {
      overrides: cfg.structuralDeepIndexers,
      timeoutMs: cfg.structuralDeepTimeoutMs ?? 120_000,
    }
  } catch {
    return { timeoutMs: 120_000 }
  }
}

export interface TaskWorkspaceInsightRouteDependencies {
  readonly configuration: TaskWorkspaceInsightConfiguration
  /** RFC-453: the structural diff, change narrative, file content / symbols, code intel and call targets. */
  readonly workspaceInsight: TaskWorkspaceInsight
  /** RFC-239 — the change narrative's member gate (owner / collaborator / admin), run right before the trigger. */
  readonly changeNarrativeAccess: {
    requireMember(actor: Actor, taskId: string): Promise<void>
  }
  /** The two task operations the change narrative trigger uses (operator gate and the task read). */
  readonly operations: Pick<TaskRouteOperations, 'requireOperator' | 'get'>
}

export function mountTaskWorkspaceInsightRoutes(
  app: Hono,
  deps: TaskWorkspaceInsightRouteDependencies,
): void {
  if (deps.workspaceInsight === undefined) {
    throw new Error('task-workspace-insight-not-composed')
  }
  if (deps.changeNarrativeAccess === undefined) {
    throw new Error('task-change-narrative-not-composed')
  }
  const { operations, workspaceInsight, changeNarrativeAccess } = deps
  // RFC-083 — structural (semantic) diff overlay for the textual diff above.
  // `?scope=task|node` (+ `nodeRunId` for node scope); 'wrapper' → 422.
  // `?mode=deep` tries an external SCIP indexer for precise cross-file impact,
  // auto-falling back to the heuristic baseline when none is available.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/structural-diff',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Structural diff',
    },
    async (c) => {
      const scope = structuralScopeSchema.catch('task').parse(c.req.query('scope'))
      const nodeRunId = c.req.query('nodeRunId')
      const mode = c.req.query('mode') === 'deep' ? 'deep' : 'baseline'
      return c.json(
        await workspaceInsight.structuralDiff(c.req.param('id'), scope, nodeRunId, {
          mode,
          deepCfg:
            mode === 'deep' ? await resolveStructuralDeepConfig(deps.configuration) : undefined,
        }),
      )
    },
  )

  // RFC-239 §3.2 — AI change narrative. GET follows the task-visibility
  // middleware (read = can see the task); POST additionally requires the
  // member gate (owner / collaborator / admin) inside the service. 404 body
  // means "not generated yet" — the frontend's button state.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/change-narrative',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Read the change narrative',
    },
    async (c) => {
      const scope = c.req.query('scope') ?? 'task'
      if (scope !== 'task') {
        throw new ValidationError('narrative-scope-invalid', `only scope=task is supported`)
      }
      const status = await workspaceInsight.changeNarrativeStatus(c.req.param('id'))
      if (status === null) {
        throw new NotFoundError('narrative-not-found', 'no narrative generated for this task yet')
      }
      return c.json(status)
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/change-narrative',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Generate the change narrative (model call)',
    },
    async (c) => {
      // RFC-324 —— 观察者看得见任务，但推动任务是成员的事。
      await operations.requireOperator(actorOf(c), c.req.param('id'))
      const body = (await safeJsonOrEmpty(c.req.raw)) as { scope?: string } | null
      const scope = body?.scope ?? 'task'
      if (scope !== 'task') {
        throw new ValidationError('narrative-scope-invalid', `only scope=task is supported`)
      }
      const id = c.req.param('id')
      const task = await operations.get(id)
      if (task === null) {
        throw new NotFoundError('task-not-found', `task '${id}' not found`)
      }
      const narrativeCfg = await deps.configuration.read()
      await changeNarrativeAccess.requireMember(actorOf(c), task.id)
      const state = await workspaceInsight.triggerChangeNarrative(task, {
        runtimeName: narrativeCfg.changeNarrativeRuntime ?? null,
        defaultRuntime: narrativeCfg.defaultRuntime ?? null,
      })
      return c.json(state, 202)
    },
  )

  // RFC-239 §3.5 — full-text file content (base|worktree side) for the
  // markdown rendered-diff view. Both sides answer a missing file with
  // 200 {exists:false}; a renamed file's base side is read via `basePath`
  // (the caller passes the structural diff's renamedFrom). Behind the same
  // /api/tasks/:id visibility middleware as every other task read.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/file-content',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Read a file from the diff',
    },
    async (c) => {
      const side = c.req.query('side')
      if (side !== 'base' && side !== 'worktree') {
        throw new ValidationError(
          'file-content-side-invalid',
          `side query param must be 'base' or 'worktree'`,
        )
      }
      const q: TaskFileContentQuery = {
        path: c.req.query('path') ?? '',
        side,
      }
      const basePath = c.req.query('basePath')
      if (basePath !== undefined && basePath !== '') q.basePath = basePath
      const repo = c.req.query('repo')
      if (repo !== undefined && repo !== '') q.repo = repo
      return c.json(await workspaceInsight.fileContent(c.req.param('id'), q))
    },
  )

  // RFC-258 §2.1 — one file's symbol table (full-file anchor bar, baseline
  // engine lookup, graph→source resolution). Multi-repo selects by the wire
  // repo key ('.' = root, F-04); completeness is an honest 200 state (F-09).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/file-symbols',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'File symbol table',
    },
    async (c) => {
      const side = c.req.query('side') === 'base' ? 'base' : 'worktree'
      const q: FileSymbolsQuery = {
        path: c.req.query('path') ?? '',
        side,
      }
      const repo = c.req.query('repo')
      if (repo !== undefined && repo !== '') q.repo = repo
      return c.json(await workspaceInsight.fileSymbols(c.req.param('id'), q))
    },
  )

  // RFC-258 §2.2 — identifier click resolution (definitions + references).
  // deep degrades per file to baseline with an honest reason (F-07); the base
  // side always resolves baseline (F-05).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/code-intel',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Resolve an identifier',
    },
    async (c) => {
      const q: CodeIntelQuery = {
        path: c.req.query('path') ?? '',
        side: c.req.query('side') === 'base' ? 'base' : 'worktree',
        line: Number(c.req.query('line') ?? 0),
        col: Number(c.req.query('col') ?? 0),
        name: c.req.query('name') ?? '',
        mode: c.req.query('mode') === 'deep' ? 'deep' : 'baseline',
      }
      const repo = c.req.query('repo')
      if (repo !== undefined && repo !== '') q.repo = repo
      return c.json(await workspaceInsight.codeIntel(c.req.param('id'), q))
    },
  )

  // RFC-085 — lazy call-chain expansion: direct callees of one method (method+
  // constructor calls), source-ordered, best-effort resolved/external/unresolved.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/call-targets',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Call-node targets',
    },
    async (c) => {
      const methodRef = c.req.query('methodRef')
      if (methodRef === undefined || methodRef === '') {
        // RFC-203 T6: uniform error body (was a bare `{error: string}` the
        // shared decoder could not parse) + a call-target-specific code.
        throw new ValidationError(
          'call-target-method-required',
          'methodRef query param required for /call-targets',
        )
      }
      const targets = await workspaceInsight.callTargets(c.req.param('id'), methodRef)
      return c.json({ targets })
    },
  )
}
