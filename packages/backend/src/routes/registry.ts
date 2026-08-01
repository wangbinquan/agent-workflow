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
import { isResourceAdminRole, type Permission } from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { ForbiddenError } from '@/util/errors'

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
    const actor = actorOf(c)
    if (meta.tokenAccess === 'never' && actor.source === 'pat') {
      throw new ForbiddenError(
        'token-forbidden-route',
        'personal access tokens cannot reach this endpoint',
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
