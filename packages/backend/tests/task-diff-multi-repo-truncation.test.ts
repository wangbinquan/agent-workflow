// LOCKS: RFC-066 PR-B — getTaskDiff multi-repo byte-budget + all-clean fall-through.
// RFC-165: multi-repo/pre-created PATH bodies are the framework-internal face
// now (the wire is URL-only) — bodies are cast through the internal
// RepoSourceSpec widening; runtime behavior is byte-identical to pre-165.
//
// Sibling of task-diff-multi-repo.test.ts (B16/B17/B18), which only exercises
// the small-fixture path where `truncated === false`. This file locks the two
// boundaries those tests never reach (verified uncovered across backend /
// shared / frontend test suites):
//
//   T-A truncation branch: two repos each with a valid baseCommit whose
//       concatenated diff (headers + bodies) overflows TASK_DIFF_MAX_BYTES
//       (1 MiB, task.ts:1640). The byte-budget loop (task.ts:1709-1733) must
//       emit repo[0] in full, emit repo[1]'s header, then slice repo[1]'s body
//       to the remaining budget → `truncated === true`, `baseCommit === null`,
//       repo[0]'s `# === Repo:` header present, total bytes <= 1 MiB.
//   T-B all-clean-but-base-present fall-through: two repos BOTH with a recorded
//       baseCommit and an existing worktree, neither mutated. `usable.length`
//       is still > 0 so the `task-no-base-commit` 409 (task.ts:1700-1706) must
//       NOT be raised; every per-repo gitDiffSnapshot returns '' → each repo is
//       `continue`d (task.ts:1711) → returns { diff:'', baseCommit:null,
//       truncated:false } with NO header emitted. This is a distinct boundary
//       from B18 (one-of-two empty): here EVERY repo is empty.

import { afterEach, describe, expect, test } from 'bun:test'
import type { StartTask } from '@agent-workflow/shared'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { getTaskDiff, startTask } from '../src/services/task'
import { workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TASK_DIFF_MAX_BYTES = 1024 * 1024 // mirror of the cap in task.ts:1640.

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(repoCount: number): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc066-trunc-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc066-trunc-repos-'))
  const repos: string[] = []
  for (let i = 0; i < repoCount; i++) {
    const repoPath = mkdtempSync(join(reposParent, `r${i}-`))
    await runGit(repoPath, ['init', '-q', '-b', 'main'])
    await runGit(repoPath, ['config', 'user.email', 't@t'])
    await runGit(repoPath, ['config', 'user.name', 'T'])
    writeFileSync(join(repoPath, 'README.md'), `# repo-${i}\n`)
    await runGit(repoPath, ['add', '.'])
    await runGit(repoPath, ['commit', '-q', '-m', 'init'])
    repos.push(repoPath)
  }
  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(workflows).values({
    id: 'wf-trunc',
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return {
    db,
    appHome,
    repos,
    cleanup: () => {
      rmSync(appHome, { recursive: true, force: true })
      rmSync(reposParent, { recursive: true, force: true })
    },
  }
}

// A deterministic, ASCII, line-broken filler so the unified diff body is
// proportional to the file size (no Date.now / random). 700 KiB per repo means
// the combined two-repo diff (~1.4 MiB of bodies + headers) overflows the
// 1 MiB cap, forcing truncation into the SECOND repo's body.
function filler(approxBytes: number): string {
  const line = 'x'.repeat(63) + '\n' // 64 bytes/line
  return line.repeat(Math.ceil(approxBytes / 64))
}

describe('RFC-066 PR-B — getTaskDiff multi-repo truncation + all-clean fall-through', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('T-A two repos overflow TASK_DIFF_MAX_BYTES → truncated, repo[0] header present, body cut in repo[1]', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-trunc',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!, baseBranch: 'main' },
          { repoPath: h.repos[1]!, baseBranch: 'main' },
        ],
        inputs: {},
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome },
    )
    const wtA = join(task.worktreePath, task.repos[0]!.worktreeDirName)
    const wtB = join(task.worktreePath, task.repos[1]!.worktreeDirName)
    // Each repo gets ~700 KiB of untracked content: per-repo body non-empty
    // (so the `'' continue` skip never fires), repo[0] fits fully under 1 MiB,
    // and the running total overflows partway through repo[1]'s body.
    writeFileSync(join(wtA, 'big.txt'), filler(700 * 1024))
    writeFileSync(join(wtB, 'big.txt'), filler(700 * 1024))

    const diff = await getTaskDiff(h.db, task.id)
    expect(diff.truncated).toBe(true)
    expect(diff.baseCommit).toBeNull()
    // repo[0]'s header was emitted before the budget ran out.
    expect(diff.diff).toContain(`# === Repo: ${task.repos[0]!.worktreeDirName} ===`)
    // The output never exceeds the byte cap (final slice == bodyBudget).
    expect(Buffer.byteLength(diff.diff, 'utf8')).toBeLessThanOrEqual(TASK_DIFF_MAX_BYTES)
  })

  test('T-B two repos both clean (valid baseCommit, no changes) → empty diff, no 409, no header', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-trunc',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!, baseBranch: 'main' },
          { repoPath: h.repos[1]!, baseBranch: 'main' },
        ],
        inputs: {},
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome },
    )
    // Neither worktree is mutated: both repos are in `usable` (valid base +
    // existing worktree) so the 409 task-no-base-commit must NOT throw, yet
    // every per-repo snapshot is '' so the loop `continue`s every repo.
    const diff = await getTaskDiff(h.db, task.id)
    expect(diff.diff).toBe('')
    expect(diff.baseCommit).toBeNull()
    expect(diff.truncated).toBe(false)
    expect(diff.diff.includes('# === Repo:')).toBe(false)
  })
})
