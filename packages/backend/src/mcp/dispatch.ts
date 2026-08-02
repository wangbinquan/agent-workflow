// RFC-247 §4 — how an MCP tool reaches business logic.
//
// It dispatches into the SAME Hono route table the REST API serves, with the
// caller's already-resolved actor injected. Nothing here reimplements a gate, a
// payload schema, or a row-level ACL check.
//
// The alternative — tools calling `services/*` directly — was rejected. It
// would mean every authorization rule that lives in a route handler (workflow
// launchability, ACL ownership, delete-confirmation, revision fences) has a
// second implementation reachable by a second door, and the two would be
// correct only for as long as someone kept checking. The single-source-of-truth
// argument that produced `RouteMeta` in the first place applies with more force
// here, not less: this door is opened by a model.
//
// ## Why the actor arrives out-of-band
//
// `multiAuth` is deliberately NOT mounted on the dispatch app. Authentication
// already happened at `POST /api/mcp`; re-deriving it from a header here would
// mean re-parsing the credential once per tool call and, worse, would make the
// dispatch app's behaviour depend on a header an inner layer could influence.
// The actor is passed as a value through AsyncLocalStorage instead — a value
// cannot be forged by a request, only by code, and the only code that sets it
// is `dispatch` below.

import { AsyncLocalStorage } from 'node:async_hooks'
import { Hono, type MiddlewareHandler } from 'hono'
import type { Actor } from '@/auth/actor'
import { type AppDeps, mountApiRoutes } from '@/server'
import { errorHandler } from '@/util/errors'

/** The actor a dispatch is running as; empty outside `dispatch`. */
const actorStore = new AsyncLocalStorage<Actor>()

export interface DispatchRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path only, e.g. `/api/tasks/01J...`. Query goes in `query`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  /** Serialized as JSON. Omit for GET/DELETE-without-body. */
  readonly body?: unknown
}

export interface DispatchResult {
  readonly status: number
  /** Parsed JSON body, or `null` for 204 / empty responses. */
  readonly body: unknown
}

export type Dispatcher = (req: DispatchRequest, actor: Actor) => Promise<DispatchResult>

/**
 * Build the dispatcher once per daemon. Mounting ~250 routes is not something
 * to redo per tool call, and Hono compiles its router on first request.
 */
export function createDispatcher(deps: AppDeps): Dispatcher {
  const app = new Hono()
  const injectActor: MiddlewareHandler = async (c, next) => {
    const actor = actorStore.getStore()
    // Unreachable through `dispatch`, which always establishes the store. A
    // throw here beats proceeding actor-less, which `routeMetaGate` would read
    // as "public route" for any route declaring no points.
    if (actor === undefined) throw new Error('mcp dispatch: no actor in scope')
    c.set('actor', actor)
    await next()
  }
  app.use('*', injectActor)
  mountApiRoutes(app, deps)
  // Same translation from DomainError to `{code, message}` the REST channel
  // uses, so a tool reports the code a REST caller would have seen.
  app.onError(errorHandler)
  app.notFound((c) =>
    c.json({ ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` }, 404),
  )

  return async (req, actor) => {
    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) search.set(k, v)
    const qs = search.toString()
    const url = `http://mcp.internal${req.path}${qs === '' ? '' : `?${qs}`}`

    const init: RequestInit = { method: req.method }
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body)
      init.headers = { 'content-type': 'application/json' }
    }

    const res = await actorStore.run(actor, () => app.request(url, init))
    if (res.status === 204) return { status: res.status, body: null }
    const text = await res.text()
    if (text === '') return { status: res.status, body: null }
    try {
      return { status: res.status, body: JSON.parse(text) as unknown }
    } catch {
      // A non-JSON body from an /api/* route would be a bug, but reporting the
      // text beats throwing away the only evidence of what happened.
      return { status: res.status, body: text }
    }
  }
}

/**
 * The actor an MCP tool call runs as.
 *
 * RFC-247 D2 — `purpose` is cleared. The purpose gate answers "which door may
 * this credential open", and by the time a tool runs the door is already
 * chosen: the request arrived at `POST /api/mcp`, which admits `mcp_only`
 * tokens on purpose. Leaving `mcp_only` set would make every tool 403 with
 * `token-mcp-only` — the gate refusing the exact traffic it was written to
 * allow.
 *
 * What is NOT cleared, and must never be: `permissions`. The matrix is the
 * token's authority and it is identical on both channels.
 */
export function mcpDispatchActor(actor: Actor): Actor {
  return { ...actor, purpose: undefined }
}
