// RFC-239 §3.5 — file-content endpoint for the markdown rendered-diff view.
// Locks the design-gate requirements:
//  - P0-2: base side reads `basePath ?? path` (rename-aware), BOTH sides answer
//    a missing file with {exists:false}, multi-repo reads the SELECTED repo's
//    own base_commit (not the primary's).
//  - P0-3: the worktree read is handle-first — a symlink swapped in AFTER the
//    containment decision (test seam) is refused, never followed.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskRepos, tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import {
  FILE_CONTENT_MAX_BYTES,
  getTaskFileContent,
  openContainedFile,
} from '../src/services/worktreeFileContent'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function makeRepo(): Promise<{ dir: string; commit: string }> {
  const dir = tempDir('aw-fc-repo-')
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  writeFileSync(join(dir, 'doc.md'), 'original text\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  const commit = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  return { dir, commit }
}

async function seedTask(
  db: DbClient,
  opts: { worktreePath: string; baseCommit: string | null; repoCount?: number },
): Promise<string> {
  const taskId = `01FC${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const workflowId = `wf-${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify({ nodes: [], edges: [] }),
    version: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [] }),
    repoPath: opts.worktreePath,
    worktreePath: opts.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now(),
    baseCommit: opts.baseCommit,
    repoCount: opts.repoCount ?? 1,
  })
  return taskId
}

describe('openContainedFile (handle-first contained read)', () => {
  test('regular file reads; missing path / directory report not-found', () => {
    const root = tempDir('aw-fc-open-')
    writeFileSync(join(root, 'a.md'), 'hi\n')
    mkdirSync(join(root, 'sub'))
    expect(openContainedFile(root, 'a.md')).toEqual({ kind: 'ok', content: 'hi\n', size: 3 })
    expect(openContainedFile(root, 'missing.md').kind).toBe('not-found')
    expect(openContainedFile(root, 'sub').kind).toBe('not-found')
  })

  test('escape attempts are refused: .. segments, absolute paths, symlink out', () => {
    const root = tempDir('aw-fc-esc-')
    const outside = tempDir('aw-fc-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.md'))
    expect(openContainedFile(root, '../x').kind).toBe('outside')
    expect(openContainedFile(root, '/etc/hosts').kind).toBe('outside')
    expect(openContainedFile(root, 'link.md').kind).toBe('outside')
  })

  test('P0-3 seam: symlink swapped AFTER containment resolution is refused', () => {
    const root = tempDir('aw-fc-race-')
    const outside = tempDir('aw-fc-race-out-')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    writeFileSync(join(root, 'victim.md'), 'legit\n')
    const res = openContainedFile(root, 'victim.md', {
      beforeOpen: () => {
        // the classic TOCTOU: replace the just-validated regular file with a
        // symlink pointing outside the worktree
        rmSync(join(root, 'victim.md'))
        symlinkSync(join(outside, 'secret.txt'), join(root, 'victim.md'))
      },
    })
    expect(res.kind).toBe('outside')
  })

  test('oversized and binary files are refused with their own kinds', () => {
    const root = tempDir('aw-fc-guard-')
    writeFileSync(join(root, 'big.md'), 'x'.repeat(FILE_CONTENT_MAX_BYTES + 1))
    writeFileSync(join(root, 'bin.md'), Buffer.from([0x68, 0x69, 0x00, 0x21]))
    expect(openContainedFile(root, 'big.md').kind).toBe('oversized')
    expect(openContainedFile(root, 'bin.md').kind).toBe('binary')
  })
})

describe('getTaskFileContent', () => {
  test('worktree + base sides read; missing files answer {exists:false} on BOTH sides', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { dir, commit } = await makeRepo()
    const taskId = await seedTask(db, { worktreePath: dir, baseCommit: commit })

    // worktree side: live edit visible
    writeFileSync(join(dir, 'doc.md'), 'edited text\n')
    const wt = await getTaskFileContent(db, taskId, { path: 'doc.md', side: 'worktree' })
    expect(wt).toEqual({ exists: true, content: 'edited text\n', size: 12 })

    // base side: original content
    const base = await getTaskFileContent(db, taskId, { path: 'doc.md', side: 'base' })
    expect(base.content).toBe('original text\n')

    // pure add → no base side; pure delete → no worktree side. Neither errors.
    writeFileSync(join(dir, 'new.md'), 'brand new\n')
    expect(await getTaskFileContent(db, taskId, { path: 'new.md', side: 'base' })).toEqual({
      exists: false,
    })
    rmSync(join(dir, 'README.md'))
    expect(await getTaskFileContent(db, taskId, { path: 'README.md', side: 'worktree' })).toEqual({
      exists: false,
    })
  })

  test('P0-2 rename: base side reads via basePath (the old path)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { dir, commit } = await makeRepo()
    const taskId = await seedTask(db, { worktreePath: dir, baseCommit: commit })
    renameSync(join(dir, 'doc.md'), join(dir, 'renamed.md'))

    // without basePath the base side is a miss (file never existed there) …
    expect(await getTaskFileContent(db, taskId, { path: 'renamed.md', side: 'base' })).toEqual({
      exists: false,
    })
    // … with basePath (the structural renamedFrom) it reads the old blob.
    const base = await getTaskFileContent(db, taskId, {
      path: 'renamed.md',
      side: 'base',
      basePath: 'doc.md',
    })
    expect(base.content).toBe('original text\n')
  })

  test('multi-repo selects the repo by canonical key (RFC-248: = mount_path) and uses ITS base commit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const primary = await makeRepo()
    const secondary = await makeRepo()
    writeFileSync(join(secondary.dir, 'doc.md'), 'secondary v2\n')
    await runGit(secondary.dir, ['add', '.'])
    await runGit(secondary.dir, ['commit', '-q', '-m', 'v2'])
    const secondaryHead = (await runGit(secondary.dir, ['rev-parse', 'HEAD'])).stdout.trim()

    const container = tempDir('aw-fc-multi-')
    const taskId = await seedTask(db, {
      worktreePath: container,
      baseCommit: primary.commit,
      repoCount: 2,
    })
    const repoRow = {
      taskId,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
    }
    await db.insert(taskRepos).values([
      {
        ...repoRow,
        repoIndex: 0,
        repoPath: primary.dir,
        worktreePath: primary.dir,
        worktreeDirName: 'primary',
        // RFC-248: 规范 key 是 mount_path（不再是 basename）。生产路径 startTask
        // 永远显式写它；直插 task_repos 的夹具必须自己给，否则拿到列默认 ''。
        mountPath: 'primary',
        baseCommit: primary.commit,
      },
      {
        ...repoRow,
        repoIndex: 1,
        repoPath: secondary.dir,
        worktreePath: secondary.dir,
        worktreeDirName: 'secondary',
        mountPath: 'secondary',
        baseCommit: secondaryHead,
      },
    ])

    // repo param required for multi-repo
    await expect(getTaskFileContent(db, taskId, { path: 'doc.md', side: 'base' })).rejects.toThrow(
      /repo query param required/,
    )
    // the SECONDARY repo's own base commit serves its content (v2, not v1)
    const base = await getTaskFileContent(db, taskId, {
      path: 'doc.md',
      side: 'base',
      repo: 'secondary',
    })
    expect(base.content).toBe('secondary v2\n')
    await expect(
      getTaskFileContent(db, taskId, { path: 'doc.md', side: 'base', repo: 'nope' }),
    ).rejects.toThrow(/not found/)
  })

  test('guards: no base commit → 409 code; escape → validation; oversized/binary → typed errors', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { dir } = await makeRepo()
    const noBase = await seedTask(db, { worktreePath: dir, baseCommit: null })
    await expect(getTaskFileContent(db, noBase, { path: 'doc.md', side: 'base' })).rejects.toThrow(
      /no base commit/,
    )

    const { dir: dir2, commit } = await makeRepo()
    const taskId = await seedTask(db, { worktreePath: dir2, baseCommit: commit })
    await expect(
      getTaskFileContent(db, taskId, { path: '../etc/hosts', side: 'worktree' }),
    ).rejects.toThrow(/outside the worktree/)
    writeFileSync(join(dir2, 'big.md'), 'x'.repeat(FILE_CONTENT_MAX_BYTES + 1))
    await expect(
      getTaskFileContent(db, taskId, { path: 'big.md', side: 'worktree' }),
    ).rejects.toThrow(/rendered-view limit/)
    writeFileSync(join(dir2, 'bin.md'), Buffer.from([0x00, 0x01]))
    await expect(
      getTaskFileContent(db, taskId, { path: 'bin.md', side: 'worktree' }),
    ).rejects.toThrow(/binary/)
  })
})
