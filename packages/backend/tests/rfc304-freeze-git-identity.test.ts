// RFC-304 §6.2 — freezing a change must not depend on the machine's git config.
//
// Found by CI, on the commit that added the confirmation e2e: the whole chain
// ran — the agent made the change, it validated, the diff was posted — and then
//
//   post-patch:failed (could not freeze the change:
//                      Author identity unknown; *** Please tell me who you are.)
//
// The adapter set `-c user.name` / `-c user.email` only when the CALLER named an
// author, and otherwise let git inherit the ambient configuration. On a
// developer's laptop that inherits a real identity and everything works; a task
// worktree cloned from a URL carries no local `user.*`, and a server or CI
// runner frequently has no global identity either and cannot auto-detect one.
// So the feature worked in exactly one environment and failed in the one it
// ships to — at the LAST step, after all the expensive work, with a message
// about git configuration that reads as unrelated to reviewing code.
//
// The repository had already learned this once: `AW_INTERNAL_GIT_IDENTITY`
// exists (RFC-130) precisely because `git commit-tree` failed the same way on
// ubuntu runners. This test drives the adapter with every identity source
// removed, which is what those hosts look like.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitAdapter } from '../src/modules/code-capability/infrastructure/gitAdapter'
import { bindTaskWorkspaceCommitParticipant } from '../src/modules/task-execution/composition/taskWorkspaceCommit'
import { bindRepositoryCommitParticipant } from '../src/modules/source-control/composition'
import { runGit } from '../src/util/git'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A repository with a commit, and NO identity reachable from it.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at nothing is how git
 * itself describes "this host has no configured user", so the test reproduces
 * the CI runner rather than imitating it.
 */
async function repoWithoutIdentity(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'rfc304-identity-'))
  scratch.push(dir)
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  await runGit(dir, ['init', '-q', '-b', 'main'], { env })
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  await runGit(dir, ['add', '-A'], { env })
  // The seed commit needs an identity too; it is supplied explicitly, exactly
  // the way the adapter is now expected to.
  await runGit(
    dir,
    [
      '-c',
      'user.name=seed',
      '-c',
      'user.email=seed@localhost',
      'commit',
      '--no-verify',
      '-m',
      'seed',
    ],
    { env },
  )
  return dir
}

function adapterFor(repo: string) {
  return createGitAdapter({
    taskCommit: bindTaskWorkspaceCommitParticipant({
      candidate: bindRepositoryCommitParticipant({ repoPath: repo }),
      publication: bindRepositoryCommitParticipant({ repoPath: repo }),
    }),
  })
}

describe('RFC-304 — freezing a change on a host with no git identity', () => {
  test('the commit succeeds and is attributed to the platform', async () => {
    const repo = await repoWithoutIdentity()
    const previous = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
    }
    // Strip every source git would otherwise fall back to, for the duration of
    // the call: config files, and the environment variables that stand in for
    // them. What is left is what a fresh server looks like.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL

    try {
      writeFileSync(join(repo, 'app.ts'), 'export const guard = () => true\n')
      const frozen = await adapterFor(repo).commitWorktree({
        repoPath: repo,
        worktreePath: repo,
        message: 'apply the requested change',
        keepRef: 'refs/aw/keep/test',
      })

      expect(frozen.ok, `commit failed: ${JSON.stringify(frozen)}`).toBe(true)

      const author = await runGit(repo, ['log', '-1', '--format=%an <%ae>'])
      expect(author.stdout.trim()).toBe('agent-workflow <agent-workflow@localhost>')
    } finally {
      if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous.global
      if (previous.system === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = previous.system
      if (previous.name !== undefined) process.env.GIT_AUTHOR_NAME = previous.name
      if (previous.email !== undefined) process.env.GIT_AUTHOR_EMAIL = previous.email
    }
  })

  test('a named author still wins — the branch owner keeps their name', async () => {
    // The fallback must not overwrite an attribution the platform DOES know:
    // a patch pushed to somebody's branch is authored by them, and rewriting
    // that to `agent-workflow` would misattribute the change in `git log`.
    const repo = await repoWithoutIdentity()
    writeFileSync(join(repo, 'app.ts'), 'export const guard = () => true\n')
    const frozen = await adapterFor(repo).commitWorktree({
      repoPath: repo,
      worktreePath: repo,
      message: 'apply the requested change',
      keepRef: 'refs/aw/keep/test-2',
      authorName: 'Real Person',
      authorEmail: 'real@example.com',
    })
    expect(frozen.ok).toBe(true)
    const author = await runGit(repo, ['log', '-1', '--format=%an <%ae>'])
    expect(author.stdout.trim()).toBe('Real Person <real@example.com>')
  })
})
