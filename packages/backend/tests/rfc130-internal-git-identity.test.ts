import { rimrafDir } from './helpers/cleanup'
// RFC-130 — internal iso/merge commits must use a FIXED platform git identity,
// independent of the ambient git config.
//
// REGRESSION INTENT (ubuntu-only CI incident, 2026-07-01): `snapshotFullState` and
// `commitTree` run `git commit-tree`, which needs a committer identity. A task
// worktree cloned from a Git URL inherits no `user.name`/`user.email`, and GitHub's
// ubuntu runner has no global identity AND cannot auto-detect one (email resolves to
// `root@…(none)`), so bare `commit-tree` failed with "committer identity unknown" →
// the node's `createNodeIso` threw → task `errorMessage: "iso-setup-failed"`. It only
// reproduced on ubuntu (macOS CI + every local box could auto-detect an identity),
// which is why it slipped: the RFC-024 e2e (git-URL launch, cache-clone worktree)
// reached "failed" only on the ubuntu Playwright shard. The fix injects
// AW_INTERNAL_GIT_IDENTITY into those internal commit-tree calls. If a refactor drops
// that env, these assertions go red on ANY machine (the author reverts to ambient).

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitTree, runGit, snapshotFullState } from '../src/util/git'

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc130-ident-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  // A LOCAL identity is needed only to lay down the initial commit; the internal
  // snapshot commits below must NOT rely on it.
  await runGit(dir, ['config', 'user.email', 'fixture@local'])
  await runGit(dir, ['config', 'user.name', 'fixture'])
  writeFileSync(join(dir, 'a.txt'), 'A\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
async function author(repo: string, sha: string): Promise<string> {
  return (await runGit(repo, ['log', '-1', '--format=%an <%ae>', sha])).stdout.trim()
}

describe('RFC-130 — internal git commits use a fixed identity (ubuntu iso-setup-failed regression)', () => {
  test('snapshotFullState stamps the fixed agent-workflow identity (not the ambient one)', async () => {
    const repo = await initRepo()
    try {
      writeFileSync(join(repo, 'b.txt'), 'B\n') // untracked → part of the snapshot
      const sha = await snapshotFullState(repo)
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      // The snapshot commit's author/committer is the FIXED platform identity — proves
      // the injected env (which overrides ambient config) was applied.
      expect(await author(repo, sha)).toBe('agent-workflow <agent-workflow@localhost>')
    } finally {
      rimrafDir(repo)
    }
  })

  test('commitTree stamps the fixed agent-workflow identity', async () => {
    const repo = await initRepo()
    try {
      const head = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
      const tree = (await runGit(repo, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
      const sha = await commitTree(repo, tree, head, 'aw-test')
      expect(await author(repo, sha)).toBe('agent-workflow <agent-workflow@localhost>')
    } finally {
      rimrafDir(repo)
    }
  })

  test('snapshotFullState SUCCEEDS with NO usable ambient identity (the ubuntu condition)', async () => {
    const repo = await initRepo()
    // Neutralize the ambient identity exactly like a bare CI runner: empty global +
    // system config, and disable git's user@host auto-detection on this repo, and
    // clear any GIT_* identity env. Without the fix, commit-tree would fail here.
    const prev: Record<string, string | undefined> = {}
    const clear = [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]
    for (const k of clear) {
      prev[k] = process.env[k]
      delete process.env[k]
    }
    prev.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL
    prev.GIT_CONFIG_SYSTEM = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    try {
      // Remove the local identity + forbid auto-detect → no identity source at all
      // except the fix's injected env.
      await runGit(repo, ['config', '--unset-all', 'user.email'])
      await runGit(repo, ['config', '--unset-all', 'user.name'])
      await runGit(repo, ['config', 'user.useConfigOnly', 'true'])
      writeFileSync(join(repo, 'c.txt'), 'C\n')
      const sha = await snapshotFullState(repo) // must NOT throw "identity unknown"
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(await author(repo, sha)).toBe('agent-workflow <agent-workflow@localhost>')
    } finally {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
      rimrafDir(repo)
    }
  })
})
