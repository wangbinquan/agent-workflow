import { rimrafDir } from './helpers/cleanup'
// RFC-075 T3: createWorktree's optional `workingBranch` path.
//
// Locks the six branches of util/git checkoutWorkingBranch against real temp
// repos with a bare "remote":
//   - no workingBranch → legacy `agent-workflow/{taskId}` (byte-compat guard)
//   - new branch (absent local + remote) → created off base
//   - reuse local branch + fast-forward base merge
//   - reuse local branch + non-FF clean merge (merge commit)
//   - reuse + base merge conflict → working-branch-base-merge-conflict +
//     worktree torn down (failed launch leaves nothing behind)
//   - branch already checked out elsewhere → working-branch-in-use
//   - reuse a branch that exists only on the remote → fetch + check out
//   - invalid branch name → working-branch-invalid

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, runGit } from '../src/util/git'

interface Fixture {
  source: string
  remote: string
  homes: string[]
  cleanup: () => void
}

async function buildRemoteAndClone(): Promise<Fixture> {
  const remote = mkdtempSync(join(tmpdir(), 'aw-wb-remote-'))
  await runGit(remote, ['init', '-q', '--bare', '-b', 'main'])

  const source = mkdtempSync(join(tmpdir(), 'aw-wb-src-'))
  await runGit(source, ['init', '-q', '-b', 'main'])
  await runGit(source, ['config', 'user.email', 'test@example.com'])
  await runGit(source, ['config', 'user.name', 'Test'])
  writeFileSync(join(source, 'a.txt'), 'original\n')
  await runGit(source, ['add', '.'])
  await runGit(source, ['commit', '-q', '-m', 'init'])
  await runGit(source, ['remote', 'add', 'origin', remote])
  await runGit(source, ['push', '-q', '-u', 'origin', 'main'])

  const homes: string[] = []
  return {
    source,
    remote,
    homes,
    cleanup: () => {
      rimrafDir(remote)
      rimrafDir(source)
      for (const h of homes) rimrafDir(h)
    },
  }
}

function newHome(f: Fixture): string {
  const h = mkdtempSync(join(tmpdir(), 'aw-wb-home-'))
  f.homes.push(h)
  return h
}

async function currentBranchOf(worktree: string): Promise<string> {
  return (await runGit(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
}

describe('createWorktree RFC-075 working branch', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await buildRemoteAndClone()
  })
  afterEach(() => f.cleanup())

  test('no workingBranch → legacy agent-workflow/{taskId} branch', async () => {
    const r = await createWorktree({
      repoPath: f.source,
      taskId: 'task-legacy',
      baseBranch: 'main',
      appHome: newHome(f),
      submoduleMode: 'never',
    })
    expect(r.branch).toBe('agent-workflow/task-legacy')
    expect(await currentBranchOf(r.worktreePath)).toBe('agent-workflow/task-legacy')
  })

  test('new working branch → created off base', async () => {
    const r = await createWorktree({
      repoPath: f.source,
      taskId: 'task-new',
      baseBranch: 'main',
      appHome: newHome(f),
      submoduleMode: 'never',
      workingBranch: 'feature/brand-new',
    })
    expect(r.branch).toBe('feature/brand-new')
    expect(await currentBranchOf(r.worktreePath)).toBe('feature/brand-new')
    expect(readFileSync(join(r.worktreePath, 'a.txt'), 'utf-8')).toBe('original\n')
  })

  test('reuse local branch + fast-forward base merge brings base-only files in', async () => {
    // feature/ff branches at base, then base advances with a new file.
    await runGit(f.source, ['branch', 'feature/ff', 'main'])
    writeFileSync(join(f.source, 'base-only.txt'), 'from base\n')
    await runGit(f.source, ['add', '.'])
    await runGit(f.source, ['commit', '-q', '-m', 'advance base'])

    const r = await createWorktree({
      repoPath: f.source,
      taskId: 'task-ff',
      baseBranch: 'main',
      appHome: newHome(f),
      submoduleMode: 'never',
      workingBranch: 'feature/ff',
    })
    expect(r.branch).toBe('feature/ff')
    // FF merge pulled the base-only file into the working branch.
    expect(existsSync(join(r.worktreePath, 'base-only.txt'))).toBe(true)
  })

  test('reuse local branch + non-FF clean merge creates a merge commit', async () => {
    // feature/div adds its own file; base adds a different file → clean merge.
    await runGit(f.source, ['checkout', '-q', '-b', 'feature/div', 'main'])
    writeFileSync(join(f.source, 'branch-only.txt'), 'from branch\n')
    await runGit(f.source, ['add', '.'])
    await runGit(f.source, ['commit', '-q', '-m', 'branch work'])
    await runGit(f.source, ['checkout', '-q', 'main'])
    writeFileSync(join(f.source, 'base-only.txt'), 'from base\n')
    await runGit(f.source, ['add', '.'])
    await runGit(f.source, ['commit', '-q', '-m', 'advance base'])

    const r = await createWorktree({
      repoPath: f.source,
      taskId: 'task-div',
      baseBranch: 'main',
      appHome: newHome(f),
      submoduleMode: 'never',
      workingBranch: 'feature/div',
      gitUserName: 'AW Bot',
      gitUserEmail: 'bot@aw.local',
    })
    // Both files present after the merge commit.
    expect(existsSync(join(r.worktreePath, 'branch-only.txt'))).toBe(true)
    expect(existsSync(join(r.worktreePath, 'base-only.txt'))).toBe(true)
  })

  test('reuse + base merge conflict → throws and tears down the worktree', async () => {
    // feature/cf and base both edit a.txt differently → conflict.
    await runGit(f.source, ['checkout', '-q', '-b', 'feature/cf', 'main'])
    writeFileSync(join(f.source, 'a.txt'), 'from branch\n')
    await runGit(f.source, ['add', '.'])
    await runGit(f.source, ['commit', '-q', '-m', 'branch edit'])
    await runGit(f.source, ['checkout', '-q', 'main'])
    writeFileSync(join(f.source, 'a.txt'), 'from base\n')
    await runGit(f.source, ['add', '.'])
    await runGit(f.source, ['commit', '-q', '-m', 'base edit'])

    const home = newHome(f)
    let thrown: unknown
    try {
      await createWorktree({
        repoPath: f.source,
        taskId: 'task-cf',
        baseBranch: 'main',
        appHome: home,
        submoduleMode: 'never',
        workingBranch: 'feature/cf',
        gitUserName: 'AW Bot',
        gitUserEmail: 'bot@aw.local',
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    expect((thrown as { code?: string }).code).toBe('working-branch-base-merge-conflict')
    // Worktree torn down: no dangling registration nor directory.
    const list = await runGit(f.source, ['worktree', 'list', '--porcelain'])
    expect(list.stdout.includes('task-cf')).toBe(false)
  })

  test('branch already checked out elsewhere → working-branch-in-use', async () => {
    await createWorktree({
      repoPath: f.source,
      taskId: 'task-w1',
      baseBranch: 'main',
      appHome: newHome(f),
      submoduleMode: 'never',
      workingBranch: 'feature/shared',
    })
    let thrown: unknown
    try {
      await createWorktree({
        repoPath: f.source,
        taskId: 'task-w2',
        baseBranch: 'main',
        appHome: newHome(f),
        submoduleMode: 'never',
        workingBranch: 'feature/shared',
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe('working-branch-in-use')
  })

  test('reuse a branch that exists only on the remote → fetch + check out', async () => {
    // Push feature/remote to the bare remote, then delete it locally so it
    // only exists upstream.
    await runGit(f.source, ['branch', 'feature/remote', 'main'])
    await runGit(f.source, ['push', '-q', 'origin', 'feature/remote'])
    await runGit(f.source, ['branch', '-D', 'feature/remote'])

    const r = await createWorktree({
      repoPath: f.source,
      taskId: 'task-remote',
      baseBranch: 'main',
      appHome: newHome(f),
      submoduleMode: 'never',
      workingBranch: 'feature/remote',
    })
    expect(r.branch).toBe('feature/remote')
    expect(await currentBranchOf(r.worktreePath)).toBe('feature/remote')
  })

  test('invalid branch name → working-branch-invalid', async () => {
    let thrown: unknown
    try {
      await createWorktree({
        repoPath: f.source,
        taskId: 'task-bad',
        baseBranch: 'main',
        appHome: newHome(f),
        submoduleMode: 'never',
        workingBranch: 'bad..name',
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe('working-branch-invalid')
  })
})
