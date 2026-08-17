// RFC-308 — platform excludes are per-worktree Git configuration, never a
// mutation/commit of the business repository's .gitignore.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  bindWorkspaceExcludeParticipant,
  ensureBoundPlatformWorkspaceDirectory,
} from '../src/modules/source-control/composition'
import {
  gitignoreDirectoryRule,
  planWorkspaceExcludeProfile,
} from '../src/modules/source-control/domain/workspaceExcludeProfile'
import { runGit } from '../src/util/git'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ home: string; worktree: string }> {
  const home = mkdtempSync(join(tmpdir(), 'rfc308-excludes-'))
  roots.push(home)
  const repo = join(home, 'repos', 'source')
  const worktree = join(home, 'worktrees', 'task')
  mkdirSync(repo, { recursive: true })
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await runGit(repo, ['config', 'user.name', 'Test'])
  await runGit(repo, ['config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(repo, 'tracked.txt'), 'base\n')
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  await runGit(repo, ['add', '-A'])
  await runGit(repo, ['commit', '-q', '-m', 'base'])
  mkdirSync(join(home, 'worktrees'), { recursive: true })
  await runGit(repo, ['worktree', 'add', '-q', '-b', 'task', worktree, 'HEAD'])
  return { home, worktree }
}

describe('RFC-308 workspace exclude profile', () => {
  test('renders canonical root and escaped mount rules deterministically', () => {
    expect(gitignoreDirectoryRule('a[b]')).toBe('/a\\[b\\]/')
    const a = planWorkspaceExcludeProfile({ directChildMounts: ['vendor/sdk', 'a[b]'] })
    const b = planWorkspaceExcludeProfile({ directChildMounts: ['a[b]', 'vendor/sdk'] })
    expect(a).toEqual(b)
    expect(a.content).toContain('/.agent-workflow/')
    expect(a.content).toContain('/vendor/sdk/')
  })

  test('hides platform root and nested mounts without touching .gitignore or HEAD', async () => {
    const { home, worktree } = await fixture()
    const beforeIgnore = readFileSync(join(worktree, '.gitignore'), 'utf8')
    const beforeHead = (await runGit(worktree, ['rev-parse', 'HEAD'])).stdout.trim()

    const receipt = await bindWorkspaceExcludeParticipant({
      worktreePath: worktree,
      appHome: home,
    }).ensure({ directChildMounts: ['vendor/sdk'] })
    expect(receipt.version).toBe(1)

    mkdirSync(join(worktree, '.agent-workflow', 'runs'), { recursive: true })
    writeFileSync(join(worktree, '.agent-workflow', 'runs', 'trace.json'), '{}')
    mkdirSync(join(worktree, 'vendor', 'sdk'), { recursive: true })
    writeFileSync(join(worktree, 'vendor', 'sdk', 'nested.txt'), 'nested')

    expect((await runGit(worktree, ['status', '--porcelain'])).stdout.trim()).toBe('')
    expect(readFileSync(join(worktree, '.gitignore'), 'utf8')).toBe(beforeIgnore)
    expect((await runGit(worktree, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(beforeHead)

    const gitDir = (await runGit(worktree, ['rev-parse', '--git-dir'])).stdout.trim()
    expect(existsSync(join(resolve(worktree, gitDir), 'agent-workflow', 'excludes', 'v1'))).toBe(
      true,
    )
  })

  test('rebinds a platform profile copied by git worktree add', async () => {
    const { home, worktree } = await fixture()
    await bindWorkspaceExcludeParticipant({ worktreePath: worktree, appHome: home }).ensure()
    const parentProfile = (
      await runGit(worktree, ['config', '--worktree', '--path', '--get', 'core.excludesFile'])
    ).stdout.trim()

    const child = join(home, 'worktrees', 'child')
    const created = await runGit(worktree, [
      'worktree',
      'add',
      '-q',
      '-b',
      'task-child',
      child,
      'HEAD',
    ])
    expect(created.exitCode).toBe(0)
    const copiedProfile = (
      await runGit(child, ['config', '--worktree', '--path', '--get', 'core.excludesFile'])
    ).stdout.trim()
    expect(resolve(copiedProfile)).toBe(resolve(parentProfile))

    await bindWorkspaceExcludeParticipant({ worktreePath: child, appHome: home }).ensure()
    const reboundProfile = (
      await runGit(child, ['config', '--worktree', '--path', '--get', 'core.excludesFile'])
    ).stdout.trim()
    const childGitDir = (await runGit(child, ['rev-parse', '--git-dir'])).stdout.trim()
    expect(resolve(reboundProfile)).toBe(
      resolve(child, childGitDir, 'agent-workflow', 'excludes', 'v1'),
    )
    expect(resolve(reboundProfile)).not.toBe(resolve(parentProfile))

    mkdirSync(join(child, '.agent-workflow', 'runs'), { recursive: true })
    writeFileSync(join(child, '.agent-workflow', 'runs', 'trace.json'), '{}')
    expect((await runGit(child, ['status', '--porcelain'])).stdout.trim()).toBe('')
  })

  test('still rejects a worktree profile outside Git platform storage', async () => {
    const { home, worktree } = await fixture()
    const foreign = join(home, 'foreign-excludes')
    writeFileSync(
      foreign,
      '# agent-workflow platform excludes v1\n# managed outside the business repository; do not edit\n/.agent-workflow/\n',
    )
    await runGit(worktree, ['config', 'extensions.worktreeConfig', 'true'])
    await runGit(worktree, ['config', '--worktree', 'core.excludesFile', foreign])

    await expect(
      bindWorkspaceExcludeParticipant({ worktreePath: worktree, appHome: home }).ensure(),
    ).rejects.toThrow('non-platform core.excludesFile')
  })

  test('fails closed when business ignore precedence negates the hard root', async () => {
    const { home, worktree } = await fixture()
    writeFileSync(join(worktree, '.gitignore'), 'dist/\n!/.agent-workflow/\n')
    await runGit(worktree, ['add', '.gitignore'])
    await runGit(worktree, ['commit', '-q', '-m', 'business negation'])

    await expect(
      bindWorkspaceExcludeParticipant({ worktreePath: worktree, appHome: home }).ensure(),
    ).rejects.toThrow('business ignore precedence')
  })

  test('does not overwrite an explicit worktreeConfig=false policy', async () => {
    const { home, worktree } = await fixture()
    await runGit(worktree, ['config', '--local', 'extensions.worktreeConfig', 'false'])
    await expect(
      bindWorkspaceExcludeParticipant({ worktreePath: worktree, appHome: home }).ensure(),
    ).rejects.toThrow('explicitly disables')
  })

  test('canonical directory creation refuses a symlink planted by repository code', async () => {
    const { home, worktree } = await fixture()
    const outside = join(home, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(worktree, '.agent-workflow'))

    expect(() =>
      ensureBoundPlatformWorkspaceDirectory({
        worktreePath: worktree,
        kind: 'runs',
        segments: ['code-capability', 'round', 'stage'],
      }),
    ).toThrow('symlink or non-directory')
    expect(existsSync(join(outside, 'runs'))).toBe(false)
  })
})
