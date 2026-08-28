// RFC-067 — source-layer guards locking the runner / service / schema
// wiring against silent regressions. Targets:
//   (a) the opencode spawn env (RFC-111 PR-A: runtime/opencode/spawn.ts) must
//       inject ALL FOUR `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env keys in the SAME
//       conditional block, so a future refactor cannot ship a half identity to
//       opencode. (RunNodeOptions still declares the fields in runner.ts.)
//   (b) services/task.ts must persist the trimmed identity into the
//       tasks INSERT — and must NOT write to the worktree's `.git/config`
//       (which would race-overwrite across concurrent same-repo tasks;
//       see design.md §7 second point + AC-6 in the behavior tests).
//   (c) shared/schemas/task.ts must continue to expose the canonical
//       error codes `git-identity-incomplete` / `git-identity-email-invalid`
//       so the frontend can localize them when the server 422s.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const RUNNER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
  'utf-8',
)
// RFC-111 PR-A: the opencode spawn env (incl. the RFC-067 GIT_* injection) moved
// into the opencode runtime driver. RunNodeOptions still declares the fields in
// runner.ts; the env-key injection now lives in spawn.ts.
const SPAWN_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'opencode', 'spawn.ts'),
  'utf-8',
)
const TASK_SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf-8')
const SCHEMA_SRC = readFileSync(
  resolve(import.meta.dir, '..', '..', 'shared', 'src', 'schemas', 'task.ts'),
  'utf-8',
)
const SCHEDULER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf-8',
)
const NODE_MECHANICS_SRC = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'nodeMechanics.ts',
  ),
  'utf-8',
)
const WRAPPER_MECHANICS_SRC = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'wrapperMechanics.ts',
  ),
  'utf-8',
)

describe('RFC-067 source-text guards', () => {
  test('spawn.ts injects all four GIT_AUTHOR_* / GIT_COMMITTER_* env keys', () => {
    expect(SPAWN_SRC).toContain('GIT_AUTHOR_NAME')
    expect(SPAWN_SRC).toContain('GIT_AUTHOR_EMAIL')
    expect(SPAWN_SRC).toContain('GIT_COMMITTER_NAME')
    expect(SPAWN_SRC).toContain('GIT_COMMITTER_EMAIL')
  })

  test('spawn.ts gates the four-tuple behind a single AND check (no half identity)', () => {
    // The defensive `if (gitName.length > 0 && gitEmail.length > 0)` block
    // is the second line of defense after the schema's XOR superRefine.
    // A regression that splits these into two if blocks (one per pair)
    // could ship author-only or committer-only envs.
    expect(SPAWN_SRC).toMatch(
      /if\s*\(\s*gitName\.length\s*>\s*0\s*&&\s*gitEmail\.length\s*>\s*0\s*\)/,
    )
  })

  test('runner.ts RunNodeOptions declares gitUserName + gitUserEmail (optional, nullable)', () => {
    expect(RUNNER_SRC).toMatch(/gitUserName\?:\s*string\s*\|\s*null/)
    expect(RUNNER_SRC).toMatch(/gitUserEmail\?:\s*string\s*\|\s*null/)
  })

  test('task.ts persists the server-resolved identity into the tasks INSERT', () => {
    expect(TASK_SRC).toContain('resolveTaskGitCommitIdentity')
    expect(TASK_SRC).toContain('getUserGitCommitIdentity')
    expect(TASK_SRC).toContain('persistedGitUserName')
    expect(TASK_SRC).toContain('persistedGitUserEmail')
    expect(TASK_SRC).toMatch(/gitUserName:\s*persistedGitUserName/)
    expect(TASK_SRC).toMatch(/gitUserEmail:\s*persistedGitUserEmail/)
  })

  test('task.ts does NOT call runGit user.name / user.email on the worktree', () => {
    // Earlier draft of RFC-067 wrote `[user]` into the worktree's `.git/
    // config`. We dropped that path because `git config` inside a worktree
    // writes to the PARENT repo's shared `.git/config`, so two concurrent
    // tasks against the same source repo race-overwrite each other. If a
    // future commit reintroduces it, the AC-6 concurrent-isolation test
    // would re-fail; this grep is the canary that flags the wrong wiring
    // sooner (and forces a re-review of the design.md §7 trade-off).
    expect(TASK_SRC).not.toMatch(
      /runGit\(\s*worktreePath\s*,\s*\[\s*['"]config['"]\s*,\s*['"]user\./,
    )
  })

  test('task-execution mechanics thread task.gitUserName / Email through every runNode call', () => {
    // Three call sites today: agent-single dispatch + fanout shard +
    // fanout aggregator. All three must spread the per-task identity.
    const executionSource = `${SCHEDULER_SRC}\n${NODE_MECHANICS_SRC}\n${WRAPPER_MECHANICS_SRC}`
    const matches = executionSource.match(/gitUserName:\s*task\.gitUserName/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
    const emailMatches = executionSource.match(/gitUserEmail:\s*task\.gitUserEmail/g) ?? []
    expect(emailMatches.length).toBeGreaterThanOrEqual(3)
  })

  test('shared schema retires client-owned identity with one stable code', () => {
    expect(SCHEMA_SRC).toContain("'task-git-identity-client-owned'")
    expect(SCHEMA_SRC).toContain("'gitUserName'")
    expect(SCHEMA_SRC).toContain("'gitUserEmail'")
  })

  test('TaskSchema (shared) carries gitUserName + gitUserEmail nullable fields', () => {
    // Locks the response shape so /api/tasks/:id returns NULL columns
    // verbatim instead of dropping them (which would break the type
    // contract on the frontend).
    expect(SCHEMA_SRC).toMatch(/gitUserName:\s*z\.string\(\)\.nullable\(\)/)
    expect(SCHEMA_SRC).toMatch(/gitUserEmail:\s*z\.string\(\)\.nullable\(\)/)
  })
})
