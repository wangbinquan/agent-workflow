// Guard: everything Playwright loads must run on NODE, not Bun.
//
// WHY THIS EXISTS (commit 86ebbf2d, CI runs on 2026-08-04)
// -------------------------------------------------------
// `bun run e2e` shells out to Playwright, and Playwright runs the spec files —
// and everything they import — on its OWN Node runner. RFC-254 T29 moved the
// fixture SQLite boundary onto `import { Database } from 'bun:sqlite'`, which
// Node cannot resolve. The failure is not a skipped test or a red assertion:
// the suite dies at LOAD time, before any test runs, with
//
//     Error: Only URLs with a scheme in: file, data, and node are supported
//     by the default ESM loader. Received protocol 'bun:'
//
// and Playwright then reports "No tests found" — which reads like a filter
// typo, not a broken import. All four e2e shards stayed down for four commits
// because nothing between `bun run test` and `git push` looks at this.
//
// The Bun-only work still exists; it lives in a CHILD process now
// (`e2e/fixtures/sqlite-exec.ts`, spawned by `e2e/command.ts`). That is the
// distinction this guard draws: the fixtures directory is executed BY Bun (the
// compiled stub, the sqlite runner) and may use it freely; the files Playwright
// itself imports may not.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const E2E_DIR = resolve(import.meta.dir, '..', '..', '..', 'e2e')

/** The files Playwright's Node runner loads: `e2e/*.ts`, fixtures excluded. */
function nodeLoadedFiles(): string[] {
  return readdirSync(E2E_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort()
}

const BUN_MODULE_IMPORT = /\bfrom\s+['"]bun:[^'"]+['"]/
// `Bun.` as a real reference — not the word inside a comment or a string.
const BUN_GLOBAL_USE = /(?<![\w.'"`])Bun\s*\.\s*[A-Za-z]/

function withoutCommentsOrStrings(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1')
    .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replaceAll(/`(?:[^`\\]|\\.)*`/g, '``')
}

describe('RFC-254 — the Playwright-loaded e2e files stay Node-compatible', () => {
  test('the scan actually sees files', () => {
    const files = nodeLoadedFiles()
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain('harness.ts')
    expect(files).toContain('command.ts')
  })

  test('none of them import a `bun:` module', () => {
    const offenders = nodeLoadedFiles().filter((name) =>
      BUN_MODULE_IMPORT.test(readFileSync(join(E2E_DIR, name), 'utf8')),
    )
    expect(offenders, 'these run under Node — move the Bun work into a child process').toEqual([])
  })

  test('none of them touch the `Bun` global', () => {
    const offenders = nodeLoadedFiles().filter((name) =>
      BUN_GLOBAL_USE.test(withoutCommentsOrStrings(readFileSync(join(E2E_DIR, name), 'utf8'))),
    )
    expect(offenders, '`Bun` is undefined under Node — spawn `bun` instead').toEqual([])
  })

  test('the Bun-side runner it delegates to is still there', () => {
    // If this file were renamed or removed, `runSqlite` would fail at RUN time
    // in every fixture that plants state — worth failing here instead.
    const runner = readFileSync(join(E2E_DIR, 'fixtures', 'sqlite-exec.ts'), 'utf8')
    expect(runner).toContain("from 'bun:sqlite'")
    expect(readFileSync(join(E2E_DIR, 'command.ts'), 'utf8')).toContain('sqlite-exec.ts')
  })
})
