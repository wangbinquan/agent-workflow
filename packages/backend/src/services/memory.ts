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
// The coarse `memory:*` gate is enforced by each route's own `registerRoute`
// declaration (routes/registry.ts); the CRUD helpers below do not re-check it,
// but they do require the caller to pass `adminUserId` for write paths so the
// audit trail (`approved_by_user_id`) is always populated. Row-level rights are
// a separate concern owned by this module: see canViewMemory / canManageMemory
// (RFC-099 D12), which follow the scope resource's ACL.

import { and, desc, eq, gt, inArray, like, or, getTableColumns } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  Memory,
  MemoryCandidatePromote,
  MemoryCreateRequest,
  MemoryListFilter,
  MemoryMoveRequest,
  MemoryPatchField,
  MemoryPatchRequest,
  MemoryScope,
  MemoryStatus,
  MemorySummary,
  MemoryWsMessage,
} from '@agent-workflow/shared'
import {
  MemoryMoveRequestSchema,
  MemoryPatchRequestSchema,
  MemorySchema,
  matchesTagFilter,
  normalizeStoredAdditionalPermissions,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  cachedRepos,
  memories,
  memoryDistillJobs,
  memoryScopeMoveEvents,
  repoGroups,
  userPermissionGrants,
  users,
} from '@/db/schema'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import { MEMORY_CHANNEL, memoryBroadcaster } from '@/ws/broadcaster'
import { buildActor, type Actor, type ActorSource } from '@/auth/actor'
import type {
  AuthenticatedPrincipal,
  CommandContext,
  DirectCommandContextFactory,
  PrincipalSource,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import type { ResourceScopeAuthorizationInTx } from '@/modules/resource-catalog/public/participants'
import type {
  ResourceMemoryScopeRef,
  ResourceScopeAccess,
} from '@/modules/resource-catalog/public/types'
import { hasResourceAclBypass } from '@/services/resourceAcl'

/** A memory row + its (possibly empty) supersede ancestor chain. */
export interface MemoryWithChain {
  memory: Memory
  /** From immediate parent (supersedes_id) outward, oldest last. */
  ancestors: Memory[]
}

interface MemoryRow {
  id: string
  scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
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
  fusedIntoSkillId: string | null
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

/** RFC-311：摘要路径的窄投影——除 `bodyMd` 外的全部列（新增列自动跟随）。 */
const SUMMARY_COLUMNS = Object.fromEntries(
  Object.entries(getTableColumns(memories)).filter(([k]) => k !== 'bodyMd'),
) as Omit<ReturnType<typeof getTableColumns<typeof memories>>, 'bodyMd'>

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
    fusedIntoSkillId: row.fusedIntoSkillId,
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
    fusedIntoSkillId: m.fusedIntoSkillId ?? null,
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
    fusedIntoSkillId: null,
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
  // RFC-311：**摘要路径不读正文**。`toSummary` 本来就把 `bodyMd` 丢掉，而此前 SQL 走的
  // 是 `select()` 全行——每一行都跟着把 markdown 正文读出来再在 JS 里扔掉。
  // /api/overview 的记忆计数正是这条路径：为了出一个数字，把整张表的正文搬了一遍
  // （性能防护网的「列表不碰重列」判据抓到）。`filter.search` 的 LIKE 在 WHERE 里，
  // 不需要正文出现在投影中。
  //
  // 摘要路径**不经过 `rowToMemory`**：那一步用 `MemorySchema` 校验完整记忆，正文非空
  // 是其不变量，拿占位符去凑会把「读得少」变成「写得假」。这里从窄行直接构造摘要。
  const wantBody = options.includeBody === true
  if (!wantBody) {
    const narrow = (await (where
      ? db.select(SUMMARY_COLUMNS).from(memories).where(where).orderBy(desc(memories.createdAt))
      : db.select(SUMMARY_COLUMNS).from(memories).orderBy(desc(memories.createdAt)))) as Array<
      Omit<MemoryRow, 'bodyMd'>
    >
    let summaries = narrow.map((r) => ({ row: r, tags: parseTags(r.tags) }))
    // RFC-327: 单值 `tag` 与多值 `tags` 走同一条语义（any/all，缺省 any）。
    // 标签是 JSON 列，SQL 没法可靠 AND/OR，仍在内存里判——与下面的整行读法同一实现。
    summaries = summaries.filter((x) => matchesTagFilter(x.tags, filter))
    const jobIds = new Set<string>()
    for (const { row } of summaries) {
      if (row.status === 'candidate' && row.distillJobId !== null) jobIds.add(row.distillJobId)
    }
    const langs = await loadJobOutputLangs(db, [...jobIds])
    return summaries.map(({ row, tags }) => ({
      id: row.id,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      title: row.title,
      status: row.status,
      tags,
      approvedAt: row.approvedAt,
      version: row.version,
      distillAction: row.distillAction,
      fusedIntoSkill: row.fusedIntoSkill ?? null,
      fusedIntoSkillId: row.fusedIntoSkillId ?? null,
      fusedIntoSkillVersion: row.fusedIntoSkillVersion ?? null,
      outputLang:
        row.status === 'candidate'
          ? row.distillJobId === null
            ? null
            : (langs.get(row.distillJobId) ?? null)
          : null,
    })) as MemorySummary[]
  }
  const rows = (await (where
    ? db.select().from(memories).where(where).orderBy(desc(memories.createdAt))
    : db.select().from(memories).orderBy(desc(memories.createdAt)))) as MemoryRow[]
  const items = rows.map(rowToMemory).filter((m) => matchesTagFilter(m.tags, filter))
  return items
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
 * RFC-045/RFC-342: in-place content edit of `title / body_md / tags` on
 * candidate, approved, or archived rows. Scope changes are rejected here and
 * belong exclusively to {@link moveMemory}. Terminal-status rows
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

export interface MemoryMutationTestHooks {
  /** Test-only fault seam after the SQL write but before transaction commit. */
  afterWriteInTx?: (tx: DbTxSync) => void
  /** Test-only seam for target-delete / authority-drift mutation proofs. */
  afterMoveAuthorizationInTx?: (tx: DbTxSync) => void
}

export async function patchMemory(
  db: DbClient,
  id: string,
  input: MemoryPatchRequest,
  editorUserId?: string,
  hooks: MemoryMutationTestHooks = {},
): Promise<PatchMemoryResult> {
  const raw = input as Record<string, unknown>
  if (
    Object.prototype.hasOwnProperty.call(raw, 'scopeType') ||
    Object.prototype.hasOwnProperty.call(raw, 'scopeId')
  ) {
    throw new ValidationError(
      'memory-scope-move-required',
      'scopeType and scopeId cannot be changed by generic PATCH; use the move command',
    )
  }
  const parsed = MemoryPatchRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('invalid-body', 'invalid patch request', parsed.error.format())
  }
  // RFC-093: synchronous transaction (dbTxSync) — the previous async form
  // COMMITted at its first await and provided no atomicity (audit S-10).
  const committed = dbTxSync(db, (tx) => {
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

    const synthTitle = parsed.data.title !== undefined ? parsed.data.title : row.title
    const synthBody = parsed.data.bodyMd !== undefined ? parsed.data.bodyMd : row.bodyMd
    const synthTags = parsed.data.tags !== undefined ? parsed.data.tags : parseTags(row.tags)

    // Re-validate the synthesized content through the full MemorySchema so
    // title/body/tag normalization keeps the same contract as create/read.
    // Scope is copied unchanged; the dedicated move command owns that field.
    const synthParsed = MemorySchema.safeParse({
      id: row.id,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
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
      fusedIntoSkillId: row.fusedIntoSkillId,
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
        title: synth.title,
        bodyMd: synth.bodyMd,
        tags: JSON.stringify(synth.tags),
        version: nextVersion,
      })
      .where(eq(memories.id, id))
      .run()
    hooks.afterWriteInTx?.(tx)

    const after = tx
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1)
      .all() as MemoryRow[]
    return { memory: rowToMemory(after[0]!), changedFields: changed }
  })
  if (committed.changedFields.length > 0) {
    publish({
      type: 'memory.updated',
      memoryId: id,
      changedFields: [...committed.changedFields],
      version: committed.memory.version,
    })
    // Audit/log delivery happens only after the durable transaction returns;
    // rollback must not leave a ghost observer record any more than ghost WS.
    console.log(
      `[memory-edited] id=${id} editedBy=${editorUserId ?? 'unknown'} fieldsChanged=${committed.changedFields.join(',')} version=${committed.memory.version}`,
    )
  }
  return committed
}

export interface MoveMemoryResult {
  memory: Memory
  moved: boolean
}

/** Composition-owned factory injected by the HTTP/WS bootstrap roots. */
export interface MemoryResourceScopeAuthorization {
  inTransaction(
    tx: DbTxSync,
    pair: Readonly<{ authority: RequestAuthority; actor: Actor }>,
  ): ResourceScopeAuthorizationInTx
}

/** Exact opaque authority handle and its admitted current actor projection. */
export interface MemoryResourceScopeAuthority {
  readonly authority: RequestAuthority
  readonly actor: Actor
  readonly authorization: MemoryResourceScopeAuthorization
}

/**
 * RFC-342 / RFC-294 P0-A — the only scope mutation path.
 *
 * The serialized command contains only the memory target, expected memory
 * revision and destination scope. Request identity comes from a factory-minted
 * CommandContext; current account permissions, resource grants and both scope
 * targets are re-read synchronously inside the same writer transaction.
 */
export function moveMemory(
  db: DbClient,
  contexts: DirectCommandContextFactory,
  context: CommandContext,
  authorization: MemoryResourceScopeAuthorization,
  id: string,
  input: MemoryMoveRequest,
  hooks: MemoryMutationTestHooks = {},
): MoveMemoryResult {
  const parsed = MemoryMoveRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('invalid-body', 'invalid move request', parsed.error.format())
  }
  const committed = dbTxSync(db, (tx) => {
    const authority = contexts.resolveCommandContext(context)
    const actor = currentMoveActorInTx(tx, authority)
    const row = tx.select().from(memories).where(eq(memories.id, id)).limit(1).get() as
      | MemoryRow
      | undefined
    if (row === undefined) {
      throw new NotFoundError('memory-not-found', `memory ${id} not found`)
    }
    if (row.version !== parsed.data.expectedVersion) {
      throw staleConflictError(
        'memory',
        `memory ${id} changed since version ${parsed.data.expectedVersion}; reload and retry`,
        {
          expectedVersion: parsed.data.expectedVersion,
          currentVersion: row.version,
        },
      )
    }
    if (row.status !== 'candidate') {
      throw new ConflictError(
        'memory-move-status-forbidden',
        `memory ${id} is '${row.status}'; only candidate memories may move scope`,
        { status: row.status },
      )
    }

    const previousScope: MemoryScopeRef = {
      scopeType: row.scopeType,
      scopeId: row.scopeId,
    }
    const nextScope: MemoryScopeRef = {
      scopeType: parsed.data.scopeType,
      scopeId: parsed.data.scopeId,
    }
    const scopeAuthority: MemoryResourceScopeAuthority = {
      authority: context.authority,
      actor,
      authorization,
    }
    assertMemoryScopeManageableInTx(tx, scopeAuthority, previousScope, 'current')
    assertMemoryScopeManageableInTx(tx, scopeAuthority, nextScope, 'destination')

    const scopeTypeChanged = previousScope.scopeType !== nextScope.scopeType
    const scopeIdChanged = previousScope.scopeId !== nextScope.scopeId
    if (!scopeTypeChanged && !scopeIdChanged) {
      return {
        memory: rowToMemory(row),
        moved: false,
        previousScope,
        changedFields: [] as Array<'scopeType' | 'scopeId'>,
      }
    }

    hooks.afterMoveAuthorizationInTx?.(tx)

    // The write transaction already excludes an external writer, but these
    // second reads lock the command against future same-transaction
    // participants and make target-delete/authority-drift mutation tests real.
    const refreshed = tx.select().from(memories).where(eq(memories.id, id)).limit(1).get() as
      | MemoryRow
      | undefined
    if (
      refreshed === undefined ||
      refreshed.version !== row.version ||
      refreshed.status !== row.status ||
      refreshed.scopeType !== row.scopeType ||
      refreshed.scopeId !== row.scopeId
    ) {
      throw staleConflictError('memory', `memory ${id} changed; reload and retry`, {
        expectedVersion: row.version,
        currentVersion: refreshed?.version,
      })
    }
    const refreshedActor = currentMoveActorInTx(tx, authority)
    const refreshedScopeAuthority: MemoryResourceScopeAuthority = {
      authority: context.authority,
      actor: refreshedActor,
      authorization,
    }
    assertMemoryScopeManageableInTx(tx, refreshedScopeAuthority, previousScope, 'current')
    assertMemoryScopeManageableInTx(tx, refreshedScopeAuthority, nextScope, 'destination')

    const nextVersion = row.version + 1
    const update = tx
      .update(memories)
      .set({
        scopeType: nextScope.scopeType,
        scopeId: nextScope.scopeId,
        version: nextVersion,
      })
      .where(and(eq(memories.id, id), eq(memories.version, row.version)))
      .run()
    if ((update as unknown as { changes?: number }).changes !== 1) {
      throw staleConflictError('memory', `memory ${id} changed; reload and retry`, {
        expectedVersion: row.version,
      })
    }
    tx.insert(memoryScopeMoveEvents)
      .values({
        id: context.operationId,
        memoryId: id,
        actorUserId: authority.userId,
        actorSource: authority.source,
        fromScopeType: previousScope.scopeType,
        fromScopeId: previousScope.scopeId,
        toScopeType: nextScope.scopeType,
        toScopeId: nextScope.scopeId,
        expectedVersion: row.version,
        resultingVersion: nextVersion,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
        occurredAt: context.now,
      })
      .run()
    hooks.afterWriteInTx?.(tx)

    const after = tx.select().from(memories).where(eq(memories.id, id)).limit(1).get() as
      | MemoryRow
      | undefined
    if (after === undefined) throw new Error('memory disappeared after scope move')
    return {
      memory: rowToMemory(after),
      moved: true,
      actorUserId: authority.userId,
      previousScope,
      changedFields: [
        ...(scopeTypeChanged ? (['scopeType'] as const) : []),
        ...(scopeIdChanged ? (['scopeId'] as const) : []),
      ],
    }
  })

  if (committed.moved) {
    publish({
      type: 'memory.updated',
      memoryId: id,
      changedFields: committed.changedFields,
      version: committed.memory.version,
    })
    console.log(
      `[memory-moved] id=${id} movedBy=${committed.actorUserId} from=${_scopeKey(committed.previousScope.scopeType, committed.previousScope.scopeId)} to=${_scopeKey(committed.memory.scopeType, committed.memory.scopeId)} version=${committed.memory.version} operationId=${context.operationId}`,
    )
  }
  return { memory: committed.memory, moved: committed.moved }
}

function currentMoveActorInTx(tx: DbTxSync, authority: AuthenticatedPrincipal): Actor {
  const user = tx
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      accessRevision: users.accessRevision,
    })
    .from(users)
    .where(eq(users.id, authority.userId))
    .limit(1)
    .get()
  if (user === undefined || user.status !== 'active') {
    throw new UnauthorizedError('request authority is no longer active')
  }
  const storedPermissions = tx
    .select({ permission: userPermissionGrants.permission })
    .from(userPermissionGrants)
    .where(eq(userPermissionGrants.userId, user.id))
    .all()
    .map((row) => row.permission)
  const additionalPermissions = normalizeStoredAdditionalPermissions({
    role: user.role,
    additionalPermissions: storedPermissions,
  }).additionalPermissions
  const source = actorSourceOf(authority.source)
  return buildActor({
    user,
    source,
    additionalPermissions,
    // PATs never regain system-domain resource-acl:bypass from their account.
    // The route already proved this token carries memory:update; this actor is
    // only the fresh row-scope oracle inside the command transaction.
    ...(source === 'pat' ? { patScopes: ['memory:update' as const] } : {}),
    authorityRevision: user.accessRevision,
  })
}

function actorSourceOf(source: PrincipalSource): ActorSource {
  if (source === 'session' || source === 'pat' || source === 'daemon') return source
  return 'daemon'
}

function assertMemoryScopeManageableInTx(
  tx: DbTxSync,
  authority: MemoryResourceScopeAuthority,
  scope: MemoryScopeRef,
  side: 'current' | 'destination',
): void {
  const actor = authority.actor
  if (scope.scopeType === 'global') {
    if (hasResourceAclBypass(actor)) return
    throw new ForbiddenError(
      'memory-scope-forbidden',
      `${side} global memory scope requires resource-acl:bypass`,
    )
  }
  if (scope.scopeId === null || scope.scopeId === '') {
    throw new ValidationError('invalid-body', `${scope.scopeType} scope requires scopeId`)
  }

  if (scope.scopeType === 'repo' || scope.scopeType === 'repo_group') {
    const exists =
      scope.scopeType === 'repo'
        ? tx
            .select({ id: cachedRepos.id })
            .from(cachedRepos)
            .where(eq(cachedRepos.id, scope.scopeId))
            .get()
        : tx
            .select({ id: repoGroups.id })
            .from(repoGroups)
            .where(eq(repoGroups.id, scope.scopeId))
            .get()
    if (exists === undefined && !(side === 'current' && hasResourceAclBypass(actor))) {
      throw new NotFoundError(
        'memory-scope-target-not-found',
        `${side} ${scope.scopeType} scope target not found`,
      )
    }
    if (hasResourceAclBypass(actor)) return
    throw new ForbiddenError(
      'memory-scope-forbidden',
      `${side} ${scope.scopeType} memory scope requires resource-acl:bypass`,
    )
  }

  const access = resourceScopeAccessInTx(tx, authority, scope)
  if (access === 'none') {
    if (side === 'current' && hasResourceAclBypass(actor)) return
    throw new NotFoundError(
      'memory-scope-target-not-found',
      `${side} ${scope.scopeType} scope target not found`,
    )
  }
  if (access !== 'write' && access !== 'own') {
    throw new ForbiddenError(
      'memory-scope-forbidden',
      `request authority cannot manage the ${side} ${scope.scopeType} scope`,
    )
  }
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
    skillId: string
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
        fusedIntoSkillId: args.skillId,
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
  args: { skillId: string; aboveVersion: number },
): string[] {
  const rows = tx
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.status, 'fused'),
        eq(memories.fusedIntoSkillId, args.skillId),
        gt(memories.fusedIntoSkillVersion, args.aboveVersion),
      ),
    )
    .all() as MemoryRow[]
  for (const row of rows) {
    tx.update(memories)
      .set({
        status: 'approved',
        fusedIntoSkillId: null,
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
// manageable by its owner (+ `resource-acl:bypass`); workflow-scoped rows
// likewise; repo and global rows stay all-readable / ACL-bypass-managed. Runtime
// injection (memoryInject.ts) is untouched — the daemon actor is `__system__`.
// ---------------------------------------------------------------------------

export interface MemoryScopeRef {
  // RFC-248: 第 5 种 scope。`repo_group` 与 repo/global 同档——全员可读、仅
  // 仅 ACL-bypass 可管（下面 canViewMemory / canManageMemory / filterVisibleMemories
  // 三处的提前放行分支）。
  scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  scopeId: string | null
}

function resourceMemoryScope(scope: MemoryScopeRef): ResourceMemoryScopeRef | null {
  if (
    (scope.scopeType !== 'agent' && scope.scopeType !== 'workflow') ||
    scope.scopeId === null ||
    scope.scopeId === ''
  ) {
    return null
  }
  return { kind: scope.scopeType, id: scope.scopeId }
}

function resourceScopeAccessInTx(
  tx: DbTxSync,
  authority: MemoryResourceScopeAuthority,
  scope: MemoryScopeRef,
): ResourceScopeAccess {
  const ref = resourceMemoryScope(scope)
  if (ref === null) return 'none'
  return authority.authorization.inTransaction(tx, authority).accessOf(authority.authority, ref)
}

/** Read visibility (D12): repo/global → everyone; agent/workflow → resource viewers. */
export async function canViewMemory(
  db: DbClient,
  authority: MemoryResourceScopeAuthority,
  scope: MemoryScopeRef,
): Promise<boolean> {
  const actor = authority.actor
  if (hasResourceAclBypass(actor)) return true
  // RFC-248 AC-29: repo_group 与 repo/global 同档——全员可读。
  if (
    scope.scopeType === 'repo' ||
    scope.scopeType === 'repo_group' ||
    scope.scopeType === 'global'
  ) {
    return true
  }
  return dbTxSync(db, (tx) => resourceScopeAccessInTx(tx, authority, scope) !== 'none')
}

/** Management rights (D12): scope-resource owner or ACL bypass; repo/global require bypass. */
export async function canManageMemory(
  db: DbClient,
  authority: MemoryResourceScopeAuthority,
  scope: MemoryScopeRef,
): Promise<boolean> {
  const actor = authority.actor
  if (hasResourceAclBypass(actor)) return true
  // RFC-248/RFC-305: repo_group 与 repo/global 同档——仅 ACL bypass 可管。
  if (
    scope.scopeType === 'repo' ||
    scope.scopeType === 'repo_group' ||
    scope.scopeType === 'global'
  ) {
    return false
  }
  // RFC-324 D9 —— 「随 scope 资源写权」现在包含 `write` 授权档：能改这个 agent /
  // workflow 的人，也能管它名下的记忆。读面（canViewMemory）不受影响。
  return dbTxSync(db, (tx) => {
    const access = resourceScopeAccessInTx(tx, authority, scope)
    return access === 'write' || access === 'own'
  })
}

/**
 * List filter: one pass that resolves the visible agent/workflow id sets,
 * then filters in memory. ACL-bypass actors short-circuit.
 */
export async function filterMemoriesByScopeVisibility<T extends MemoryScopeRef>(
  db: DbClient,
  authority: MemoryResourceScopeAuthority,
  rows: readonly T[],
): Promise<T[]> {
  const actor = authority.actor
  if (hasResourceAclBypass(actor)) return [...rows]
  const accessByScope = dbTxSync(db, (tx) => {
    const access = new Map<string, ResourceScopeAccess>()
    for (const row of rows) {
      const ref = resourceMemoryScope(row)
      if (ref === null) continue
      const key = `${ref.kind}:${ref.id}`
      if (!access.has(key)) access.set(key, resourceScopeAccessInTx(tx, authority, row))
    }
    return access
  })
  return rows.filter((r) => {
    // RFC-248 AC-29: repo_group 与 repo/global 同档。
    if (r.scopeType === 'repo' || r.scopeType === 'repo_group' || r.scopeType === 'global') {
      return true
    }
    if (r.scopeId === null) return false
    return accessByScope.get(`${r.scopeType}:${r.scopeId}`) !== 'none'
  })
}

/**
 * RFC-099 (D12) — stamp per-row `canManage` for the UI (approve/edit/archive
 * buttons): `resource-acl:bypass` → all true; otherwise true only on agent/workflow rows
 * whose scope resource the actor OWNS. One query per scope type.
 */
export async function annotateMemoryManageRights<T extends MemoryScopeRef>(
  db: DbClient,
  authority: MemoryResourceScopeAuthority,
  rows: readonly T[],
): Promise<Array<T & { canManage: boolean }>> {
  const actor = authority.actor
  if (hasResourceAclBypass(actor)) return rows.map((r) => ({ ...r, canManage: true }))
  const accessByScope = dbTxSync(db, (tx) => {
    const access = new Map<string, ResourceScopeAccess>()
    for (const row of rows) {
      const ref = resourceMemoryScope(row)
      if (ref === null) continue
      const key = `${ref.kind}:${ref.id}`
      if (!access.has(key)) access.set(key, resourceScopeAccessInTx(tx, authority, row))
    }
    return access
  })
  return rows.map((r) => ({
    ...r,
    canManage:
      (r.scopeType === 'agent' || r.scopeType === 'workflow') && r.scopeId !== null
        ? accessByScope.get(`${r.scopeType}:${r.scopeId}`) === 'own'
        : false,
  }))
}
