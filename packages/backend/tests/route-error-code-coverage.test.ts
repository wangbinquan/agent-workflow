// Route-local error codes must be named by at least one test.
//
// WHY THIS EXISTS
// ---------------
// The 2026-07-21 test-guard audit's most common escape class was 只测「该发生的」,
// 不测「不该发生的」: happy paths get written because a feature is not "done"
// without them, while the 4xx half has no product pressure behind it and nothing
// mechanical asking for it. Concretely, `routes/*.ts` throws 158 distinct error
// codes and a large slice of them appeared nowhere in any test.
//
// "Named by a test" is a deliberately strict criterion. Asserting a status range
// (`>= 400 && < 500`) passes no matter WHICH branch fired, so a guard can be
// deleted and its request answered by some other rejection with every test still
// green. That is not hypothetical: tightening the three path-traversal cases in
// worktree-files-proxy.test.ts revealed that two of them never reached the
// containment check at all (WHATWG URL parsing collapses `..` segments before
// routing), leaving `worktree-file-escapes-worktree` with zero real coverage
// while three tests appeared to guard it.
//
// This file is a RATCHET, not a demand to fix everything at once (the RFC-206
// route: baseline to stop the bleeding → burn it down → hard failure):
//   * a NEW error code with no test that names it fails immediately;
//   * an allowlist entry that gains coverage must be REMOVED from the list, so
//     the baseline can only shrink;
//   * an allowlist entry whose code no longer exists must also be removed.
//
// Scope note: only git-TRACKED route files are scanned. Local working trees on
// this repository routinely carry another session's in-flight route file, and a
// guard whose baseline differs between a developer's machine and CI is worse
// than no guard.
//
// See design/test-guard-audit-2026-07-21 gap B1-routes-7 / 逃逸机制③.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')

/** Error codes thrown from routes/*.ts: `new SomethingError('kebab-code', …)`. */
const ERROR_CTOR_RE = /new\s+\w*Error\s*\(\s*'([a-z0-9][a-z0-9-]*)'/g

function trackedFiles(pathspec: string): string[] {
  const proc = Bun.spawnSync(['git', 'ls-files', '-z', '--', pathspec], { cwd: repoRoot })
  if (proc.exitCode !== 0) {
    // Fail closed: a guard that silently degrades to "no files, therefore no
    // violations" is exactly the shape of the problems it exists to catch.
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(proc.stderr)}`)
  }
  return new TextDecoder()
    .decode(proc.stdout)
    .split('\0')
    .filter((p) => p.length > 0)
}

function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

/** Line + block comments removed, so prose can never stand in for an assertion. */
function stripComments(src: string): string {
  return stripLineComments(src.replace(/\/\*[\s\S]*?\*\//g, ' '))
}

// RFC-217 T4 moved the workgroup route-handler bodies (and the error codes
// they throw) into services/workgroup/{taskActions,configActions,dwActions}.ts;
// routes/workgroupTasks.ts is pure transport now. Those codes are still
// client-reachable route surface, so the scan follows them — narrowing the
// corpus would silently drop the ratchet's pressure on exactly those branches.
const routeFiles = [
  ...trackedFiles('packages/backend/src/routes/*.ts'),
  ...trackedFiles('packages/backend/src/services/workgroup/taskActions.ts'),
  ...trackedFiles('packages/backend/src/services/workgroup/configActions.ts'),
  ...trackedFiles('packages/backend/src/services/workgroup/dwActions.ts'),
]

const codeToFiles = new Map<string, Set<string>>()
for (const rel of routeFiles) {
  const src = stripLineComments(readFileSync(resolve(repoRoot, rel), 'utf8'))
  ERROR_CTOR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ERROR_CTOR_RE.exec(src)) !== null) {
    const code = m[1]!
    if (!codeToFiles.has(code)) codeToFiles.set(code, new Set())
    codeToFiles.get(code)!.add(rel.split('/').slice(-1)[0]!)
  }
}

// NOTE on pathspecs: git's default (non-`:(glob)`) wildmatch treats
// `dir/**/*.ts` as requiring at least one intermediate directory, so it silently
// matched 15 files instead of 793 here — the corpus was nearly empty while the
// "fails closed" sanity check still passed on the other roots. Pass DIRECTORY
// pathspecs and filter extensions in JS, which has no such subtlety.
const testCorpus = [
  ...trackedFiles('packages/backend/tests/'),
  ...trackedFiles('packages/frontend/tests/'),
  ...trackedFiles('packages/frontend/src/'),
  ...trackedFiles('packages/shared/'),
  ...trackedFiles('e2e/'),
]
  .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
  .filter((p) => !p.endsWith('route-error-code-coverage.test.ts'))
  // A tracked path can be missing on disk when a concurrent session has deleted
  // it without committing the deletion yet. Such a file contributes no test
  // text, so skipping it is equivalent — and far better than the whole guard
  // erroring out and being disabled.
  .flatMap((p) => {
    try {
      // Comments are stripped: a code merely MENTIONED in prose ("…leaving
      // `foo-bar` uncovered…") must not count as covered. Discovered while
      // mutation-testing this very guard — removing the real assertion left it
      // green because the code name survived in a nearby comment.
      return [stripComments(readFileSync(resolve(repoRoot, p), 'utf8'))]
    } catch {
      return []
    }
  })

function isNamedSomewhere(code: string): boolean {
  return testCorpus.some(
    (src) => src.includes(`'${code}'`) || src.includes(`"${code}"`) || src.includes(`\`${code}\``),
  )
}

// ---------------------------------------------------------------------------
// BASELINE — route error codes that no test names yet, frozen 2026-07-21.
//
// This list may only SHRINK. Adding to it requires a deliberate edit and shows
// up in review as "this change ships an unverifiable failure path".
//
// Each of these is a real gap: the branch exists, it can be reached by a client,
// and no test says what it does. Prioritise the ones on unauthenticated or
// destructive paths when burning the list down.
// ---------------------------------------------------------------------------
const UNCOVERED_BASELINE: readonly string[] = [
  'distill-job-not-failed',
  'distill-job-not-pending',
  'events-limit-invalid',
  'events-since-invalid',
  'fusion-invalid',
  'fusion-not-found',
  'fusion-reject-invalid',
  'invalid-filter',
  'members-invalid',
  'pat-invalid',
  'port-artifact-bad-item',
  'reset-invalid',
  'retry-request-invalid',
  'user-invalid',
  'workflow-draft-validation-invalid',
  'workgroup-assignment-not-found',
  'workgroup-message-invalid',
  'workgroup-rename-invalid',
  'workgroup-save-as-invalid',
  'workgroup-task-not-found',
]

describe('route-local error codes are named by tests', () => {
  test('the scan actually found routes and codes (fails closed)', () => {
    expect(routeFiles.length).toBeGreaterThan(20)
    expect(codeToFiles.size).toBeGreaterThan(100)
    // 793 backend test files alone at the time of writing. A pathspec that
    // silently matches a fraction of the corpus makes every "no offenders"
    // result meaningless, so keep this threshold near the real size rather
    // than at a token non-zero value.
    expect(testCorpus.length).toBeGreaterThan(1200)
  })

  test('no NEW error code ships without a test that names it', () => {
    const baseline = new Set(UNCOVERED_BASELINE)
    const offenders = [...codeToFiles.entries()]
      .filter(([code]) => !baseline.has(code))
      .filter(([code]) => !isNamedSomewhere(code))
      .map(([code, files]) => `${code}  (thrown in ${[...files].sort().join(', ')})`)
      .sort()
    expect(offenders).toEqual([])
  })

  test('the baseline only shrinks: entries that gained coverage must be removed', () => {
    const nowCovered = UNCOVERED_BASELINE.filter(
      (code) => codeToFiles.has(code) && isNamedSomewhere(code),
    )
    expect(nowCovered).toEqual([])
  })

  test('the baseline carries no stale entries for codes that no longer exist', () => {
    const gone = UNCOVERED_BASELINE.filter((code) => !codeToFiles.has(code))
    expect(gone).toEqual([])
  })
})
