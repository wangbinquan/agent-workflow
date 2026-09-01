// RFC-019: ZIP batch import for skills.
//
// decodeZip:   raw bytes → normalised entries (safety limits + zip-slip).
// parseSkillZip:   thin wrapper around shared parseSkillZipEntries that also
//                  decorates candidates with DB-conflict info.
// commitSkillZip:  applies a decision map and writes accepted candidates to
//                  ~/.agent-workflow/skills/{id}/files/.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Unzip, UnzipInflate, unzipSync, type UnzipFileInfo } from 'fflate'
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
import {
  createManagedSkillWithFiles,
  getSkillById,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { isSkillAvailableThisBoot } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import {
  decodeSkillToken,
  encodeSkillToken,
  skillTokenMatches,
} from '@/modules/resource-catalog/infrastructure/legacy/skillToken'
import { commitSkillVersion } from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import {
  canEditResource,
  canViewResource,
} from '@/modules/resource-catalog/composition/resourceAcl'
import { canEditRow } from '@/modules/resource-catalog/domain/resourceAccess'
import { listWritableGrantedResourceIds } from '@/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository'
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

type SafeZipPath = {
  path: string
  isDir: boolean
}

type ZipCentralEntry = {
  name: string
  compression: number
  originalSize: number
}

// `UnzipInflate` grows its output buffer for each compressed input chunk before
// yielding it. Keep those chunks deliberately small so even a forged ZIP whose
// central-directory size understates the real DEFLATE output can only create a
// bounded transient allocation before the actual-byte counters stop decoding.
const ZIP_STREAM_INPUT_CHUNK_BYTES = 4 * 1024

function safeZipPath(rawPath: string): SafeZipPath {
  const normalisedPath = rawPath.replace(/\\/g, '/')

  if (normalisedPath.startsWith('/')) {
    throw new ValidationError(
      'zip-traversal',
      `absolute path inside zip is not allowed: ${rawPath}`,
    )
  }
  const segments = normalisedPath.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    throw new ValidationError('zip-decode-failed', 'zip entry path is empty')
  }
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new ValidationError('zip-traversal', `path traversal segment in zip entry: ${rawPath}`)
  }
  if (segments.length > ZIP_LIMITS.depth) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `zip entry too deep (${segments.length} > ${ZIP_LIMITS.depth}): ${rawPath}`,
    )
  }

  const isDir = normalisedPath.endsWith('/')
  return {
    path: segments.join('/'),
    isDir,
  }
}

function zipDecodeError(err: unknown): ValidationError {
  if (err instanceof ValidationError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new ValidationError('zip-decode-failed', `failed to decode zip: ${message}`)
}

function centralEntryKey(entry: ZipCentralEntry): string {
  return JSON.stringify([entry.name, entry.compression, entry.originalSize])
}

/**
 * Parse and validate every central-directory record without extracting any
 * entry. `fflate` invokes `filter` before allocating the advertised output
 * buffer, so returning false for every record makes entry-count, path and
 * declared-size failures true pre-inflate checks instead of post-hoc checks.
 */
function preflightZip(buffer: Uint8Array): ZipCentralEntry[] {
  const entries: ZipCentralEntry[] = []
  const seenPaths = new Set<string>()
  let totalBytes = 0

  try {
    unzipSync(buffer, {
      filter: (entry: UnzipFileInfo) => {
        if (entries.length >= ZIP_LIMITS.entries) {
          throw new ValidationError(
            'zip-limit-exceeded',
            `zip has more than ${ZIP_LIMITS.entries} entries`,
          )
        }
        const safePath = safeZipPath(entry.name)
        if (seenPaths.has(safePath.path)) {
          throw new ValidationError(
            'zip-decode-failed',
            `duplicate normalized zip entry path '${safePath.path}'`,
          )
        }
        seenPaths.add(safePath.path)
        if (entry.compression !== 0 && entry.compression !== 8) {
          throw new ValidationError(
            'zip-decode-failed',
            `unsupported compression type ${entry.compression} for zip entry '${entry.name}'`,
          )
        }
        if (entry.originalSize > ZIP_LIMITS.perFileBytes) {
          throw new ValidationError(
            'zip-limit-exceeded',
            `zip entry '${entry.name}' declares ${entry.originalSize} bytes (limit ${ZIP_LIMITS.perFileBytes})`,
          )
        }
        totalBytes += entry.originalSize
        if (totalBytes > ZIP_LIMITS.totalBytes) {
          throw new ValidationError(
            'zip-limit-exceeded',
            `total uncompressed size exceeds ${ZIP_LIMITS.totalBytes} bytes`,
          )
        }
        entries.push({
          name: entry.name,
          compression: entry.compression,
          originalSize: entry.originalSize,
        })
        return false
      },
    })
  } catch (err) {
    throw zipDecodeError(err)
  }

  return entries
}

function mergeZipChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

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

  const centralEntries = preflightZip(buffer)
  const remainingCentralEntries = new Map<string, number>()
  for (const entry of centralEntries) {
    const key = centralEntryKey(entry)
    remainingCentralEntries.set(key, (remainingCentralEntries.get(key) ?? 0) + 1)
  }

  let failure: unknown
  const out: ZipEntryRef[] = []
  let totalBytes = 0
  let localEntryCount = 0

  const unzip = new Unzip((file) => {
    if (failure !== undefined) return
    localEntryCount += 1
    if (localEntryCount > ZIP_LIMITS.entries || localEntryCount > centralEntries.length) {
      failure = new ValidationError(
        'zip-limit-exceeded',
        `zip has more than ${ZIP_LIMITS.entries} entries`,
      )
      return
    }

    let safePath: SafeZipPath
    try {
      safePath = safeZipPath(file.name)
    } catch (err) {
      failure = err
      return
    }
    if (file.compression !== 0 && file.compression !== 8) {
      failure = new ValidationError(
        'zip-decode-failed',
        `unsupported compression type ${file.compression} for zip entry '${file.name}'`,
      )
      return
    }
    if (file.originalSize !== undefined && file.originalSize > ZIP_LIMITS.perFileBytes) {
      failure = new ValidationError(
        'zip-limit-exceeded',
        `zip entry '${file.name}' declares ${file.originalSize} bytes (limit ${ZIP_LIMITS.perFileBytes})`,
      )
      return
    }

    const chunks: Uint8Array[] = []
    let entryBytes = 0
    file.ondata = (err, chunk, final) => {
      if (failure !== undefined) return
      if (err) {
        failure = err
        return
      }
      if (chunk !== null && chunk.byteLength > 0) {
        const nextEntryBytes = entryBytes + chunk.byteLength
        if (nextEntryBytes > ZIP_LIMITS.perFileBytes) {
          failure = new ValidationError(
            'zip-limit-exceeded',
            `zip entry '${file.name}' exceeds ${ZIP_LIMITS.perFileBytes} bytes while inflating`,
          )
          file.terminate()
          return
        }
        const nextTotalBytes = totalBytes + chunk.byteLength
        if (nextTotalBytes > ZIP_LIMITS.totalBytes) {
          failure = new ValidationError(
            'zip-limit-exceeded',
            `total uncompressed size exceeds ${ZIP_LIMITS.totalBytes} bytes`,
          )
          file.terminate()
          return
        }
        chunks.push(chunk)
        entryBytes = nextEntryBytes
        totalBytes = nextTotalBytes
      }
      if (!final) return

      const centralKey = centralEntryKey({
        name: file.name,
        compression: file.compression,
        originalSize: entryBytes,
      })
      const remaining = remainingCentralEntries.get(centralKey) ?? 0
      if (remaining === 0) {
        failure = new ValidationError(
          'zip-decode-failed',
          `zip local header/output does not match central directory for '${file.name}'`,
        )
        return
      }
      if (remaining === 1) remainingCentralEntries.delete(centralKey)
      else remainingCentralEntries.set(centralKey, remaining - 1)

      if (safePath.path.length === 0) return
      const cached = mergeZipChunks(chunks, entryBytes)
      chunks.length = 0
      out.push({
        path: safePath.path,
        isDir: safePath.isDir,
        size: entryBytes,
        bytes: () => cached,
      })
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  try {
    for (let offset = 0; offset < buffer.byteLength; offset += ZIP_STREAM_INPUT_CHUNK_BYTES) {
      const end = Math.min(buffer.byteLength, offset + ZIP_STREAM_INPUT_CHUNK_BYTES)
      unzip.push(buffer.subarray(offset, end), end === buffer.byteLength)
      if (failure !== undefined) break
    }
  } catch (err) {
    failure ??= err
  }

  if (failure !== undefined) throw zipDecodeError(failure)
  if (localEntryCount !== centralEntries.length || remainingCentralEntries.size > 0) {
    throw new ValidationError(
      'zip-decode-failed',
      'zip local entries do not match the central directory',
    )
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
  // RFC-324 —— 覆盖候选的判据从「我是不是 owner」变成「我改不改得动」，而这里是
  // 同步 filter，所以先把这一类里我拿到 `write` 档的 id 预取一次。
  const writableSkillIds = await listWritableGrantedResourceIds(db, actor, 'skill')
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
      .filter((row) => targetIsAvailable(row) && canEditRow(actor, row, writableSkillIds))
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
          code: 'resource-operation-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }

      // Missing and invisible targets deliberately share one response. A
      // stolen or stale preview must not become an existence or generation
      // oracle for a resource the caller can no longer inspect.
      if (!(await canViewResource(db, aclOpts.actor, 'skill', target))) {
        outcome.failed.push({
          name: candidate.name,
          code: 'resource-operation-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }
      if (!(await canEditResource(db, aclOpts.actor, 'skill', target))) {
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-overwrite-forbidden',
          message: 'you can no longer overwrite the previewed skill; review the ZIP again',
        })
        continue
      }
      if (!targetIsAvailable(target)) {
        outcome.failed.push({
          name: candidate.name,
          code: 'resource-operation-stale',
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
          code: 'resource-operation-stale',
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
            // RFC-231: the ZIP importer becomes owner and the new row is private.
            ownerUserId: aclOpts.actor.user.id,
            actor: aclOpts.actor,
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
      // RFC-285 B5：技能版本围栏冲突已归一 resource-operation-stale（Q1/Q7）。
      const isStaleOverwrite =
        isOverwrite && err instanceof ConflictError && err.code === 'resource-operation-stale'
      outcome.failed.push({
        name: candidate.name,
        code: isNameConflict
          ? 'skill-rename-conflict'
          : isStaleOverwrite
            ? 'resource-operation-stale'
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
