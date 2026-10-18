// RFC-377 locks caller-owned submodule policy and its original execution timing.
// Local repositories cover successful materialization, defaults and resolver cleanup failures.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  alignWorktreeGitlinks,
  createIsolatedWorktree,
  createWorktree,
  materializeTree,
  runGit,
  snapshotFullState,
  type CreateWorktreeOptions,
  type SubmoduleMode,
} from '@/util/git'

const roots: string[] = []

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await runGit(repoPath, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc377-policy-'))
  roots.push(root)
  const repoPath = join(root, 'repo')
  const appHome = join(root, 'home')
  mkdirSync(repoPath)
  await git(repoPath, ['init', '-q', '-b', 'main'])
  await git(repoPath, ['config', 'user.name', 'RFC377'])
  await git(repoPath, ['config', 'user.email', 'rfc377@example.test'])
  writeFileSync(join(repoPath, 'base.txt'), 'base\n')
  // No gitlink: sync observes .gitmodules without contacting any remote.
  writeFileSync(
    join(repoPath, '.gitmodules'),
    '[submodule "unused"]\n\tpath = unused\n\turl = ./unused-local-submodule\n',
  )
  await git(repoPath, ['add', '.'])
  await git(repoPath, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'])
  const head = await git(repoPath, ['rev-parse', 'HEAD'])
  const tree = await git(repoPath, ['rev-parse', 'HEAD^{tree}'])
  return { root, repoPath, appHome, head, tree }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-377 submodule policy injection', () => {
  test.each(['never', 'auto'] as const)(
    'createWorktree resolves once after post-add and honors %s',
    async (mode) => {
      const { repoPath, appHome } = await fixture()
      const stages: string[] = []
      const resolver = mock((inputMode: SubmoduleMode | undefined, jobs: number | undefined) => {
        expect(stages.at(-1)).toBe('post-add-before-submodules')
        expect(inputMode).toBe('always')
        expect(jobs).toBe(7)
        stages.push('resolve')
        return { mode, jobs: 1, remote: false }
      })
      const result = await createWorktree({
        repoPath,
        appHome,
        taskId: `policy-${mode}`,
        submoduleMode: 'always',
        submoduleJobs: 7,
        resolveSubmoduleParams: resolver,
        lifecycleHook: (event) => {
          stages.push(event.stage)
          if (event.stage === 'post-add-before-submodules') {
            expect(existsSync(event.worktreePath)).toBe(true)
          }
        },
      })
      expect(resolver).toHaveBeenCalledTimes(1)
      expect(resolver).toHaveBeenCalledWith('always', 7)
      expect(result.hasSubmodules).toBe(mode === 'auto')
      expect(result.submoduleInitOk).toBe(true)
      expect(result.submoduleInitError).toBeNull()
    },
  )

  test('createWorktree forwards omitted policy inputs to the resolver', async () => {
    const { repoPath, appHome } = await fixture()
    const resolver = mock(() => ({ mode: 'never' as const, jobs: 1, remote: false }))
    const result = await createWorktree({
      repoPath,
      appHome,
      taskId: 'policy-defaults',
      resolveSubmoduleParams: resolver,
    })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith(undefined, undefined)
    expect(result.hasSubmodules).toBe(false)
  })

  test('resolver failure propagates unchanged after removing the worktree and branch', async () => {
    const { repoPath, appHome } = await fixture()
    const failure = new Error('policy unavailable')
    const stages: string[] = []
    let worktreePath = ''
    let branchRef = ''
    const resolver = mock(() => {
      expect(stages.at(-1)).toBe('post-add-before-submodules')
      throw failure
    })
    let caught: unknown
    try {
      await createWorktree({
        repoPath,
        appHome,
        taskId: 'policy-error',
        resolveSubmoduleParams: resolver,
        lifecycleHook: (event) => {
          stages.push(event.stage)
          worktreePath = event.worktreePath
          branchRef = event.branchRef
        },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(stages).toContain('post-add-cleanup-worktree-remove')
    expect(stages).toContain('post-add-cleanup-branch-restore')
    expect(worktreePath).not.toBe('')
    expect(branchRef).not.toBe('')
    expect(existsSync(worktreePath)).toBe(false)
    expect((await runGit(repoPath, ['show-ref', '--verify', '--quiet', branchRef])).exitCode).toBe(
      1,
    )
    expect(await git(repoPath, ['worktree', 'list', '--porcelain'])).not.toContain(worktreePath)
  })

  const inputs: Array<{
    label: string
    options: Pick<CreateWorktreeOptions, 'submoduleMode' | 'submoduleJobs'>
  }> = [
    { label: 'explicit', options: { submoduleMode: 'always', submoduleJobs: 3 } },
    { label: 'omitted', options: {} },
  ]

  for (const { label, options } of inputs) {
    test(`createIsolatedWorktree resolves ${label} inputs once after checkout`, async () => {
      const { root, repoPath, head } = await fixture()
      const isoPath = join(root, 'iso')
      const resolver = mock(() => {
        expect(readFileSync(join(isoPath, 'base.txt'), 'utf8')).toBe('base\n')
        return { mode: 'never' as const, jobs: 1, remote: true }
      })
      await createIsolatedWorktree({
        repoPath,
        isoPath,
        baseSnapshotCommit: head,
        taskBaseHead: head,
        ...options,
        resolveSubmoduleParams: resolver,
      })
      expect(resolver).toHaveBeenCalledTimes(1)
      expect(resolver).toHaveBeenCalledWith(options.submoduleMode, options.submoduleJobs)
    })

    test(`alignWorktreeGitlinks resolves ${label} inputs once`, async () => {
      const { repoPath, tree } = await fixture()
      const resolver = mock(() => ({ mode: 'never' as const, jobs: 1, remote: false }))
      expect(
        await alignWorktreeGitlinks(repoPath, tree, tree, {
          ...options,
          resolveSubmoduleParams: resolver,
        }),
      ).toBe(false)
      expect(resolver).toHaveBeenCalledTimes(1)
      expect(resolver).toHaveBeenCalledWith(options.submoduleMode, options.submoduleJobs)
    })

    test(`materializeTree resolves ${label} inputs once after writing the tree`, async () => {
      const { repoPath, tree } = await fixture()
      writeFileSync(join(repoPath, 'base.txt'), 'merged\n')
      const snapshot = await snapshotFullState(repoPath)
      writeFileSync(join(repoPath, 'base.txt'), 'base\n')
      const resolver = mock(() => {
        expect(readFileSync(join(repoPath, 'base.txt'), 'utf8')).toBe('merged\n')
        return { mode: 'never' as const, jobs: 1, remote: true }
      })
      await materializeTree(repoPath, {
        mergedTree: await git(repoPath, ['rev-parse', `${snapshot}^{tree}`]),
        canonCurrentTree: tree,
        ...options,
        resolveSubmoduleParams: resolver,
      })
      expect(resolver).toHaveBeenCalledTimes(1)
      expect(resolver).toHaveBeenCalledWith(options.submoduleMode, options.submoduleJobs)
      expect(await git(repoPath, ['diff', '--name-only'])).toBe('base.txt')
    })
  }
})
