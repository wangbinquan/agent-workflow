import { rimrafDir } from './helpers/cleanup'
// Tests for the git util (P-1-12 helpers + parsers shared with P-1-10).
// Builds a real fixture repo per test via `git init` + a few commits/branches.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyBaseRef,
  createWorktree,
  currentBranch,
  defaultBranch,
  listBranches,
  listFiles,
  listTags,
  recentCommits,
  removeWorktree,
  repoSlug,
  requireGitRepo,
  runGit,
} from '../src/util/git'
import { NotFoundError, ValidationError } from '../src/util/errors'

let baseTmp: string
let repoPath: string
let appHome: string

beforeAll(() => {
  baseTmp = mkdtempSync(join(tmpdir(), 'aw-git-'))
})

afterAll(() => {
  rimrafDir(baseTmp)
})

beforeEach(async () => {
  repoPath = mkdtempSync(join(baseTmp, 'repo-'))
  appHome = mkdtempSync(join(baseTmp, 'home-'))
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'first commit'])
  writeFileSync(join(repoPath, 'a.txt'), 'aaa\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'second commit'])
  await runGit(repoPath, ['branch', 'feature/x'])
  await runGit(repoPath, ['tag', 'v1.0'])
})

afterEach(() => {
  rimrafDir(repoPath)
  rimrafDir(appHome)
})

describe('runGit + requireGitRepo', () => {
  test('runGit returns stdout/stderr/exitCode', async () => {
    const r = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('main')
  })

  test('requireGitRepo passes for a real repo', async () => {
    await expect(requireGitRepo(repoPath)).resolves.toBeUndefined()
  })

  test('requireGitRepo throws NotFoundError for missing path', async () => {
    await expect(requireGitRepo('/no/such/path/xyz-asdf')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('requireGitRepo throws ValidationError for non-repo dir', async () => {
    const notRepo = mkdtempSync(join(baseTmp, 'notrepo-'))
    try {
      await expect(requireGitRepo(notRepo)).rejects.toBeInstanceOf(ValidationError)
    } finally {
      rimrafDir(notRepo)
    }
  })
})

describe('ref/file parsers', () => {
  test('listBranches yields local + remote-tracking', async () => {
    const branches = await listBranches(repoPath)
    expect(branches).toContain('main')
    expect(branches).toContain('feature/x')
  })

  test('listTags yields tag names', async () => {
    expect(await listTags(repoPath)).toEqual(['v1.0'])
  })

  test('recentCommits returns sha + subject newest first', async () => {
    const commits = await recentCommits(repoPath, 10)
    expect(commits.length).toBe(2)
    expect(commits[0]?.subject).toBe('second commit')
    expect(commits[1]?.subject).toBe('first commit')
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('currentBranch returns main', async () => {
    expect(await currentBranch(repoPath)).toBe('main')
  })

  test('currentBranch returns null on detached HEAD', async () => {
    const sha = (await runGit(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(repoPath, ['checkout', '-q', sha])
    expect(await currentBranch(repoPath)).toBeNull()
  })

  test('defaultBranch falls back to main when no origin/HEAD set', async () => {
    expect(await defaultBranch(repoPath)).toBe('main')
  })

  test('listFiles returns git-tracked paths', async () => {
    const files = await listFiles(repoPath)
    expect(files.sort()).toEqual(['README.md', 'a.txt'])
  })
})

describe('repoSlug', () => {
  test('produces sha1-prefix + basename', () => {
    const slug = repoSlug('/Users/me/Documents/myrepo')
    expect(slug).toMatch(/^[0-9a-f]{8}-myrepo$/)
  })

  test('different paths -> different slugs', () => {
    expect(repoSlug('/a/myrepo')).not.toBe(repoSlug('/b/myrepo'))
  })

  test('stable for the same path', () => {
    expect(repoSlug('/x/y/z')).toBe(repoSlug('/x/y/z'))
  })
})

describe('worktree create + remove', () => {
  test('createWorktree places under ~/.agent-workflow/worktrees/{slug}/{taskId}', async () => {
    const result = await createWorktree({
      repoPath,
      taskId: 'T-001',
      appHome,
    })
    expect(result.branch).toBe('agent-workflow/T-001')
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    const expectedDir = join(appHome, 'worktrees', repoSlug(repoPath), 'T-001')
    expect(result.worktreePath).toBe(expectedDir)
    expect(existsSync(expectedDir)).toBe(true)
    expect(existsSync(join(expectedDir, 'README.md'))).toBe(true)

    // The new branch exists in the source repo.
    const branches = await listBranches(repoPath)
    expect(branches).toContain('agent-workflow/T-001')

    // Cleanup
    await removeWorktree({ repoPath, worktreePath: expectedDir })
  })

  test('createWorktree respects baseBranch', async () => {
    const result = await createWorktree({
      repoPath,
      taskId: 'T-002',
      baseBranch: 'feature/x',
      appHome,
    })
    // The worktree's HEAD should resolve to the same commit as feature/x.
    const sha = (await runGit(result.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    const featSha = (await runGit(repoPath, ['rev-parse', 'feature/x'])).stdout.trim()
    expect(sha).toBe(featSha)
    await removeWorktree({ repoPath, worktreePath: result.worktreePath })
  })

  test('createWorktree fails for non-git path', async () => {
    const notRepo = mkdtempSync(join(baseTmp, 'notrepo-'))
    try {
      await expect(
        createWorktree({ repoPath: notRepo, taskId: 'T', appHome }),
      ).rejects.toBeInstanceOf(ValidationError)
    } finally {
      rimrafDir(notRepo)
    }
  })

  test('removeWorktree cleans up the directory', async () => {
    const w = await createWorktree({ repoPath, taskId: 'T-003', appHome })
    expect(existsSync(w.worktreePath)).toBe(true)
    await removeWorktree({ repoPath, worktreePath: w.worktreePath })
    expect(existsSync(w.worktreePath)).toBe(false)
  })

  test('two concurrent tasks on same repo get independent worktrees', async () => {
    const a = await createWorktree({ repoPath, taskId: 'T-A', appHome })
    const b = await createWorktree({ repoPath, taskId: 'T-B', appHome })
    try {
      expect(a.worktreePath).not.toBe(b.worktreePath)
      // Branches don't collide
      const branches = await listBranches(repoPath)
      expect(branches).toContain('agent-workflow/T-A')
      expect(branches).toContain('agent-workflow/T-B')
    } finally {
      await removeWorktree({ repoPath, worktreePath: a.worktreePath })
      await removeWorktree({ repoPath, worktreePath: b.worktreePath })
    }
  })
})

describe('classifyBaseRef (RFC-068)', () => {
  test('classifies local branch as branch', async () => {
    const kind = await classifyBaseRef(repoPath, 'main')
    expect(kind).toBe('branch')
  })

  test('classifies branch with slash in name', async () => {
    const kind = await classifyBaseRef(repoPath, 'feature/x')
    expect(kind).toBe('branch')
  })

  test('classifies tag as tag', async () => {
    const kind = await classifyBaseRef(repoPath, 'v1.0')
    expect(kind).toBe('tag')
  })

  test('classifies remote-tracking ref as remote-tracking', async () => {
    const head = await runGit(repoPath, ['rev-parse', 'HEAD'])
    expect(head.exitCode).toBe(0)
    const sha = head.stdout.trim()
    await runGit(repoPath, ['update-ref', 'refs/remotes/origin/main', sha])
    const kind = await classifyBaseRef(repoPath, 'origin/main')
    expect(kind).toBe('remote-tracking')
  })

  test('classifies hex commit sha as sha', async () => {
    const head = await runGit(repoPath, ['rev-parse', 'HEAD'])
    expect(head.exitCode).toBe(0)
    const sha = head.stdout.trim()
    const kind = await classifyBaseRef(repoPath, sha)
    expect(kind).toBe('sha')
  })

  test('classifies short hex commit prefix as sha', async () => {
    const head = await runGit(repoPath, ['rev-parse', 'HEAD'])
    const short = head.stdout.trim().slice(0, 8)
    const kind = await classifyBaseRef(repoPath, short)
    expect(kind).toBe('sha')
  })

  test('classifies unknown ref as unknown', async () => {
    const kind = await classifyBaseRef(repoPath, 'no-such-ref')
    expect(kind).toBe('unknown')
  })

  test('classifies empty / HEAD as unknown (caller short-circuit)', async () => {
    expect(await classifyBaseRef(repoPath, '')).toBe('unknown')
    expect(await classifyBaseRef(repoPath, 'HEAD')).toBe('unknown')
  })

  test('branch wins over same-named tag (launcher UX preserves intent)', async () => {
    await runGit(repoPath, ['tag', 'feature/x'])
    const kind = await classifyBaseRef(repoPath, 'feature/x')
    expect(kind).toBe('branch')
  })
})
