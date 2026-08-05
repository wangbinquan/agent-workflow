// RFC-254 T32 — ban `new URL(<file url>).pathname` repo-wide.
//
// WHY THIS GUARD EXISTS
// ---------------------
// `URL.pathname` is a URL component, not a filesystem path. On POSIX the two
// happen to coincide for `file:` URLs, so `path.dirname(new URL(import.meta.url)
// .pathname)` looks correct and passes everywhere the suite normally runs. On
// Windows the same expression yields `/C:/aw/packages/...`, and resolving that
// against the cwd produces the doubled-drive-letter path that showed up 125
// times in one frontend run:
//
//     Error: ENOENT: no such file or directory,
//            open 'C:\C:\aw\packages\frontend\src\styles.css'
//
// It also silently mangles any path containing a character that percent-encodes
// (a space becomes `%20`), which is wrong on BOTH platforms — this is not
// merely a Windows portability wart.
//
// `fileURLToPath()` from `node:url` is the correct conversion and is what this
// repo's own `vite.config.ts` / `vitest.config.ts` already use; the tests were
// the stragglers.
//
// SCOPE: only `import.meta.url`-derived (i.e. `file:`) URLs are banned. Reading
// `.pathname` off an HTTP request URL is completely legitimate and stays
// allowed, which is why the pattern below is anchored on `import.meta.url`.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const SCAN_DIRS = ['packages', 'e2e', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'test-results'])
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']

function walk(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXTS.some((x) => e.name.endsWith(x))) out.push(p)
  }
}

/** `new URL(...import.meta.url...).pathname` in any argument arrangement. */
const OFFENDER = /new URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/
const SELF = fileURLToPath(import.meta.url)

describe('RFC-254 T32 — no file-URL .pathname', () => {
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files)

  test('the scan actually reaches the source tree (guard against a silent empty sweep)', () => {
    // A guard that scans nothing passes forever. Anchor it on a floor that
    // cannot be met by an empty or mis-rooted walk.
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.endsWith(join('packages', 'backend', 'src', 'server.ts')))).toBe(
      true,
    )
  })

  test('no source file derives a filesystem path from URL.pathname', () => {
    const offenders: string[] = []
    for (const f of files) {
      // This file necessarily SPELLS the banned pattern — in its own header and
      // in the self-check below. A table-level guard matches literals in
      // comments too (the RFC-072 lesson), so it has to skip itself; the
      // self-check test is what keeps the regex honest instead.
      if (f === SELF) continue
      const src = readFileSync(f, 'utf-8')
      if (!OFFENDER.test(src)) continue
      for (const [i, line] of src.split(/\r?\n/).entries()) {
        if (OFFENDER.test(line)) {
          offenders.push(`${f.slice(REPO_ROOT.length + 1)}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    // Use fileURLToPath(import.meta.url) instead — see this file's header.
    expect(offenders).toEqual([])
  })

  test('the pattern it bans is the one that actually breaks (self-check)', () => {
    expect(OFFENDER.test('const d = path.dirname(new URL(import.meta.url).pathname)')).toBe(true)
    expect(OFFENDER.test("new URL('../x.ts', import.meta.url).pathname")).toBe(true)
    // HTTP request URLs keep their pathname — the ban is file-URL only.
    expect(OFFENDER.test('const p = new URL(request.url).pathname')).toBe(false)
    expect(OFFENDER.test('fileURLToPath(import.meta.url)')).toBe(false)
  })

  test('at least one real file was scanned for content, not just listed', () => {
    const self = files.find((f) => f.endsWith('rfc254-file-url-pathname-guard.test.ts'))
    expect(self).toBeDefined()
    expect(statSync(self!).size).toBeGreaterThan(0)
  })
})
