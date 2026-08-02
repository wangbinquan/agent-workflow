// RFC-247 T1 — the route metadata registry.
//
// WHY THIS EXISTS
//
// Before RFC-247, "which permission does this endpoint need" was spread across
// three unrelated places: middleware mounted by path prefix in `server.ts`,
// `requirePermission(...)` calls inside individual route files, and ad-hoc ACL
// checks inside handlers. Nothing could answer the question for an arbitrary
// route, which had two consequences:
//
//   1. Whole domains shipped with NO coarse gate at all (workgroups, reviews,
//      clarify, and the PUT/DELETE half of scheduled-tasks) — a narrowed token
//      could not be narrowed away from them because there was no point to
//      strip. Recorded at docs/audit-backlog.md:60.
//   2. An accurate, non-drifting API document was impossible to produce, and
//      "the security doc is subtly wrong" is the worst kind of wrong.
//
// So: every route declares its own metadata, the framework derives the gate
// from that declaration, and a startup self-check refuses to boot when the
// declaration set and the mounted route set disagree — in EITHER direction.
//
// The reverse direction matters as much as the forward one: a permission point
// that no route references still shows up on the account page's token matrix,
// where it tells the user that ticking it grants a capability. That is the
// authorization UI lying to its user, and it is much harder to notice than a
// missing gate. Two such points were found while writing this RFC (`repos:update`
// and `skills:execute`, both produced by "every resource gets four verbs"
// symmetry rather than by any real route) and deliberately never created.

import type { Handler, Hono, MiddlewareHandler } from 'hono'
import type { BlankEnv } from 'hono/types'
import { isResourceAdminRole, ROUTE_BACKED_POINTS, type Permission } from '@agent-workflow/shared'
import { tryActorOf } from '@/auth/actor'
import { ForbiddenError, UnauthorizedError } from '@/util/errors'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Whether a Personal Access Token may reach this route at all.
 *
 * `'never'` is a gate INDEPENDENT of permission points, and it exists because
 * two RFC-247 decisions cannot be expressed as points:
 *
 *   D6 — a token must not be able to mint another token. Everything under
 *        `/api/auth/*` is therefore closed to tokens outright; no combination
 *        of matrix ticks reopens it.
 *   D5 — a token must never change owner / grants / visibility. That invariant
 *        has FOUR distinct URL shapes, not one, and the RFC's first draft only
 *        listed the obvious one:
 *          · `PUT /api/{res}/:id/acl`            (the six ACL'd resources)
 *          · `PUT /api/tasks/:id/members`        (tasks carry their own ACL:
 *            `services/taskCollab.ts` accepts `{ownerUserId, userIds}` and task
 *            membership IS the review/clarify answering boundary — and the
 *            grant survives revoking the token that made it)
 *          · `PUT /api/workgroup-tasks/:taskId/config` (its `addMembers` writes
 *            `task_collaborators` rows, and it kicks the engine besides)
 */
export type TokenAccess = 'allow' | 'never'

export interface RouteMeta<P extends string = string> {
  readonly method: HttpMethod
  /** Hono path template, byte-identical to the string passed at registration. */
  readonly path: P
  /**
   * Points required to pass. The array is an **AND** — every entry must be held.
   *
   * AND (rather than "the one point for this resource") is required by the
   * cross-domain side-effect family: routes whose real effect lands in a
   * different domain than their URL implies. Five are known:
   *
   *   · `POST /api/scheduled-tasks`                        arms a future launch
   *   · `POST /api/workgroup-tasks/:id/dw-save-as-workflow` creates a workflow
   *   · `POST /api/fusions`                                 runs an agent
   *   · `POST /api/fusions/:id/approve`                     rewrites a skill
   *   · `POST /api/memory-distill-jobs/:id/retry`           spawns an LLM run
   *
   * Each is gated on BOTH its surface domain and the domain it actually
   * touches, so a token holding only the former cannot use the latter through
   * the back door.
   *
   * An empty array is legal ONLY together with `publicReason`.
   */
  readonly permissions: ReadonlyArray<Permission>
  /** Required when `permissions` is empty: why this route needs no point. */
  readonly publicReason?: string
  readonly tokenAccess: TokenAccess
  /**
   * RFC-222 identity requirement, when the route needs one IN ADDITION to its
   * points. Kept in the metadata rather than mounted as a separate middleware
   * so the declaration is the FULL authorization contract: the generated API
   * documentation reads from here, and a doc that said "needs memory:update"
   * for a route that also demands resource-admin identity would understate the
   * requirement — which is the failure mode this registry exists to prevent.
   *
   * The identity door and the point door are AND-ed, and both are needed:
   * identity alone would let a scope-stripped token through (the hole RFC-099's
   * route-gate contract warns about); the point alone would let a plain `user`
   * through on points that sit in the user baseline.
   */
  readonly identity?: 'admin' | 'resource-admin'
  /** One-line English summary; feeds the generated API documentation. */
  readonly summary: string
}

const REGISTRY = new Map<string, RouteMeta>()

function key(method: string, path: string): string {
  return `${method} ${path}`
}

export function routeMetaKey(method: string, path: string): string {
  return key(method, path)
}

/** Everything registered so far. The doc generator and the self-check read this. */
export function allRouteMeta(): ReadonlyArray<RouteMeta> {
  return [...REGISTRY.values()]
}

export function lookupRouteMeta(method: string, path: string): RouteMeta | undefined {
  return REGISTRY.get(key(method, path))
}

export class RouteMetaError extends Error {}

/** Two declarations describe the same authorization contract. */
function sameMeta(a: RouteMeta, b: RouteMeta): boolean {
  return (
    a.tokenAccess === b.tokenAccess &&
    a.identity === b.identity &&
    a.publicReason === b.publicReason &&
    a.summary === b.summary &&
    a.permissions.length === b.permissions.length &&
    a.permissions.every((p, i) => p === b.permissions[i])
  )
}

function validate(meta: RouteMeta): void {
  if (meta.permissions.length === 0 && meta.publicReason === undefined) {
    throw new RouteMetaError(
      `${key(meta.method, meta.path)}: permissions is empty — declare publicReason explaining why this route needs no permission point`,
    )
  }
  if (meta.permissions.length > 0 && meta.publicReason !== undefined) {
    throw new RouteMetaError(
      `${key(meta.method, meta.path)}: publicReason is only for routes with no permission point`,
    )
  }
  if (meta.summary.trim() === '') {
    throw new RouteMetaError(
      `${key(meta.method, meta.path)}: summary is required (it is published)`,
    )
  }
}

/**
 * The gate derived from a declaration. Ordering is deliberate and load-bearing:
 *
 *   1. `tokenAccess: 'never'`  — refuse before any permission maths, so a token
 *      can never reach an auth/ACL surface no matter how its matrix is filled.
 *   2. permission points        — every entry of the AND.
 *
 * Both run BEFORE the handler, so the refusal is free of side effects.
 */
export function routeMetaGate(meta: RouteMeta): MiddlewareHandler {
  return async (c, next) => {
    // A route declared with `publicReason` answers BEFORE any identity exists —
    // the login flow and the bootstrap gate are in multiAuth's
    // PUBLIC_PATH_PREFIXES, so no actor is on the context at all. Demanding one
    // here would turn every public route into a 401 and make logging in
    // impossible. Use the optional lookup and let the declaration decide:
    // no points declared ⇒ no identity needed.
    const actor = tryActorOf(c)
    if (actor === null) {
      if (meta.permissions.length === 0) {
        await next()
        return
      }
      throw new UnauthorizedError()
    }
    if (meta.tokenAccess === 'never' && actor.source === 'pat') {
      throw new ForbiddenError(
        'token-forbidden-route',
        'personal access tokens cannot reach this endpoint',
        { route: key(meta.method, meta.path) },
      )
    }
    // RFC-247 D2 — the purpose gate. A token issued for MCP use only must not
    // become a general REST credential just because it authenticates.
    //
    // Ordered AFTER the `never` check on purpose: an `mcp_only` token hitting
    // `/api/auth/me` should be told it cannot reach that endpoint AT ALL rather
    // than that it is the wrong kind of token — the permanent reason wins, and
    // the answer stays stable if the same matrix is later reissued as
    // `general`. `/api/mcp` never reaches this gate: it is the MCP transport,
    // not a route registered through registerRoute.
    if (actor.source === 'pat' && actor.purpose === 'mcp_only') {
      throw new ForbiddenError(
        'token-mcp-only',
        'this token was issued for MCP use only and cannot call the REST API',
        { route: key(meta.method, meta.path) },
      )
    }
    if (meta.identity === 'admin' && actor.user.role !== 'admin') {
      throw new ForbiddenError('forbidden', 'admin only')
    }
    if (meta.identity === 'resource-admin' && !isResourceAdminRole(actor.user.role)) {
      throw new ForbiddenError('forbidden', 'resource admin only')
    }
    for (const perm of meta.permissions) {
      if (!actor.permissions.has(perm)) {
        throw new ForbiddenError('forbidden', `missing permission: ${perm}`, {
          requiredPermission: perm,
          actorPermissions: [...actor.permissions],
        })
      }
    }
    await next()
  }
}

/**
 * Register a route together with its metadata and mount the derived gate.
 *
 * Replaces the "register the handler here, mount its middleware over there"
 * pair, so a route physically cannot exist without a declaration — which is what
 * makes the forward self-check meaningful rather than aspirational.
 *
 * (Deliberately no literal `app.<verb>('/path'…)` example anywhere in this file:
 * `tests/api-contract-coverage.test.ts` discovers routes by regex over
 * `src/routes/*.ts` and its `stripLineComments` does not strip block comments,
 * so an example in a doc comment is discovered as a real endpoint.)
 */
export function registerRoute<P extends string>(
  app: Hono,
  meta: RouteMeta<P>,
  // Generic over the path literal so Hono's `c.req.param('id')` inference
  // survives the indirection — without it every migrated handler would see
  // `string | undefined` and the migration would trade a real type guarantee
  // for the registry's bookkeeping.
  ...handlers: Array<Handler<BlankEnv, P>>
): void {
  validate(meta)
  const k = key(meta.method, meta.path)
  const existing = REGISTRY.get(k)
  if (existing !== undefined && !sameMeta(existing, meta)) {
    throw new RouteMetaError(
      `${k}: already declared with DIFFERENT metadata — a route has exactly one authorization contract`,
    )
  }
  // Re-declaring the same contract is a no-op rather than an error: the registry
  // describes the CODEBASE's route inventory, which is static, while `createApp`
  // is legitimately called many times in one process (every backend test that
  // builds a fresh app). Throwing on the second identical declaration would make
  // the registry unusable in exactly the place its guarantees matter most.
  // A CONFLICTING re-declaration is still an error — that is the real mistake
  // this check exists to catch.
  REGISTRY.set(k, meta)
  // `app.on(method, path, ...)` rather than `app.get`/`app.post`/… : the latter
  // are generic over a literal path type, which a runtime `meta.path` cannot
  // satisfy. `on` takes the method as data, which is exactly what a registry
  // needs — and it keeps this switch-free, so a future HttpMethod addition
  // cannot silently fall through.
  app.on(meta.method, meta.path, routeMetaGate(meta), ...handlers)
}

/** Test-only: drop every registration so suites can build fresh apps. */
export function resetRouteMetaRegistry(): void {
  REGISTRY.clear()
}

// -----------------------------------------------------------------------------
// RFC-247 T4 — startup exhaustiveness self-check, in BOTH directions.
//
// Forward: a route with no declaration would run ungated. That is the failure
// this whole layer exists to make impossible, so it must be impossible to ship,
// not merely discouraged.
//
// Reverse: a permission point that no route references still appears on the
// account page's token matrix, where it tells the user that ticking it grants
// a capability. The authorization UI lying to its user is harder to notice than
// a missing gate and just as wrong. Four such points were caught while writing
// this RFC — `repos:update`, `skills:execute`, `agents:execute`,
// `workgroups:execute` — every one of them produced by the symmetric intuition
// "each resource gets each verb" rather than by any real route.
//
// Range points are exempt from the reverse check because handlers consume them
// directly through `actor.permissions.has(...)` and they never appear in a
// declaration; `RANGE_POINTS` carries the file:line of each consumer so that
// exemption cannot quietly become a dumping ground.
// -----------------------------------------------------------------------------

export interface RouteMetaCoverage {
  /** Mounted on the app but carrying no declaration. */
  readonly undeclaredRoutes: ReadonlyArray<string>
  /** Declared in the catalog but referenced by no declaration. */
  readonly unroutedPoints: ReadonlyArray<Permission>
}

/**
 * Compare the declaration set against the app's mounted routes and the
 * permission catalog. Pure — callers decide what to do with the result.
 */
export function routeMetaCoverage(
  mountedRoutes: ReadonlyArray<{ method: string; path: string }>,
): RouteMetaCoverage {
  const declared = new Set(allRouteMeta().map((m) => key(m.method, m.path)))
  const undeclaredRoutes = mountedRoutes
    // Hono reports `app.use(...)` middleware in the same table as endpoints,
    // with method 'ALL'. Middleware is not an endpoint and has no permission
    // contract of its own — the request logger, multiAuth, and the task
    // visibility filter all land here. Filtering on the METHOD is a structural
    // distinction; adding each of them to EXEMPT_MOUNTS by path would be a
    // hand-maintained list that silently grows into a hole.
    .filter((r) => r.method.toUpperCase() !== 'ALL')
    .filter((r) => !EXEMPT_MOUNTS.has(r.path))
    .filter((r) => !declared.has(key(r.method.toUpperCase(), r.path)))
    .map((r) => `${r.method.toUpperCase()} ${r.path}`)
    .sort()

  const referenced = new Set<string>()
  for (const m of allRouteMeta()) for (const p of m.permissions) referenced.add(p)
  const unroutedPoints = ROUTE_BACKED_POINTS.filter((p) => !referenced.has(p))
    .slice()
    .sort()

  return { undeclaredRoutes, unroutedPoints }
}

/**
 * Mounted paths that are deliberately not API endpoints and therefore carry no
 * declaration. Kept explicit and tiny — every entry is a hole in the forward
 * check, so each needs a reason a reader can audit.
 */
const EXEMPT_MOUNTS = new Set<string>([
  // The embedded SPA fallback: serves index.html for client-side routes. It is
  // not an API surface and explicitly 404s anything under /api/ or /ws/.
  '*',
  // RFC-247 §4.1 — the MCP transport. It carries no permission point because it
  // is not an endpoint with a capability: it is a pipe, and authorization
  // happens per TOOL against the same declarations `tools/list` filters on.
  // Its own gates (PAT-only, surface switch) run before any tool does.
  //
  // Listed explicitly even though `app.all` mounts register as method ALL and
  // are already skipped above. Relying on that would make the exemption an
  // accident of how the route happens to be mounted rather than a decision.
  '/api/mcp',
])

/** Throw when either direction of the coverage check fails. */
export function assertRouteMetaCoverage(
  mountedRoutes: ReadonlyArray<{ method: string; path: string }>,
): void {
  const { undeclaredRoutes, unroutedPoints } = routeMetaCoverage(mountedRoutes)
  const problems: string[] = []
  if (undeclaredRoutes.length > 0) {
    problems.push(
      `${undeclaredRoutes.length} route(s) mounted without a RouteMeta declaration — they would run UNGATED:\n` +
        undeclaredRoutes.map((r) => `    ${r}`).join('\n') +
        '\n  Register them with registerRoute(), or add a reasoned entry to EXEMPT_MOUNTS.',
    )
  }
  if (unroutedPoints.length > 0) {
    problems.push(
      `${unroutedPoints.length} permission point(s) reference no route — they would appear on the token matrix advertising a capability that maps to no endpoint:\n` +
        unroutedPoints.map((p) => `    ${p}`).join('\n') +
        '\n  Delete them, or declare the route that uses them.',
    )
  }
  if (problems.length > 0) {
    throw new RouteMetaError(`RFC-247 route metadata coverage failed.\n  ${problems.join('\n  ')}`)
  }
}
