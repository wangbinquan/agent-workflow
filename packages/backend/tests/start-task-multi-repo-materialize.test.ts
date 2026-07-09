import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-066 PR-A T3 — multi-repo task launch materialize behavior.
//
// Cases covered:
//   B7  two path-mode repos → parent dir + two sibling worktrees + two
//       task_repos rows.
//   B8  per-repo branch is `agent-workflow/{taskId}` for each entry (same
//       name in different source repos — no collision).
//   B9  legacy `tasks.*` mirror columns reflect `task_repos[0]`.
//   B10 two repos with the same basename → second one gets `-2` suffix.
//   B11 second repo fails worktree add → entire task lands as failed,
//       first repo's task_repos row already persisted (visible artifact).
//   B12 single-repo v2 body (`repos: [{...}]`) is byte-baseline equivalent
//       to legacy single-repo path: same worktree layout, same tasks.*
//       columns, same single task_repos row at repo_index=0.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve, basename, sep } from 'node:path'
import { eq, asc } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { startTask } from '../src/services/task'
import { taskRepos, tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface RepoHarness {
  repoPath: string
  basename: string
}

interface Harness {
  db: DbClient
  appHome: string
  repos: RepoHarness[]
  cleanup: () => void
}

async function seedRepo(parent: string, name: string): Promise<RepoHarness> {
  const repoPath = mkdtempSync(join(parent, `aw-rfc066-${name}-`))
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t'])
  await runGit(repoPath, ['config', 'user.name', 'T'])
  writeFileSync(join(repoPath, 'README.md'), `# ${name}\n`)
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])
  // Find the actual basename we got (mkdtempSync adds random suffix). Use
  // path.basename (not split('/')) so it works on Windows backslash paths.
  return { repoPath, basename: basename(repoPath) }
}

async function buildHarness(repoCount: number, sharedBasenameRoot?: string): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc066-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc066-repos-'))
  // For collision tests: seed two repos under separate sub-dirs with the SAME
  // basename. mkdtemp's random suffix would otherwise prevent collisions.
  let repos: RepoHarness[]
  if (sharedBasenameRoot !== undefined) {
    repos = []
    for (let i = 0; i < repoCount; i++) {
      const subParent = mkdtempSync(join(reposParent, `parent-${i}-`))
      const repoPath = join(subParent, sharedBasenameRoot)
      // Use a deterministic name (not mkdtempSync).
      await runGit(subParent, ['init', '-q', '-b', 'main', sharedBasenameRoot])
      await runGit(repoPath, ['config', 'user.email', 't@t'])
      await runGit(repoPath, ['config', 'user.name', 'T'])
      writeFileSync(join(repoPath, 'README.md'), `# repo-${i}\n`)
      await runGit(repoPath, ['add', '.'])
      await runGit(repoPath, ['commit', '-q', '-m', 'init'])
      repos.push({ repoPath, basename: sharedBasenameRoot })
    }
  } else {
    repos = []
    for (let i = 0; i < repoCount; i++) {
      repos.push(await seedRepo(reposParent, `r${i}`))
    }
  }

  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(workflows).values({
    id: 'wf-multi',
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

describe('RFC-066 PR-A T3 — multi-repo materialize', () => {
  let h: Harness

  afterEach(() => {
    h?.cleanup()
  })

  test('B7 two path-mode repos → parent dir + two worktrees + two task_repos rows', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 'multi-task',
        repos: [
          { repoPath: h.repos[0]!.repoPath, baseBranch: 'main' },
          { repoPath: h.repos[1]!.repoPath, baseBranch: 'main' },
        ],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )

    // Parent worktree dir exists at multi/{taskId}/.
    expect(task.worktreePath).toBe(join(h.appHome, 'worktrees', 'multi', task.id))
    expect(existsSync(task.worktreePath)).toBe(true)
    // Each repo materializes a child worktree at multi/{taskId}/<basename>/.
    const r0Path = join(task.worktreePath, h.repos[0]!.basename)
    const r1Path = join(task.worktreePath, h.repos[1]!.basename)
    expect(existsSync(r0Path)).toBe(true)
    expect(existsSync(r1Path)).toBe(true)
    // task_repos has two rows sorted by repo_index ascending.
    const rows = await h.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, task.id))
      .orderBy(asc(taskRepos.repoIndex))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.repoIndex).toBe(0)
    expect(rows[1]!.repoIndex).toBe(1)
    expect(rows[0]!.worktreeDirName).toBe(h.repos[0]!.basename)
    expect(rows[1]!.worktreeDirName).toBe(h.repos[1]!.basename)
    expect(rows[0]!.worktreePath).toBe(r0Path)
    expect(rows[1]!.worktreePath).toBe(r1Path)
  })

  test('B8 per-repo branch is agent-workflow/{taskId} for every entry', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!.repoPath, baseBranch: 'main' },
          { repoPath: h.repos[1]!.repoPath, baseBranch: 'main' },
        ],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    const expectedBranch = `agent-workflow/${task.id}`
    const rows = await h.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, task.id))
      .orderBy(asc(taskRepos.repoIndex))
    for (const r of rows) expect(r.branch).toBe(expectedBranch)
  })

  test('B9 tasks.* mirror columns reflect task_repos[0]', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!.repoPath, baseBranch: 'main' },
          { repoPath: h.repos[1]!.repoPath, baseBranch: 'main' },
        ],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    const rows = await h.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(rows[0]!.repoPath).toBe(h.repos[0]!.repoPath)
    expect(rows[0]!.repoCount).toBe(2)
    expect(rows[0]!.branch).toBe(`agent-workflow/${task.id}`)
  })

  test('B10 two repos with same basename → second gets `-2` suffix', async () => {
    h = await buildHarness(2, 'utils')
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!.repoPath, baseBranch: 'main' },
          { repoPath: h.repos[1]!.repoPath, baseBranch: 'main' },
        ],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    const rows = await h.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, task.id))
      .orderBy(asc(taskRepos.repoIndex))
    expect(rows[0]!.worktreeDirName).toBe('utils')
    expect(rows[1]!.worktreeDirName).toBe('utils-2')
    expect(existsSync(rows[0]!.worktreePath)).toBe(true)
    expect(existsSync(rows[1]!.worktreePath)).toBe(true)
  })

  test('B11 second repo fails worktree add → task lands as failed, first repo row still persists', async () => {
    h = await buildHarness(1)
    // Second "repo" path is a non-git directory → createWorktree fails.
    const notARepo = mkdtempSync(join(tmpdir(), 'aw-rfc066-not-repo-'))
    try {
      const task = await startTask(
        {
          workflowId: 'wf-multi',
          name: 't',
          repos: [
            { repoPath: h.repos[0]!.repoPath, baseBranch: 'main' },
            { repoPath: notARepo, baseBranch: 'main' },
          ],
          inputs: {},
        },
        { db: h.db, appHome: h.appHome },
      )
      expect(task.status).toBe('failed')
      // First repo materialized fine; its task_repos row is recorded.
      const rows = await h.db
        .select()
        .from(taskRepos)
        .where(eq(taskRepos.taskId, task.id))
        .orderBy(asc(taskRepos.repoIndex))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.repoIndex).toBe(0)
      expect(rows[0]!.repoPath).toBe(h.repos[0]!.repoPath)
      // tasks.error_summary surfaces the failing repo index.
      expect(task.errorSummary).toContain('repo[1]')
    } finally {
      rimrafDir(notARepo)
    }
  })

  test('B12 single-repo v2 body (`repos: [{...}]`) byte-baseline matches legacy single-repo layout', async () => {
    h = await buildHarness(1)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 't',
        repos: [{ repoPath: h.repos[0]!.repoPath, baseBranch: 'main' }],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Single-repo always uses the legacy {repoSlug}/{taskId} layout — NOT
    // the multi/{taskId}/<basename>/ namespace.
    expect(task.worktreePath).not.toContain(`worktrees${sep}multi${sep}`)
    expect(task.worktreePath).toContain(`worktrees${sep}`)
    expect(task.worktreePath).toContain(`${sep}${task.id}`)
    const rows = await h.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(rows[0]!.repoCount).toBe(1)
    const repoRows = await h.db.select().from(taskRepos).where(eq(taskRepos.taskId, task.id))
    expect(repoRows).toHaveLength(1)
    expect(repoRows[0]!.repoIndex).toBe(0)
    // Single-repo's worktree_dir_name is empty (the worktree IS the repo).
    expect(repoRows[0]!.worktreeDirName).toBe('')
    // The worktree path matches the task's worktree path exactly (no
    // parent-child indirection in single-repo).
    expect(repoRows[0]!.worktreePath).toBe(task.worktreePath)
  })

  test('B12b legacy single-repo body (top-level repoPath, no repos[]) byte-baseline matches v2 single-repo', async () => {
    h = await buildHarness(1)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 't-legacy',
        repoPath: h.repos[0]!.repoPath,
        baseBranch: 'main',
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Same layout invariants as B12.
    expect(task.worktreePath).not.toContain('worktrees/multi/')
    const rows = await h.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(rows[0]!.repoCount).toBe(1)
    const repoRows = await h.db.select().from(taskRepos).where(eq(taskRepos.taskId, task.id))
    expect(repoRows).toHaveLength(1)
    expect(repoRows[0]!.worktreeDirName).toBe('')
    expect(repoRows[0]!.worktreePath).toBe(task.worktreePath)
  })

  // B15 (multi-repo gates) is covered in start-task-multi-repo-gates.test.ts.
})
void ulid // satisfy unused-import lint while we keep this helper for future shards
