// RFC-054 W1-7 — grep guard: route handlers must not use `as T` to bypass
// Zod validation on request bodies.
//
// LOCKS: the canonical anti-pattern this catches is
//
//   const body = (await c.req.json()) as MyType
//   ...use body.x without Zod parse...
//
// which moves request shape responsibility from a shared schema into ad-hoc
// runtime checks (or worse, no checks). The structural rule is: every body /
// query / param that crosses the route handler boundary must be validated
// with a shared Zod schema (`packages/shared/src/schemas/*.ts`) before use.
// `as Error` in catch blocks, `as Permission` narrowing from an already-
// validated array, etc. are still allowed because they're narrowings of
// types TypeScript can't infer on its own, not validation bypasses.
//
// New `as T` introductions that don't fit the allowlist → CI red. Lift an
// entry off the allowlist by refactoring to a Zod `safeParse`.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROUTES_DIR = resolve(import.meta.dir, '..', 'src', 'routes')

/**
 * Patterns that are NEVER cast bypasses — they're legitimate type narrowings
 * TypeScript can't infer on its own (catch-block error narrowing, scope
 * filtering of already-validated arrays, etc.). Listed by exact `as <Word>`
 * cast target.
 */
const ALLOWED_CAST_TARGETS = new Set<string>([
  'const', // `as const` — readonly tuple / literal narrowing
  'Hono', // Hono framework type
  'Error', // catch(err) { err as Error } — required for `.message` access
  'Permission', // narrowing string from validated scopes array → Permission enum
  'unknown', // `(await c.req.json()) as unknown` — the SAFE shape that forces
  // the next step to Zod-safeParse before use. This is the
  // opposite of the anti-pattern — it's the pattern we recommend.
])

/**
 * Specific (file, lineSnippet) pairs that are escape hatches with no clean
 * Zod alternative today. Each entry must include a `Reason:` line in the
 * source file pointing at the next refactor opportunity. Lift entries off
 * this allowlist by refactoring.
 *
 * Format: `<basename>:<exact line trim snippet (first 80 chars)>`.
 */
const FILE_LINE_ALLOWLIST = new Set<string>([
  // RFC-054 W1-7: documented TODOs — refactor to Zod safeParse on the
  // body schema. Manual `typeof` narrowing keeps these safe at runtime;
  // they're listed so new code doesn't follow the same pattern.
  'oidc-auth.ts:const body = (await safeJson(c.req.raw)) as Record<string, unknown>',
  // (RFC-099: the tasks.ts assignments PATCH handler that carried the same
  // cast was removed along with the node-assignment mechanism.)
  // (RFC-218: the multipart FormData-entries cast moved out of routes/tasks.ts
  // into services/launchMultipart.ts when the parser was extracted for the
  // agent launch route to share — no cast remains in routes/*.ts for it.)
  // (RFC-066 PR-A: the legacy `tasks.ts:repoPath: startInput.repoPath as
  // string,` entry was retired when the multipart handler was refactored
  // to narrow via an explicit `if (!multipartRepoPath) throw …` guard;
  // the cast disappeared and no zombie remains on this allowlist.)
])

interface Violation {
  file: string
  line: number
  text: string
  castTarget: string
}

/**
 * Strip both `/* … * /` and `// …` comments from TS source while preserving
 * line breaks (so line numbers don't shift). Uses a character-level lexer
 * instead of a naive regex because routes like `app.get('/*', …)` have a
 * literal `/*` inside a string that a regex-only approach mis-matches as the
 * start of a block comment.
 */
function stripComments(src: string): string {
  const out: string[] = new Array<string>(src.length)
  let outIdx = 0
  let inBlock = false
  let inString: '"' | "'" | '`' | null = null
  let escape = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (inBlock) {
      if (c === '*' && src[i + 1] === '/') {
        out[outIdx++] = ' '
        out[outIdx++] = ' '
        i++ // skip the '/'
        inBlock = false
        continue
      }
      // Preserve newlines so line numbers don't drift; replace any other
      // comment content with a space.
      out[outIdx++] = c === '\n' ? '\n' : ' '
      continue
    }
    if (escape) {
      escape = false
      out[outIdx++] = c
      continue
    }
    if (inString) {
      if (c === '\\') {
        escape = true
        out[outIdx++] = c
        continue
      }
      if (c === inString) inString = null
      out[outIdx++] = c
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      out[outIdx++] = c
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      // Line comment — skip to (but keep) the newline.
      while (i + 1 < src.length && src[i] !== '\n') i++
      out[outIdx++] = src[i] === '\n' ? '\n' : ''
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      out[outIdx++] = ' '
      out[outIdx++] = ' '
      inBlock = true
      i++ // skip the '*'
      continue
    }
    out[outIdx++] = c
  }
  return out.slice(0, outIdx).join('')
}

/** Skip lines that are import/export statements (where `as` is a rename
 *  alias, not a type cast). Be permissive — multi-line import blocks
 *  may have intermediate lines without `import` keyword. */
function isImportishLine(line: string, allLines: string[], lineIdx: number): boolean {
  // Line itself starts with import/export
  const trimmed = line.trimStart()
  if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) return true
  // Could be inside a multi-line import — walk back to find the opening
  // `import {` and check we haven't seen `}` yet.
  for (let i = lineIdx - 1; i >= 0 && i >= lineIdx - 30; i--) {
    const prev = allLines[i]!.trimStart()
    if (prev.includes('}')) return false // closed before our line
    if (prev.startsWith('import ') || prev.startsWith('export ')) return true
  }
  return false
}

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(ROUTES_DIR, f))
}

const CAST_RE = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Blank the contents of single/double-quoted string literals on ONE line
 * before cast matching, so prose inside a message string (e.g. "cannot add
 * the system user as a member", RFC-099 bda0d4fb) never scans as an `as`
 * cast. Escape-aware and PAIR-REQUIRED: an unpaired quote (regex literal
 * like /["]/) blanks nothing, so this step can only produce a false
 * POSITIVE (a flagged line someone inspects) — it can never hide a real
 * cast that sits outside a string. The stateful lexer above deliberately
 * does NOT blank strings for the same reason: a phantom string opened by a
 * regex-literal quote would swallow real code across lines.
 */
function blankLineStrings(line: string): string {
  return line.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, (m) =>
    m.length <= 2 ? m : m[0]! + ' '.repeat(m.length - 2) + m[m.length - 1]!,
  )
}

describe('blankLineStrings — cast-scan string blanking', () => {
  test('blanks prose inside quoted strings (the RFC-099 bda0d4fb false positive)', () => {
    const line = "throw new ValidationError('x', 'cannot add the system user as a member')"
    expect(blankLineStrings(line)).not.toMatch(/\bas\s+a\b/)
  })

  test('an unpaired quote (regex literal like /["]/) blanks nothing — later casts stay visible', () => {
    const line = 'const m = (raw.match(/["]/) ?? body) as UnsafeBody'
    expect(blankLineStrings(line)).toContain('as UnsafeBody')
  })

  test('escaped quotes do not end the pair early', () => {
    const line = "t('it\\'s counted as a member here')"
    expect(blankLineStrings(line)).not.toMatch(/\bas\s+a\b/)
  })

  test('a real cast between two string args survives blanking', () => {
    const line = `foo('a', body as UnsafeBody, "b")`
    expect(blankLineStrings(line)).toContain('as UnsafeBody')
  })
})

describe('RFC-054 W1-7 — routes/*.ts must not use `as T` to bypass Zod', () => {
  test('every `as Word` cast in route handlers is allowlisted or banned', () => {
    const files = listRouteFiles()
    expect(files.length).toBeGreaterThan(5) // sanity — there are ~20 routes

    const violations: Violation[] = []
    for (const f of files) {
      const basename = f.slice(ROUTES_DIR.length + 1)
      const lines = stripComments(readFileSync(f, 'utf-8')).split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (isImportishLine(line, lines, i)) continue
        // Match against the string-blanked view; keep snippet/allowlist keys
        // on the original line so FILE_LINE_ALLOWLIST entries stay stable.
        const scanLine = blankLineStrings(line)
        CAST_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = CAST_RE.exec(scanLine)) !== null) {
          const target = m[1]!
          if (ALLOWED_CAST_TARGETS.has(target)) continue
          const snippet = line.trim().slice(0, 80)
          const key = `${basename}:${snippet}`
          if (FILE_LINE_ALLOWLIST.has(key)) continue
          violations.push({ file: basename, line: i + 1, text: snippet, castTarget: target })
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}  cast→${v.castTarget}\n    ${v.text}`)
        .join('\n')
      throw new Error(
        `RFC-054 W1-7 — banned \`as T\` casts in routes/*.ts (${violations.length}):\n${msg}\n\n` +
          `Refactor to validate the source with a shared Zod schema:\n` +
          `  const parsed = MyBodySchema.safeParse(await safeJson(c.req.raw))\n` +
          `  if (!parsed.success) throw new ValidationError(...)\n` +
          `  const body = parsed.data\n\n` +
          `If the cast target is a legitimate narrowing TypeScript can't infer\n` +
          `(e.g. \`as Error\` in a catch block), add it to ALLOWED_CAST_TARGETS\n` +
          `in this test. If it's an escape hatch with no clean alternative,\n` +
          `add the file:snippet pair to FILE_LINE_ALLOWLIST and document the\n` +
          `reason inline in the source.`,
      )
    }
  })

  test('FILE_LINE_ALLOWLIST entries still match real source lines (no zombie entries)', () => {
    // Inverse — if an allowlisted line is removed by refactor, the allowlist
    // entry must come off too. This test reads each route file and verifies
    // every allowlist entry corresponds to a real (stripped-comment) line.
    const sources = new Map<string, string[]>()
    for (const f of listRouteFiles()) {
      const basename = f.slice(ROUTES_DIR.length + 1)
      sources.set(basename, stripComments(readFileSync(f, 'utf-8')).split('\n'))
    }
    const zombies: string[] = []
    for (const entry of FILE_LINE_ALLOWLIST) {
      const colon = entry.indexOf(':')
      if (colon === -1) {
        zombies.push(`malformed entry: ${entry}`)
        continue
      }
      const file = entry.slice(0, colon)
      const snippet = entry.slice(colon + 1)
      const lines = sources.get(file)
      if (!lines) {
        zombies.push(`${entry} (no such file in routes/)`)
        continue
      }
      const found = lines.some((l) => l.trim().slice(0, 80) === snippet)
      if (!found) {
        zombies.push(entry)
      }
    }
    if (zombies.length > 0) {
      throw new Error(
        `RFC-054 W1-7 — FILE_LINE_ALLOWLIST has ${zombies.length} stale entries:\n` +
          zombies.map((z) => `  ${z}`).join('\n') +
          '\n\nRemove the entry — the cast was refactored away.',
      )
    }
  })
})
