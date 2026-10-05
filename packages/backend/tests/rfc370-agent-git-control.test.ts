// RFC-370: Task's original six semantic Git observations must survive the purpose cut.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureAgentWorkspaceGitControlSnapshot } from '@/modules/source-control/application/agentWorkspaceGitControl'
import { bindNativeAgentWorkspaceGitControlObservation } from '@/modules/source-control/composition/agentWorkspaceGitControl'
import type {
  RepositoryGitOutcome,
  RepositoryGitWorkspaceScope,
} from '@/modules/source-control/application/ports/repositoryGitWorkspace'
import { runGit } from '@/util/git'
import { sha256Hex } from '@/util/hash'
import { GitWorkspaceStore, MappedGitWorkspaceFactory } from './helpers/repositoryGitWorkspace'

const roots: string[] = []
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc370-agent-git-control-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]) {
  const result = await runGit(cwd, args)
  expect(result.exitCode).toBe(0)
  return result
}

async function fixture(commit = true) {
  const repo = temp()
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'Agent Git Control Test'])
  await git(repo, ['config', 'user.email', 'agent-git-control@example.test'])
  if (commit) {
    writeFileSync(join(repo, 'tracked.txt'), 'initial\n')
    await git(repo, ['add', 'tracked.txt'])
    await git(repo, ['commit', '-q', '-m', repo])
  }
  const observation = bindNativeAgentWorkspaceGitControlObservation({
    workingDirectory: () => repo,
  })
  return { repo, observation }
}

describe('RFC-370 Task Agent Git control purpose', () => {
  test('native binding is inert and samples the current cwd once per capture with its receiver', async () => {
    const first = await fixture()
    const second = await fixture()
    const input = {
      cwd: first.repo,
      reads: 0,
      workingDirectory() {
        this.reads += 1
        return this.cwd
      },
    }
    const observation = bindNativeAgentWorkspaceGitControlObservation(input)
    expect(input.reads).toBe(0)
    expect(await observation.capture()).toEqual(await first.observation.capture())
    expect(input.reads).toBe(1)
    input.cwd = second.repo
    expect(await observation.capture()).toEqual(await second.observation.capture())
    expect(input.reads).toBe(2)
  }, 30_000)

  test('staging content changes the semantic index without substituting HEAD', async () => {
    const f = await fixture()
    const before = await f.observation.capture()
    writeFileSync(join(f.repo, 'tracked.txt'), 'staged edit\n')
    await git(f.repo, ['add', 'tracked.txt'])
    const after = await f.observation.capture()
    expect(after.index).not.toBe(before.index)
    expect(after.head).toBe(before.head)
    expect(after.symbolicHead).toBe(before.symbolicHead)
    expect(after.refs).toBe(before.refs)
  }, 30_000)

  test('a readonly status refresh can rewrite index stat bytes without changing control state', async () => {
    const f = await fixture()
    const before = await f.observation.capture()
    const indexBefore = readFileSync(join(f.repo, '.git', 'index'))
    utimesSync(join(f.repo, 'tracked.txt'), new Date('2001-01-01'), new Date('2001-01-01'))
    expect((await git(f.repo, ['status', '--porcelain'])).stdout).toBe('')
    expect(readFileSync(join(f.repo, '.git', 'index')).equals(indexBefore)).toBe(false)
    expect(await f.observation.capture()).toEqual(before)
  }, 30_000)

  test('the exact private namespace is excluded while a similar public namespace remains visible', async () => {
    const f = await fixture()
    const before = await f.observation.capture()
    await git(f.repo, ['update-ref', 'refs/agent-workflow/task/control-test', 'HEAD'])
    expect(await f.observation.capture()).toEqual(before)
    await git(f.repo, ['update-ref', 'refs/agent-workflowish/control-test', 'HEAD'])
    const after = await f.observation.capture()
    expect(after.refs).not.toBe(before.refs)
    expect(after.head).toBe(before.head)
    expect(after.index).toBe(before.index)
  }, 30_000)

  test('switching symbolic HEAD to a branch at the same commit remains observable', async () => {
    const f = await fixture()
    await git(f.repo, ['branch', 'other'])
    const before = await f.observation.capture()
    await git(f.repo, ['checkout', '-q', 'other'])
    const after = await f.observation.capture()
    expect(after.symbolicHead).not.toBe(before.symbolicHead)
    expect(after.head).toBe(before.head)
    expect(after.refs).toBe(before.refs)
    expect(after.index).toBe(before.index)
  }, 30_000)

  test('local and separate worktree configuration both keep their original observations', async () => {
    const f = await fixture()
    const initial = await f.observation.capture()
    await git(f.repo, ['config', '--local', 'agentControl.local', 'one'])
    const local = await f.observation.capture()
    expect(local.localConfig).not.toBe(initial.localConfig)
    await git(f.repo, ['config', '--local', 'extensions.worktreeConfig', 'true'])
    const beforeWorktree = await f.observation.capture()
    await git(f.repo, ['config', '--worktree', 'agentControl.worktree', 'two'])
    const afterWorktree = await f.observation.capture()
    expect(afterWorktree.worktreeConfig).not.toBe(beforeWorktree.worktreeConfig)
    expect(afterWorktree.localConfig).toBe(beforeWorktree.localConfig)
    expect(afterWorktree.head).toBe(beforeWorktree.head)
  }, 30_000)

  test('an unborn HEAD retains the real nonzero result, empty stdout and stderr', async () => {
    const f = await fixture(false)
    const outcome = await runGit(f.repo, ['rev-parse', '--verify', 'HEAD'])
    expect(outcome.exitCode).not.toBe(0)
    expect(outcome.stdout).toBe('')
    expect(outcome.stderr.length).toBeGreaterThan(0)
    const snapshot = await f.observation.capture()
    expect(snapshot.head).toBe(
      sha256Hex(`${outcome.exitCode}\0${outcome.stdout}\0${outcome.stderr}`),
    )
    expect(snapshot.head).not.toBe(sha256Hex(''))
  }, 30_000)

  test('the selected opaque workspace runs the actual six operations through its whole receiver', async () => {
    const f = await fixture()
    const store = new GitWorkspaceStore()
    const workspaceRef = 'opaque:agent-window:git-control'
    store.locations.set(workspaceRef, f.repo)
    const workspace = new MappedGitWorkspaceFactory(store).bind({
      taskId: 'task-control',
      workspaceRef,
      repositoryRef: 'opaque:repository:control',
    })
    expect(store.calls).toEqual([])
    expect(await captureAgentWorkspaceGitControlSnapshot(workspace)).toEqual(
      await f.observation.capture(),
    )
    expect(store.calls).toHaveLength(6)
    expect(
      store.calls.every((call) => call.workspaceRef === workspaceRef && call.method === 'run'),
    ).toBe(true)
    expect(store.nativeCalls).toHaveLength(6)
    expect(store.nativeCalls.every((call) => call.cwd === f.repo)).toBe(true)
  }, 30_000)

  test('the selected six reads start in parallel, keep their receiver and preserve raw failure facts', async () => {
    const calls: string[][] = []
    const resolvers: Array<(outcome: RepositoryGitOutcome) => void> = []
    const selected = {
      identity: 'opaque:no-native-path',
      run(args: readonly string[]) {
        expect(this.identity).toBe('opaque:no-native-path')
        calls.push([...args])
        return new Promise<RepositoryGitOutcome>((resolve) => resolvers.push(resolve))
      },
    } satisfies Pick<RepositoryGitWorkspaceScope, 'run'> & { identity: string }
    const pending = captureAgentWorkspaceGitControlSnapshot(selected)
    expect(calls).toEqual([
      ['rev-parse', '--verify', 'HEAD'],
      ['symbolic-ref', '--quiet', 'HEAD'],
      ['ls-files', '--stage', '-z'],
      ['for-each-ref', '--format=%(refname) %(objectname)'],
      ['config', '--local', '--null', '--list'],
      ['config', '--worktree', '--null', '--list'],
    ])
    expect(resolvers).toHaveLength(6)
    const outcomes: RepositoryGitOutcome[] = Array.from({ length: 6 }, (_, index) => ({
      exitCode: 31 + index,
      stdout: index === 0 ? '' : `raw-${index}\0stdout`,
      stderr: `stderr-${index}`,
    }))
    outcomes[3]!.stdout =
      'refs/heads/main aa\nrefs/agent-workflow/private bb\nrefs/agent-workflowish/public cc\n'
    for (let index = 5; index >= 0; index -= 1) resolvers[index]!(outcomes[index]!)
    const snapshot = await pending
    const fields = [
      'head',
      'symbolicHead',
      'index',
      'refs',
      'localConfig',
      'worktreeConfig',
    ] as const
    expect(Object.keys(snapshot)).toEqual([...fields])
    for (let index = 0; index < fields.length; index += 1) {
      const outcome = outcomes[index]!
      const stdout =
        index === 3 ? 'refs/heads/main aa\nrefs/agent-workflowish/public cc\n' : outcome.stdout
      expect(snapshot[fields[index]!]).toBe(
        sha256Hex(`${outcome.exitCode}\0${stdout}\0${outcome.stderr}`),
      )
    }
  })

  test('a selected read rejection keeps its identity and never substitutes a native result', async () => {
    const raw = Object.freeze({ reason: 'selected-observation-unavailable' })
    let calls = 0
    const selected = {
      async run() {
        calls += 1
        throw raw
      },
    } satisfies Pick<RepositoryGitWorkspaceScope, 'run'>
    const received = await captureAgentWorkspaceGitControlSnapshot(selected).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(received).toBe(raw)
    expect(calls).toBe(6)
  })
})
