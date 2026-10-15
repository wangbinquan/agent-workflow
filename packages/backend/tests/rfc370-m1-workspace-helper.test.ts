// RFC-370 M1: the task-image helper delegates real Git/script semantics to
// the same native owners, with a supplied fixture volume instead of /work.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '@/util/git'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import type {
  MaterializedSpace,
  ResolvedRepoSource,
} from '@/modules/source-control/application/workspaceMaterialization'
import type {
  ResolvedInterpreter,
  ScriptRunOutcome,
  ScriptRunRequest,
} from '@/modules/task-execution/infrastructure/local/scriptRun'
import type { IsolationWorkspace } from '@/modules/source-control/application/ports/isolationWorkspace'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'

beforeAll(startGitHttpRemote)
afterAll(stopGitHttpRemote)

test('remote clone/fetch, worktree, Git diff and script all share the task volume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-volume-'))
  const remote = join(root, 'remote')
  mkdirSync(remote)
  const git = async (path: string, args: string[]) => {
    const result = await runGit(path, args)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const call = <T>(operation: string, input: unknown): Promise<T> =>
    executeWorkspaceTaskImageOperation(operation, input, undefined, root) as Promise<T>
  try {
    await git(remote, ['init', '-b', 'main'])
    await git(remote, ['config', 'user.name', 'Fixture'])
    await git(remote, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(remote, 'hello.txt'), 'before\n')
    await git(remote, ['add', 'hello.txt'])
    await git(remote, ['commit', '-m', 'initial'])
    const url = remoteUrlFor(remote)
    const source = await call<ResolvedRepoSource>('resolve-repository', {
      id: 'repo',
      url,
      ref: 'main',
    })
    expect(source.resolvedCommit).toBe(await git(remote, ['rev-parse', 'HEAD']))
    // A warm clone must resolve the newly fetched branch, not its stale local main.
    writeFileSync(join(remote, 'new.txt'), 'new\n')
    await git(remote, ['add', 'new.txt'])
    await git(remote, ['commit', '-m', 'advance'])
    const advanced = await call<ResolvedRepoSource>('resolve-repository', {
      id: 'repo',
      url,
      ref: 'main',
    })
    expect(advanced.resolvedCommit).toBe(await git(remote, ['rev-parse', 'HEAD']))
    expect(advanced.resolvedCommit).not.toBe(source.resolvedCommit)
    const space = await call<MaterializedSpace>('materialize-single', {
      taskId: 'task',
      source: advanced,
      gitCommitIdentity: { name: 'Task Actor', email: 'task@example.test' },
    })
    expect(space.earlyError).toBeNull()
    expect(await call('is-git', { path: space.worktreePath })).toBe(true)
    const binding = {
      taskId: 'task',
      storageRootRef: root,
      repositories: [
        {
          repositoryRef: advanced.repoPath,
          workspaceRef: space.worktreePath,
          mount: '',
          baseBranch: 'main',
        },
      ],
    }
    const isolated = await call<IsolationWorkspace>('isolation', {
      binding,
      method: 'create',
      args: [{ key: 'wrapper', dbNodeRunId: 'wrapper' }],
    })
    expect(isolated.passthrough).toBe(false)
    await call('write-seeds', {
      path: isolated.workspaceRef,
      files: [{ path: 'hello.txt', content: 'after\n' }],
    })
    expect(readFileSync(join(space.worktreePath, 'hello.txt'), 'utf8')).toBe('before\n')
    const captured = await call<{ workspace: IsolationWorkspace; trees: Record<string, string> }>(
      'isolation',
      { binding, method: 'snapshot', args: [isolated] },
    )
    const merged = await call<{ clean: boolean; workspace: IsolationWorkspace }>('isolation', {
      binding,
      method: 'merge',
      args: [captured.workspace, captured.trees],
    })
    expect(merged.clean).toBe(true)
    expect(readFileSync(join(space.worktreePath, 'hello.txt'), 'utf8')).toBe('after\n')
    const diff = await call<{ stdout: string; exitCode: number }>('git', {
      path: space.worktreePath,
      args: ['diff', '--', 'hello.txt'],
    })
    // Merge may commit the canonical tree. Compare against the frozen base.
    const changed = await call<{ stdout: string }>('git', {
      path: space.worktreePath,
      args: ['diff', advanced.resolvedCommit, '--', 'hello.txt'],
    })
    expect(changed.stdout).toContain('+after')
    expect(diff.exitCode).toBe(0)
    const interpreter = await call<ResolvedInterpreter>('script-interpreter', {
      language: 'node',
      overrides: {},
    })
    expect(interpreter).not.toBeNull()
    const request: ScriptRunRequest = {
      node: {
        id: 'script',
        kind: 'script',
        language: 'node',
        script:
          'import {readFileSync} from "node:fs"; console.log(readFileSync("hello.txt", "utf8"))',
      },
      inputs: {},
      taskId: 'task',
      nodeId: 'script',
      nodeRunId: 'run',
      iteration: 0,
      retryIndex: 0,
      shardKey: null,
      envelopeNonce: 'nonce',
      runDir: join(root, 'runs', 'task', 'run'),
      worktreePath: space.worktreePath,
      repos: [],
      interpreter,
      depsEnv: null,
      timeoutMs: 10_000,
    }
    const script = await call<ScriptRunOutcome>('run-script', request)
    expect(script.result.outcome).toBe('exited')
    expect(script.result.exitCode).toBe(0)
    expect(script.result.rawStdout).toContain('after')
    expect(script.result).not.toHaveProperty('pid')
    expect(readFileSync(join(space.worktreePath, 'new.txt'), 'utf8')).toBe('new\n')
    await call('isolation', { binding, method: 'discard', args: [merged.workspace] })
    expect(await call('cleanup-space', space)).toMatchObject({ complete: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('the helper rejects paths outside its volume and unsupported commands before effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-helper-'))
  try {
    await expect(
      executeWorkspaceTaskImageOperation(
        'exists',
        { path: join(root, '..', 'outside') },
        undefined,
        root,
      ),
    ).rejects.toThrow('outside-work-volume')
    await expect(
      executeWorkspaceTaskImageOperation(
        'resolve-repository',
        { id: 'repo', url: 'https://user:secret@example.test/repo' },
        undefined,
        root,
      ),
    ).rejects.toThrow('platform-credentials')
    await expect(
      executeWorkspaceTaskImageOperation('arbitrary', {}, undefined, root),
    ).rejects.toThrow('operation-unknown')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
