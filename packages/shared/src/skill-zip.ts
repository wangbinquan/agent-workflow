// RFC-019: pure logic for turning a decoded ZIP (list of `ZipEntryRef`) into
// a set of skill candidates ready to be written to disk.
//
// The decoding itself (fflate / safety limits / zip-slip) lives in the
// backend `services/skill-zip.ts`; this module only sees already-normalised
// entries (posix paths, no `..`, no leading `/`).

import { parseSkillMarkdown } from './skill-md'
import { SKILL_NAME_RE } from './schemas/skill'
import type { SkillZipError } from './schemas/skill'

// shared/tsconfig sets `lib: ["ES2022"]` so TextDecoder isn't in the global
// type space. It's part of every runtime we ship to (Bun + browser) so we
// just declare the slice we use.
declare const TextDecoder: {
  new (label?: string, opts?: { fatal?: boolean }): { decode(buf: Uint8Array): string }
}

/**
 * RFC-196: one source of truth for every ZIP safety limit. The backend owns
 * enforcement; the frontend only reads `totalBytes` for early file feedback.
 */
export const SKILL_ZIP_LIMITS = {
  totalBytes: 64 * 1024 * 1024,
  perFileBytes: 10 * 1024 * 1024,
  entries: 2000,
  depth: 12,
} as const

/** A normalised file entry from inside the uploaded ZIP. */
export interface ZipEntryRef {
  /** posix path inside the zip; never starts with '/', never contains '..'. */
  path: string
  isDir: boolean
  size: number
  /** lazy byte accessor — only called for entries we actually want to keep. */
  bytes: () => Uint8Array
}

export interface ZipFileSlice {
  /** Path relative to the skill directory (e.g. 'SKILL.md', 'reference/x.md'). */
  relPath: string
  bytes: Uint8Array
}

export interface SkillCandidate {
  /** kebab-case dirname inside the zip. */
  name: string
  description: string
  frontmatterExtra: Record<string, unknown>
  bodyMd: string
  /** Every file under the skill dir, including SKILL.md. */
  files: ZipFileSlice[]
  totalBytes: number
  warnings: string[]
}

export interface ParseSkillZipResult {
  skills: SkillCandidate[]
  errors: SkillZipError[]
}

function firstSegment(path: string): string {
  const slash = path.indexOf('/')
  return slash === -1 ? path : path.slice(0, slash)
}

function stripLeadingSegment(path: string, segment: string): string {
  const prefix = `${segment}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Returns the unique first path segments across all entries, in first-seen
 * order. Skips empty paths (which can occur for the root directory record).
 */
function topLevelSegments(entries: ZipEntryRef[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of entries) {
    if (e.path.length === 0) continue
    const head = firstSegment(e.path)
    if (head.length === 0) continue
    if (seen.has(head)) continue
    seen.add(head)
    out.push(head)
  }
  return out
}

/** True iff the entry sits *directly* inside `dir/` (one segment deeper, not nested). */
function isDirectChild(entry: ZipEntryRef, dir: string): boolean {
  const prefix = `${dir}/`
  if (!entry.path.startsWith(prefix)) return false
  const rest = entry.path.slice(prefix.length)
  if (rest.length === 0) return false
  return !rest.includes('/')
}

function hasSkillMdDirectlyUnder(entries: ZipEntryRef[], dir: string): boolean {
  return entries.some((e) => !e.isDir && isDirectChild(e, dir) && basename(e.path) === 'SKILL.md')
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/**
 * Detects whether the zip uses the "wrapper" layout (single top-level dir
 * containing the actual skill dirs) and, if so, peels the wrapper off so the
 * remaining work treats all zips uniformly as "top-level entries are skill
 * directories".
 *
 * Wrapper detection: top has exactly one segment AND that segment does *not*
 * have a SKILL.md directly inside (otherwise it's a single-skill zip, not a
 * wrapper).
 */
function peelWrapper(entries: ZipEntryRef[]): ZipEntryRef[] {
  const top = topLevelSegments(entries)
  if (top.length !== 1) return entries
  const wrapper = top[0]!
  if (hasSkillMdDirectlyUnder(entries, wrapper)) return entries
  return entries
    .map((e) => ({ ...e, path: stripLeadingSegment(e.path, wrapper) }))
    .filter((e) => e.path.length > 0)
}

function collectFilesFor(entries: ZipEntryRef[], skillDir: string): ZipFileSlice[] {
  const prefix = `${skillDir}/`
  const out: ZipFileSlice[] = []
  for (const e of entries) {
    if (e.isDir) continue
    if (!e.path.startsWith(prefix)) continue
    const relPath = e.path.slice(prefix.length)
    if (relPath.length === 0) continue
    out.push({ relPath, bytes: e.bytes() })
  }
  return out
}

function decodeSkillMd(files: ZipFileSlice[]): string | null {
  const md = files.find((f) => f.relPath === 'SKILL.md')
  if (!md) return null
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(md.bytes)
  } catch {
    return null
  }
}

/**
 * Build skill candidates from a decoded ZIP.
 *
 * Whole-zip validation (zip-slip, size limits, decode failures) is the
 * caller's responsibility and must happen before we get here. We trust paths
 * are already normalised to posix without `..` or leading `/`.
 */
export function parseSkillZipEntries(entries: ZipEntryRef[]): ParseSkillZipResult {
  const errors: SkillZipError[] = []

  const peeled = peelWrapper(entries)
  const topDirs = topLevelSegments(peeled)

  if (topDirs.length === 0) {
    errors.push({
      path: '',
      code: 'no-skill-found',
      message: 'zip contains no skill directory',
    })
    return { skills: [], errors }
  }

  // Detect duplicate top-level dir names (case-sensitive) ─ a zip can technically
  // contain `foo/` and `Foo/` but we treat them as ambiguous for skill import.
  const dupes = new Set<string>()
  const seen = new Map<string, string>()
  for (const dir of topDirs) {
    const key = dir.toLowerCase()
    if (seen.has(key) && seen.get(key) !== dir) {
      dupes.add(dir)
      dupes.add(seen.get(key)!)
    } else if (seen.has(key)) {
      dupes.add(dir)
    } else {
      seen.set(key, dir)
    }
  }

  const candidates: SkillCandidate[] = []

  for (const dir of topDirs) {
    if (dupes.has(dir)) {
      errors.push({
        path: dir,
        code: 'skill-name-duplicated-in-zip',
        message: `duplicate skill directory '${dir}' in zip (case-insensitive)`,
      })
      continue
    }

    if (!SKILL_NAME_RE.test(dir)) {
      errors.push({
        path: dir,
        code: 'skill-name-invalid',
        message: `'${dir}' is not a valid skill name (must match ${SKILL_NAME_RE.source})`,
      })
      continue
    }

    const files = collectFilesFor(peeled, dir)
    if (files.length === 0) {
      // Pure directory marker with no children — treat as missing SKILL.md.
      errors.push({
        path: dir,
        code: 'skill-md-missing',
        message: `skill '${dir}' has no files`,
      })
      continue
    }

    const skillMdText = decodeSkillMd(files)
    if (skillMdText === null) {
      errors.push({
        path: dir,
        code: 'skill-md-missing',
        message: `skill '${dir}' is missing SKILL.md`,
      })
      continue
    }

    const parsed = parseSkillMarkdown(skillMdText)
    const warnings = [...parsed.warnings]

    // SKILL.md `name` field is informational; the directory name wins because
    // that's what the file gets written under.
    if (parsed.name !== undefined && parsed.name !== dir) {
      warnings.push(
        `SKILL.md name='${parsed.name}' will be replaced by directory name '${dir}' on import`,
      )
    }

    const totalBytes = files.reduce((sum, f) => sum + f.bytes.byteLength, 0)

    candidates.push({
      name: dir,
      description: parsed.description,
      frontmatterExtra: parsed.frontmatterExtra,
      bodyMd: parsed.bodyMd,
      files,
      totalBytes,
      warnings,
    })
  }

  return { skills: candidates, errors }
}
