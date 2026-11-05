// RFC-033-T2: source-code-level guard.
//
// Why: anywhere in services/repoBatchImport.ts that references row.inputUrl
// or builds a wire-bound message must funnel through redactGitUrl or
// clipAndRedact. If a future patch builds a snapshot row or WS payload from
// the raw URL without scrubbing, this assertion goes red so it surfaces in
// review instead of leaking a token to disk.
//
// Approach: read the file, then for every line that mentions `inputUrl`
// (excluding the type definition + the line that stores it into the
// MutableRow), require that the same logical block also calls redactGitUrl
// or clipAndRedact.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FILE = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'source-control',
  'infrastructure',
  'local',
  'repositoryBatchImport.ts',
)

describe('repoBatchImport redact guard (RFC-033)', () => {
  test('every wire-bound row uses redactGitUrl', () => {
    const src = readFileSync(FILE, 'utf-8')
    // The `rowToWire` function MUST run redactGitUrl on inputUrl.
    const rowToWire = extractFunction(src, 'rowToWire')
    expect(rowToWire).toContain('redactGitUrl')

    // clipAndRedact MUST call redactGitUrl on both the message AND the URL.
    const clipAndRedact = extractFunction(src, 'clipAndRedact')
    expect(clipAndRedact).toContain('redactGitUrl')
  })

  test('catch-handler funnels error message through clipAndRedact', () => {
    const src = readFileSync(FILE, 'utf-8')
    const runRow = extractFunction(src, 'runRow')
    // The catch arm must scrub via clipAndRedact, not assign err.message directly.
    expect(runRow).toContain('clipAndRedact')
  })
})

/** Return the body of the first top-level function/method `name`. */
function extractFunction(src: string, name: string): string {
  const re = new RegExp(`function\\s+${name}\\b[^{]*\\{`)
  const m = re.exec(src)
  if (!m) throw new Error(`function ${name} not found`)
  let depth = 0
  let i = m.index + m[0].length - 1
  const start = i
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
    i += 1
  }
  throw new Error(`could not find end of function ${name}`)
}
