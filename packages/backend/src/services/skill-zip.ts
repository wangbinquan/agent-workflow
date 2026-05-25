// RFC-019: ZIP batch import for skills.
//
// decodeZip:   raw bytes → normalised entries (safety limits + zip-slip).
// parseSkillZip:   thin wrapper around shared parseSkillZipEntries that also
//                  decorates candidates with DB-conflict info.
// commitSkillZip:  applies a decision map and writes accepted candidates to
//                  ~/.agent-workflow/skills/{name}/files/.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import {
  parseSkillZipEntries,
  SKILL_NAME_RE,
  type CommitSkillZipResponse,
  type ParseSkillZipResponse,
  type Skill,
  type SkillCandidate,
  type SkillZipCandidateView,
  type SkillZipCommitFailure,
  type SkillZipCommitSkipped,
  type SkillZipDecisionMap,
  type SkillZipError,
  type ZipEntryRef,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { skills } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getSkill, listSkills } from '@/services/skill'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { stringifyFrontmatter } from '@/util/frontmatter'

const log = createLogger('skill-zip')

// Safety limits — tuned for "a community skill pack with a handful of
// skills, each with a few KB of markdown + occasional small images".
export const ZIP_LIMITS = {
  /** Total uncompressed bytes across all entries. */
  totalBytes: 64 * 1024 * 1024,
  /** Single-entry uncompressed bytes. */
  perFileBytes: 10 * 1024 * 1024,
  /** Total entries (files + dirs). */
  entries: 2000,
  /** Maximum path depth (segments). */
  depth: 12,
} as const

export interface SkillZipFsOptions {
  /** App home dir; managed skills live under `${appHome}/skills/{name}/files/`. */
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

export async function parseSkillZipBuffer(
  db: DbClient,
  buffer: Uint8Array,
): Promise<{ response: ParseSkillZipResponse; candidates: SkillCandidate[] }> {
  const entries = decodeZip(buffer)
  const parsed = parseSkillZipEntries(entries)

  const existing = await listSkills(db)
  const byName = new Map(existing.map((s) => [s.name, s] as const))

  const skillsView: SkillZipCandidateView[] = parsed.skills.map((c) => {
    const conflict = byName.get(c.name)
    const view: SkillZipCandidateView = {
      name: c.name,
      description: c.description,
      fileCount: c.files.length,
      totalBytes: c.totalBytes,
      warnings: c.warnings,
    }
    if (conflict !== undefined) {
      view.conflict = conflict.sourceKind
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
): Promise<CommitSkillZipResponse> {
  const { candidates } = await parseSkillZipBuffer(db, buffer)
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

    const existing = await getSkill(db, targetName)
    const isOverwrite = decision.action === 'overwrite'
    const isRename = decision.action === 'rename'

    if (existing !== null && existing.sourceKind === 'external') {
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-external-cannot-overwrite',
        message: `skill '${targetName}' is external (managed by user); cannot overwrite via ZIP import`,
      })
      continue
    }

    if (existing !== null && !isOverwrite) {
      // Either action=import on top of an existing skill, or rename collided
      // with a DB row we didn't see during parse.
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-rename-conflict',
        message: `skill '${targetName}' already exists; pick a different name or choose Overwrite`,
      })
      continue
    }

    if (existing === null && isOverwrite) {
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-rename-conflict',
        message: `cannot overwrite '${targetName}': no such skill exists`,
      })
      continue
    }

    try {
      const result = writeCandidate(opts, candidate, targetName, existing)
      if (existing === null) {
        const created = await insertManagedRow(db, targetName, candidate.description)
        outcome.created.push(created)
      } else {
        const updated = await updateManagedRow(db, existing.id, candidate.description)
        outcome.updated.push(updated)
      }
      claimedNames.add(targetName)
      void result
    } catch (err) {
      // log-only: per-skill failure is reported back to the caller in
      // `outcome.failed` (the user-visible alert channel — the HTTP
      // response or the UI's import dialog renders this list). The
      // server-side log captures the underlying error message so
      // operators can debug pathological skill_zip uploads after the
      // fact without re-running the import.
      log.error('zip-commit: skill write failed', {
        candidate: candidate.name,
        target: targetName,
        error: err instanceof Error ? err.message : String(err),
      })
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-write-failed',
        message: err instanceof Error ? err.message : String(err),
      })
      // Best-effort cleanup of a partially written skill dir so the user
      // doesn't see an orphaned folder in /skills filesystem.
      if (isRename || existing === null) {
        const filesDir = join(opts.appHome, 'skills', targetName, 'files')
        try {
          rmSync(filesDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
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

function writeCandidate(
  opts: SkillZipFsOptions,
  candidate: SkillCandidate,
  targetName: string,
  existing: Skill | null,
): void {
  const filesDir = join(opts.appHome, 'skills', targetName, 'files')
  const safeRoot = resolve(filesDir) + sep

  if (existing !== null) {
    // Overwrite: wipe old files dir, then re-create.
    rmSync(filesDir, { recursive: true, force: true })
  }
  mkdirSync(filesDir, { recursive: true })

  for (const file of candidate.files) {
    if (file.relPath === 'SKILL.md') continue // we re-write this below
    const dst = resolve(join(filesDir, file.relPath))
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
  writeFileSync(join(filesDir, 'SKILL.md'), skillMd, 'utf-8')

  // Sanity: directory must actually exist after write.
  if (!existsSync(join(filesDir, 'SKILL.md'))) {
    throw new Error('SKILL.md was not written')
  }
}

async function insertManagedRow(db: DbClient, name: string, description: string): Promise<Skill> {
  const id = ulid()
  const now = Date.now()
  await db.insert(skills).values({
    id,
    name,
    description,
    sourceKind: 'managed',
    managedPath: `skills/${name}/files`,
    externalPath: null,
    createdAt: now,
    updatedAt: now,
  })
  const created = await getSkill(db, name)
  if (created === null) throw new Error('skill disappeared right after insert')
  return created
}

async function updateManagedRow(db: DbClient, id: string, description: string): Promise<Skill> {
  const now = Date.now()
  await db.update(skills).set({ description, updatedAt: now }).where(eq(skills.id, id))
  const rows = await db.select().from(skills).where(eq(skills.id, id)).limit(1)
  const row = rows[0]
  if (!row) throw new Error('skill row disappeared after update')
  // Re-fetch via getSkill so we get the same shape the parse path would.
  const refetched = await getSkill(db, row.name)
  if (refetched === null) throw new Error('refetch returned null')
  return refetched
}
