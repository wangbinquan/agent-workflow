// RFC-041 — platform long-term memory service (PR1 scope).
//
// Responsibilities:
//   - Pure CRUD on `memories` rows (no distiller, no inject — those land in
//     PR2 / PR3 respectively).
//   - `promoteCandidate` implements the immutable + supersede chain described
//     in design/RFC-041-platform-long-term-memory/design.md §7.3. The whole
//     promote → mark-superseded → broadcast sequence runs inside a SYNCHRONOUS
//     transaction (dbTxSync, RFC-093) so we never end up with a half-promoted
//     candidate or an orphan supersede link. (The previous
//     `db.transaction(async …)` form COMMITted at its first await and provided
//     no such guarantee — audit S-10.)
//
// Authorization is enforced by `requirePermission` at the route layer; this
// module does not re-check permissions but does require the caller to pass
// `adminUserId` for write paths so the audit trail (`approved_by_user_id`)
// is always populated.

import { and, desc, eq, gt, inArray, like, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  Memory,
  MemoryCandidatePromote,
  MemoryCreateRequest,
  MemoryListFilter,
  MemoryPatchField,
  MemoryPatchRequest,
  MemoryScope,
  MemoryStatus,
  MemorySummary,
  MemoryWsMessage,
} from '@agent-workflow/shared'
import { MemorySchema } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { memories, memoryDistillJobs } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { MEMORY_CHANNEL, memoryBroadcaster } from '@/ws/broadcaster'

/** A memory row + its (possibly empty) supersede ancestor chain. */
export interface MemoryWithChain {
  memory: Memory
  /** From immediate parent (supersedes_id) outward, oldest last. */
  ancestors: Memory[]
}

interface MemoryRow {
  id: string
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
  scopeId: string | null
  title: string
  bodyMd: string
  tags: string
  status: 'candidate' | 'approved' | 'archived' | 'superseded' | 'rejected' | 'fused'
  sourceKind: 'clarify' | 'review' | 'feedback' | 'manual'
  sourceEventId: string | null
  sourceTaskId: string | null
  distillJobId: string | null
  distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with' | null
  supersedesId: string | null
  supersededById: string | null
  approvedByUserId: string | null
  approvedAt: number | null
  createdAt: number
  version: number
  fusedIntoSkill: string | null
  fusedIntoSkillVersion: number | null
  fusedAt: number | null
  fusedByUserId: string | null
  fusedFusionId: string | null
}

function parseTags(s: string): string[] {
  try {
    const parsed = JSON.parse(s) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return MemorySchema.parse({
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    tags: parseTags(row.tags),
    status: row.status,
    sourceKind: row.sourceKind,
    sourceEventId: row.sourceEventId,
    sourceTaskId: row.sourceTaskId,
    distillJobId: row.distillJobId,
    distillAction: row.distillAction,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    version: row.version,
    fusedIntoSkill: row.fusedIntoSkill,
    fusedIntoSkillVersion: row.fusedIntoSkillVersion,
    fusedAt: row.fusedAt,
    fusedByUserId: row.fusedByUserId,
  })
}

export function toSummary(
  m: Memory,
  extras: { outputLang?: 'zh-CN' | 'en-US' | null } = {},
): MemorySummary {
  return {
    id: m.id,
    scopeType: m.scopeType,
    scopeId: m.scopeId,
    title: m.title,
    status: m.status,
    tags: m.tags,
    approvedAt: m.approvedAt,
    version: m.version,
    distillAction: m.distillAction,
    fusedIntoSkill: m.fusedIntoSkill ?? null,
    fusedIntoSkillVersion: m.fusedIntoSkillVersion ?? null,
    // RFC-050: only candidate rows carry the lang chip — approved /
    // archived / superseded / rejected are "facts" whose generation
    // language we no longer surface.
    outputLang: m.status === 'candidate' ? (extras.outputLang ?? null) : null,
  }
}

function publish(msg: MemoryWsMessage): void {
  memoryBroadcaster.broadcast(MEMORY_CHANNEL, msg)
}

/**
 * Admin-issued direct create (source_kind='manual'). The row is persisted
 * with status='candidate' so it still flows through the standard approval
 * UI — there is no "skip approval" shortcut even for admin.
 */
export async function createManualCandidate(
  db: DbClient,
  input: MemoryCreateRequest,
): Promise<Memory> {
  const tags = input.tags ?? []
  // Schema-level validation surfaces user-facing 422 before hitting SQLite.
  const draft = MemorySchema.parse({
    id: ulid(),
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    title: input.title,
    bodyMd: input.bodyMd,
    tags,
    status: 'candidate',
    sourceKind: 'manual',
    sourceEventId: null,
    sourceTaskId: null,
    distillJobId: null,
    distillAction: null,
    supersedesId: null,
    supersededById: null,
    approvedByUserId: null,
    approvedAt: null,
    createdAt: Date.now(),
    version: 1,
  })
  await db.insert(memories).values({
    id: draft.id,
    scopeType: draft.scopeType,
    scopeId: draft.scopeId,
    title: draft.title,
    bodyMd: draft.bodyMd,
    tags: JSON.stringify(draft.tags),
    status: 'candidate',
    sourceKind: 'manual',
    sourceEventId: null,
    sourceTaskId: null,
    distillJobId: null,
    distillAction: null,
    supersedesId: null,
    supersededById: null,
    approvedByUserId: null,
    approvedAt: null,
    createdAt: draft.createdAt,
    version: 1,
  })
  publish({ type: 'memory.candidate.created', memory: toSummary(draft) })
  return draft
}

// `includeBody: true` returns full `Memory[]` (with bodyMd + source / supersede
// fields) so the approval queue can render the candidate body inline for review
// — the default `MemorySummary[]` shape stays the cheap path for grouped /
// scope-browsing UIs that only need titles + chips.
export async function listMemories(
  db: DbClient,
  filter: MemoryListFilter,
  options: { includeBody: true },
): Promise<Memory[]>
export async function listMemories(
  db: DbClient,
  filter?: MemoryListFilter,
  options?: { includeBody?: false },
): Promise<MemorySummary[]>
export async function listMemories(
  db: DbClient,
  filter: MemoryListFilter = {},
  options: { includeBody?: boolean } = {},
): Promise<Memory[] | MemorySummary[]> {
  const conds = []
  if (filter.status !== undefined) conds.push(eq(memories.status, filter.status))
  if (filter.scopeType !== undefined) conds.push(eq(memories.scopeType, filter.scopeType))
  if (filter.scopeId !== undefined) conds.push(eq(memories.scopeId, filter.scopeId))
  if (filter.search !== undefined) {
    const term = `%${filter.search}%`
    const titleLike = like(memories.title, term)
    const bodyLike = like(memories.bodyMd, term)
    conds.push(or(titleLike, bodyLike)!)
  }
  const where = conds.length > 0 ? and(...conds) : undefined
  const rows = (await (where
    ? db.select().from(memories).where(where).orderBy(desc(memories.createdAt))
    : db.select().from(memories).orderBy(desc(memories.createdAt)))) as MemoryRow[]
  let items = rows.map(rowToMemory)
  if (filter.tag !== undefined) {
    const needle = filter.tag
    items = items.filter((m) => m.tags.includes(needle))
  }
  if (options.includeBody === true) return items
  // RFC-050: for the cheap summary path, batch-lookup output_lang on the
  // distill jobs that produced this row's CANDIDATES. We deliberately
  // skip the lookup for non-candidate rows because toSummary itself
  // discards the value (approved / archived / superseded / rejected are
  // language-less "facts" by design).
  const candidateJobIds = new Set<string>()
  for (const m of items) {
    if (m.status === 'candidate' && m.distillJobId !== null) candidateJobIds.add(m.distillJobId)
  }
  const langByJob = await loadJobOutputLangs(db, [...candidateJobIds])
  return items.map((m) =>
    toSummary(m, {
      outputLang: m.distillJobId === null ? null : (langByJob.get(m.distillJobId) ?? null),
    }),
  )
}

async function loadJobOutputLangs(
  db: DbClient,
  jobIds: string[],
): Promise<Map<string, 'zh-CN' | 'en-US' | null>> {
  if (jobIds.length === 0) return new Map()
  const rows = (await db
    .select({ id: memoryDistillJobs.id, outputLang: memoryDistillJobs.outputLang })
    .from(memoryDistillJobs)
    .where(inArray(memoryDistillJobs.id, jobIds))) as Array<{
    id: string
    outputLang: string | null
  }>
  const out = new Map<string, 'zh-CN' | 'en-US' | null>()
  for (const r of rows) {
    if (r.outputLang === 'zh-CN' || r.outputLang === 'en-US') {
      out.set(r.id, r.outputLang)
    } else {
      out.set(r.id, null)
    }
  }
  return out
}

export async function getMemoryById(db: DbClient, id: string): Promise<MemoryWithChain | null> {
  const rows = (await db.select().from(memories).where(eq(memories.id, id)).limit(1)) as MemoryRow[]
  if (rows.length === 0) return null
  const head = rowToMemory(rows[0]!)
  const ancestors: Memory[] = []
  let cursor: string | null = head.supersedesId
  const seen = new Set<string>([head.id])
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor)
    const parent = (await db
      .select()
      .from(memories)
      .where(eq(memories.id, cursor))
      .limit(1)) as MemoryRow[]
    if (parent.length === 0) break
    const m = rowToMemory(parent[0]!)
    ancestors.push(m)
    cursor = m.supersedesId
  }
  return { memory: head, ancestors }
}

export async function promoteCandidate(
  db: DbClient,
  id: string,
  body: MemoryCandidatePromote,
  adminUserId: string,
): Promise<Memory> {
  // RFC-093: synchronous transaction (dbTxSync) — the previous async form
  // COMMITted at its first await and provided no atomicity (audit S-10).
  return dbTxSync(db, (tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all() as MemoryRow[]
    if (rows.length === 0) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
    const cand = rows[0]!
    if (cand.status !== 'candidate') {
      throw new ConflictError(
        'memory-not-candidate',
        `memory ${id} is in status '${cand.status}', not 'candidate'`,
      )
    }

    if (body.action === 'reject') {
      tx.update(memories).set({ status: 'rejected' }).where(eq(memories.id, id)).run()
      publish({ type: 'memory.candidate.promoted', memoryId: id, newStatus: 'rejected' })
      const final = tx
        .select()
        .from(memories)
        .where(eq(memories.id, id))
        .limit(1)
        .all() as MemoryRow[]
      return rowToMemory(final[0]!)
    }

    const supersedeIds = body.action === 'approve_and_supersede' ? body.supersedeIds : []
    const overrideTags = body.tagsOverride
    let nextVersion = 1
    if (supersedeIds.length > 0) {
      const targets = tx
        .select()
        .from(memories)
        .where(inArray(memories.id, supersedeIds))
        .all() as MemoryRow[]
      if (targets.length !== supersedeIds.length) {
        const missing = supersedeIds.filter((sid) => !targets.some((t) => t.id === sid))
        throw new NotFoundError(
          'supersede-target-not-found',
          `supersede target(s) not found: ${missing.join(', ')}`,
          { missing },
        )
      }
      for (const t of targets) {
        if (t.id === id) {
          throw new ValidationError('supersede-self', 'a candidate cannot supersede itself')
        }
        if (t.status !== 'approved') {
          throw new ConflictError(
            'supersede-target-not-approved',
            `cannot supersede memory ${t.id} — status is '${t.status}', not 'approved'`,
          )
        }
        if (t.scopeType !== cand.scopeType || t.scopeId !== cand.scopeId) {
          throw new ConflictError(
            'supersede-scope-mismatch',
            `cannot supersede memory ${t.id} — scope mismatch (cand=${cand.scopeType}/${cand.scopeId ?? 'null'}, target=${t.scopeType}/${t.scopeId ?? 'null'})`,
          )
        }
      }
      nextVersion = targets.reduce((mx, t) => (t.version > mx ? t.version : mx), 0) + 1
    }

    const tagsForRow = overrideTags !== undefined ? JSON.stringify(overrideTags) : cand.tags
    const approvedAt = Date.now()
    tx.update(memories)
      .set({
        status: 'approved',
        approvedByUserId: adminUserId,
        approvedAt,
        version: nextVersion,
        supersedesId: supersedeIds[0] ?? null,
        tags: tagsForRow,
      })
      .where(eq(memories.id, id))
      .run()

    if (supersedeIds.length > 0) {
      tx.update(memories)
        .set({ status: 'superseded', supersededById: id })
        .where(inArray(memories.id, supersedeIds))
        .run()
    }

    publish({
      type: 'memory.candidate.promoted',
      memoryId: id,
      newStatus: 'approved',
      supersededIds: supersedeIds.length > 0 ? supersedeIds : undefined,
    })
    for (const sid of supersedeIds) {
      publish({ type: 'memory.superseded', oldId: sid, newId: id })
    }

    const final = tx
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1)
      .all() as MemoryRow[]
    return rowToMemory(final[0]!)
  })
}

/**
 * RFC-045: in-place edit of `scope_type / scope_id / title / body_md / tags`
 * on candidate, approved, or archived rows. Terminal-status rows
 * (superseded / rejected) reject with `memory-terminal-status` 409.
 *
 * Semantics (design.md §4.2):
 *   1. version bumps only when ≥ 1 field actually changes (idempotent re-save
 *      returns the row unchanged + an empty changedFields array, no WS event).
 *   2. The supersede chain is untouched — this path NEVER writes supersedes_id
 *      / superseded_by_id. "approved row in-place edit" is intentional and is
 *      what supersedes RFC-041 §G7 (see proposal §5).
 *   3. The row's audit columns (source_*, distill_*, approved_by_user_id,
 *      approved_at) are likewise frozen — admin edit is not a new approval.
 *
 * `editorUserId` is optional in the type for callers that don't have an actor
 * context (e.g. unit tests); it's only used to attribute the log line.
 */
export interface PatchMemoryResult {
  memory: Memory
  changedFields: ReadonlyArray<MemoryPatchField>
}

export async function patchMemory(
  db: DbClient,
  id: string,
  input: MemoryPatchRequest,
  editorUserId?: string,
): Promise<PatchMemoryResult> {
  // RFC-093: synchronous transaction (dbTxSync) — the previous async form
  // COMMITted at its first await and provided no atomicity (audit S-10).
  return dbTxSync(db, (tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all() as MemoryRow[]
    if (rows.length === 0) {
      throw new NotFoundError('memory-not-found', `memory ${id} not found`)
    }
    const row = rows[0]!
    if (row.status === 'superseded' || row.status === 'rejected' || row.status === 'fused') {
      throw new ConflictError(
        'memory-terminal-status',
        `memory ${id} is in terminal status '${row.status}'; cannot edit`,
      )
    }

    // Synthesize the post-PATCH shape by overlaying provided fields.
    // scope_id is special: when scopeType changes but scopeId is *not* in
    // input, the existing scopeId is reused — the synth then runs through
    // MemorySchema below, which enforces the global ↔ null invariant.
    const synthScopeType = input.scopeType ?? row.scopeType
    const synthScopeId = input.scopeId !== undefined ? input.scopeId : row.scopeId
    const synthTitle = input.title !== undefined ? input.title : row.title
    const synthBody = input.bodyMd !== undefined ? input.bodyMd : row.bodyMd
    const synthTags = input.tags !== undefined ? input.tags : parseTags(row.tags)

    // Re-validate the synthesized row through the full MemorySchema so that
    // e.g. "change scopeType to global but the row already has scopeId='x'"
    // is caught with the same error code as a malformed POST body.
    const synthParsed = MemorySchema.safeParse({
      id: row.id,
      scopeType: synthScopeType,
      scopeId: synthScopeId,
      title: synthTitle,
      bodyMd: synthBody,
      tags: synthTags,
      status: row.status,
      sourceKind: row.sourceKind,
      sourceEventId: row.sourceEventId,
      sourceTaskId: row.sourceTaskId,
      distillJobId: row.distillJobId,
      distillAction: row.distillAction,
      supersedesId: row.supersedesId,
      supersededById: row.supersededById,
      approvedByUserId: row.approvedByUserId,
      approvedAt: row.approvedAt,
      createdAt: row.createdAt,
      version: row.version,
    })
    if (!synthParsed.success) {
      throw new ValidationError(
        'invalid-body',
        'patch would put the row in an invalid state',
        synthParsed.error.format(),
      )
    }
    const synth = synthParsed.data

    const changed: MemoryPatchField[] = []
    if (synth.scopeType !== row.scopeType) changed.push('scopeType')
    if (synth.scopeId !== row.scopeId) changed.push('scopeId')
    if (synth.title !== row.title) changed.push('title')
    if (synth.bodyMd !== row.bodyMd) changed.push('bodyMd')
    if (!sameTagsJSON(synth.tags, parseTags(row.tags))) changed.push('tags')

    if (changed.length === 0) {
      // Idempotent no-op — return the parsed current row, do not bump version
      // and do not publish WS. Route layer still returns 200 with the row.
      return { memory: rowToMemory(row), changedFields: [] as ReadonlyArray<MemoryPatchField> }
    }

    const nextVersion = row.version + 1
    tx.update(memories)
      .set({
        scopeType: synth.scopeType,
        scopeId: synth.scopeId,
        title: synth.title,
        bodyMd: synth.bodyMd,
        tags: JSON.stringify(synth.tags),
        version: nextVersion,
      })
      .where(eq(memories.id, id))
      .run()

    publish({
      type: 'memory.updated',
      memoryId: id,
      changedFields: changed,
      version: nextVersion,
    })

    // Append an audit line in the structured log so we can ask "who edited
    // what" without a dedicated history table (non-goal §2.2). The line is
    // intentionally terse so log greps stay cheap.
    console.log(
      `[memory-edited] id=${id} editedBy=${editorUserId ?? 'unknown'} fieldsChanged=${changed.join(',')} version=${nextVersion}`,
    )

    const after = tx
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1)
      .all() as MemoryRow[]
    return { memory: rowToMemory(after[0]!), changedFields: changed }
  })
}

/** Tag arrays are compared order-independently: tags are a *set* of labels,
 *  not an ordered list, so PATCH `{tags:["b","a"]}` against `["a","b"]` is a
 *  no-op (no version bump). Anything mutating the underlying set (added /
 *  removed / case-changed) flips the diff. */
function sameTagsJSON(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false
  }
  return true
}

async function transitionStatus(
  db: DbClient,
  id: string,
  expected: ReadonlyArray<MemoryStatus>,
  next: MemoryStatus,
  errorCode: string,
): Promise<Memory> {
  const rows = (await db.select().from(memories).where(eq(memories.id, id)).limit(1)) as MemoryRow[]
  if (rows.length === 0) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
  const row = rows[0]!
  if (!expected.includes(row.status)) {
    throw new ConflictError(
      errorCode,
      `memory ${id} is in status '${row.status}'; expected one of ${expected.join(', ')}`,
    )
  }
  await db.update(memories).set({ status: next }).where(eq(memories.id, id))
  const after = (await db
    .select()
    .from(memories)
    .where(eq(memories.id, id))
    .limit(1)) as MemoryRow[]
  return rowToMemory(after[0]!)
}

export async function archiveMemory(db: DbClient, id: string): Promise<Memory> {
  const m = await transitionStatus(db, id, ['approved'], 'archived', 'memory-not-approved')
  publish({ type: 'memory.archived', memoryId: id })
  return m
}

export async function unarchiveMemory(db: DbClient, id: string): Promise<Memory> {
  const m = await transitionStatus(db, id, ['archived'], 'approved', 'memory-not-archived')
  publish({ type: 'memory.unarchived', memoryId: id })
  return m
}

/**
 * RFC-101: fuse memories into a skill INSIDE an existing transaction (called
 * from commitSkillVersion's txExtra during fusion apply, so the skill version
 * bump + the memory status flip commit atomically). Only `approved` memories
 * transition to `fused` + provenance; ids that drifted out of `approved`
 * (archived/superseded/deleted between launch and apply) are skipped. Returns
 * the ids actually fused.
 */
export function fuseMemoriesTx(
  tx: DbTxSync,
  args: {
    memoryIds: readonly string[]
    skillName: string
    skillVersion: number
    fusionId: string
    userId: string | null
    now: number
  },
): string[] {
  const fused: string[] = []
  for (const id of args.memoryIds) {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all() as MemoryRow[]
    const row = rows[0]
    if (!row || row.status !== 'approved') continue
    tx.update(memories)
      .set({
        status: 'fused',
        fusedIntoSkill: args.skillName,
        fusedIntoSkillVersion: args.skillVersion,
        fusedAt: args.now,
        fusedByUserId: args.userId,
        fusedFusionId: args.fusionId,
      })
      .where(eq(memories.id, id))
      .run()
    fused.push(id)
  }
  return fused
}

/**
 * RFC-101: un-fuse memories whose knowledge no longer lives in the skill after
 * a restore to `aboveVersion` (status fused→approved, provenance cleared).
 * Runs inside the restore transaction. Returns the un-fused ids.
 */
export function unfuseMemoriesTx(
  tx: DbTxSync,
  args: { skillName: string; aboveVersion: number },
): string[] {
  const rows = tx
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.status, 'fused'),
        eq(memories.fusedIntoSkill, args.skillName),
        gt(memories.fusedIntoSkillVersion, args.aboveVersion),
      ),
    )
    .all() as MemoryRow[]
  for (const row of rows) {
    tx.update(memories)
      .set({
        status: 'approved',
        fusedIntoSkill: null,
        fusedIntoSkillVersion: null,
        fusedAt: null,
        fusedByUserId: null,
        fusedFusionId: null,
      })
      .where(eq(memories.id, row.id))
      .run()
  }
  return rows.map((r) => r.id)
}

export async function deleteMemory(db: DbClient, id: string): Promise<void> {
  const rows = (await db.select().from(memories).where(eq(memories.id, id)).limit(1)) as MemoryRow[]
  if (rows.length === 0) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
  await db.delete(memories).where(eq(memories.id, id))
  publish({ type: 'memory.deleted', memoryId: id })
}

/** Test-only helper to assert WS publication on a fresh broadcaster. */
export function _scopeKey(scope: MemoryScope, id: string | null): string {
  return `${scope}:${id ?? '__global__'}`
}

// ---------------------------------------------------------------------------
// RFC-099 (D12) — memory visibility + management rights follow the scoped
// resource: agent-scoped rows are visible to whoever can view that agent and
// manageable by its owner (+admin); workflow-scoped rows likewise; repo and
// global rows stay all-readable / admin-managed. Runtime injection
// (memoryInject.ts) is untouched — the daemon actor is the __system__ admin.
// ---------------------------------------------------------------------------

import type { Actor } from '@/auth/actor'
import { agents as agentsTable, workflows as workflowsTable } from '@/db/schema'
import {
  canViewResource,
  filterVisibleRows,
  isResourceAdminActor,
  isResourceOwner,
  type AclRow,
} from '@/services/resourceAcl'

export interface MemoryScopeRef {
  scopeType: 'agent' | 'workflow' | 'repo' | 'global'
  scopeId: string | null
}

async function loadScopeAclRow(db: DbClient, scope: MemoryScopeRef): Promise<AclRow | null> {
  if (scope.scopeId === null) return null
  if (scope.scopeType === 'agent') {
    const rows = await db
      .select({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        visibility: agentsTable.visibility,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, scope.scopeId))
      .limit(1)
    return rows[0] ?? null
  }
  if (scope.scopeType === 'workflow') {
    const rows = await db
      .select({
        id: workflowsTable.id,
        ownerUserId: workflowsTable.ownerUserId,
        visibility: workflowsTable.visibility,
      })
      .from(workflowsTable)
      .where(eq(workflowsTable.id, scope.scopeId))
      .limit(1)
    return rows[0] ?? null
  }
  return null
}

/** Read visibility (D12): repo/global → everyone; agent/workflow → resource viewers. */
export async function canViewMemory(
  db: DbClient,
  actor: Actor,
  scope: MemoryScopeRef,
): Promise<boolean> {
  if (isResourceAdminActor(actor)) return true
  if (scope.scopeType === 'repo' || scope.scopeType === 'global') return true
  const row = await loadScopeAclRow(db, scope)
  // Scope resource vanished → fail closed for non-admins (nothing to anchor
  // visibility on; admins still see it for cleanup).
  if (row === null) return false
  return canViewResource(db, actor, scope.scopeType, row)
}

/** Management rights (D12): scope-resource owner or admin; repo/global admin-only. */
export async function canManageMemory(
  db: DbClient,
  actor: Actor,
  scope: MemoryScopeRef,
): Promise<boolean> {
  if (isResourceAdminActor(actor)) return true
  if (scope.scopeType === 'repo' || scope.scopeType === 'global') return false
  const row = await loadScopeAclRow(db, scope)
  if (row === null) return false
  return isResourceOwner(actor, row)
}

/**
 * List filter: one pass that resolves the visible agent/workflow id sets,
 * then filters in memory. Admins short-circuit.
 */
export async function filterMemoriesByScopeVisibility<T extends MemoryScopeRef>(
  db: DbClient,
  actor: Actor,
  rows: readonly T[],
): Promise<T[]> {
  if (isResourceAdminActor(actor)) return [...rows]
  const agentIds = new Set(
    rows.filter((r) => r.scopeType === 'agent' && r.scopeId !== null).map((r) => r.scopeId!),
  )
  const workflowIds = new Set(
    rows.filter((r) => r.scopeType === 'workflow' && r.scopeId !== null).map((r) => r.scopeId!),
  )
  const visibleAgents = new Set<string>()
  if (agentIds.size > 0) {
    const aRows = await db
      .select({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        visibility: agentsTable.visibility,
      })
      .from(agentsTable)
      .where(inArray(agentsTable.id, [...agentIds]))
    for (const r of await filterVisibleRows(db, actor, 'agent', aRows)) visibleAgents.add(r.id)
  }
  const visibleWorkflows = new Set<string>()
  if (workflowIds.size > 0) {
    const wRows = await db
      .select({
        id: workflowsTable.id,
        ownerUserId: workflowsTable.ownerUserId,
        visibility: workflowsTable.visibility,
      })
      .from(workflowsTable)
      .where(inArray(workflowsTable.id, [...workflowIds]))
    for (const r of await filterVisibleRows(db, actor, 'workflow', wRows)) {
      visibleWorkflows.add(r.id)
    }
  }
  return rows.filter((r) => {
    if (r.scopeType === 'repo' || r.scopeType === 'global') return true
    if (r.scopeId === null) return false
    return r.scopeType === 'agent' ? visibleAgents.has(r.scopeId) : visibleWorkflows.has(r.scopeId)
  })
}

/**
 * RFC-099 (D12) — stamp per-row `canManage` for the UI (approve/edit/archive
 * buttons): admin → all true; otherwise true only on agent/workflow rows
 * whose scope resource the actor OWNS. One query per scope type.
 */
export async function annotateMemoryManageRights<T extends MemoryScopeRef>(
  db: DbClient,
  actor: Actor,
  rows: readonly T[],
): Promise<Array<T & { canManage: boolean }>> {
  if (isResourceAdminActor(actor)) return rows.map((r) => ({ ...r, canManage: true }))
  const agentIds = [
    ...new Set(
      rows.filter((r) => r.scopeType === 'agent' && r.scopeId !== null).map((r) => r.scopeId!),
    ),
  ]
  const workflowIds = [
    ...new Set(
      rows.filter((r) => r.scopeType === 'workflow' && r.scopeId !== null).map((r) => r.scopeId!),
    ),
  ]
  const ownedAgents = new Set<string>()
  if (agentIds.length > 0) {
    const aRows = await db
      .select({ id: agentsTable.id, ownerUserId: agentsTable.ownerUserId })
      .from(agentsTable)
      .where(inArray(agentsTable.id, agentIds))
    for (const r of aRows) if (r.ownerUserId === actor.user.id) ownedAgents.add(r.id)
  }
  const ownedWorkflows = new Set<string>()
  if (workflowIds.length > 0) {
    const wRows = await db
      .select({ id: workflowsTable.id, ownerUserId: workflowsTable.ownerUserId })
      .from(workflowsTable)
      .where(inArray(workflowsTable.id, workflowIds))
    for (const r of wRows) if (r.ownerUserId === actor.user.id) ownedWorkflows.add(r.id)
  }
  return rows.map((r) => ({
    ...r,
    canManage:
      r.scopeType === 'agent'
        ? r.scopeId !== null && ownedAgents.has(r.scopeId)
        : r.scopeType === 'workflow'
          ? r.scopeId !== null && ownedWorkflows.has(r.scopeId)
          : false,
  }))
}
