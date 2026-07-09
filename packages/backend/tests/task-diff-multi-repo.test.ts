import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-066 PR-B T12 — getTaskDiff multi-repo concatenation.
//
// Cases covered:
//   B16 single-repo task: diff response shape byte-baseline against
//       pre-RFC-066 (baseCommit non-null, diff body contains the worktree
//       change, no `# === Repo:` header injection).
//   B17 two repos, both with changes: response wraps each repo's diff in a
//       `# === Repo: <basename> ===\n` header, repos appear in repoIndex
//       order, baseCommit is null, truncated is false.
//   B18 one repo has zero changes: that repo's section (including header)
//       is silently dropped; only the changed repo appears in output.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { getTaskDiff, startTask } from '../src/services/task'
import { workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(repoCount: number): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc066-diff-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc066-diff-repos-'))
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
    id: 'wf-diff',
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
      rimrafDir(appHome)
      rimrafDir(reposParent)
    },
  }
}

describe('RFC-066 PR-B T12 — getTaskDiff multi-repo concat', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('B16 single-repo task: baseline diff shape (baseCommit non-null, no `# === Repo:` header)', async () => {
    h = await buildHarness(1)
    const task = await startTask(
      {
        workflowId: 'wf-diff',
        name: 't',
        repoPath: h.repos[0]!,
        baseBranch: 'main',
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Stage a change inside the worktree so the diff is non-empty.
    writeFileSync(join(task.worktreePath, 'README.md'), '# repo-0 (mutated)\n')
    const diff = await getTaskDiff(h.db, task.id)
    expect(diff.baseCommit).not.toBeNull()
    expect(diff.truncated).toBe(false)
    expect(diff.diff).toContain('README.md')
    expect(diff.diff.includes('# === Repo:')).toBe(false)
  })

  test('B17 two repos both with changes: concat with `# === Repo:` headers per repo in repoIndex order, baseCommit null', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-diff',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!, baseBranch: 'main' },
          { repoPath: h.repos[1]!, baseBranch: 'main' },
        ],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Each sub-worktree gets a tracked-file mutation so the per-repo diff
    // is non-empty.
    const wtA = join(task.worktreePath, task.repos[0]!.worktreeDirName)
    const wtB = join(task.worktreePath, task.repos[1]!.worktreeDirName)
    writeFileSync(join(wtA, 'README.md'), '# repo-A mutated\n')
    writeFileSync(join(wtB, 'README.md'), '# repo-B mutated\n')

    const diff = await getTaskDiff(h.db, task.id)
    expect(diff.baseCommit).toBeNull()
    expect(diff.truncated).toBe(false)
    // Both per-repo headers are present, in repoIndex order.
    const aHeaderIdx = diff.diff.indexOf(`# === Repo: ${task.repos[0]!.worktreeDirName} ===`)
    const bHeaderIdx = diff.diff.indexOf(`# === Repo: ${task.repos[1]!.worktreeDirName} ===`)
    expect(aHeaderIdx).toBeGreaterThanOrEqual(0)
    expect(bHeaderIdx).toBeGreaterThan(aHeaderIdx)
    // Each repo's own README change is in the diff body.
    expect(diff.diff).toContain('repo-A mutated')
    expect(diff.diff).toContain('repo-B mutated')
  })

  test('B18 one of two repos has zero changes → its header + section is silently dropped', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-diff',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!, baseBranch: 'main' },
          { repoPath: h.repos[1]!, baseBranch: 'main' },
        ],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Only repo A mutated; B stays clean.
    const wtA = join(task.worktreePath, task.repos[0]!.worktreeDirName)
    writeFileSync(join(wtA, 'README.md'), '# repo-A mutated\n')

    const diff = await getTaskDiff(h.db, task.id)
    expect(diff.baseCommit).toBeNull()
    expect(diff.truncated).toBe(false)
    expect(diff.diff).toContain(`# === Repo: ${task.repos[0]!.worktreeDirName} ===`)
    // The clean repo's header is NOT emitted.
    expect(diff.diff.includes(`# === Repo: ${task.repos[1]!.worktreeDirName} ===`)).toBe(false)
    expect(diff.diff).toContain('repo-A mutated')
  })
})
