// Parses a SKILL.md (YAML frontmatter + markdown body) into a typed shape
// suitable for ZIP-batch import. Pure function — no IO, no exceptions; YAML
// failures surface via `warnings`.
//
// Distinct from `agent-md.ts` because the SKILL.md schema is narrower (only
// `name` + `description` get first-class treatment; everything else lands in
// `frontmatterExtra`).

import { parse as parseYaml } from 'yaml'

/**
 * RFC-169 — is `relPath` the skill's protected main file (root `SKILL.md`)?
 *
 * The file-tree endpoints (`writeSkillFile` / `deleteSkillFile`) must never
 * write or delete the main file through an arbitrary relative path — users edit
 * it exclusively through `PUT /api/skills/:id/content`. Before RFC-169 the
 * write path had NO check at all (adding a file literally named `SKILL.md`
 * truncated it) and the delete path only did a raw `=== 'SKILL.md'` compare,
 * bypassable via `./SKILL.md`, a trailing separator (`SKILL.md/`, which
 * `safeJoin` resolves back to the root file), or case variants on a
 * case-insensitive filesystem.
 *
 * This is the LEXICAL guard, shared front + back: it canonicalizes the path
 * (normalize slashes, drop empty / `.` segments, reject anything but a single
 * root-level segment) and matches case-insensitively (NFC + lower-case) against
 * `skill.md`. Filesystem-equivalent names this lexical check can't see — e.g.
 * APFS folding `ſKILL.md` (U+017F long-s) onto the same inode as `SKILL.md` —
 * are caught by the backend's realpath / dev+inode fallback (design §5.2 F3);
 * on a case-sensitive filesystem those are genuinely different files and are
 * correctly allowed there.
 *
 * Pure — no IO. Nested `docs/SKILL.md` etc. are NOT the main file and stay
 * writable.
 */
export function isProtectedSkillMainFile(relPath: string): boolean {
  const segments = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  if (segments.length !== 1) return false
  return segments[0]!.normalize('NFC').toLowerCase() === 'skill.md'
}

export interface SkillMarkdownParseResult {
  name: string | undefined
  description: string
  bodyMd: string
  frontmatterExtra: Record<string, unknown>
  warnings: string[]
  hadFrontmatter: boolean
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function trimBody(body: string): string {
  return body.replace(/^[\s\r\n]+/, '').replace(/[\s\r\n]+$/, '')
}

export function parseSkillMarkdown(raw: string): SkillMarkdownParseResult {
  const warnings: string[] = []
  const match = raw.match(FRONTMATTER_RE)
  const hadFrontmatter = match !== null

  let data: Record<string, unknown> = {}
  let body: string

  if (!match) {
    body = raw
  } else {
    body = match[2] ?? ''
    const yamlSrc = match[1] ?? ''
    let parsed: unknown
    try {
      parsed = parseYaml(yamlSrc)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`yaml-parse-failed: ${message}`)
      parsed = null
    }
    if (parsed === null || parsed === undefined) {
      data = {}
    } else if (!isPlainObject(parsed)) {
      warnings.push('frontmatter-not-object: top-level YAML must be a mapping; ignored')
      data = {}
    } else {
      data = parsed
    }
  }

  let name: string | undefined
  if (data.name !== undefined) {
    if (isNonEmptyString(data.name)) {
      name = data.name
    } else {
      warnings.push('name must be non-empty string; ignored')
    }
  }

  let description = ''
  if (data.description !== undefined) {
    if (typeof data.description === 'string') {
      description = data.description
    } else {
      warnings.push('description must be string; ignored')
    }
  }

  const frontmatterExtra: Record<string, unknown> = {}
  for (const key of Object.keys(data)) {
    if (key === 'name' || key === 'description') continue
    frontmatterExtra[key] = data[key]
  }

  return {
    name,
    description,
    bodyMd: trimBody(body),
    frontmatterExtra,
    warnings,
    hadFrontmatter,
  }
}
