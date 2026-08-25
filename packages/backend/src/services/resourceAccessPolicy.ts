// RFC-324 — the resource access policy, as pure functions.
//
// Why this is its own file
// ------------------------
// `services/resourceAcl.ts` has been the single source for "can this actor see /
// modify this resource" since RFC-099, but it holds three different kinds of
// thing at once: the decision itself, the queries that feed it, and the HTTP
// endpoint service behind `GET/PUT /acl`. RFC-294 G1 wants the decision layer to
// depend on nothing — no Hono, no Drizzle, no DbClient — so it can eventually be
// consumed from a domain layer. This file is that decision layer, extracted
// whole; `resourceAcl.ts` keeps the IO and re-exports everything here so the
// ~300 existing call sites do not move.
//
// The four-value verdict
// ----------------------
// Before RFC-324 the codebase asked two independent yes/no questions
// (`isVisibleRow`, `isResourceOwner`) whose branch orders had to be kept in
// agreement by hand. A grant with depth makes that arrangement untenable — a
// third question ("may they change the content?") would have become a third
// predicate with its own copy of the bypass / private-range / public / owner
// ladder. Instead there is ONE ladder producing `own > write > read > none`, and
// the three questions are projections of it.
//
// Equivalence with the pre-RFC-324 predicates is not a claim, it is a test:
// `rfc324-access-policy-equivalence.test.ts` enumerates every combination of
// (bypass × private-range × public/private × owner/non-owner × grant/no-grant)
// and asserts this ladder reproduces the old two predicates exactly when every
// grant is `read` — which, after the migration backfill, is every existing row.

import type { ResourceAccess, ResourceGrantLevel, ResourceVisibility } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { ForbiddenError } from '@/util/errors'

/**
 * Minimal row shape every ACL check accepts; full resource rows AND mapped
 * DTOs superset it. The two ACL fields are optional so shared DTOs (which
 * declare them optional for fixture back-compat) plug in directly; absent
 * visibility means 'public' (the D2 legacy semantics) and absent owner means
 * "no owner yet" (platform-managed).
 */
export interface AclRow {
  id: string
  ownerUserId?: string | null
  visibility?: ResourceVisibility
  /** RFC-104 — built-in marker; present on agent/workflow DTOs, absent (→ not
   *  built-in) on skill/mcp/plugin rows. Read by assertNotBuiltin. */
  builtin?: boolean | null
}

/** Single source for the row-level resource ACL bypass. */
export function hasResourceAclBypass(actor: Actor): boolean {
  return actor.permissions.has('resource-acl:bypass')
}

/** Account-range capability for owner/grant visibility on private ACL rows. */
export function hasPrivateResourceAccess(actor: Actor): boolean {
  return actor.permissions.has('resource-acl:private')
}

/** The two authority bits the ladder consumes, projected off an actor. */
export interface ResourceAclAudienceAuthority {
  readonly bypass: boolean
  readonly private: boolean
}

/** Snapshot-friendly projection of the only two resource-ACL authority points. */
export function resourceAclAudienceAuthority(actor: Actor): ResourceAclAudienceAuthority {
  return {
    bypass: hasResourceAclBypass(actor),
    private: hasPrivateResourceAccess(actor),
  }
}

/**
 * The ladder. Every access question in the codebase resolves through here.
 *
 * Branch order is load-bearing and matches the pre-RFC-324 predicates exactly:
 *
 *  1. `resource-acl:bypass` outranks everything (RFC-305: authority, not role).
 *  2. An owner is an owner on a public row even without the account-range
 *     `resource-acl:private` point — this mirrors `isResourceOwner`, whose
 *     private-row guard only fired for PRIVATE rows. Dropping the `isPublic`
 *     disjunct here would silently demote guest-preset owners of public rows.
 *  3. Without the private range, grants are not observable at all, so a
 *     non-owner sees only what `public` gives them (`isVisibleRow` branch 3).
 *  4. Grants apply, deepest first.
 *  5. Otherwise `public` still grants read.
 */
export function resolveAccessFrom(
  authority: ResourceAclAudienceAuthority,
  userId: string,
  row: Pick<AclRow, 'ownerUserId' | 'visibility'>,
  grant: ResourceGrantLevel | null,
): ResourceAccess {
  if (authority.bypass) return 'own'
  const isPublic = (row.visibility ?? 'public') === 'public'
  const ownerMatch = row.ownerUserId != null && row.ownerUserId === userId
  if (ownerMatch && (isPublic || authority.private)) return 'own'
  if (!authority.private) return isPublic ? 'read' : 'none'
  if (grant === 'write') return 'write'
  if (grant === 'read') return 'read'
  return isPublic ? 'read' : 'none'
}

/** Actor-facing form of {@link resolveAccessFrom}. */
export function resolveResourceAccess(
  actor: Actor,
  row: AclRow,
  grant: ResourceGrantLevel | null,
): ResourceAccess {
  return resolveAccessFrom(resourceAclAudienceAuthority(actor), actor.user.id, row, grant)
}

/**
 * Sync edit predicate against a pre-fetched set of `write`-granted ids.
 *
 * The mirror of `isVisibleRow`, for the same reason it exists: a few call sites
 * decide over a LIST inside a synchronous map/filter (skill ZIP overwrite
 * candidates, for one) and cannot await per row. They pre-fetch the writable set
 * once and consult it here.
 */
export function canEditRow(
  actor: Actor,
  row: AclRow,
  writableGrantIds: ReadonlySet<string>,
): boolean {
  return canEditAccess(
    resolveResourceAccess(actor, row, writableGrantIds.has(row.id) ? 'write' : null),
  )
}

/** May they observe it at all? Anything but `none`. */
export function canViewAccess(access: ResourceAccess): boolean {
  return access !== 'none'
}

/**
 * May they change its CONTENT? `write` grant or ownership.
 *
 * Content is everything the resource is FOR — a workflow's canvas, an agent's
 * body and frontmatter, a skill's files, an MCP's config, a digital employee's
 * definition and its published revisions. It is deliberately NOT: the name
 * (owner-scoped unique domain), deletion, ownership transfer, visibility, or
 * the grant list itself. Those are {@link canGovernAccess}.
 */
export function canEditAccess(access: ResourceAccess): boolean {
  return access === 'write' || access === 'own'
}

/**
 * May they govern it? Ownership only (bypass resolves to `own` above).
 *
 * This is the predicate `isResourceOwner` used to answer under a name that
 * suggested a plain identity comparison. It never was one — it has folded in
 * ACL bypass since RFC-099 — and RFC-324 made the misnomer actively dangerous,
 * because the file now has a second write-shaped predicate right next to it.
 */
export function canGovernAccess(access: ResourceAccess): boolean {
  return access === 'own'
}

/**
 * RFC-324 — renaming is a governance act, but the name usually rides inside the
 * same body as the content.
 *
 * Almost every resource takes its name in the same PUT that carries its content,
 * so "edit grants cover content only" cannot be enforced by routing alone. This
 * runs INSIDE the write transaction against the in-transaction current name —
 * comparing against a name read before the transaction would let a concurrent
 * rename slip an editor's rename through.
 *
 * A no-op submission (same name) is not a rename and passes: clients routinely
 * echo the whole resource back.
 */
export function assertNameUnchangedForEditor(
  access: ResourceAccess,
  currentName: string,
  submittedName: string | null | undefined,
): void {
  if (canGovernAccess(access)) return
  if (submittedName === null || submittedName === undefined) return
  if (submittedName === currentName) return
  throw new ForbiddenError(
    'resource-rename-owner-only',
    'only the resource owner can rename it; an edit grant covers content only',
  )
}
