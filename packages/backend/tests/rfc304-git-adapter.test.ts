// RFC-304 — the git side of `prepare-worktree`, against real repositories.
//
// This one uses real `git` rather than a mock, because the claim it verifies is
// specifically about git's behaviour: that a merge-request head published as a
// ref in the TARGET repository can be fetched and resolved from that repository
// alone. That claim is the entire fork countermeasure (design §6.1 deviation).
// A mocked `runGit` would assert only that this module composes the argv it was
// written to compose, which proves nothing about whether the argv works.
//
// The setup mirrors the real shape: an "upstream" repo holding a ref under
// `refs/merge-requests/…`, whose commit is NOT on any branch — exactly what a
// fork MR looks like from the target's side.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createGitAdapter } from '../src/modules/code-capability/infrastructure/gitAdapter'
import { runGit } from '../src/util/git'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

async function upstreamWithMrRef(): Promise<{
  upstream: string
  clone: string
  mrSha: string
  mainSha: string
}> {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc304-git-'))
  roots.push(root)
  const upstream = join(root, 'upstream')
  const clone = join(root, 'clone')

  await runGit(root, ['init', '--initial-branch=main', 'upstream'])
  await runGit(upstream, ['config', 'user.email', 'test@example.invalid'])
  await runGit(upstream, ['config', 'user.name', 'Test'])
  writeFileSync(join(upstream, 'a.txt'), 'one\n')
  await runGit(upstream, ['add', '.'])
  await runGit(upstream, ['commit', '-m', 'base'])
  const mainSha = (await runGit(upstream, ['rev-parse', 'HEAD'])).stdout.trim()

  // A commit reachable ONLY from the MR ref — a fork head, from the target's
  // point of view. `fetch --all` would never bring this down.
  await runGit(upstream, ['checkout', '-q', '-b', 'contributor-work'])
  writeFileSync(join(upstream, 'a.txt'), 'one\ntwo\n')
  await runGit(upstream, ['commit', '-qam', 'contribution'])
  const mrSha = (await runGit(upstream, ['rev-parse', 'HEAD'])).stdout.trim()
  await runGit(upstream, ['update-ref', 'refs/merge-requests/412/head', mrSha])
  await runGit(upstream, ['checkout', '-q', 'main'])
  await runGit(upstream, ['branch', '-qD', 'contributor-work'])

  await runGit(root, ['clone', '-q', upstream, clone])
  return { upstream, clone, mrSha, mainSha }
}

describe('RFC-304 — fetching an MR head from the target repository', () => {
  test('the MR ref resolves even though the commit is on no branch', async () => {
    // The fork countermeasure, verified against real git: a clone that has
    // never seen the contributor's branch can still fetch the head.
    const { clone, mrSha } = await upstreamWithMrRef()
    const git = createGitAdapter()

    const onBranch = await runGit(clone, ['branch', '-r'])
    expect(onBranch.stdout).not.toContain('contributor-work')

    const result = await git.fetchRef({
      repoPath: clone,
      refspec: 'refs/merge-requests/412/head',
    })
    expect(result).toEqual({ ok: true, resolvedSha: mrSha })
  })

  test('a commit can also be fetched by its bare sha', async () => {
    // The fallback attempt, for instances that prune MR refs. A local remote
    // allows this; a hosted one depends on its uploadpack settings, which is
    // exactly why it is a fallback rather than the primary.
    const { clone, mrSha } = await upstreamWithMrRef()
    const result = await createGitAdapter().fetchRef({ repoPath: clone, refspec: mrSha })
    expect(result).toEqual({ ok: true, resolvedSha: mrSha })
  })

  test('a missing ref fails with git’s own words, not a generic error', () => {
    // The message is what an operator reads to tell "pruned ref" apart from
    // "token cannot reach this repository".
    return upstreamWithMrRef().then(async ({ clone }) => {
      const result = await createGitAdapter().fetchRef({
        repoPath: clone,
        refspec: 'refs/merge-requests/999/head',
      })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error.length).toBeGreaterThan(0)
      expect(!result.ok && result.error).not.toBe('git exited with code 1')
    })
  })

  test('a repository that is not a repository fails rather than throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc304-nogit-'))
    roots.push(root)
    const result = await createGitAdapter().fetchRef({ repoPath: root, refspec: 'refs/heads/main' })
    expect(result.ok).toBe(false)
  })
})

describe('RFC-304 — putting the worktree on the commit', () => {
  test('checkout --detach lands exactly on the fetched commit', async () => {
    const { clone, mrSha, mainSha } = await upstreamWithMrRef()
    const git = createGitAdapter()
    await git.fetchRef({ repoPath: clone, refspec: 'refs/merge-requests/412/head' })

    expect((await runGit(clone, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(mainSha)
    const checkout = await git.checkoutDetached({ worktreePath: clone, sha: mrSha })
    expect(checkout.ok).toBe(true)
    expect((await runGit(clone, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(mrSha)
  })

  test('the checkout leaves no branch attached', async () => {
    // Detached is deliberate: a round must never be able to advance a branch
    // that a person owns.
    const { clone, mrSha } = await upstreamWithMrRef()
    const git = createGitAdapter()
    await git.fetchRef({ repoPath: clone, refspec: 'refs/merge-requests/412/head' })
    await git.checkoutDetached({ worktreePath: clone, sha: mrSha })
    const branch = await runGit(clone, ['symbolic-ref', '-q', 'HEAD'])
    expect(branch.exitCode).not.toBe(0)
  })

  test('checking out a commit that is not present fails by name', async () => {
    const { clone } = await upstreamWithMrRef()
    const result = await createGitAdapter().checkoutDetached({
      worktreePath: clone,
      sha: 'ffffffffffffffffffffffffffffffffffffffff',
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.length).toBeGreaterThan(0)
  })
})
