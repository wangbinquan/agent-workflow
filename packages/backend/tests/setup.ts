// Shared backend test isolation.
//
// `--isolate` gives every file a fresh global object, while cases inside one
// file still share process.env and cwd. Snapshot after suite-level beforeAll
// hooks and restore after each case so randomized neighbors inherit the suite
// baseline rather than the previous case's mutations.

import { afterEach, beforeEach } from 'bun:test'
import { readdirSync } from 'node:fs'

let envAtTestStart: NodeJS.ProcessEnv | undefined
let cwdAtTestStart: string | undefined
let cwdEntriesAtTestStart: Set<string> | undefined

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(snapshot, key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/**
 * Entries of `dir`, or undefined when it cannot be read (a test that chdir'd
 * into a directory it later removes must not turn the guard into the failure).
 */
function listEntries(dir: string): Set<string> | undefined {
  try {
    return new Set(readdirSync(dir))
  } catch {
    return undefined
  }
}

beforeEach(() => {
  envAtTestStart = { ...process.env }
  cwdAtTestStart = process.cwd()
  cwdEntriesAtTestStart = listEntries(cwdAtTestStart)
})

afterEach(() => {
  const env = envAtTestStart
  const cwd = cwdAtTestStart
  const entriesBefore = cwdEntriesAtTestStart
  envAtTestStart = undefined
  cwdAtTestStart = undefined
  cwdEntriesAtTestStart = undefined
  if (env !== undefined) restoreEnv(env)
  if (cwd !== undefined && process.cwd() !== cwd) process.chdir(cwd)

  // Working-directory leak invariant.
  //
  // A test that writes relative paths without first chdir'ing into a temp dir
  // deposits them in the repository root, and nothing in a path-based test
  // suite can see that: the assertions still pass, the files just pile up.
  // That is not hypothetical — `loadConfig('')` took a branch no test covered
  // and 21 suites spent two months depositing ~40 files per run into the repo
  // root (11493 files / 45 MB accumulated) with the gate green throughout.
  //
  // Resource leaks have no result to assert on, only an invariant, so it has to
  // be checked by the harness rather than by each author remembering to. This
  // is the cheapest possible form: one readdir of a single directory per test.
  //
  // If this fires: the test wrote into the repo (or wherever it was launched
  // from) instead of a temp dir — give it `mkdtempSync(join(tmpdir(), …))` and
  // clean up in afterEach, or chdir before the write.
  //
  // See design/test-guard-audit-2026-07-21 §3 结构守卫 G2 / 逃逸机制⑨.
  if (entriesBefore !== undefined && cwd !== undefined) {
    const after = listEntries(cwd)
    if (after !== undefined) {
      const leaked = [...after]
        .filter((entry) => !entriesBefore.has(entry))
        // Bun writes a transient `.<hash>-<n>.bun-build` file into cwd while
        // `Bun.build({ compile })` runs and removes it asynchronously (a few
        // tests shell out to the binary build). It is not a real leak — the
        // afterEach snapshot just catches it mid-flight. Ignoring the exact
        // pattern keeps the guard sound for genuine leaks without racing Bun's
        // own cleanup.
        .filter((entry) => !/^\.[0-9a-f]+-[0-9a-f]+\.bun-build$/.test(entry))
        .sort()
      if (leaked.length > 0) {
        throw new Error(
          `Test leaked ${leaked.length} entr${leaked.length === 1 ? 'y' : 'ies'} into its working directory (${cwd}):\n` +
            `${leaked.map((entry) => `  - ${entry}`).join('\n')}\n` +
            'Write to a temp dir instead (mkdtempSync(join(tmpdir(), …))) and clean it up.',
        )
      }
    }
  }
})
