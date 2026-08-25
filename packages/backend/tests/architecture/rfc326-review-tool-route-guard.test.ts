// RFC-326 — the review gate's REST routes and its MCP tools are the SAME surface
// (proposal AC-23 reverse / AC-31 / AC-34; design §8).
//
// WHY THIS GUARD EXISTS: RFC-247 plan T18 claimed a "complete human-gate tool
// surface" and ticked it, while the tool table dispatched to three of the ten
// review routes and nobody could add a comment over MCP. A claim about a
// surface is only as good as the guard that pins it, so this file derives BOTH
// sides from the code — the routes from the registry `mountReviewRoutes` fills,
// the tool paths from what each tool actually dispatches — and pins them equal
// in both directions. Deliberate exceptions are listed in `EXEMPT_REVIEW_ROUTES`
// (a ledger: baseline in architecture/ledger-baselines.json, high-water only).
//
// Mutation evidence (design §13 ④): delete one review tool → the route it
// dispatched to shows up in `uncovered` → red.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { ALL_TOOLS, type McpToolContext } from '@/mcp/tools'
import { allRouteMeta, resetRouteMetaRegistry } from '@/routes/registry'
import { mountReviewRoutes } from '@/routes/reviews'
import type { AppDeps } from '@/server'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/**
 * Review routes that deliberately have NO MCP tool. Every entry is a decision,
 * not an oversight: the guard fails when one of these grows a tool (stale
 * exemption) as well as when a route outside this list has none.
 */
const EXEMPT_REVIEW_ROUTES: ReadonlyArray<string> = [
  // A badge counter for the web inbox; list_pending_gates / list_reviews carry
  // the rows themselves, and a model has no use for the number alone.
  'GET /api/reviews/pending-count',
]

const REVIEW_PREFIX = '/api/reviews'

/** `GET /api/reviews/:nodeRunId/versions/:versionId` → `GET /api/reviews/:id/versions/:id`. */
function canonicalTemplate(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/:[A-Za-z_]+/g, ':id')}`
}

/** Placeholder ids the recording dispatch turns back into `:id`. */
const PLACEHOLDERS: Record<string, string> = {
  nodeRunId: 'PH_NODE',
  docVersionId: 'PH_DOC',
  commentId: 'PH_COMMENT',
  id: 'PH_ID',
  taskId: 'PH_TASK',
  workflowId: 'PH_WORKFLOW',
}

function canonicalDispatch(method: string, path: string): string {
  let out = path
  for (const value of Object.values(PLACEHOLDERS)) out = out.split(value).join(':id')
  return `${method.toUpperCase()} ${out}`
}

/**
 * Every `/api/reviews*` path a tool dispatches to, derived by CALLING each
 * handler against a recording dispatcher (the same `ctx.dispatch` seam the
 * real server hands the tool). Tools that refuse the placeholder arguments
 * before dispatching (the converged resource tools) contribute nothing.
 */
async function reviewPathsDispatchedByTools(): Promise<Map<string, string[]>> {
  const byTool = new Map<string, string[]>()
  const args: Record<string, unknown> = {
    ...PLACEHOLDERS,
    kind: 'workflows',
    method: 'get',
    commentText: 'placeholder',
    selection: 'accepted',
    decision: 'approved',
    reviewIteration: 0,
    confirm: 'placeholder',
    body: {},
  }
  // Pre-aborted: a long-running tool (watch_task polls until a state change)
  // must give up immediately instead of holding the guard. The race below is
  // the belt to that suspender — a review tool dispatches on its first tick.
  const aborted = new AbortController()
  aborted.abort()
  for (const tool of ALL_TOOLS) {
    const calls: string[] = []
    const ctx: McpToolContext = {
      actor: {} as McpToolContext['actor'],
      dispatch: async (req) => {
        if (req.path.startsWith(REVIEW_PREFIX)) calls.push(canonicalDispatch(req.method, req.path))
        return { status: 200, body: {} }
      },
      progress: async () => {},
      signal: aborted.signal,
    }
    try {
      await Promise.race([
        tool.handler(args, ctx),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ])
    } catch {
      // A tool that rejects the placeholder arguments cannot reach a review route.
    }
    if (calls.length > 0) byTool.set(tool.name, calls)
  }
  return byTool
}

/** Pure comparison — shared by the guard and its negative fixture. */
export function reviewSurfaceDrift(
  routes: ReadonlyArray<string>,
  toolPaths: ReadonlyArray<string>,
  exempt: ReadonlyArray<string>,
): { uncovered: string[]; staleExemptions: string[]; unroutedTools: string[] } {
  const routeSet = new Set(routes)
  const toolSet = new Set(toolPaths)
  const exemptSet = new Set(exempt)
  return {
    uncovered: routes.filter((r) => !toolSet.has(r) && !exemptSet.has(r)).sort(),
    staleExemptions: exempt.filter((r) => toolSet.has(r) || !routeSet.has(r)).sort(),
    unroutedTools: toolPaths.filter((p) => !routeSet.has(p)).sort(),
  }
}

function mountedReviewRoutes(): string[] {
  resetRouteMetaRegistry()
  // Handlers are never invoked: the registry only needs the declarations.
  mountReviewRoutes(new Hono(), { db: {} as AppDeps['db'], configPath: '' } as AppDeps)
  const routes = allRouteMeta()
    .filter((meta) => meta.path.startsWith(REVIEW_PREFIX))
    .map((meta) => canonicalTemplate(meta.method, meta.path))
  resetRouteMetaRegistry()
  return [...new Set(routes)].sort()
}

describe('RFC-326 AC-31 — /api/reviews* routes ⟷ MCP gate tools, both directions', () => {
  test('corpus: the review route table and the tool table are both non-trivial', async () => {
    const routes = mountedReviewRoutes()
    const byTool = await reviewPathsDispatchedByTools()
    expect(routes.length).toBeGreaterThanOrEqual(11)
    expect(byTool.size).toBeGreaterThanOrEqual(10)
  })

  test('every review route has a tool (or a named exemption), every exemption is live, every tool path is a route', async () => {
    const routes = mountedReviewRoutes()
    const byTool = await reviewPathsDispatchedByTools()
    const toolPaths = [...new Set([...byTool.values()].flat())]
    const drift = reviewSurfaceDrift(routes, toolPaths, EXEMPT_REVIEW_ROUTES)
    expect(
      drift,
      'a review route without a tool means the MCP surface is a strict subset again (RFC-247 T18 all over); ' +
        'a stale exemption means a tool exists for a route this file says has none; an unrouted tool path ' +
        'means a tool dispatches to a route that does not exist',
    ).toEqual({ uncovered: [], staleExemptions: [], unroutedTools: [] })
  })

  test('each review tool reaches exactly the routes design §8 assigns it', async () => {
    const byTool = await reviewPathsDispatchedByTools()
    const expected: Record<string, string[]> = {
      list_pending_gates: ['GET /api/reviews'],
      list_reviews: ['GET /api/reviews'],
      get_review: ['GET /api/reviews/:id'],
      get_review_document: ['GET /api/reviews/:id/versions/:id'],
      list_review_history: ['GET /api/reviews/:id/versions', 'GET /api/reviews/:id/rounds'],
      add_review_comment: ['POST /api/reviews/:id/comments'],
      update_review_comment: ['PATCH /api/reviews/:id/comments/:id'],
      delete_review_comment: ['DELETE /api/reviews/:id/comments/:id'],
      set_review_document_selection: ['PATCH /api/reviews/:id/documents/:id/selection'],
      submit_review: ['POST /api/reviews/:id/decision'],
    }
    const actual: Record<string, string[]> = {}
    for (const [name, paths] of byTool) actual[name] = [...paths].sort()
    for (const paths of Object.values(expected)) paths.sort()
    expect(actual).toEqual(expected)
  })

  test('negative fixture: the comparison flags a route without a tool, a stale exemption and an unrouted tool', () => {
    const drift = reviewSurfaceDrift(
      ['GET /api/reviews', 'GET /api/reviews/:id', 'GET /api/reviews/pending-count'],
      ['GET /api/reviews', 'GET /api/reviews/pending-count', 'POST /api/reviews/:id/ghost'],
      ['GET /api/reviews/pending-count', 'GET /api/reviews/gone'],
    )
    expect(drift.uncovered).toEqual(['GET /api/reviews/:id'])
    expect(drift.staleExemptions).toEqual(['GET /api/reviews/gone', 'GET /api/reviews/pending-count'])
    expect(drift.unroutedTools).toEqual(['POST /api/reviews/:id/ghost'])
  })
})

describe('RFC-326 AC-34 — the RFC-247 plan no longer claims a complete gate surface it never had', () => {
  test('RFC-247 plan T18 carries the RFC-326 correction', () => {
    const plan = readFileSync(resolve(REPO_ROOT, 'design', 'RFC-247-mcp-remote-access', 'plan.md'), 'utf8')
    const t18 = plan.slice(plan.indexOf('RFC-247-T18'), plan.indexOf('RFC-247-T19'))
    expect(t18.length).toBeGreaterThan(40)
    expect(t18).toContain('RFC-326')
  })
})
