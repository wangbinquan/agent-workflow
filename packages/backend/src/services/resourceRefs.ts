// RFC-099 (D15) — save-time reference usability check.
//
// Editing a workflow (or an agent) is the ONLY place per-resource use rights
// are enforced: launching a task checks just the workflow itself (D3), so the
// save-time gate is what stops a user from referencing a private agent /
// skill / mcp / plugin they cannot see. Per D15 the check covers NEW
// references only — references already present in the stored row are
// grandfathered, so losing a grant never bricks saving your own resource.
//
// Ids that do not resolve to any row are NOT this module's business — the
// existing existence validators (validateDependsOn / validateMcpReferences /
// validatePluginReferences; workflows tolerate dangling agent names until
// launch validation) keep their behavior. We only reject names that resolve
// to a row the editor cannot view, and the error deliberately echoes ONLY the
// name the editor typed (no id / description / owner — D1).

import type { AclResourceType, WorkflowDefinition } from '@agent-workflow/shared'
import { collectWorkflowCallRefs, collectWorkgroupCallRefs } from '@agent-workflow/shared'
import { inArray, like } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { agents } from '@/db/schema'
import { ValidationError } from '@/util/errors'
import {
  ACL_TABLES,
  hasResourceAclBypass,
  isVisibleRow,
  listGrantedResourceIds,
  listGrantedResourceIdsInTx,
  type AclRow,
} from './resourceAcl'

/**
 * Agent references of a workflow definition (agent-single nodes). RFC-223
 * (PR-8): returns only canonical `agentId` values. A name-only persisted node
 * is corrupt/legacy data and fails closed; portable YAML names are resolved by
 * the dedicated importRefs service before this function is reached.
 */
export function extractWorkflowAgentRefs(def: {
  nodes?: ReadonlyArray<Record<string, unknown>>
}): Set<string> {
  const out = new Set<string>()
  for (const node of def.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    if (node.kind !== 'agent-single') continue
    const ref = typeof node.agentId === 'string' && node.agentId.length > 0 ? node.agentId : null
    if (ref !== null) out.add(ref)
  }
  return out
}

/** Names in `next` that are not in `prev` — the D15 "new references". */
export function diffNewNames(prev: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
  return [...next].filter((n) => !prev.has(n))
}

/**
 * RFC-243 (§5.3) — workflow references of a workflow definition (call-workflow
 * nodes). Unlike agent refs these are NAME selectors (the authoritative field;
 * `workflowId` is a local cache), deduped in declaration order. A malformed
 * call node without a `workflowName` is skipped — the validator owns that
 * error, exactly like the agent extractor's name-only fail-closed stance.
 */
export function extractWorkflowWorkflowRefs(defn: WorkflowDefinition): string[] {
  return [...new Set(collectWorkflowCallRefs(defn).map((ref) => ref.workflowName))]
}

/** RFC-243 PR-4 — call-workgroup selectors (same name-domain semantics). */
export function extractWorkflowWorkgroupRefs(defn: WorkflowDefinition): string[] {
  return [...new Set(collectWorkgroupCallRefs(defn).map((ref) => ref.workgroupName))]
}

/**
 * RFC-223 (PR-2) — portable EXPORT form of a workflow definition: drop the
 * internal `agentId` from every agent-single node so exported YAML is a
 * name-based selector that resolves against the TARGET environment's agents on
 * import (an id is meaningless across installs). `agentName` is retained as the
 * portable identity. Pure; only agent-single nodes are touched.
 */
export function stripWorkflowNodeAgentIds(def: WorkflowDefinition): WorkflowDefinition {
  return {
    ...def,
    nodes: (def.nodes ?? []).map((node) => {
      if (node.kind !== 'agent-single') return node
      const rec = node as Record<string, unknown>
      if (!('agentId' in rec)) return node
      const { agentId: _drop, ...rest } = rec
      return rest as typeof node
    }),
  }
}

export interface RefCheckGroup {
  type: AclResourceType
  /**
   * Reference tokens. In the default `'id'` domain these are canonical
   * resource ids (portable selectors are resolved only by the explicit
   * importRefs boundary). In the `'name'` domain (RFC-243 workflow call
   * selectors) they are display names resolved against the type's `name`
   * column.
   */
  names: readonly string[]
  /**
   * RFC-243 (§5.3) — token domain. `'name'` groups carry dangle-tolerant NAME
   * selectors (workflow names are deliberately non-unique): a name matching
   * ZERO rows passes (dangling until launch, which fails closed with
   * `workflow-call-ref-missing`), a name whose every matching row is
   * invisible to the actor is rejected — that visibility fence is the ONLY
   * thing standing between a name-guessing editor and the launch-time closure
   * freeze, which reads referenced rows without ACL (D3/D11 implicit closure
   * authorization).
   *
   * RFC-282 D4 — REQUIRED (was `?: … = 'id'`): a caller that passed name
   * tokens but forgot the tag used to silently take the id path and pass;
   * now the omission is a compile error.
   */
  domain: 'id' | 'name'
}

/**
 * RFC-243 (§5.3) — async preflight twin of `resolveRefsUsableById` for the
 * NAME token domain. Existence is not enforced (zero matching rows = dangling,
 * legal to persist); a name is `missing` only when at least one row matches
 * and none is visible to the enforcing actor. Never throws — callers
 * aggregate `missing` across groups into one `acl-missing-refs`.
 */
export async function resolveRefsUsableByName(
  db: DbClient,
  actor: Actor | null,
  type: AclResourceType,
  names: readonly string[],
  /**
   * RFC-282 D4 — D15 grandfathering lives IN the resolver, symmetric with
   * `resolveRefsUsableById`'s `grandfatheredIds`: pass the FULL next name set
   * plus the previously-stored names, and only genuinely-new names are
   * ACL-checked. Callers no longer diff by hand (a forgotten diff silently
   * dropped grandfathering with zero type-level signal).
   */
  opts: { grandfatheredNames?: ReadonlySet<string> } = {},
): Promise<{ missing: Array<{ type: AclResourceType; name: string }> }> {
  const grandfathered = opts.grandfatheredNames ?? new Set<string>()
  const refs = [...new Set(names)].filter((n) => n.length > 0 && !grandfathered.has(n))
  const missing: Array<{ type: AclResourceType; name: string }> = []
  const enforce = actor !== null && !hasResourceAclBypass(actor)
  if (refs.length === 0 || !enforce) return { missing }
  const table = ACL_TABLES[type]
  const rows = (await db
    .select({
      id: table.id,
      name: table.name,
      ownerUserId: table.ownerUserId,
      visibility: table.visibility,
    })
    .from(table)
    .where(inArray(table.name, refs))) as Array<AclRow & { name: string }>
  if (rows.length === 0) return { missing }
  const granted = await listGrantedResourceIds(db, actor, type)
  const byName = groupRowsByName(rows)
  for (const ref of refs) {
    const matched = byName.get(ref)
    if (matched === undefined) continue // dangling until launch
    if (!matched.some((row) => isVisibleRow(actor, row, granted))) {
      missing.push({ type, name: ref }) // echo INPUT token (D1/P2-2)
    }
  }
  return { missing }
}

function groupRowsByName(
  rows: ReadonlyArray<AclRow & { name: string }>,
): Map<string, Array<AclRow & { name: string }>> {
  const byName = new Map<string, Array<AclRow & { name: string }>>()
  for (const row of rows) {
    const bucket = byName.get(row.name)
    if (bucket === undefined) byName.set(row.name, [row])
    else bucket.push(row)
  }
  return byName
}

/** id + name maps for the tokens that matched a row of `type`. */
async function loadAclRefRows(
  db: DbClient,
  type: AclResourceType,
  tokens: readonly string[],
): Promise<{
  byId: Map<string, AclRow & { name: string }>
}> {
  const byId = new Map<string, AclRow & { name: string }>()
  if (tokens.length === 0) return { byId }
  const table = ACL_TABLES[type]
  const rows = (await db
    .select({
      id: table.id,
      name: table.name,
      ownerUserId: table.ownerUserId,
      visibility: table.visibility,
    })
    .from(table)
    .where(inArray(table.id, [...tokens]))) as Array<AclRow & { name: string }>
  for (const row of rows) {
    byId.set(row.id, row)
  }
  return { byId }
}

/**
 * Throws 422 `acl-missing-refs` when any reference resolves to a row the actor
 * cannot view. Unresolvable references pass through (existence validators own
 * them). Admins short-circuit.
 *
 * Codex impl-gate P2-2 / D1: the refusal echoes the caller's INPUT token (the id
 * or name they actually supplied), NEVER the resolved `row.name`. Echoing
 * `row.name` for an input that was a private resource's ID would leak that
 * resource's name — an existence/metadata oracle for a resource the caller
 * cannot view.
 */
export async function assertNewRefsUsable(
  db: DbClient,
  actor: Actor,
  groups: readonly RefCheckGroup[],
): Promise<void> {
  if (hasResourceAclBypass(actor)) return
  const missing: Array<{ type: AclResourceType; name: string }> = []
  for (const group of groups) {
    if (group.domain === 'name') {
      const resolved = await resolveRefsUsableByName(db, actor, group.type, group.names)
      missing.push(...resolved.missing)
      continue
    }
    const refs = [...new Set(group.names)].filter((n) => n.length > 0)
    if (refs.length === 0) continue
    const { byId } = await loadAclRefRows(db, group.type, refs)
    if (byId.size === 0) continue
    const granted = await listGrantedResourceIds(db, actor, group.type)
    for (const ref of refs) {
      const row = byId.get(ref)
      if (row === undefined) continue // unresolvable → existence validator owns it
      if (!isVisibleRow(actor, row, granted)) {
        // Echo the INPUT token (P2-2 / D1), not row.name.
        missing.push({ type: group.type, name: ref })
      }
    }
  }
  if (missing.length > 0) {
    throw missingRefsError(missing)
  }
}

/**
 * Final, synchronous D15 reference fence.
 *
 * Async preflight keeps validation errors early and friendly, but it cannot be
 * the authorization linearization point: a referenced row can be deleted,
 * transferred or made private after preflight and before the writer commits.
 * Every ordinary writer calls this from the SAME `dbTxSync` body as its
 * INSERT/UPDATE, passing only ids that are new relative to the row snapshot
 * read in that transaction.
 *
 * This deliberately does not compare `aclRevision`. The commit invariant is
 * exactly "the canonical id still exists and is usable by this actor now";
 * unrelated ACL edits that preserve usability must not reject a save.
 *
 * Callers pass only ids that preflight matched (or whose dedicated existence
 * validator accepted). Reference kinds that deliberately allow unresolved
 * tokens keep their own contract; Agent managed Skills are rejected by
 * RFC-228's complete-candidate integrity gate before this fence.
 * Missing-at-preflight tokens never enter this fence; matched-then-deleted is
 * the race it closes.
 *
 * Missing and invisible fenced rows share `acl-missing-refs`, echoing only the
 * caller-supplied canonical id. That preserves D1's non-enumerating shape.
 * Framework callers (`actor === null`) and actors with `resource-acl:bypass` bypass visibility,
 * but never existence — they cannot commit a new dangling reference either.
 *
 * `'name'`-domain groups (RFC-243 workflow call selectors) invert the
 * existence half on purpose: a dangling name IS a legal persisted state
 * (launch fails closed with `workflow-call-ref-missing`), so a fenced name
 * whose rows vanished between preflight and commit degrades to dangling
 * instead of rejecting the save. Only "every matching row is invisible to the
 * enforcing actor" rejects — the matched-then-made-private race.
 */
export function assertRefsUsableInTx(
  tx: DbTxSync,
  actor: Actor | null,
  groups: readonly RefCheckGroup[],
): void {
  const missing: Array<{ type: AclResourceType; name: string }> = []
  for (const group of groups) {
    const refs = [...new Set(group.names)].filter((ref) => ref.length > 0)
    if (refs.length === 0) continue
    const nameDomain = group.domain === 'name'
    const table = ACL_TABLES[group.type]
    // Narrowed enforcement identity: null ⇒ framework caller or ACL-bypass actor.
    const enforcingActor = actor !== null && !hasResourceAclBypass(actor) ? actor : null
    if (nameDomain && enforcingActor === null) continue // dangle-tolerant + no ACL to enforce
    const rows = tx
      .select({
        id: table.id,
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(nameDomain ? inArray(table.name, refs) : inArray(table.id, refs))
      .all() as Array<AclRow & { name: string }>
    const byId = new Map(rows.map((row) => [row.id, row]))
    // RFC-282 D2 — the grant-set SQL lives in resourceAcl only.
    const granted =
      enforcingActor !== null
        ? listGrantedResourceIdsInTx(tx, enforcingActor, group.type)
        : new Set<string>()

    if (nameDomain && enforcingActor !== null) {
      const byName = groupRowsByName(rows)
      for (const ref of refs) {
        const matched = byName.get(ref)
        if (matched === undefined) continue // dangling until launch
        if (!matched.some((row) => isVisibleRow(enforcingActor, row, granted))) {
          missing.push({ type: group.type, name: ref })
        }
      }
      continue
    }

    for (const ref of refs) {
      const row = byId.get(ref)
      if (
        row === undefined ||
        (enforcingActor !== null && !isVisibleRow(enforcingActor, row, granted))
      ) {
        missing.push({ type: group.type, name: ref })
      }
    }
  }
  if (missing.length > 0) throw missingRefsError(missing)
}

function missingRefsError(
  missing: Array<{ type: AclResourceType; name: string }>,
): ValidationError {
  return new ValidationError(
    'acl-missing-refs',
    `you do not have access to: ${missing.map((m) => `${m.type} '${m.name}'`).join(', ')}`,
    { missing },
  )
}

/** Per-type resolution result: ids for persistence + ACL violations (new refs
 *  the actor cannot view), echoing the caller's INPUT token (D1/P2-2). */
export interface ResolvedRefsById {
  /** Resolved ids, deduped, first-seen order — for flat id[] columns. An
   *  unresolvable token is kept verbatim (existence validators own it). */
  ids: string[]
  /** MATCHED input token → its row id (only tokens that resolved to a row). A
   *  caller that must preserve per-entry identity (skills / workgroup members)
   *  reads `byToken.get(token) ?? <token-or-null>` so an unresolvable token keeps
   *  its own semantics (skill: unresolved managed; member: dangling → null). */
  byToken: Map<string, string>
  missing: Array<{ type: AclResourceType; name: string }>
}

/**
 * RFC-223 (PR-1, Codex impl-gate P1-2) — resolve id-or-name tokens to canonical
 * ids AND decide ACL usability in a SINGLE query pass, so the id used for the
 * ACL decision is the exact id returned for persistence. This closes the
 * check-then-resolve TOCTOU: the old shape ACL-checked the raw token in the
 * route and then RE-RESOLVED it (with no actor) in the service, so a private
 * resource renamed into that token between the two steps could bind an id the
 * caller was never authorized for.
 *
 * - A token equal to a row id resolves; an unresolvable token is returned
 *   verbatim (existence validators own `*-not-found`). Names are deliberately
 *   not queried here after the PR-8 uniqueness flip.
 * - A NEW reference (resolved id NOT in `grandfatheredIds`, D15) whose row the
 *   actor cannot view is collected in `missing`, echoing the INPUT token.
 * - `actor === null` (framework/system callers) skips the ACL gate; a resource
 *   actor with `resource-acl:bypass` likewise resolves without ACL filtering.
 *
 * Never throws — the caller aggregates `missing` across ref groups and raises a
 * single `acl-missing-refs`.
 */
export async function resolveRefsUsableById(
  db: DbClient,
  actor: Actor | null,
  type: AclResourceType,
  tokens: readonly string[],
  opts: { grandfatheredIds?: ReadonlySet<string> } = {},
): Promise<ResolvedRefsById> {
  if (tokens.length === 0) return { ids: [], byToken: new Map(), missing: [] }
  const { byId } = await loadAclRefRows(db, type, [...new Set(tokens)])
  const enforce = actor !== null && !hasResourceAclBypass(actor)
  const granted = enforce ? await listGrantedResourceIds(db, actor, type) : new Set<string>()
  const grandfathered = opts.grandfatheredIds ?? new Set<string>()
  const missing: Array<{ type: AclResourceType; name: string }> = []
  const byToken = new Map<string, string>()
  const seen = new Set<string>()
  const ids: string[] = []
  for (const token of tokens) {
    const row = byId.get(token)
    const id = row?.id ?? token
    if (row !== undefined) byToken.set(token, row.id) // only MATCHED tokens
    if (
      enforce &&
      row !== undefined &&
      !grandfathered.has(id) &&
      !isVisibleRow(actor, row, granted)
    ) {
      missing.push({ type, name: token }) // echo INPUT token (D1/P2-2)
    }
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return { ids, byToken, missing }
}

/** Raise the aggregated `acl-missing-refs` (or return if none). Callers collect
 *  `missing` from several `resolveRefsUsableById` groups and pass them here. */
export function assertNoMissingRefs(
  missing: ReadonlyArray<{ type: AclResourceType; name: string }>,
): void {
  if (missing.length > 0) throw missingRefsError([...missing])
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC-284 T9（§2.1）——「哪些 agent 的 JSON 列引用了这个 id」的唯一实现。
//
// mcp / plugin / skill / dependsOn 四个守卫此前各持一份两段式扫描（SQL LIKE
// 粗过滤 + JSON parse 精确匹配），matcher 形状互有出入，且 skillReferenceGuard
// 一直缺 LIKE 预过滤（全表扫描）。收编后各域守卫只留自己的 matcher + 一行委托；
// LIKE 只是缩扫描量的粗过滤（`"<id>"` 子串可能命中别的值），matcher 才是权威。
// ─────────────────────────────────────────────────────────────────────────────

/** 引用扫描的统一返回行（四域同形；披露/过滤仍须按 id 绑定，name 跨 owner 不唯一）。 */
export interface ReferencingAgentRow {
  id: string
  name: string
  ownerUserId: string | null
  visibility: 'public' | 'private'
}

export interface ReferencingScanArgs {
  /** agents 表上的 JSON 文本列（agents.mcp / plugins / skills / dependsOn）。 */
  column: AnySQLiteColumn
  /** 被引用的资源 id。 */
  id: string
  /** 对 parse 后的列值做权威判定。 */
  matches: (parsed: unknown, id: string) => boolean
}

interface RawReferencingRow {
  id: string
  name: string
  raw: unknown
  ownerUserId: string | null
  visibility: 'public' | 'private'
}

function collectReferencing(
  rows: ReadonlyArray<RawReferencingRow>,
  args: Pick<ReferencingScanArgs, 'id' | 'matches'>,
): ReferencingAgentRow[] {
  const out: ReferencingAgentRow[] = []
  for (const row of rows) {
    try {
      // 四列均为 TEXT NOT NULL；drizzle 动态列的静态型退化为 unknown，此处收窄。
      const parsed = JSON.parse(String(row.raw)) as unknown
      if (args.matches(parsed, args.id)) {
        out.push({
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
      }
    } catch {
      // 损坏行与各域 Agent mapper 一致：fail-closed 当空表处理。
    }
  }
  return out
}

function referencingSelectShape(column: AnySQLiteColumn) {
  return {
    id: agents.id,
    name: agents.name,
    raw: column,
    ownerUserId: agents.ownerUserId,
    visibility: agents.visibility,
  }
}

export async function findAgentsReferencingIdInJsonColumn(
  db: DbClient,
  args: ReferencingScanArgs,
): Promise<ReferencingAgentRow[]> {
  const rows = await db
    .select(referencingSelectShape(args.column))
    .from(agents)
    .where(like(args.column, `%"${args.id}"%`))
  return collectReferencing(rows, args)
}

export function findAgentsReferencingIdInJsonColumnInTx(
  tx: DbTxSync,
  args: ReferencingScanArgs,
): ReferencingAgentRow[] {
  const rows = tx
    .select(referencingSelectShape(args.column))
    .from(agents)
    .where(like(args.column, `%"${args.id}"%`))
    .all()
  return collectReferencing(rows, args)
}
