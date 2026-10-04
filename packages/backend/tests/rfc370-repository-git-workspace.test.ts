// RFC-370: actual SC and Task consumers must use the complete selected Git workspace.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { bindRepositoryCommitParticipant } from '@/modules/source-control/composition'
import {
  bindRepositoryGitWorkspace,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import type {
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
} from '@/modules/source-control/public/types'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { inspectReadonlyRepos, maybeRunCommitPush } from '@/services/scheduler'
import {
  runCommitPush,
  type CommitPushDeps,
  type CommitPushParams,
} from '@/services/commitPushRunner'
import { createLogger } from '@/util/log'
import { runGit } from '@/util/git'
import { GitWorkspaceStore, MappedGitWorkspaceFactory } from './helpers/repositoryGitWorkspace'
import { createTestRepositoryPublicationTransport } from './helpers/taskExecutionTestTopology'
import { held } from './helpers/portArtifactContent'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc370-git-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture() {
  const repo = temp(),
    remote = temp()
  await runGit(remote, ['init', '-q', '--bare', '-b', 'main'])
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await runGit(repo, ['config', 'user.name', 'Workspace Test'])
  await runGit(repo, ['config', 'user.email', 'workspace@example.test'])
  writeFileSync(join(repo, 'keep.txt'), 'base\n')
  writeFileSync(join(repo, 'tracked.tmp'), 'base\n')
  await runGit(repo, ['add', '-A'])
  await runGit(repo, ['commit', '-q', '-m', 'base'])
  await runGit(repo, ['remote', 'add', 'origin', remote])
  await runGit(repo, ['push', '-q', '-u', 'origin', 'main'])
  await runGit(repo, ['checkout', '-q', '-b', 'feature/workspace'])
  const baseSha = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
  const store = new GitWorkspaceStore(),
    ref = 'opaque:root:' + repo.length
  store.locations.set(ref, repo)
  const factory = Object.freeze(new MappedGitWorkspaceFactory(store))
  const workspace = bindRepositoryGitWorkspace(factory, {
    taskId: 'task-git',
    workspaceRef: ref,
    repositoryRef: 'opaque:repository',
  })
  return { repo, remote, baseSha, store, ref, factory, workspace }
}

describe('RFC-370 complete selected repository Git workspace', () => {
  test('all seven SC operations retain selection, exclusion, preview ACK, options and publication session', async () => {
    const f = await fixture()
    writeFileSync(join(f.repo, 'keep.txt'), 'visible\n')
    writeFileSync(join(f.repo, 'tracked.tmp'), 'excluded\n')
    await runGit(f.repo, ['add', 'tracked.tmp'])
    const liveBefore = await runGit(f.repo, ['diff', '--cached', '--raw', '-z'])
    const options = {
      env: { AW_GIT_WORKSPACE_TEST: 'preserved', AW_CANCEL_OVERRIDE: undefined },
      stdin: '',
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    }
    let fallbackCalls = 0
    const transport = f.store.transport(createTestRepositoryPublicationTransport())
    const opened = await transport.open({ subject: { kind: 'system' }, remoteUrl: f.remote })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error('test transport must open')
    const session = opened.session
    const participant = bindRepositoryCommitParticipant({
      repoPath: f.ref,
      configuredPatterns: ['*.tmp'],
      gitWorkspace: f.workspace,
      gitOptions: options,
      runGit: async () => {
        fallbackCalls += 1
        throw new Error('legacy hook used')
      },
      previewIndex: {
        async withIndex() {
          throw new Error('legacy index used')
        },
      },
      runNetworkGit: (cwd, args, opts) => session.runNetwork(cwd, args, opts),
    })
    const cleanupEntered = held<void>(),
      releaseCleanup = held<void>()
    f.store.after = async (call) => {
      if (call.method === 'withPreviewIndex') {
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
    }
    let previewSettled = false
    const previewPromise = participant.preview().then((value) => {
      previewSettled = true
      return value
    })
    try {
      await cleanupEntered.promise
      expect(previewSettled).toBe(false)
      const indexCalls = f.store.nativeCalls.filter((call) => call.options?.env?.GIT_INDEX_FILE)
      expect(indexCalls.length).toBeGreaterThan(0)
      const indexPath = indexCalls[0]!.options!.env!.GIT_INDEX_FILE!
      expect(existsSync(dirname(indexPath))).toBe(false)
      for (const call of indexCalls) {
        expect(call.cwd).toBe(f.repo)
        expect(call.options!.env!.GIT_INDEX_FILE).toBe(indexPath)
        expect(call.options!.env!.AW_GIT_WORKSPACE_TEST).toBe('preserved')
        expect(Object.hasOwn(call.options!.env!, 'AW_CANCEL_OVERRIDE')).toBe(true)
        expect(call.options!.env!.AW_CANCEL_OVERRIDE).toBeUndefined()
        expect(call.options!.stdin).toBe('')
        expect(call.options!.signal).toBe(options.signal)
        expect(call.options!.timeoutMs).toBe(3_000)
      }
      expect(indexCalls.some((call) => call.options!.env!.GIT_LITERAL_PATHSPECS === '1')).toBe(true)
    } finally {
      releaseCleanup.resolve()
    }
    const preview = await previewPromise
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error(preview.error)
    expect(preview.diff).toContain('keep.txt')
    expect(preview.diff).not.toContain('tracked.tmp')
    expect(preview.receipt.excludedPaths).toEqual(['tracked.tmp'])
    expect((await runGit(f.repo, ['diff', '--cached', '--raw', '-z'])).stdout).toBe(
      liveBefore.stdout,
    )
    expect(f.store.calls.find((call) => call.method === 'withPreviewIndex')!.options).toBe(options)

    const classified = await participant.classifyPath({ path: 'tracked.tmp' })
    expect(classified.excluded).toBe(true)
    const prepared = await participant.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.receipt).toEqual(preview.receipt)
    const commit = await participant.commitPrepared({
      message: 'selected workspace commit',
      verification: 'normal',
      authorName: 'Selected Author',
      authorEmail: 'selected@example.test',
    })
    expect(commit.ok).toBe(true)
    if (!commit.ok) throw new Error('selected commit failed')
    expect(
      await participant.resolvePushBase({
        remote: 'origin',
        branch: 'feature/workspace',
        fallbackRef: 'main',
      }),
    ).toBe(f.baseSha)
    expect(
      await participant.updateRef({ ref: 'refs/aw-test/selected', commitSha: commit.commitSha }),
    ).toEqual({ ok: true })
    expect((await runGit(f.repo, ['rev-parse', 'refs/aw-test/selected'])).stdout.trim()).toBe(
      commit.commitSha,
    )
    expect(await participant.updateRef({ ref: 'refs/aw-test/selected' })).toEqual({ ok: true })
    try {
      expect(
        await participant.publish({
          baseSha: f.baseSha,
          tipSha: commit.commitSha,
          mode: { kind: 'normal', remote: 'origin', branch: 'feature/workspace' },
        }),
      ).toEqual({ ok: true, policyDigest: prepared.receipt.policyDigest })
    } finally {
      session.close()
    }
    expect(
      (await runGit(f.remote, ['rev-parse', 'refs/heads/feature/workspace'])).stdout.trim(),
    ).toBe(commit.commitSha)
    expect((await runGit(f.repo, ['log', '-1', '--format=%an <%ae>'])).stdout.trim()).toBe(
      'Selected Author <selected@example.test>',
    )
    expect(f.store.networkCalls).toHaveLength(1)
    expect(f.store.networkCalls[0]!.args[0]).toBe('push')
    expect(
      f.store.calls.some((call) => call.method === 'run' && call.args?.[0] === 'rev-list'),
    ).toBe(true)
    expect(f.store.opened).toBe(1)
    expect(f.store.closed).toBe(1)
    expect(fallbackCalls).toBe(0)
    expect(f.store.bindings).toEqual([
      { taskId: 'task-git', workspaceRef: f.ref, repositoryRef: 'opaque:repository' },
    ])
  }, 30_000)

  test('native compatibility binding has no IO and preserves argv/options/outcome and raw rejection identity', async () => {
    const args = ['status', '--porcelain'],
      options = {
        env: { AW_TEST: undefined },
        stdin: 'stdin',
        timeoutMs: 41,
        signal: new AbortController().signal,
      }
    const result = { stdout: 'raw\0output', stderr: 'raw error', exitCode: 37 }
    const calls: unknown[][] = []
    const native = selectRepositoryGitWorkspaceFactory(undefined, async (...input) => {
      calls.push(input)
      return result
    })
    const root = bindRepositoryGitWorkspace(native, {
      taskId: 'a',
      workspaceRef: '/native/root',
      repositoryRef: 'repo-a',
    })
    const child = root.subrepository('vendor/with spaces')
    expect(calls).toEqual([])
    expect(child.workspaceRef).toBe(join('/native/root', 'vendor/with spaces'))
    expect(await child.run(args, options)).toBe(result)
    expect(calls[0]).toEqual([child.workspaceRef, args, options])
    expect(calls[0]![1]).toBe(args)
    expect(calls[0]![2]).toBe(options)
    const raw = Object.freeze({
      toString() {
        throw new Error('unprintable')
      },
    })
    const rejecting = selectRepositoryGitWorkspaceFactory(undefined, async () => {
      throw raw
    })
    await expect<unknown>(
      bindRepositoryGitWorkspace(rejecting, {
        taskId: 'b',
        workspaceRef: '/native/b',
        repositoryRef: 'repo-b',
      }).run(args),
    ).rejects.toBe(raw)
  })

  test('selected preview captures the original options receiver while retaining its live env contents', async () => {
    const f = await fixture()
    const options = {
      env: { AW_GIT_WORKSPACE_TEST: 'initial' },
      timeoutMs: 3_000,
      signal: new AbortController().signal,
    }
    const input: Parameters<typeof bindRepositoryCommitParticipant>[0] = {
      repoPath: f.ref,
      gitWorkspace: f.workspace,
      gitOptions: options,
    }
    const participant = bindRepositoryCommitParticipant(input)
    const replacement = new AbortController()
    replacement.abort()
    input.gitOptions = {
      env: { AW_GIT_WORKSPACE_TEST: 'replacement' },
      timeoutMs: 0,
      signal: replacement.signal,
    }
    options.env.AW_GIT_WORKSPACE_TEST = 'live original'
    expect((await participant.preview()).ok).toBe(true)
    expect(f.store.calls.find((call) => call.method === 'withPreviewIndex')!.options).toBe(options)
    expect(f.store.nativeCalls.length).toBeGreaterThan(0)
    for (const call of f.store.nativeCalls) {
      expect(call.options!.env!.AW_GIT_WORKSPACE_TEST).toBe('live original')
      expect(call.options!.timeoutMs).toBe(3_000)
      expect(call.options!.signal).toBe(options.signal)
    }
  }, 30_000)

  test('native resolve/update retain call-time hooks while prepare retains its captured hook', async () => {
    const oldFailure = new Error('captured native preparation')
    const oldCalls: string[][] = [],
      newCalls: string[][] = []
    const input: Parameters<typeof bindRepositoryCommitParticipant>[0] = {
      repoPath: '/native/hook',
      runGit: async (_cwd, args) => {
        oldCalls.push(args)
        throw oldFailure
      },
    }
    const participant = bindRepositoryCommitParticipant(input)
    input.runGit = async (_cwd, args) => {
      newCalls.push(args)
      return { stdout: 'new-head\n', stderr: '', exitCode: 0 }
    }
    expect(
      await participant.resolvePushBase({
        remote: 'origin',
        branch: 'feature',
        fallbackRef: 'main',
      }),
    ).toBe('new-head')
    expect(await participant.updateRef({ ref: 'refs/aw-test/hot', commitSha: 'new-head' })).toEqual(
      { ok: true },
    )
    await expect<unknown>(participant.prepare()).rejects.toBe(oldFailure)
    expect(oldCalls).toEqual([['add', '-A']])
    expect(newCalls).toEqual([
      ['rev-parse', '--verify', 'refs/remotes/origin/feature^{commit}'],
      ['update-ref', 'refs/aw-test/hot', 'new-head'],
    ])
  })

  test('invalid explicit factories and scopes fail in actual commit/SC consumers before physical IO', async () => {
    const params = { taskId: 'invalid', worktreePath: 'opaque:invalid' } as CommitPushParams
    let physicalCalls = 0
    for (const selected of [
      null,
      {},
      { bind: () => null },
      {
        bind: () => ({
          workspaceRef: 'opaque:invalid',
          run: () => {
            physicalCalls += 1
          },
        }),
      },
    ]) {
      const deps = { repositoryGitWorkspaces: selected } as unknown as CommitPushDeps
      await expect(runCommitPush(params, deps)).rejects.toThrow(
        'Repository Git requires a complete workspace',
      )
    }
    expect(() =>
      bindRepositoryCommitParticipant({
        repoPath: 'opaque:invalid',
        gitWorkspace: null as unknown as RepositoryGitWorkspaceScope,
      }),
    ).toThrow('Repository Git requires a complete workspace scope')
    expect(physicalCalls).toBe(0)
  })

  test('selected prepare and preview propagate the original rejection after native preview cleanup', async () => {
    const f = await fixture()
    const raw = Object.freeze({
      toString() {
        throw new Error('unprintable selected failure')
      },
    })
    let fallbackCalls = 0
    const factory = Object.freeze(
      new MappedGitWorkspaceFactory(f.store, async () => {
        throw raw
      }),
    )
    const scope = bindRepositoryGitWorkspace(factory, {
      taskId: 'rejected-task',
      workspaceRef: f.ref,
      repositoryRef: 'rejected-repository',
    })
    const participant = bindRepositoryCommitParticipant({
      repoPath: f.ref,
      gitWorkspace: scope,
      runGit: async () => {
        fallbackCalls += 1
        throw new Error('legacy fallback used')
      },
      previewIndex: {
        async withIndex() {
          fallbackCalls += 1
          throw new Error('legacy preview fallback used')
        },
      },
    })
    await expect<unknown>(participant.prepare()).rejects.toBe(raw)
    await expect<unknown>(participant.preview()).rejects.toBe(raw)
    expect(f.store.nativeCalls.map((call) => call.args)).toEqual([
      ['add', '-A'],
      ['read-tree', 'HEAD'],
    ])
    const indexPath = f.store.nativeCalls.at(-1)!.options!.env!.GIT_INDEX_FILE!
    expect(existsSync(dirname(indexPath))).toBe(false)
    expect(fallbackCalls).toBe(0)
    expect(f.store.opened).toBe(0)
  }, 30_000)

  test('Task readonly inspection waits for status and persistence ACK with the selected receiver and task/repo identities', async () => {
    const f = await fixture()
    writeFileSync(join(f.repo, 'keep.txt'), 'modified\n')
    const entered = held<void>(),
      releaseStatus = held<void>(),
      persistenceEntered = held<void>(),
      releasePersistence = held<void>()
    f.store.before = async (call) => {
      if (call.method === 'run') {
        entered.resolve()
        await releaseStatus.promise
      }
    }
    const recorded: unknown[] = []
    const state = {
      task: { id: 'readonly-task' },
      repos: [
        {
          readonly: true,
          worktreePath: f.ref,
          repoPath: 'readonly-repo',
          repoIndex: 3,
          mountPath: 'mount',
        },
        { readonly: false, worktreePath: 'opaque:never', repoPath: 'never' },
      ],
      opts: {
        repositoryGitWorkspaces: f.factory,
        persistence: {
          scheduler: {
            async recordReadonlyDirty(input: unknown) {
              recorded.push(input)
              persistenceEntered.resolve()
              await releasePersistence.promise
            },
          },
        },
      },
    } as unknown as TaskMechanicsState
    let done = false
    const pending = inspectReadonlyRepos(state, createLogger('selected-git-test')).then(() => {
      done = true
    })
    try {
      await entered.promise
      expect(recorded).toEqual([])
      expect(done).toBe(false)
      releaseStatus.resolve()
      await persistenceEntered.promise
      expect(done).toBe(false)
      expect(recorded).toEqual([
        expect.objectContaining({ taskId: 'readonly-task', repoIndex: 3, changedCount: 1 }),
      ])
    } finally {
      releaseStatus.resolve()
      releasePersistence.resolve()
    }
    await pending
    expect(f.store.bindings.at(-1)).toEqual({
      taskId: 'readonly-task',
      workspaceRef: f.ref,
      repositoryRef: 'readonly-repo',
    })
    expect(f.store.calls.filter((call) => call.method === 'run').map((call) => call.args)).toEqual([
      ['status', '--porcelain'],
    ])
  }, 30_000)

  test('Task auto-commit status uses selected scopes for each repository even when readonly or clean', async () => {
    const calls: string[][] = [],
      bindings: unknown[] = []
    const factory: RepositoryGitWorkspaceFactory = Object.freeze({
      bind(binding) {
        bindings.push(binding)
        return Object.freeze({
          workspaceRef: binding.workspaceRef,
          async run(args) {
            calls.push([binding.workspaceRef, ...args])
            return { stdout: '', stderr: '', exitCode: 0 }
          },
          hasSubmodules: () => false,
          effectiveSubmodules: () => [],
          async withPreviewIndex() {
            throw new Error('clean repo must not preview')
          },
          subrepository() {
            throw new Error('clean repo must not discover children')
          },
        } satisfies RepositoryGitWorkspaceScope)
      },
    })
    const state = {
      task: { id: 'auto-task', branch: 'feature/x' },
      repos: [
        { readonly: true, worktreePath: 'opaque:a', repoPath: 'repo-a' },
        { readonly: false, worktreePath: 'opaque:b', repoPath: 'repo-b' },
      ],
      opts: {
        repositoryGitWorkspaces: factory,
        persistence: {
          scheduler: {
            async listDoneNodeRuns() {
              return []
            },
          },
        },
        runtimeRegistry: {
          async resolveInternalAgentRuntime() {
            return {}
          },
        },
      },
    } as unknown as TaskMechanicsState
    expect(
      await maybeRunCommitPush(
        state,
        { id: 'worker', kind: 'agent-single', agentId: 'a' },
        0,
        createLogger('selected-git-test'),
      ),
    ).toEqual({})
    expect(calls).toEqual([
      ['opaque:a', 'status', '--porcelain'],
      ['opaque:b', 'status', '--porcelain'],
    ])
    expect(bindings).toEqual([
      { taskId: 'auto-task', workspaceRef: 'opaque:a', repositoryRef: 'repo-a' },
      { taskId: 'auto-task', workspaceRef: 'opaque:b', repositoryRef: 'repo-b' },
    ])
  })
})
