// LOCKS: RFC-066 PR-B T13 — resume per-repo rollback. The single-repo path
// RFC-165: multi-repo/pre-created PATH bodies are the framework-internal face
// now (the wire is URL-only) — bodies are cast through the internal
// RepoSourceSpec widening; runtime behavior is byte-identical to pre-165.
// must stay byte-baseline (read `pre_snapshot`, roll `task.worktreePath`);
// the multi-repo path reads `pre_snapshot_repos_json` as a `{dirName: sha}`
// map and rolls each sub-worktree independently.
//
// Setup pattern for each test:
//   1. write a tracked file with a "snapshot-time" body
//   2. capture a git stash sha (non-empty because the worktree has
//      uncommitted changes vs HEAD)
//   3. mutate the file again to a "post-mutation" body
//   4. flip the task to a resumable status and call resumeTask
//   5. assert the file reverts to the snapshot-time body (rollback applied
//      the stash) — proves the helper followed the right code path.

import { afterEach, describe, expect, test } from 'bun:test'
import type { StartTask } from '@agent-workflow/shared'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { getTask, resumeTask, startTask, startTaskWithLocalRepo } from '../src/services/task'
import { nodeRuns, tasks as tasksTbl, workflows } from '../src/db/schema'
import { gitStashSnapshot, runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(repoCount: number): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc066-rb-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc066-rb-repos-'))
  const repos: string[] = []
  for (let i = 0; i < repoCount; i++) {
    const repoPath = mkdtempSync(join(reposParent, `r${i}-`))
    await runGit(repoPath, ['init', '-q', '-b', 'main'])
    await runGit(repoPath, ['config', 'user.email', 't@t'])
    await runGit(repoPath, ['config', 'user.name', 'T'])
    writeFileSync(join(repoPath, 'data.txt'), `repo-${i} HEAD\n`)
    await runGit(repoPath, ['add', '.'])
    await runGit(repoPath, ['commit', '-q', '-m', 'init'])
    repos.push(repoPath)
  }
  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(workflows).values({
    id: 'wf-rb',
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

describe('RFC-066 PR-B T13 — resume per-repo rollback', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('B19 single-repo: rollback uses pre_snapshot single sha; pre_snapshot_repos_json stays NULL', async () => {
    h = await buildHarness(1)
    const task = await startTaskWithLocalRepo(
      {
        workflowId: 'wf-rb',
        name: 't',
        repoPath: h.repos[0]!,
        baseBranch: 'main',
        inputs: {},
      },
      { db: h.db, appHome: h.appHome, awaitScheduler: true },
    )
    // Snapshot-time body: a non-trivial mutation against HEAD so the stash
    // is non-empty and the apply step is meaningful.
    writeFileSync(join(task.worktreePath, 'data.txt'), 'SNAPSHOT-TIME\n')
    const snapSha = await gitStashSnapshot(task.worktreePath)
    expect(snapSha).not.toBe('') // non-empty stash captured
    // Mutate again to a different bad state — resume must throw away this
    // body and restore the snapshot-time body.
    writeFileSync(join(task.worktreePath, 'data.txt'), 'POST-MUTATION\n')

    await h.db.insert(nodeRuns).values({
      id: 'nr-single',
      taskId: task.id,
      nodeId: 'fake-node',
      status: 'failed',
      preSnapshot: snapSha,
    })
    await h.db.update(tasksTbl).set({ status: 'failed' }).where(eq(tasksTbl.id, task.id))

    await resumeTask(h.db, task.id, { db: h.db, appHome: h.appHome })

    expect(readFileSync(join(task.worktreePath, 'data.txt'), 'utf-8')).toBe('SNAPSHOT-TIME\n')
    const rerow = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'nr-single')).limit(1)
    )[0]!
    expect(rerow.preSnapshotReposJson).toBeNull()
    expect(rerow.preSnapshot).toBe(snapSha)
  })

  test('B20 multi-repo: rollback honors pre_snapshot_repos_json map; each sub-worktree restored independently', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-rb',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!, baseBranch: 'main' },
          { repoPath: h.repos[1]!, baseBranch: 'main' },
        ],
        inputs: {},
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome, awaitScheduler: true },
    )
    const r0 = task.repos[0]!
    const r1 = task.repos[1]!
    // Snapshot-time body per repo (different content so we can tell them apart).
    writeFileSync(join(r0.worktreePath, 'data.txt'), 'SNAP-A\n')
    writeFileSync(join(r1.worktreePath, 'data.txt'), 'SNAP-B\n')
    const shaA = await gitStashSnapshot(r0.worktreePath)
    const shaB = await gitStashSnapshot(r1.worktreePath)
    expect(shaA).not.toBe('')
    expect(shaB).not.toBe('')
    // Mutate each further.
    writeFileSync(join(r0.worktreePath, 'data.txt'), 'MUTATED-A\n')
    writeFileSync(join(r1.worktreePath, 'data.txt'), 'MUTATED-B\n')

    await h.db.insert(nodeRuns).values({
      id: 'nr-multi',
      taskId: task.id,
      nodeId: 'fake-node',
      status: 'failed',
      preSnapshotReposJson: JSON.stringify({
        [r0.worktreeDirName]: shaA,
        [r1.worktreeDirName]: shaB,
      }),
    })
    await h.db.update(tasksTbl).set({ status: 'failed' }).where(eq(tasksTbl.id, task.id))

    await resumeTask(h.db, task.id, { db: h.db, appHome: h.appHome })

    expect(readFileSync(join(r0.worktreePath, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expect(readFileSync(join(r1.worktreePath, 'data.txt'), 'utf-8')).toBe('SNAP-B\n')
  })

  test('B21 multi-repo: malformed pre_snapshot_repos_json → defensive fallback to legacy pre_snapshot single sha path', async () => {
    h = await buildHarness(2)
    const task = await startTask(
      {
        workflowId: 'wf-rb',
        name: 't',
        repos: [
          { repoPath: h.repos[0]!, baseBranch: 'main' },
          { repoPath: h.repos[1]!, baseBranch: 'main' },
        ],
        inputs: {},
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome, awaitScheduler: true },
    )
    // Garbage in repos_json AND provide a legacy single-stash fallback. The
    // helper logs a warn and falls through to the single-stash branch,
    // which rolls `task.worktreePath` (the parent dir — not a git repo
    // in multi-repo mode). The rollback call itself fails on the parent,
    // BUT the helper swallows that failure with a warn so resumeTask
    // proceeds to flip task → pending. This test simply asserts that
    // resumeTask does NOT throw on malformed JSON — defense-in-depth.
    await h.db.insert(nodeRuns).values({
      id: 'nr-malformed',
      taskId: task.id,
      nodeId: 'fake-node',
      status: 'failed',
      preSnapshotReposJson: '{not valid json',
      preSnapshot: '', // empty sha → helper short-circuits on legacy path
    })
    await h.db.update(tasksTbl).set({ status: 'failed' }).where(eq(tasksTbl.id, task.id))

    // Should NOT throw.
    await resumeTask(h.db, task.id, { db: h.db, appHome: h.appHome })

    const t = await getTask(h.db, task.id)
    expect(t).not.toBeNull()
    // resumeTask flips status to 'pending' on successful resume entry.
    expect(t!.status).toBe('pending')
  })
})
