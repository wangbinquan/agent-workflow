import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitAdapter } from '../src/modules/code-capability/infrastructure/gitAdapter'
import { bindTaskWorkspaceCommitParticipant } from '../src/modules/task-execution/composition/taskWorkspaceCommit'
import { bindRepositoryCommitParticipant } from '../src/modules/source-control/composition'
import { runGit } from '../src/util/git'

const roots: string[] = []

async function fixture(): Promise<{ repo: string; remote: string; base: string }> {
  const remote = mkdtempSync(join(tmpdir(), 'aw-rfc308-code-remote-'))
  const repo = mkdtempSync(join(tmpdir(), 'aw-rfc308-code-repo-'))
  roots.push(remote, repo)
  await runGit(remote, ['init', '-q', '--bare', '-b', 'main'])
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await runGit(repo, ['config', 'user.name', 'RFC308'])
  await runGit(repo, ['config', 'user.email', 'rfc308@example.test'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  writeFileSync(join(repo, 'secret.tmp'), 'base\n')
  await runGit(repo, ['add', '-A'])
  await runGit(repo, ['commit', '-q', '-m', 'base'])
  await runGit(repo, ['remote', 'add', 'origin', remote])
  await runGit(repo, ['push', '-q', '-u', 'origin', 'main'])
  const base = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
  await runGit(repo, ['checkout', '-q', '--detach', base])
  return { repo, remote, base }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-308 code capability delegates to the shared commit engine', () => {
  test('preview, freeze, and CAS push contain only allowed paths', async () => {
    const { repo, remote, base } = await fixture()
    writeFileSync(join(repo, 'allowed.txt'), 'allowed\n')
    writeFileSync(join(repo, 'secret.tmp'), 'must stay local\n')
    mkdirSync(join(repo, '.agent-workflow', 'runs'), { recursive: true })
    writeFileSync(join(repo, '.agent-workflow', 'runs', 'stage.json'), '{}\n')
    const git = createGitAdapter({
      taskCommit: bindTaskWorkspaceCommitParticipant({
        candidate: bindRepositoryCommitParticipant({
          repoPath: repo,
          configuredPatterns: ['*.tmp'],
        }),
        publication: bindRepositoryCommitParticipant({
          repoPath: repo,
          configuredPatterns: ['*.tmp'],
        }),
      }),
    })

    const preview = await git.readWorktreeDiff({ worktreePath: repo })
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      expect(preview.diff).toContain('allowed.txt')
      expect(preview.diff).not.toContain('secret.tmp')
      expect(preview.diff).not.toContain('.agent-workflow')
    }

    const frozen = await git.commitWorktree({
      repoPath: repo,
      worktreePath: repo,
      message: 'freeze allowed change',
      keepRef: 'refs/aw/test/rfc308',
    })
    expect(frozen.ok).toBe(true)
    if (!frozen.ok) return
    expect(
      (await runGit(repo, ['show', '--format=', '--name-only', frozen.commitSha])).stdout,
    ).toContain('allowed.txt')
    expect((await runGit(repo, ['show', `${frozen.commitSha}:secret.tmp`])).stdout).toBe('base\n')

    const pushed = await git.pushCommit({
      repoPath: repo,
      commitSha: frozen.commitSha,
      branch: 'main',
      expectedRemoteSha: base,
    })
    expect(pushed).toEqual({ ok: true })
    expect((await runGit(remote, ['show', 'main:allowed.txt'])).stdout).toBe('allowed\n')
  })

  test('CAS and new-branch publication both reject an excluded ancestor', async () => {
    const { repo, base } = await fixture()
    mkdirSync(join(repo, '.agent-workflow', 'runs'), { recursive: true })
    writeFileSync(join(repo, '.agent-workflow', 'runs', 'leak.json'), '{}\n')
    await runGit(repo, ['add', '-f', '.agent-workflow/runs/leak.json'])
    await runGit(repo, ['commit', '-q', '-m', 'manual leak'])
    const tip = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    const git = createGitAdapter({
      taskCommit: bindTaskWorkspaceCommitParticipant({
        candidate: bindRepositoryCommitParticipant({ repoPath: repo }),
        publication: bindRepositoryCommitParticipant({ repoPath: repo }),
      }),
    })

    const cas = await git.pushCommit({
      repoPath: repo,
      commitSha: tip,
      branch: 'main',
      expectedRemoteSha: base,
    })
    expect(cas).toMatchObject({ ok: false, reason: 'failed' })
    if (!cas.ok) expect(cas.error).toContain('excluded path')

    const created = await git.pushNewBranch({ repoPath: repo, commitSha: tip, branch: 'leak' })
    expect(created).toMatchObject({ ok: false, reason: 'failed' })
    if (!created.ok) expect(created.error).toContain('excluded path')
  })
})
