// RFC-213 G4a (AC-8) — same-machine worktree capture + reconstruction.
//
// Backup captures non-terminal tasks' worktree working state (tracked changes +
// untracked, excl .git); restore reconstructs a worktree that is now MISSING so
// the user's in-flight work returns. Terminal tasks are not captured; an existing
// worktree is never overwritten; over-cap worktrees are skipped.
//
// MUTATION CHECK (manually verified): widen captureWorktrees' status filter to
// all statuses → the terminal task gets captured → "terminal not captured" reds.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import {
  captureWorktrees,
  reconstructWorktrees,
  DEFAULT_MAX_WORKTREE_BYTES,
} from '../src/services/worktreeBackup'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-wt-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await p.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(p.stderr).text()}`)
}

/** A git mirror repo with one commit + a task worktree checked out on its branch. */
async function setup(
  appHome: string,
  branch: string,
): Promise<{ repoPath: string; worktreePath: string }> {
  const repoPath = join(appHome, 'repo')
  mkdirSync(repoPath, { recursive: true })
  await git(repoPath, ['init', '-b', 'main'])
  await git(repoPath, ['config', 'user.email', 't@t'])
  await git(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'file.txt'), 'base\n')
  await git(repoPath, ['add', '.'])
  await git(repoPath, ['commit', '-m', 'init'])
  const worktreePath = join(appHome, 'worktrees', branch.replace(/\//g, '_'))
  mkdirSync(join(appHome, 'worktrees'), { recursive: true })
  await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath])
  return { repoPath, worktreePath }
}

function seedTask(
  db: DbClient,
  wfId: string,
  status: string,
  repoPath: string,
  worktreePath: string,
  branch: string,
): string {
  const id = ulid()
  db.insert(tasks)
    .values({
      id,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath,
      worktreePath,
      baseBranch: 'main',
      branch,
      status: status as never,
      inputs: '{}',
      startedAt: 0,
    })
    .run()
  return id
}

describe('RFC-213 G4a worktree capture + reconstruct', () => {
  test('captures a non-terminal worktree and reconstructs it when missing', async () => {
    const appHome = tmp()
    const branch = `agent-workflow/${ulid()}`
    const { repoPath, worktreePath } = await setup(appHome, branch)
    // In-flight work: modify a tracked file + add an untracked one.
    writeFileSync(join(worktreePath, 'file.txt'), 'MODIFIED\n')
    writeFileSync(join(worktreePath, 'untracked.txt'), 'NEW\n')

    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
      })
      .run()
    const taskId = seedTask(db, wfId, 'running', repoPath, worktreePath, branch)

    const staging = tmp()
    const cap = await captureWorktrees(db, staging)
    expect(cap.captured).toContain(taskId)
    expect(existsSync(join(staging, 'worktrees', `${taskId}.tar.gz`))).toBe(true)

    // Lose the worktree, then reconstruct.
    rmSync(worktreePath, { recursive: true, force: true })
    expect(existsSync(worktreePath)).toBe(false)
    const rec = await reconstructWorktrees(db, staging)
    expect(rec.reconstructed).toContain(taskId)
    // The in-flight state is back.
    expect(readFileSync(join(worktreePath, 'file.txt'), 'utf-8')).toBe('MODIFIED\n')
    expect(readFileSync(join(worktreePath, 'untracked.txt'), 'utf-8')).toBe('NEW\n')
    ;(db as unknown as { $client: Database }).$client.close()
  })

  test('terminal tasks are NOT captured', async () => {
    const appHome = tmp()
    const branch = `agent-workflow/${ulid()}`
    const { repoPath, worktreePath } = await setup(appHome, branch)
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
      })
      .run()
    const doneId = seedTask(db, wfId, 'done', repoPath, worktreePath, branch)

    const staging = tmp()
    const cap = await captureWorktrees(db, staging)
    expect(cap.captured).not.toContain(doneId)
    expect(existsSync(join(staging, 'worktrees', `${doneId}.tar.gz`))).toBe(false)
    ;(db as unknown as { $client: Database }).$client.close()
  })

  test('reconstruct does NOT overwrite an existing worktree', async () => {
    const appHome = tmp()
    const branch = `agent-workflow/${ulid()}`
    const { repoPath, worktreePath } = await setup(appHome, branch)
    writeFileSync(join(worktreePath, 'file.txt'), 'CAPTURED\n')
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
      })
      .run()
    const taskId = seedTask(db, wfId, 'running', repoPath, worktreePath, branch)
    const staging = tmp()
    await captureWorktrees(db, staging)

    // Worktree still present but with DIFFERENT (newer) content.
    writeFileSync(join(worktreePath, 'file.txt'), 'NEWER-ON-DISK\n')
    const rec = await reconstructWorktrees(db, staging)
    expect(rec.reconstructed).not.toContain(taskId)
    expect(
      rec.skipped.some((s) => s.taskId === taskId && s.reason.includes('already present')),
    ).toBe(true)
    // Untouched.
    expect(readFileSync(join(worktreePath, 'file.txt'), 'utf-8')).toBe('NEWER-ON-DISK\n')
    ;(db as unknown as { $client: Database }).$client.close()
  })

  test('over-cap worktrees are skipped (recorded), not captured', async () => {
    const appHome = tmp()
    const branch = `agent-workflow/${ulid()}`
    const { repoPath, worktreePath } = await setup(appHome, branch)
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
      })
      .run()
    const taskId = seedTask(db, wfId, 'running', repoPath, worktreePath, branch)
    const staging = tmp()
    // Cap of 1 byte → the worktree (has file.txt) exceeds it.
    const cap = await captureWorktrees(db, staging, { maxBytes: 1 })
    expect(cap.captured).not.toContain(taskId)
    expect(cap.skipped.some((s) => s.taskId === taskId && s.reason.includes('over cap'))).toBe(true)
    ;(db as unknown as { $client: Database }).$client.close()
  })

  test('the cap default is a sane positive size', () => {
    expect(DEFAULT_MAX_WORKTREE_BYTES).toBeGreaterThan(0)
  })

  test('createBackup --include-worktrees embeds the worktree + sets manifest flag', async () => {
    const appHome = tmp()
    const branch = `agent-workflow/${ulid()}`
    const { repoPath, worktreePath } = await setup(appHome, branch)
    writeFileSync(join(worktreePath, 'untracked.txt'), 'x\n')
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
      })
      .run()
    const taskId = seedTask(db, wfId, 'running', repoPath, worktreePath, branch)

    const { createBackup } = await import('../src/services/backup')
    const { extractTarGz } = await import('../src/util/archive')
    const { readManifest } = await import('../src/services/backupManifest')
    const res = await createBackup({ db, appHome, includeWorktrees: true, now: 1 })
    ;(db as unknown as { $client: Database }).$client.close()

    const out = tmp()
    await extractTarGz(res.path, out)
    expect(readManifest(out)!.includesWorktrees).toBe(true)
    expect(existsSync(join(out, 'worktrees', `${taskId}.tar.gz`))).toBe(true)
  })
})

describe('impl-gate P2-7 — one un-tarrable worktree skips, not aborts', () => {
  test('unreadable file in one worktree → that task lands in skipped (no meta orphan), backup continues', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // root reads chmod-000 files fine — the fixture can't fail. Skip.
      return
    }
    const appHome = tmp()
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
      })
      .run()
    const a = await setup(appHome, 'aw/ok-task')
    // second worktree off the SAME mirror (setup() commits once; a re-run would
    // make an empty commit and fail)
    const badWt = join(appHome, 'worktrees', 'aw_bad-task')
    await git(a.repoPath, ['worktree', 'add', '-b', 'aw/bad-task', badWt])
    const okId = seedTask(db, wfId, 'running', a.repoPath, a.worktreePath, 'aw/ok-task')
    const badId = seedTask(db, wfId, 'running', a.repoPath, badWt, 'aw/bad-task')
    // make ONE file unreadable → tar exits non-zero for that worktree only
    writeFileSync(join(badWt, 'secret.bin'), 'x')
    chmodSync(join(badWt, 'secret.bin'), 0o000)

    const staging = tmp()
    const cap = await captureWorktrees(db, staging)
    try {
      expect(cap.captured).toEqual([okId])
      expect(cap.skipped.map((s) => s.taskId)).toEqual([badId])
      expect(cap.skipped[0]?.reason ?? '').toContain('tar failed')
      const wtDir = join(staging, 'worktrees')
      expect(existsSync(join(wtDir, `${okId}.tar.gz`))).toBe(true)
      expect(existsSync(join(wtDir, `${badId}.tar.gz`))).toBe(false)
      // no meta-without-tar orphan for reconstruct to trip on
      expect(existsSync(join(wtDir, `${badId}.json`))).toBe(false)
    } finally {
      chmodSync(join(badWt, 'secret.bin'), 0o644)
      ;(db as unknown as { $client: Database }).$client.close()
    }
  })
})
