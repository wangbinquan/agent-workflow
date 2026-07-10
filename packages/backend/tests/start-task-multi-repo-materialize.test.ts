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
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { eq, asc } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { StartTask } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { materializeSpace, startTask, startTaskWithLocalRepo } from '../src/services/task'
import { taskRepos, tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface RepoHarness {
  repoPath: string
  basename: string
  /** RFC-165: the wire form — path mode retired, multi-repo rows are URL-only. */
  url: string
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
  // Find the actual basename we got (mkdtempSync adds random suffix).
  const parts = repoPath.split('/')
  return { repoPath, basename: parts[parts.length - 1] ?? '', url: pathToFileURL(repoPath).href }
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
      repos.push({ repoPath, basename: sharedBasenameRoot, url: pathToFileURL(repoPath).href })
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
      rmSync(appHome, { recursive: true, force: true })
      rmSync(reposParent, { recursive: true, force: true })
    },
  }
}

describe('RFC-066 PR-A T3 — multi-repo materialize', () => {
  let h: Harness

  afterEach(() => {
    h?.cleanup()
  })

  test('B7 two url-mode repos → parent dir + two sibling worktrees + two task_repos rows', async () => {
    // RFC-165: path mode retired from the wire — rows are file:// URLs; each
    // source clones a mirror and the sibling dir is named after the MIRROR
    // (hash-slug), so the layout assertions are structural rather than
    // source-basename based.
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 'multi-task',
        repos: [{ repoUrl: h.repos[0]!.url }, { repoUrl: h.repos[1]!.url }],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )

    // Parent worktree dir exists at multi/{taskId}/.
    expect(task.worktreePath).toBe(join(h.appHome, 'worktrees', 'multi', task.id))
    expect(existsSync(task.worktreePath)).toBe(true)
    // task_repos has two rows sorted by repo_index ascending, each a live
    // sibling worktree directly under the parent container.
    const rows = await h.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, task.id))
      .orderBy(asc(taskRepos.repoIndex))
    expect(rows).toHaveLength(2)
    for (const [i, r] of rows.entries()) {
      expect(r.repoIndex).toBe(i)
      expect(r.worktreePath.startsWith(task.worktreePath + '/')).toBe(true)
      expect(r.worktreeDirName).toBe(r.worktreePath.split('/').pop() ?? '')
      expect(existsSync(r.worktreePath)).toBe(true)
      expect(r.repoUrl).toBe(h.repos[i]!.url)
    }
    expect(rows[0]!.worktreeDirName).not.toBe(rows[1]!.worktreeDirName)
  })

  test('B8 per-repo branch is agent-workflow/{taskId} for every entry', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 't',
        repos: [{ repoUrl: h.repos[0]!.url }, { repoUrl: h.repos[1]!.url }],
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
        repos: [{ repoUrl: h.repos[0]!.url }, { repoUrl: h.repos[1]!.url }],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    const rows = await h.db.select().from(tasks).where(eq(tasks.id, task.id))
    const repoRows = await h.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, task.id))
      .orderBy(asc(taskRepos.repoIndex))
    // Mirror columns reflect task_repos[0] (URL mode: the cached mirror path).
    expect(rows[0]!.repoPath).toBe(repoRows[0]!.repoPath)
    expect(rows[0]!.repoUrl).toBe(h.repos[0]!.url)
    expect(rows[0]!.repoCount).toBe(2)
    expect(rows[0]!.branch).toBe(`agent-workflow/${task.id}`)
  })

  test('B10 dirname collision → second gets `-2` suffix (internal face)', async () => {
    // RFC-165: URL-only wire rows derive sibling dirnames from the MIRROR
    // basename (hash-slug) — two different sources can no longer collide, and
    // the same URL twice fails at the second worktree add (branch name
    // collision inside one repo). The `-2` suffix logic
    // (resolveMultiRepoDirName) stays reachable through the framework's
    // internal path-spec face, so it is locked there.
    h = await buildHarness(2, 'utils')
    const space = await materializeSpace(
      {
        workflowId: 'wf-multi',
        name: 't',
        inputs: {},
        repos: [
          { repoPath: h.repos[0]!.repoPath, baseBranch: 'main' },
          { repoPath: h.repos[1]!.repoPath, baseBranch: 'main' },
        ],
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome },
      h.appHome,
    )
    expect(space.earlyError).toBe(null)
    const task = await startTask(
      { workflowId: 'wf-multi', name: 't', inputs: {} } as unknown as StartTask,
      { db: h.db, appHome: h.appHome, materializedSpace: space },
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

  test('B11 second repo fails worktree add → failed task, partial first-repo row persists', async () => {
    // RFC-165: a bad URL fails at CLONE time (422, no row), so the partial
    // materialize-failure arm is locked via the internal RepoSourceSpec face
    // (materializeSpace failure arm → startTask mints ONE failed row carrying
    // the partial repos — design F3).
    h = await buildHarness(1)
    const notARepo = mkdtempSync(join(tmpdir(), 'aw-rfc066-not-repo-'))
    try {
      // INTERNAL face: path rows are unrepresentable on the wire (the schema
      // is url-only) but normalizeStartTaskRepos' widened RepoSourceSpec keeps
      // them for the framework — cast to drive the multi partial-failure arm.
      const failing = await materializeSpace(
        {
          workflowId: 'wf-multi',
          name: 't',
          inputs: {},
          repos: [
            { repoPath: h.repos[0]!.repoPath, baseBranch: 'main' },
            { repoPath: notARepo, baseBranch: 'main' },
          ],
        } as unknown as StartTask,
        { db: h.db, appHome: h.appHome },
        h.appHome,
      )
      expect(failing.earlyError).toContain('repo[1]')
      expect(failing.repos).toHaveLength(1)

      const task = await startTask(
        { workflowId: 'wf-multi', name: 't', inputs: {} } as unknown as StartTask,
        { db: h.db, appHome: h.appHome, materializedSpace: failing },
      )
      expect(task.status).toBe('failed')
      const rows = await h.db
        .select()
        .from(taskRepos)
        .where(eq(taskRepos.taskId, task.id))
        .orderBy(asc(taskRepos.repoIndex))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.repoIndex).toBe(0)
      expect(rows[0]!.repoPath).toBe(h.repos[0]!.repoPath)
      expect(task.errorSummary).toContain('repo[1]')
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })

  test('B12 single-repo v2 body (`repos: [{...}]`) byte-baseline matches legacy single-repo layout', async () => {
    h = await buildHarness(1)
    const task = await startTask(
      {
        workflowId: 'wf-multi',
        name: 't',
        repos: [{ repoUrl: h.repos[0]!.url }],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Single-repo always uses the legacy {repoSlug}/{taskId} layout — NOT
    // the multi/{taskId}/<basename>/ namespace.
    expect(task.worktreePath).not.toContain('worktrees/multi/')
    expect(task.worktreePath).toContain('worktrees/')
    expect(task.worktreePath).toContain(`/${task.id}`)
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
    const task = await startTaskWithLocalRepo(
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
