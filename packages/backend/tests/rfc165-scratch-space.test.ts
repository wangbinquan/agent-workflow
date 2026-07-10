// LOCKS: RFC-165 T2a — scratch-space materialization (design §3, §11.3).
//
// Cases:
//   S1 scratch launch → pending row whose workspace IS a fresh git repo:
//      repo_path === worktree_path === {appHome}/scratch/{taskId}, branch
//      'main', baseCommit = the empty root commit, space_kind 'scratch',
//      single task_repos row with repoUrl NULL.
//   S2 root-commit identity: platform AW_INTERNAL_GIT_IDENTITY by default
//      (never the ambient git config — design N2), per-task git identity
//      when the launch supplied one.
//   S3 the root commit is a working diff base: files produced in the
//      workspace diff against it (all-new-files semantics).
//   S4 materialize failure → exactly one FAILED row, workspace_pruned_at
//      stamped (R3-2-r4: no revivable workspace ⇒ tombstoned at birth),
//      scratch dir cleaned up, lease released.
//   S5 lease hygiene + recent_repos isolation: success path releases the
//      materializingSpaces lease and never upserts the scratch dir into
//      recent_repos (it is not a user repo).
//   S6 scratch + preCreatedWorktree (multipart) is rejected until the unified
//      materializeSpace protocol lands (T2c) — explicit 422, not half-working.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { materializeSpace, startTask } from '../src/services/task'
import { materializingSpaces } from '../src/services/gc'
import { taskRepos, tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-scratch-'))
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows)
    .values({
      id: 'wf-scratch',
      name: 'wf',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  return {
    db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

const BODY = { workflowId: 'wf-scratch', name: 'scratch-task', inputs: {}, scratch: true }

describe('RFC-165 T2a — scratch-space materialization', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('S1 scratch launch → fresh git repo as workspace, scratch row shape', async () => {
    h = buildHarness()
    const task = await startTask({ ...BODY }, { db: h.db, appHome: h.appHome })

    const scratchDir = join(h.appHome, 'scratch', task.id)
    expect(task.status).toBe('pending')
    expect(task.spaceKind).toBe('scratch')
    expect(task.repoPath).toBe(scratchDir)
    expect(task.worktreePath).toBe(scratchDir)
    expect(task.baseBranch).toBe('main')
    expect(task.branch).toBe('main')
    expect(task.repoUrl).toBe(null)
    expect(existsSync(scratchDir)).toBe(true)

    // The workspace is a real git repo with exactly ONE (empty root) commit,
    // and baseCommit points at it (snapshot machinery resolves HEAD).
    const count = await runGit(scratchDir, ['rev-list', '--count', 'HEAD'])
    expect(count.stdout.trim()).toBe('1')
    const head = await runGit(scratchDir, ['rev-parse', 'HEAD'])
    expect(task.baseCommit).toBe(head.stdout.trim())

    // Single task_repos row mirrors the scratch layout.
    const rows = await h.db.select().from(taskRepos).where(eq(taskRepos.taskId, task.id))
    expect(rows.length).toBe(1)
    expect(rows[0]!.repoIndex).toBe(0)
    expect(rows[0]!.repoPath).toBe(scratchDir)
    expect(rows[0]!.repoUrl).toBe(null)
    expect(rows[0]!.baseBranch).toBe('main')
    expect(rows[0]!.worktreePath).toBe(scratchDir)
  })

  test('S2 root-commit identity: platform default, overridden by per-task identity', async () => {
    h = buildHarness()
    const plain = await startTask({ ...BODY }, { db: h.db, appHome: h.appHome })
    const plainAuthor = await runGit(join(h.appHome, 'scratch', plain.id), [
      'log',
      '-1',
      '--format=%an <%ae>',
    ])
    expect(plainAuthor.stdout.trim()).toBe('agent-workflow <agent-workflow@localhost>')

    const withId = await startTask(
      { ...BODY, name: 'scratch-task-2', gitUserName: 'Alice', gitUserEmail: 'a@example.com' },
      { db: h.db, appHome: h.appHome },
    )
    const author = await runGit(join(h.appHome, 'scratch', withId.id), [
      'log',
      '-1',
      '--format=%an <%ae>',
    ])
    expect(author.stdout.trim()).toBe('Alice <a@example.com>')
  })

  test('S3 root commit is a working diff base (all-new-files)', async () => {
    h = buildHarness()
    const task = await startTask({ ...BODY }, { db: h.db, appHome: h.appHome })
    const dir = join(h.appHome, 'scratch', task.id)

    writeFileSync(join(dir, 'report.md'), '# findings\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'out'])

    const diff = await runGit(dir, ['diff', '--name-only', `${task.baseCommit}..HEAD`])
    expect(diff.stdout.trim()).toBe('report.md')
  })

  test('S4 materialize failure → failed row, tombstone stamped, dir cleaned, lease released', async () => {
    h = buildHarness()
    // Force mkdir to fail: occupy {appHome}/scratch with a FILE.
    writeFileSync(join(h.appHome, 'scratch'), 'not a dir')

    const task = await startTask({ ...BODY }, { db: h.db, appHome: h.appHome })
    expect(task.status).toBe('failed')
    expect(task.worktreePath).toBe('')
    expect(task.errorMessage ?? '').toContain('scratch-')

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!
    expect(row.spaceKind).toBe('scratch')
    // R3-2-r4: no revivable workspace ⇒ tombstoned atomically with the row.
    expect(row.workspacePrunedAt).not.toBe(null)
    expect(materializingSpaces.size).toBe(0)
  })

  test('S5 lease released on success', async () => {
    // (recent_repos retired entirely by RFC-165 — nothing to pollute.)
    h = buildHarness()
    const task = await startTask({ ...BODY }, { db: h.db, appHome: h.appHome })
    expect(materializingSpaces.size).toBe(0)
    expect(task.spaceKind).toBe('scratch')
  })

  test('S7 materializedSpace success handoff: startTask consumes verbatim (F3)', async () => {
    h = buildHarness()
    const space = await materializeSpace({ ...BODY }, { db: h.db }, h.appHome)
    expect(space.kind).toBe('scratch')
    expect(space.earlyError).toBe(null)
    expect(space.repos.length).toBe(1)
    // The lease spans materialize → (route writes uploads here) → startTask.
    expect(materializingSpaces.has(space.taskId)).toBe(true)

    // A route would write uploads into the workspace at this point.
    writeFileSync(join(space.worktreePath, 'uploaded.txt'), 'payload')

    const task = await startTask(
      { ...BODY },
      {
        db: h.db,
        appHome: h.appHome,
        materializedSpace: space,
      },
    )
    expect(task.id).toBe(space.taskId) // consumed, not re-materialized
    expect(task.status).toBe('pending')
    expect(task.spaceKind).toBe('scratch')
    expect(existsSync(join(task.worktreePath, 'uploaded.txt'))).toBe(true)
    expect(materializingSpaces.size).toBe(0) // released after the row committed
  })

  test('S8 materializedSpace failure handoff: ONE failed row, no re-materialize (F3)', async () => {
    h = buildHarness()
    writeFileSync(join(h.appHome, 'scratch'), 'not a dir') // force mkdir failure
    const space = await materializeSpace({ ...BODY }, { db: h.db }, h.appHome)
    expect(space.earlyError ?? '').toContain('scratch-')
    expect(space.worktreePath).toBe('')

    const task = await startTask(
      { ...BODY },
      {
        db: h.db,
        appHome: h.appHome,
        materializedSpace: space,
      },
    )
    expect(task.id).toBe(space.taskId)
    expect(task.status).toBe('failed')
    const rows = await h.db.select().from(tasks).where(eq(tasks.id, space.taskId))
    expect(rows.length).toBe(1)
    expect(rows[0]!.workspacePrunedAt).not.toBe(null)
    expect(materializingSpaces.size).toBe(0)
  })

  test('S6 scratch + preCreatedWorktree rejected until T2c protocol lands', async () => {
    h = buildHarness()
    await expect(
      startTask(
        { ...BODY },
        {
          db: h.db,
          appHome: h.appHome,
          preCreatedWorktree: {
            taskId: 'T123',
            worktreePath: '/tmp/x',
            branch: 'b',
            baseCommit: null,
          },
        },
      ),
    ).rejects.toThrow(/multipart uploads into a scratch space/)
  })
})
