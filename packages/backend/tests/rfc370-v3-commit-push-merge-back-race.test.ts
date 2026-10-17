// RFC-370 v3 hosted acceptance (2026-10-17) — a node's merge-back and a
// commit-and-push share the canonical worktree.
//
// WHY THIS FILE EXISTS (regression intent): in the M1 acceptance workflow
// (git wrapper → script node, autoCommitPush) the git wrapper's commit-and-push
// failed with `prepared index became empty`, standalone and hosted alike. The
// commit-and-push staged the wrapper's changes and released the worktree while
// its commit message was generated; meanwhile the script node merged back, and
// materializing a merge resets the index. Merge-back also reset to the HEAD
// recorded when the node's isolated workspace was created, so a commit landing
// before a slower sibling merged back was taken off the branch again.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commitPreparedRepository,
  prepareRepositoryCommit,
} from '@/modules/source-control/application/repositoryCommit'
import { createLocalIsolationWorkspaceFactory } from '@/modules/source-control/infrastructure/local/localIsolationWorkspace'
import { runGit } from '@/util/git'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const git = async (cwd: string, args: string[]) => {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function repository(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'aw-rfc370-race-'))
  roots.push(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.email', 't@e.com'])
  await git(repo, ['config', 'user.name', 'T'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

test('a merge-back after a commit-and-push keeps that commit on the branch', async () => {
  const canon = await repository()
  const storageRootRef = mkdtempSync(join(tmpdir(), 'aw-rfc370-race-home-'))
  roots.push(storageRootRef)
  const scope = await createLocalIsolationWorkspaceFactory().bind({
    taskId: 'race',
    storageRootRef,
    repositories: [{ repositoryRef: canon, workspaceRef: canon, mount: '', baseBranch: 'main' }],
  })
  // The sibling node's isolated workspace is created first …
  const workspace = await scope.create({ key: 'sibling', dbNodeRunId: 'sibling' })
  // … then an earlier node's product is committed (and pushed) in the canonical tree.
  writeFileSync(join(canon, 'published.txt'), 'published\n')
  await git(canon, ['add', '--', 'published.txt'])
  await git(canon, ['commit', '-q', '-m', 'published by commit-and-push'])
  const published = await git(canon, ['rev-parse', 'HEAD'])

  writeFileSync(join(workspace.repositories[0]!.workspaceRef, 'sibling.txt'), 'sibling\n')
  const captured = await scope.snapshot(workspace)
  const merged = await scope.merge(captured.workspace, captured.trees)
  expect(merged.clean).toBe(true)

  expect(await git(canon, ['rev-parse', 'HEAD'])).toBe(published)
  // The sibling's change is the uncommitted product; the published file stays committed.
  expect((await runGit(canon, ['status', '--porcelain'])).stdout).toBe('?? sibling.txt\n')
  await scope.discard(merged.workspace)
})

test('the commit records the prepared tree after a merge-back reset the index', async () => {
  const repo = await repository()
  writeFileSync(join(repo, 'product.txt'), 'product\n')
  const prepared = await prepareRepositoryCommit({ repoPath: repo })
  if (!prepared.ok) throw new Error(prepared.error)
  expect(prepared.preparedTree).toMatch(/^[a-f0-9]{40}$/)

  // What materializing a sibling's merge does to the canonical index.
  await git(repo, ['reset', '-q', '--mixed', 'HEAD'])
  expect(
    await commitPreparedRepository({
      repoPath: repo,
      message: 'unprotected',
      verification: 'normal',
    }),
  ).toEqual({
    ok: false,
    reason: 'no-changes',
  })

  const committed = await commitPreparedRepository({
    repoPath: repo,
    message: 'feat: product',
    verification: 'normal',
    preparedTree: prepared.preparedTree!,
  })
  if (!committed.ok) throw new Error(JSON.stringify(committed))
  expect(await git(repo, ['rev-parse', 'HEAD^{tree}'])).toBe(prepared.preparedTree!)
  expect((await runGit(repo, ['status', '--porcelain'])).stdout).toBe('')
})

test('changes a sibling made after preparation stay uncommitted for its own commit', async () => {
  const repo = await repository()
  writeFileSync(join(repo, 'product.txt'), 'product\n')
  const prepared = await prepareRepositoryCommit({ repoPath: repo })
  if (!prepared.ok) throw new Error(prepared.error)
  await git(repo, ['reset', '-q', '--mixed', 'HEAD'])
  writeFileSync(join(repo, 'sibling.txt'), 'sibling\n')

  const committed = await commitPreparedRepository({
    repoPath: repo,
    message: 'feat: product',
    verification: 'normal',
    preparedTree: prepared.preparedTree!,
  })
  expect(committed.ok).toBe(true)
  expect(await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('product.txt')
  expect((await runGit(repo, ['status', '--porcelain'])).stdout).toBe('?? sibling.txt\n')
})
