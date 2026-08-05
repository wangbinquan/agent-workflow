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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-wt-'))
  tmps.push(d)
  return d
}
// RFC-254 T32: the appHome temp dirs here hold an open `db.sqlite`, and on
// Windows an open handle makes the delete fail outright — measured, five of
// this file's tests reported `(unnamed)` teardown failures with all of their
// own assertions already green. `removeTempDirSync` is the repo's answer to
// that (retry, then warn instead of throw on win32 only); see
// fixtures/tempDir.ts for why waiting cannot fix it.
//
// The loop shape matters just as much as the helper. The old version was one
// bare `rmSync` per iteration, so the FIRST busy dir aborted teardown and every
// later dir leaked for reasons that had nothing to do with it. Here each dir is
// attempted regardless, and the first real error is re-thrown AFTER the loop —
// deliberately, so a POSIX host that cannot delete its own temp directory still
// fails loudly (which is exactly what fixtures/tempDir.ts preserves the throw
// for). Swallowing it here would have quietly undone that.
afterEach(() => {
  let first: unknown
  for (const d of tmps.splice(0)) {
    try {
      removeTempDirSync(d)
    } catch (error) {
      first ??= error
    }
  }
  if (first !== undefined) throw first
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

describe('impl-gate P0-2 — reconstruct trusts the DB row path, not the archive JSON', () => {
  // Codex 2026-07-22: reconstructWorktrees used the archive-supplied
  // meta.worktreePath / meta.repoPath verbatim, so a forged JSON in an uploaded
  // backup could aim `git worktree add` + extractTarGz at any host path (a
  // filesystem-write primitive for an admin-uploaded backup). The paths must come
  // from the DB row, and the target must be lexically sane (absolute, no `..`).
  test('a forged worktreePath in the captured JSON cannot redirect the write', async () => {
    const appHome = tmp()
    const branch = `agent-workflow/${ulid()}`
    const { repoPath, worktreePath } = await setup(appHome, branch)
    writeFileSync(join(worktreePath, 'file.txt'), 'REAL\n')
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
    rmSync(worktreePath, { recursive: true, force: true })

    // FORGE the captured metadata: aim the reconstruction at an arbitrary host path.
    const pwned = join(tmp(), 'PWNED-worktree')
    const metaPath = join(staging, 'worktrees', `${taskId}.json`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    meta.worktreePath = pwned
    writeFileSync(metaPath, JSON.stringify(meta))

    await reconstructWorktrees(db, staging)
    // The forged host path must NOT be created — reconstruct uses the DB row's own
    // worktreePath, so the real (controlled) worktree is what gets rebuilt.
    expect(existsSync(pwned)).toBe(false)
    expect(existsSync(join(worktreePath, 'file.txt'))).toBe(true)
    ;(db as unknown as { $client: Database }).$client.close()
  })
})

describe('impl-gate P2-7 — one un-tarrable worktree skips, not aborts', () => {
  // RFC-254 T32 — HOW THIS TEST MAKES `tar` FAIL, AND WHY IT CHANGED
  // ----------------------------------------------------------------
  // It used to write a file into the bad worktree and `chmod 000` it, so tar
  // could not read it. That mechanism is POSIX-only: measured on Windows 11,
  // the chmod is accepted, the file stays fully readable, and `tar` exits 0 —
  // so the capture SUCCEEDED and the test asserted a skip that never happened.
  // It also needed a `getuid() === 0` escape hatch, because root reads
  // mode-000 files too, i.e. the fixture already had one host where it silently
  // proved nothing.
  //
  // The replacement makes the worktree path exist but not be a directory, so
  // `tar -C <path>` cannot chdir into it. Measured on all four tars this repo
  // is run against, and every one of them fails hard:
  //
  //   bsdtar 3.5.3 (macOS)      exit 1  could not chdir to '...'
  //   bsdtar (Windows 11)       exit 1  could not chdir to '...'
  //   GNU tar 1.35 (CI ubuntu)  exit 2  Cannot open: Not a directory
  //   busybox tar 1.37 (alpine) exit 1  can't change directory to '...'
  //
  // No permissions, no privilege check, no platform branch. The SUBJECT is
  // unchanged: one worktree that `tarGz` throws on must land in `skipped` with
  // its meta json dropped, while the other task still captures.
  test('un-tarrable worktree → that task lands in skipped (no meta orphan), backup continues', async () => {
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
    // The bad task's worktree path EXISTS (so it is not filtered out as
    // "missing on disk") but is a plain file, which is what `tarGz` chokes on:
    // `tar -C <file>` cannot chdir and exits non-zero. Its size scan reads 0
    // bytes, so it also clears the cap check and reaches the tar branch.
    const badWt = join(appHome, 'worktrees', 'aw_bad-task')
    writeFileSync(badWt, 'this worktree path is not a directory\n')
    const okId = seedTask(db, wfId, 'running', a.repoPath, a.worktreePath, 'aw/ok-task')
    const badId = seedTask(db, wfId, 'running', a.repoPath, badWt, 'aw/bad-task')

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
      ;(db as unknown as { $client: Database }).$client.close()
    }
  })
})
