// Regression guard: source files must not contain a literal NUL (\0) byte.
//
// RFC-113 PR-A landed `services/runtimeRegistry.ts` with two literal NUL bytes
// in profileKey's null-sentinel (`v == null ? '<NUL>' : …`) — the author meant
// the escape `'\x00'` but a raw 0x00 byte was written into the source instead.
// It was behavior-neutral at runtime (NUL is a valid string char + the dedup key
// only needs an in-band sentinel) AND tolerated by tsc/prettier/eslint/bun build,
// so every gate stayed green. But it silently turned the .ts file into a "binary"
// file: grep/ripgrep skip it ("binary file matches"), git diffs degrade, and the
// next maintainer can't search it. This guard fails loudly if any tracked source
// file picks up a NUL byte again.
//
// See the commit that fixed profileKey ('<NUL>' → '\x00').

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
// Impl-gate RFC-213 P2-11 (2026-07-22): tests/ joined the scan — two rfc213
// test files carried raw 0x00-0x02 inside string literals, which flips git diff
// to "Bin" and makes rg/grep silently skip the file: the whole
// [feedback_grep_locks_before_push] lock-sweep workflow goes blind on it.
const SCAN_DIRS = [
  'packages/backend/src',
  'packages/frontend/src',
  'packages/shared/src',
  'packages/backend/tests',
  'packages/frontend/tests',
  'packages/shared/tests',
].map((d) => join(REPO_ROOT, d))

const SOURCE_EXT = /\.(ts|tsx|js|jsx|css|json|md|sql)$/

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if (!SOURCE_EXT.test(entry.name)) continue
    // node 20+/bun: recursive Dirent.parentPath holds the dir; fall back to path.
    const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? dir
    out.push(join(parent, entry.name))
  }
  return out
}

describe('source files contain no literal NUL bytes (RFC-113 profileKey regression)', () => {
  for (const dir of SCAN_DIRS) {
    test(`no NUL byte under ${dir.replace(REPO_ROOT + '/', '')}`, () => {
      const offenders: string[] = []
      for (const file of sourceFilesUnder(dir)) {
        const buf = readFileSync(file)
        if (buf.includes(0)) offenders.push(file.replace(REPO_ROOT + '/', ''))
      }
      expect(offenders).toEqual([])
    })
  }
})
