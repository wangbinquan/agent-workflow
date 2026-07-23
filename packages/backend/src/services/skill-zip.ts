// RFC-019: ZIP batch import for skills.
//
// decodeZip:   raw bytes → normalised entries (safety limits + zip-slip).
// parseSkillZip:   thin wrapper around shared parseSkillZipEntries that also
//                  decorates candidates with DB-conflict info.
// commitSkillZip:  applies a decision map and writes accepted candidates to
//                  ~/.agent-workflow/skills/{id}/files/.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { eq, inArray } from 'drizzle-orm'
import {
  parseSkillZipEntries,
  SKILL_ZIP_LIMITS,
  SKILL_NAME_RE,
  type CommitSkillZipResponse,
  type ParseSkillZipResponse,
  type ResourceVisibility,
  type Skill,
  type SkillCandidate,
  type SkillZipCandidateConflict,
  type SkillZipCandidateView,
  type SkillZipCommitFailure,
  type SkillZipCommitSkipped,
  type SkillZipDecisionMap,
  type SkillZipError,
  type SkillZipOverwriteCandidate,
  type ZipEntryRef,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { skills } from '@/db/schema'
import { createManagedSkillWithFiles, getSkillById } from '@/services/skill'
import { isSkillAvailableThisBoot } from '@/services/skillBootVerify'
import { decodeSkillToken, encodeSkillToken, skillTokenMatches } from '@/services/skillToken'
import { commitSkillVersion } from '@/services/skillVersion'
import { canViewResource, isResourceOwner } from '@/services/resourceAcl'
import { ConflictError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { stringifyFrontmatter } from '@/util/frontmatter'

const log = createLogger('skill-zip')

// Compatibility name retained for existing backend callers/tests. Safety
// enforcement remains here; RFC-196 only moves the values to shared so the
// frontend cannot drift from them.
export const ZIP_LIMITS = SKILL_ZIP_LIMITS

export interface SkillZipFsOptions {
  /** App home dir; managed skills live under `${appHome}/skills/{id}/files/`. */
  appHome: string
}

// --- decodeZip ---------------------------------------------------------------

/**
 * Decode a raw zip buffer into normalised entries. Throws ValidationError on
 * any structural / safety failure (zip-slip, oversized, traversal, decode
 * failure). Pure / no IO besides the fflate call.
 */
export function decodeZip(buffer: Uint8Array): ZipEntryRef[] {
  if (buffer.byteLength > ZIP_LIMITS.totalBytes) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `zip body exceeds ${ZIP_LIMITS.totalBytes} bytes`,
    )
  }

  let decoded: Record<string, Uint8Array>
  try {
    decoded = unzipSync(buffer)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ValidationError('zip-decode-failed', `failed to decode zip: ${message}`)
  }

  const rawEntries = Object.entries(decoded)
  if (rawEntries.length > ZIP_LIMITS.entries) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `zip has ${rawEntries.length} entries (limit ${ZIP_LIMITS.entries})`,
    )
  }

  const out: ZipEntryRef[] = []
  let totalBytes = 0

  for (const [rawPath, bytes] of rawEntries) {
    const normalisedPath = rawPath.replace(/\\/g, '/')

    if (normalisedPath.startsWith('/')) {
      throw new ValidationError(
        'zip-traversal',
        `absolute path inside zip is not allowed: ${rawPath}`,
      )
    }
    const segments = normalisedPath.split('/').filter((s) => s.length > 0)
    if (segments.some((seg) => seg === '..' || seg === '.')) {
      throw new ValidationError('zip-traversal', `path traversal segment in zip entry: ${rawPath}`)
    }
    if (segments.length > ZIP_LIMITS.depth) {
      throw new ValidationError(
        'zip-limit-exceeded',
        `zip entry too deep (${segments.length} > ${ZIP_LIMITS.depth}): ${rawPath}`,
      )
    }

    // fflate represents directory entries as zero-length byte arrays whose
    // original path ended with a slash.
    const isDir = rawPath.endsWith('/')
    const size = bytes.byteLength

    if (!isDir && size > ZIP_LIMITS.perFileBytes) {
      throw new ValidationError(
        'zip-limit-exceeded',
        `zip entry '${rawPath}' is ${size} bytes (limit ${ZIP_LIMITS.perFileBytes})`,
      )
    }
    totalBytes += size
    if (totalBytes > ZIP_LIMITS.totalBytes) {
      throw new ValidationError(
        'zip-limit-exceeded',
        `total uncompressed size exceeds ${ZIP_LIMITS.totalBytes} bytes`,
      )
    }

    // For directory entries fflate gives us a path with trailing `/`; strip
    // it so the shared parser sees a uniform shape.
    const path = isDir ? normalisedPath.replace(/\/$/, '') : normalisedPath
    if (path.length === 0) continue

    const cached = bytes
    out.push({ path, isDir, size, bytes: () => cached })
  }

  return out
}

// --- parse (HTTP-facing) -----------------------------------------------------

type SkillZipTargetRow = {
  id: string
  name: string
  ownerUserId: string | null
  visibility: ResourceVisibility
  aclRevision: number
  contentVersion: number
  metaRevision: number
  reservationState: 'reserving' | 'ready'
  versionState:
    | 'legacy-unbackfilled'
    | 'snapshot-unverified'
    | 'snapshot-authoritative'
    | 'quarantined'
}

async function listTargetRowsByName(
  db: DbClient,
  names: ReadonlyArray<string>,
): Promise<SkillZipTargetRow[]> {
  if (names.length === 0) return []
  return db
    .select({
      id: skills.id,
      name: skills.name,
      ownerUserId: skills.ownerUserId,
      visibility: skills.visibility,
      aclRevision: skills.aclRevision,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
      reservationState: skills.reservationState,
      versionState: skills.versionState,
    })
    .from(skills)
    .where(inArray(skills.name, [...new Set(names)]))
}

async function loadTargetRowById(db: DbClient, skillId: string): Promise<SkillZipTargetRow | null> {
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      ownerUserId: skills.ownerUserId,
      visibility: skills.visibility,
      aclRevision: skills.aclRevision,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
      reservationState: skills.reservationState,
      versionState: skills.versionState,
    })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1)
  return rows[0] ?? null
}

function targetIsAvailable(row: SkillZipTargetRow): boolean {
  return row.reservationState === 'ready' && isSkillAvailableThisBoot(row)
}

function toOverwriteCandidate(row: SkillZipTargetRow): SkillZipOverwriteCandidate {
  return {
    skillId: row.id,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    expectedAclRevision: row.aclRevision,
    expectedToken: encodeSkillToken({
      skillId: row.id,
      contentVersion: row.contentVersion,
      metaRevision: row.metaRevision,
    }),
  }
}

export async function parseSkillZipBuffer(
  db: DbClient,
  actor: Actor,
  buffer: Uint8Array,
): Promise<{ response: ParseSkillZipResponse; candidates: SkillCandidate[] }> {
  const entries = decodeZip(buffer)
  const parsed = parseSkillZipEntries(entries)

  const existing = await listTargetRowsByName(
    db,
    parsed.skills.map((candidate) => candidate.name),
  )
  const byName = new Map<string, SkillZipTargetRow[]>()
  for (const row of existing) {
    const rows = byName.get(row.name) ?? []
    rows.push(row)
    byName.set(row.name, rows)
  }

  const skillsView: SkillZipCandidateView[] = parsed.skills.map((c) => {
    const sameName = byName.get(c.name) ?? []
    const ownSlotOccupied = sameName.some((row) => row.ownerUserId === actor.user.id)
    const overwriteCandidates = sameName
      .filter((row) => targetIsAvailable(row) && isResourceOwner(actor, row))
      .sort((a, b) => {
        const ownerOrder = (a.ownerUserId ?? '').localeCompare(b.ownerUserId ?? '')
        return ownerOrder !== 0 ? ownerOrder : a.id.localeCompare(b.id)
      })
      .map(toOverwriteCandidate)
    const view: SkillZipCandidateView = {
      name: c.name,
      description: c.description,
      fileCount: c.files.length,
      totalBytes: c.totalBytes,
      warnings: c.warnings,
      ...(ownSlotOccupied
        ? { conflict: 'managed' as const satisfies SkillZipCandidateConflict }
        : {}),
      overwriteCandidates,
    }
    return view
  })

  return {
    response: { skills: skillsView, errors: parsed.errors satisfies SkillZipError[] },
    candidates: parsed.skills,
  }
}

// --- commit ------------------------------------------------------------------

interface CommitOutcome {
  created: Skill[]
  updated: Skill[]
  skipped: SkillZipCommitSkipped[]
  failed: SkillZipCommitFailure[]
}

export async function commitSkillZipBuffer(
  db: DbClient,
  opts: SkillZipFsOptions,
  buffer: Uint8Array,
  decisions: SkillZipDecisionMap,
  aclOpts: {
    actor: Actor
    /** Test-only race seam after preview checks, before the version funnel tx. */
    __beforeOverwriteVersionForTest?: (target: { skillId: string; candidateName: string }) => void
  },
): Promise<CommitSkillZipResponse> {
  // Re-parse only the archive at apply time. Existing DB rows are never
  // resolved again by name: overwrite decisions must bind the exact previewed
  // skillId and generation snapshot.
  const candidates = parseSkillZipEntries(decodeZip(buffer)).skills
  const decisionFor = new Map(Object.entries(decisions))

  // Track target names already touched in this commit so a rename collision
  // inside the batch is rejected just like a DB collision.
  const claimedNames = new Set<string>()

  const outcome: CommitOutcome = { created: [], updated: [], skipped: [], failed: [] }

  for (const candidate of candidates) {
    const decision = decisionFor.get(candidate.name)
    if (decision === undefined || decision.action === 'skip') {
      outcome.skipped.push({
        name: candidate.name,
        reason: decision === undefined ? 'no decision in request' : 'skipped by user',
      })
      continue
    }

    let targetName = candidate.name
    if (decision.action === 'rename') {
      targetName = decision.newName
    }

    if (!SKILL_NAME_RE.test(targetName)) {
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-name-invalid',
        message: `target name '${targetName}' is not a valid skill name`,
      })
      continue
    }

    if (claimedNames.has(targetName)) {
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-rename-conflict',
        message: `target name '${targetName}' already taken by another candidate in this import`,
      })
      continue
    }

    const overwriteDecision = decision.action === 'overwrite' ? decision : null
    const isOverwrite = overwriteDecision !== null
    let overwriteTarget: SkillZipTargetRow | null = null
    let overwriteFence:
      | { expectedSkillId: string; expectedVersion: number; expectedMetaRevision: number }
      | undefined

    if (isOverwrite) {
      const target = await loadTargetRowById(db, overwriteDecision.skillId)
      if (target === null) {
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-overwrite-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }

      // Missing, invisible, and no-longer-owned targets deliberately share
      // one response. A stolen or stale preview must not become an existence
      // or generation oracle for a resource the caller can no longer inspect.
      if (
        !(await canViewResource(db, aclOpts.actor, 'skill', target)) ||
        !isResourceOwner(aclOpts.actor, target)
      ) {
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-overwrite-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }
      if (!targetIsAvailable(target)) {
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-overwrite-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }

      const token = decodeSkillToken(overwriteDecision.expectedToken)
      if (
        target.name !== candidate.name ||
        overwriteDecision.expectedOwnerUserId !== target.ownerUserId ||
        overwriteDecision.expectedVisibility !== target.visibility ||
        overwriteDecision.expectedAclRevision !== target.aclRevision ||
        token === null ||
        !skillTokenMatches(token, {
          skillId: target.id,
          contentVersion: target.contentVersion,
          metaRevision: target.metaRevision,
        })
      ) {
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-overwrite-stale',
          message: 'the previewed overwrite target changed; review the ZIP again',
        })
        continue
      }
      overwriteTarget = target
      overwriteFence = {
        expectedSkillId: token.skillId,
        expectedVersion: token.contentVersion,
        expectedMetaRevision: token.metaRevision,
      }
    } else {
      // Import/rename claims only the actor's namespace. Another owner may hold
      // the same display name without blocking this create.
      const ownRows = await listTargetRowsByName(db, [targetName])
      const occupied = ownRows.filter((row) => row.ownerUserId === aclOpts.actor.user.id)
      if (occupied.length > 0) {
        const unavailable = occupied.every((row) => !targetIsAvailable(row))
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-rename-conflict',
          message: unavailable
            ? `target name '${targetName}' is held by an unavailable skill for this owner; pick a different name`
            : `skill '${targetName}' already exists for this owner; pick a different name or choose Overwrite`,
        })
        continue
      }
    }

    try {
      if (overwriteTarget === null) {
        // CREATE — route through the SAME reserve→v1-snapshot→ready pipeline as
        // POST /api/skills. The old direct live-write + bare row insert left
        // versionState='legacy-unbackfilled' with no snapshot, which the RFC-170
        // availability gate hides on a live daemon: the post-insert re-read came
        // back null and every zip create failed with "skill disappeared right
        // after insert" (unit tests passed — the gate is inactive there).
        const created = await createManagedSkillWithFiles(
          db,
          opts,
          {
            name: targetName,
            description: candidate.description,
            // RFC-099: the zip importer becomes owner; default 'public' (D18).
            ownerUserId: aclOpts.actor.user.id,
          },
          (filesDir) => writeCandidateFiles(filesDir, candidate, targetName),
        )
        outcome.created.push(created)
      } else {
        aclOpts.__beforeOverwriteVersionForTest?.({
          skillId: overwriteTarget.id,
          candidateName: candidate.name,
        })
        // OVERWRITE: route through the version funnel (RFC-170 §2 "ZIP overwrite" as
        // a version writer) — op-scoped staging + atomic publish + crash rollback +
        // the in-tx composite/owner fence (expectedOwnerUserId = the owner we
        // authorized against above, so a transfer in the await window → 409, not a
        // silent clobber). Replaces the old direct writeCandidate + updateManagedRow;
        // commitSkillVersion's setDescription keeps skills.description in sync + bumps
        // the version, and it archives the tree as an immutable snapshot.
        commitSkillVersion(
          db,
          opts,
          overwriteTarget.id,
          (staging) => {
            // Full replace: drop the funnel's live-seeded staging, lay down the ZIP tree.
            for (const e of readdirSync(staging))
              rmSync(join(staging, e), { recursive: true, force: true })
            writeCandidateFiles(staging, candidate, targetName)
          },
          {
            source: 'editor',
            authorUserId: aclOpts.actor.user.id,
            expectedOwnerUserId: overwriteDecision!.expectedOwnerUserId,
            expectedAclRevision: overwriteDecision!.expectedAclRevision,
            expectedVisibility: overwriteDecision!.expectedVisibility,
            ...overwriteFence,
            setDescription: candidate.description,
          },
        )
        const updated = await getSkillById(db, overwriteTarget.id)
        if (updated !== null) outcome.updated.push(updated)
      }
      claimedNames.add(targetName)
    } catch (err) {
      log.error('zip-commit: skill write failed', {
        candidate: candidate.name,
        target: targetName,
        error: err instanceof Error ? err.message : String(err),
      })
      // A name-in-use ConflictError here is the reserve INSERT losing a race
      // (or a squatter slipping past the pre-check) — report it as the same
      // conflict the pre-checks use, not as a generic write failure. No FS
      // cleanup in either path: the create funnel rolls back its own writes
      // (row + files + op), and the old best-effort rm of the target files dir
      // could delete a CONCURRENT winner's just-published live files.
      const isNameConflict = err instanceof ConflictError && err.code === 'skill-name-in-use'
      const isStaleOverwrite =
        isOverwrite && err instanceof ConflictError && err.code === 'skill-version-conflict'
      outcome.failed.push({
        name: candidate.name,
        code: isNameConflict
          ? 'skill-rename-conflict'
          : isStaleOverwrite
            ? 'skill-overwrite-stale'
            : 'skill-write-failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Surface candidates that weren't even attempted (decisions referenced
  // candidate names that don't exist in the zip).
  const candidateNames = new Set(candidates.map((c) => c.name))
  for (const name of decisionFor.keys()) {
    if (!candidateNames.has(name)) {
      outcome.skipped.push({ name, reason: 'no matching candidate in zip' })
    }
  }

  return outcome
}

/**
 * Lay a ZIP candidate's tree (support files + the generated SKILL.md) into an
 * arbitrary target dir — a live `files/` for a fresh create, OR an op-scoped
 * staging dir for the RFC-170 version-funnel overwrite. Path-traversal-safe.
 */
function writeCandidateFiles(
  targetDir: string,
  candidate: SkillCandidate,
  targetName: string,
): void {
  const safeRoot = resolve(targetDir) + sep
  mkdirSync(targetDir, { recursive: true })

  for (const file of candidate.files) {
    if (file.relPath === 'SKILL.md') continue // we re-write this below
    const dst = resolve(join(targetDir, file.relPath))
    if (!(dst + (file.relPath.endsWith('/') ? sep : '')).startsWith(safeRoot)) {
      throw new Error(`unsafe path resolved outside skill dir: ${file.relPath}`)
    }
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, file.bytes)
  }

  const skillMd = stringifyFrontmatter({
    data: {
      name: targetName,
      description: candidate.description,
      ...candidate.frontmatterExtra,
    },
    body: candidate.bodyMd,
  })
  writeFileSync(join(targetDir, 'SKILL.md'), skillMd, 'utf-8')

  // Sanity: directory must actually exist after write.
  if (!existsSync(join(targetDir, 'SKILL.md'))) {
    throw new Error('SKILL.md was not written')
  }
}

// The old direct-write create helpers (writeCandidate → live files/ +
// insertManagedRow → bare skills row) are gone: a bare row has no v1 snapshot
// (versionState 'legacy-unbackfilled'), so the RFC-170 boot availability gate
// hid it on a live daemon and the post-insert re-read failed with "skill
// disappeared right after insert". Creates now route through
// createManagedSkillWithFiles (reserve → v1 snapshot → ready), same as
// POST /api/skills; overwrites through commitSkillVersion, whose
// setDescription syncs skills.description inside the version-bump tx.
