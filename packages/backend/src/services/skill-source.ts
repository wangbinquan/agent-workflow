// RFC-017 skill-source service.
//
// A "skill source" is a registered parent directory whose direct child
// subdirectories (each containing a SKILL.md) are auto-imported as external
// skills + tagged with `sourceId`. Reconciled lazily on daemon boot and on
// every `GET /api/skills`.
//
// Storage model:
//   skill_sources (id, path, label, enabled, lastScannedAt, lastScanError)
//   skills.sourceId references skill_sources.id  (null for hand-imported rows)
//
// Discovery rules (design.md §4.1):
//   - direct child subdir + SKILL.md   → candidate skill (name = dir basename)
//   - subdir name must match SKILL_NAME_RE
//   - no recursion deeper than one level
//   - no SKILL.md → silently ignored as "just a folder"
//
// Conflict precedence (proposal §2.1 #3):
//   manually-imported managed/external  > first-registered source  > later source
//
// Reference guard (proposal §A5):
//   lazy delete of a source-derived skill is skipped if any agent.skills still
//   names it; the skipped report bubbles up and ends in lastScanError.
//   DELETE /api/skill-sources/:id enforces the same guard pre-cascade.

import type {
  Skill,
  SkillSkipReport,
  SkillSkipReason,
  SkillSource,
  SkillSourceWithStats,
} from '@agent-workflow/shared'
import { SKILL_NAME_RE } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import type { Dirent } from 'node:fs'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, skillSources, skills } from '@/db/schema'
import { getSkill, removeSkillRowAndFiles, type SkillFsOptions } from '@/services/skill'
import { requireResourceOwner } from '@/services/resourceAcl'
import { parseFrontmatter } from '@/util/frontmatter'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('skill-source')

// ---------------------------------------------------------------------------
// Pure discovery — exported for direct unit testing without touching DB.
// ---------------------------------------------------------------------------

export interface DiscoveredCandidate {
  /** Subdirectory name (== proposed skill name). */
  name: string
  /** Absolute path of the candidate subdirectory. */
  absPath: string
  /** Description harvested from SKILL.md frontmatter, defaulting to ''. */
  description: string
}

export interface DiscoverResult {
  candidates: DiscoveredCandidate[]
  skipped: SkillSkipReport[]
}

/**
 * Walk the direct children of `parentPath`, returning candidates and a skipped
 * report. Does NOT touch DB. Reasons for skipping mirror SkillSkipReason:
 *   no-skill-md / invalid-name / frontmatter-parse-failed
 *
 * Conflict-related reasons (name-conflict-*, still-referenced) only happen
 * inside reconcileSource where DB state is visible.
 */
export function discoverSkillsInDir(parentPath: string): DiscoverResult {
  const candidates: DiscoveredCandidate[] = []
  const skipped: SkillSkipReport[] = []

  let entries: Dirent[]
  try {
    entries = readdirSync(parentPath, { withFileTypes: true }) as Dirent[]
  } catch (e) {
    // Caller propagates this to lastScanError; here just return empty.
    log.warn('discoverSkillsInDir readdir failed', { parentPath, error: (e as Error).message })
    return { candidates, skipped }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const childAbs = join(parentPath, entry.name)
    if (!SKILL_NAME_RE.test(entry.name)) {
      skipped.push({
        childPath: childAbs,
        proposedName: entry.name,
        reason: 'invalid-name',
      })
      continue
    }
    const skillMd = join(childAbs, 'SKILL.md')
    if (!existsSync(skillMd)) {
      skipped.push({ childPath: childAbs, proposedName: entry.name, reason: 'no-skill-md' })
      continue
    }
    let description = ''
    try {
      const parsed = parseFrontmatter(readFileSync(skillMd, 'utf-8'))
      const d = parsed.data['description']
      description = typeof d === 'string' ? d : ''
    } catch (e) {
      skipped.push({
        childPath: childAbs,
        proposedName: entry.name,
        reason: 'frontmatter-parse-failed',
        detail: (e as Error).message,
      })
      continue
    }
    candidates.push({ name: entry.name, absPath: childAbs, description })
  }

  return { candidates, skipped }
}

// ---------------------------------------------------------------------------
// DB-aware service surface — see proposal §2.1 / design §4 for semantics.
// ---------------------------------------------------------------------------

type SkillSourceRow = typeof skillSources.$inferSelect

export interface ReconcileOutcome {
  imported: Skill[]
  deleted: string[]
  skipped: SkillSkipReport[]
}

/** List all source rows (no stats). */
export async function listSkillSources(db: DbClient): Promise<SkillSource[]> {
  const rows = await db.select().from(skillSources)
  return rows.map(rowToSource)
}

export async function listSkillSourcesWithStats(db: DbClient): Promise<SkillSourceWithStats[]> {
  const rows = await db.select().from(skillSources)
  const out: SkillSourceWithStats[] = []
  for (const row of rows) {
    const owned = await db.select({ id: skills.id }).from(skills).where(eq(skills.sourceId, row.id))
    const skipped = parseSkippedSummary(row.lastScanError)
    out.push({ ...rowToSource(row), childCount: owned.length, skipped })
  }
  return out
}

/**
 * RFC-103 T10 (12-RES): visibility filter for skill-source listings. A source's
 * local ABSOLUTE path (+ label / stats) is sensitive, so it is visible only to
 * an admin or its registrar (created_by). Sources predating RFC-099 (created_by
 * NULL) stay admin-only. Mirrors `requireSourceRegistrar`'s authorization rule
 * — pure so the route's `/api/skill-sources` filter is unit-testable.
 */
export function filterVisibleSkillSources<S extends { createdBy?: string | null }>(
  viewer: { isAdmin: boolean; userId: string | null },
  sources: readonly S[],
): S[] {
  if (viewer.isAdmin) return [...sources]
  return sources.filter((s) => s.createdBy != null && s.createdBy === viewer.userId)
}

export async function getSkillSource(db: DbClient, id: string): Promise<SkillSource | null> {
  const rows = await db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToSource(row) : null
}

export async function getSkillSourceWithStats(
  db: DbClient,
  id: string,
): Promise<SkillSourceWithStats | null> {
  const rows = await db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1)
  const row = rows[0]
  if (!row) return null
  const owned = await db.select({ id: skills.id }).from(skills).where(eq(skills.sourceId, row.id))
  return {
    ...rowToSource(row),
    childCount: owned.length,
    skipped: parseSkippedSummary(row.lastScanError),
  }
}

export interface CreateSourceInput {
  path: string
  label?: string
}

/**
 * Validate input + canonicalize path + insert row + first reconcile.
 * Errors thrown:
 *   skill-source-path-missing (422) / skill-source-path-not-dir (422) /
 *   skill-source-path-in-use (409)
 */
export async function createSkillSource(
  db: DbClient,
  input: CreateSourceInput,
  aclOpts?: { createdBy?: string },
): Promise<{ source: SkillSourceWithStats; outcome: ReconcileOutcome }> {
  const expanded = expandHome(input.path)
  if (!isAbsolute(expanded)) {
    throw new ValidationError(
      'skill-source-path-not-absolute',
      `path must be absolute: ${input.path}`,
    )
  }
  let real: string
  try {
    real = realpathSync(expanded)
  } catch {
    throw new ValidationError('skill-source-path-missing', `path does not exist: ${input.path}`)
  }
  if (!statSync(real).isDirectory()) {
    throw new ValidationError('skill-source-path-not-dir', `path is not a directory: ${input.path}`)
  }
  const existing = await db.select().from(skillSources).where(eq(skillSources.path, real)).limit(1)
  if (existing[0]) {
    throw new ConflictError('skill-source-path-in-use', `path already registered: ${real}`)
  }

  const id = ulid()
  const now = Date.now()
  const label = (input.label?.trim() || basename(real) || real).slice(0, 200)
  await db.insert(skillSources).values({
    id,
    path: real,
    label,
    enabled: true,
    lastScannedAt: null,
    lastScanError: null,
    // RFC-099 (D11): the registrar; skills imported from this source inherit
    // this user as their owner.
    createdBy: aclOpts?.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const fresh = await getSkillSource(db, id)
  if (fresh === null) throw new Error('skill source disappeared right after insert')
  const sourceRow = (await db.select().from(skillSources).where(eq(skillSources.id, id)))[0]!
  const outcome = await reconcileSource(db, sourceRow)
  const stats = await getSkillSourceWithStats(db, id)
  if (stats === null) throw new Error('skill source disappeared right after reconcile')
  return { source: stats, outcome }
}

export interface UpdateSourcePatch {
  label?: string
  enabled?: boolean
}

export async function updateSkillSource(
  db: DbClient,
  id: string,
  patch: UpdateSourcePatch,
): Promise<{ source: SkillSourceWithStats; outcome?: ReconcileOutcome }> {
  const existingRow = (
    await db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1)
  )[0]
  if (!existingRow) throw new NotFoundError('skill-source-not-found', `source '${id}' not found`)
  const set: Partial<typeof skillSources.$inferInsert> = { updatedAt: Date.now() }
  if (patch.label !== undefined) set.label = patch.label
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  if (Object.keys(set).length > 1) {
    await db.update(skillSources).set(set).where(eq(skillSources.id, id))
  }
  let outcome: ReconcileOutcome | undefined
  if (patch.enabled !== undefined && patch.enabled !== existingRow.enabled) {
    const refreshed = (
      await db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1)
    )[0]!
    if (refreshed.enabled) {
      outcome = await reconcileSource(db, refreshed)
    } else {
      // Disable: delete owned skills (subject to ref-guard).
      outcome = await purgeSourceChildren(db, refreshed)
    }
  }
  const stats = await getSkillSourceWithStats(db, id)
  if (stats === null) throw new Error('skill source vanished mid-update')
  const result: { source: SkillSourceWithStats; outcome?: ReconcileOutcome } = { source: stats }
  if (outcome !== undefined) result.outcome = outcome
  return result
}

/**
 * Delete a source. Pre-cascade guard: if any child skill is referenced by an
 * agent, throw `skill-source-children-referenced` (422) with a `blockers`
 * array detailing which agent holds which skill. Otherwise: drop all child
 * skills + the source row.
 */
export async function deleteSkillSource(db: DbClient, id: string): Promise<void> {
  const existingRow = (
    await db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1)
  )[0]
  if (!existingRow) throw new NotFoundError('skill-source-not-found', `source '${id}' not found`)

  const owned = await db.select().from(skills).where(eq(skills.sourceId, id))
  const blockers: Array<{ skillName: string; byAgent: string }> = []
  for (const r of owned) {
    const blocker = await firstAgentReferencing(db, r.name)
    if (blocker) blockers.push({ skillName: r.name, byAgent: blocker })
  }
  if (blockers.length > 0) {
    throw new ValidationError(
      'skill-source-children-referenced',
      `${blockers.length} child skill(s) still referenced by agents`,
      { blockers },
    )
  }
  await db.delete(skills).where(eq(skills.sourceId, id))
  await db.delete(skillSources).where(eq(skillSources.id, id))
}

/**
 * Manual rescan endpoint. Same as the lazy path but always runs end-to-end,
 * even if `enabled=false` (admin wanted explicit state refresh).
 */
export async function rescanSkillSource(db: DbClient, id: string): Promise<ReconcileOutcome> {
  const row = (await db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1))[0]
  if (!row) throw new NotFoundError('skill-source-not-found', `source '${id}' not found`)
  if (!row.enabled) {
    return purgeSourceChildren(db, row)
  }
  return reconcileSource(db, row)
}

/**
 * RFC-102: resolve a `name-conflict-*` by replacing the occupying same-named
 * skill with this source's version of `name`. The route layer has already
 * enforced source-registrar rights; here we enforce the second gate — write
 * permission on the *occupying* skill (owner/admin). This is the "no permission
 * ⇒ cannot replace" rule.
 *
 * Replacing keeps the skill `name`, so agent references stay valid; we drop the
 * occupier without the reference check (via removeSkillRowAndFiles) and let the
 * source reconcile re-import `name` as its own external skill. Idempotent: if
 * the occupier is already gone or already owned by this source, we just
 * reconcile and return.
 */
export async function replaceSourceConflict(
  db: DbClient,
  fsOpts: SkillFsOptions,
  actor: Actor,
  sourceId: string,
  name: string,
): Promise<{ source: SkillSourceWithStats; replaced: string; imported: Skill }> {
  const sourceRow = (
    await db.select().from(skillSources).where(eq(skillSources.id, sourceId)).limit(1)
  )[0]
  if (!sourceRow) {
    throw new NotFoundError('skill-source-not-found', `source '${sourceId}' not found`)
  }
  // RFC-102 (Codex P2): a disabled source's children are purged, not imported —
  // resolving a conflict against it would resurrect a child that lazy reconcile
  // skips and never cleans up. Reject until the source is re-enabled.
  if (!sourceRow.enabled) {
    throw new ValidationError(
      'skill-source-disabled',
      `source '${sourceId}' is disabled; re-enable it before resolving conflicts`,
    )
  }

  // `name` must still be a live candidate under the source directory.
  const discovered = discoverSkillsInDir(sourceRow.path)
  if (!discovered.candidates.some((c) => c.name === name)) {
    throw new ValidationError(
      'skill-source-conflict-stale',
      `'${name}' is no longer an importable skill under this source`,
    )
  }

  const occupying = await getSkill(db, name)
  if (occupying !== null && occupying.sourceId !== sourceId) {
    // Second permission gate: replacing requires write permission on the
    // occupier (invisible private skills 404 here — can't replace what you
    // can't see, and we never leak the owner).
    await requireResourceOwner(db, actor, 'skill', occupying)
    // RFC-170 §6a: remove a MANAGED occupier through the crash-safe delete op
    // (root→.trash→DELETE row→clean, recoverable) instead of the old non-atomic
    // rmSync+DELETE. A crash between removing the occupier and reconcileSource
    // re-importing the source candidate is recovered at boot: ops-recovery settles
    // the delete, then reconcileAllSources (idempotent) re-inserts the external.
    if (occupying.sourceKind === 'managed') {
      const { deleteManagedSkillOp } = await import('@/services/skillDeleteOp')
      deleteManagedSkillOp(db, { appHome: fsOpts.appHome }, { id: occupying.id, name })
    } else {
      // External occupier: no managed directory — a single DB row drop is atomic.
      await removeSkillRowAndFiles(db, fsOpts, occupying)
    }
  }

  await reconcileSource(db, sourceRow)

  const imported = await getSkill(db, name)
  if (imported === null) {
    throw new ValidationError(
      'skill-source-conflict-stale',
      `'${name}' could not be imported from this source`,
    )
  }
  const stats = await getSkillSourceWithStats(db, sourceId)
  if (stats === null) throw new Error('skill source vanished mid-replace')
  return { source: stats, replaced: name, imported }
}

/**
 * Lazy entrypoint: reconcile every `enabled=true` source. Errors are swallowed
 * (lastScanError captures the per-source detail). Called by `listSkills` and
 * by daemon boot.
 */
export async function reconcileAllSources(db: DbClient): Promise<void> {
  const rows = await db.select().from(skillSources).where(eq(skillSources.enabled, true))
  for (const row of rows) {
    try {
      await reconcileSource(db, row)
    } catch (e) {
      log.warn('reconcileSource crashed; continuing other sources', {
        id: row.id,
        path: row.path,
        error: (e as Error).message,
      })
    }
  }
}

/**
 * Single-source reconcile: discover children → filter conflicts vs DB →
 * upsert accepted candidates → delete rows no longer wanted (subject to
 * agent-reference guard) → write lastScannedAt + lastScanError summary.
 */
export async function reconcileSource(
  db: DbClient,
  source: SkillSourceRow,
): Promise<ReconcileOutcome> {
  const skipped: SkillSkipReport[] = []
  let candidates: DiscoveredCandidate[] = []

  // Treat the parent path missing / unreadable as transient — don't delete
  // owned children (protect against an NFS / external drive being temporarily
  // unmounted; design §7).
  if (!existsSync(source.path)) {
    await db
      .update(skillSources)
      .set({ lastScanError: 'path-missing', lastScannedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(skillSources.id, source.id))
    return { imported: [], deleted: [], skipped: [] }
  }

  try {
    const discovered = discoverSkillsInDir(source.path)
    candidates = discovered.candidates
    skipped.push(...discovered.skipped)
  } catch (e) {
    await db
      .update(skillSources)
      .set({
        lastScanError: `discover-failed:${(e as Error).message}`,
        lastScannedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(skillSources.id, source.id))
    return { imported: [], deleted: [], skipped }
  }

  // Conflict filter — look at the full skills table once.
  const existingByName = new Map<string, typeof skills.$inferSelect>()
  for (const r of await db.select().from(skills)) {
    existingByName.set(r.name, r)
  }
  const accepted: DiscoveredCandidate[] = []
  for (const c of candidates) {
    const exist = existingByName.get(c.name)
    if (!exist) {
      accepted.push(c)
      continue
    }
    if (exist.sourceId === source.id) {
      accepted.push(c)
      continue
    }
    if (exist.sourceId === null) {
      skipped.push({ childPath: c.absPath, proposedName: c.name, reason: 'name-conflict-manual' })
      continue
    }
    skipped.push({ childPath: c.absPath, proposedName: c.name, reason: 'name-conflict-source' })
  }

  // Diff against currently-owned rows.
  const wanted = new Set(accepted.map((c) => c.name))
  const owned = await db.select().from(skills).where(eq(skills.sourceId, source.id))
  const toDelete: Array<typeof skills.$inferSelect> = []
  for (const r of owned) {
    if (wanted.has(r.name)) continue
    if (await isReferencedByAgent(db, r.name)) {
      skipped.push({
        childPath: r.externalPath ?? '',
        proposedName: r.name,
        reason: 'still-referenced',
      })
      continue
    }
    toDelete.push(r)
  }

  // `imported` reports the *delta* (newly inserted candidates) so the UI can
  // surface "added N, removed M" after a rescan. Same-source updates of
  // description/path happen silently (they're not new arrivals).
  const imported: Skill[] = []
  const now = Date.now()
  for (const c of accepted) {
    const exist = existingByName.get(c.name)
    if (exist && exist.sourceId === source.id) {
      await db
        .update(skills)
        .set({
          description: c.description,
          externalPath: c.absPath,
          updatedAt: now,
        })
        .where(eq(skills.id, exist.id))
      continue
    }
    if (!exist) {
      await db.insert(skills).values({
        id: ulid(),
        name: c.name,
        description: c.description,
        sourceKind: 'external',
        managedPath: null,
        externalPath: c.absPath,
        sourceId: source.id,
        // RFC-099 (D11): imported skills inherit the source registrar as owner.
        ownerUserId: source.createdBy ?? null,
        visibility: 'public',
        createdAt: now,
        updatedAt: now,
      })
      const refreshed = (await db.select().from(skills).where(eq(skills.name, c.name)).limit(1))[0]
      if (refreshed) imported.push(skillRowToShape(refreshed))
    }
  }
  for (const r of toDelete) {
    await db.delete(skills).where(eq(skills.id, r.id))
  }

  await db
    .update(skillSources)
    .set({
      lastScannedAt: now,
      lastScanError: skipped.length === 0 ? null : summarizeSkipped(skipped),
      updatedAt: now,
    })
    .where(eq(skillSources.id, source.id))

  return { imported, deleted: toDelete.map((r) => r.name), skipped }
}

async function purgeSourceChildren(
  db: DbClient,
  source: SkillSourceRow,
): Promise<ReconcileOutcome> {
  const skipped: SkillSkipReport[] = []
  const owned = await db.select().from(skills).where(eq(skills.sourceId, source.id))
  const toDelete: Array<typeof skills.$inferSelect> = []
  for (const r of owned) {
    if (await isReferencedByAgent(db, r.name)) {
      skipped.push({
        childPath: r.externalPath ?? '',
        proposedName: r.name,
        reason: 'still-referenced',
      })
      continue
    }
    toDelete.push(r)
  }
  for (const r of toDelete) {
    await db.delete(skills).where(eq(skills.id, r.id))
  }
  await db
    .update(skillSources)
    .set({
      lastScannedAt: Date.now(),
      lastScanError: skipped.length === 0 ? null : summarizeSkipped(skipped),
      updatedAt: Date.now(),
    })
    .where(eq(skillSources.id, source.id))
  return { imported: [], deleted: toDelete.map((r) => r.name), skipped }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True iff some agent's `skills` JSON-array names this skill. */
export async function isReferencedByAgent(db: DbClient, skillName: string): Promise<boolean> {
  return (await firstAgentReferencing(db, skillName)) !== null
}

export async function firstAgentReferencing(
  db: DbClient,
  skillName: string,
): Promise<string | null> {
  const rows = await db.select({ name: agents.name, skills: agents.skills }).from(agents)
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.skills) as unknown
      if (Array.isArray(arr) && arr.includes(skillName)) return r.name
    } catch {
      continue
    }
  }
  return null
}

function rowToSource(row: SkillSourceRow): SkillSource {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    enabled: row.enabled,
    lastScannedAt: row.lastScannedAt ?? null,
    lastScanError: row.lastScanError ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function skillRowToShape(row: typeof skills.$inferSelect): Skill {
  const out: Skill = {
    id: row.id,
    name: row.name,
    description: row.description,
    // RFC-099 ACL projection — routes filter on these.
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    sourceKind: row.sourceKind as 'managed' | 'external',
    schemaVersion: row.schemaVersion,
    contentVersion: row.contentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.managedPath !== null) out.managedPath = row.managedPath
  if (row.externalPath !== null) out.externalPath = row.externalPath
  if (row.sourceId !== null) out.sourceId = row.sourceId
  return out
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  if (p === '~') return homedir()
  return resolve(p)
}

/**
 * Encode a skipped list back into a stable, parseable string for the
 * `lastScanError` column. Format:
 *   skipped|<reason>:<name>|<reason>:<name>|...
 * UI reads this back into structured reports (see parseSkippedSummary).
 */
export function summarizeSkipped(skipped: SkillSkipReport[]): string {
  const parts = skipped.map((s) => `${s.reason}:${s.proposedName ?? ''}`)
  return `skipped|${parts.join('|')}`
}

export function parseSkippedSummary(raw: string | null): SkillSkipReport[] {
  if (!raw || !raw.startsWith('skipped|')) return []
  const body = raw.slice('skipped|'.length)
  if (body.length === 0) return []
  const out: SkillSkipReport[] = []
  for (const chunk of body.split('|')) {
    const idx = chunk.indexOf(':')
    if (idx < 0) continue
    const reason = chunk.slice(0, idx) as SkillSkipReason
    const proposedName = chunk.slice(idx + 1)
    if (
      reason === 'no-skill-md' ||
      reason === 'invalid-name' ||
      reason === 'name-conflict-manual' ||
      reason === 'name-conflict-source' ||
      reason === 'frontmatter-parse-failed' ||
      reason === 'still-referenced'
    ) {
      const rep: SkillSkipReport = { childPath: '', reason }
      if (proposedName) rep.proposedName = proposedName
      out.push(rep)
    }
  }
  return out
}

// silence ts unused-import for `and` (kept for future query composition).
void and
