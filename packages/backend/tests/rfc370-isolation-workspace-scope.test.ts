// RFC-370: complete selection and restartable native workspace values.
// Actual Task/wrapper wiring is covered separately; these tests lock the adapter contract.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  IsolationWorkspaceBinding,
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
} from '@/modules/source-control/application/ports/isolationWorkspace'
import {
  requireIsolationWorkspaceScope,
  selectIsolationWorkspaceFactory,
} from '@/modules/source-control/composition/isolationWorkspaces'
import { createLocalIsolationWorkspaceFactory } from '@/modules/source-control/infrastructure/local/localIsolationWorkspace'
import { describeEffectError } from '@/modules/task-execution/domain/effectErrorDescription'
import { runGit } from '@/util/git'
import { removeTempDirSync } from './fixtures/tempDir'

const binding: IsolationWorkspaceBinding = {
  taskId: 'logical-task',
  storageRootRef: 'opaque:storage',
  repositories: [
    {
      repositoryRef: 'opaque:repo',
      workspaceRef: 'opaque:workspace',
      mount: '',
      baseBranch: 'main',
    },
  ],
}

describe('RFC-370 isolation scope selection', () => {
  test('native construction and scene binding perform no IO', async () => {
    const factory = selectIsolationWorkspaceFactory()
    const scope = await factory.bind(binding)
    requireIsolationWorkspaceScope(scope)
    expect(Object.isFrozen(factory)).toBe(true)
    expect(Object.isFrozen(scope)).toBe(true)
  })

  test('explicit null or incomplete choices fail instead of selecting native', () => {
    for (const value of [null, {}, { bind: 0 }]) {
      expect(() =>
        selectIsolationWorkspaceFactory(value as unknown as IsolationWorkspaceFactory),
      ).toThrow('Isolation requires a complete workspace factory')
    }
    for (const value of [null, {}, { create: () => undefined }]) {
      expect(() => requireIsolationWorkspaceScope(value)).toThrow(
        'Isolation requires a complete workspace scope',
      )
    }
  })

  test('a frozen prototype/private factory keeps its receiver and original rejection', async () => {
    const rejection = Object.create(null) as object
    class SelectedFactory implements IsolationWorkspaceFactory {
      #calls: IsolationWorkspaceBinding[] = []
      get calls() {
        return this.#calls
      }
      async bind(scene: IsolationWorkspaceBinding): Promise<IsolationWorkspaceScope> {
        this.#calls.push(scene)
        throw rejection
      }
    }
    const factory = Object.freeze(new SelectedFactory())
    const selected = selectIsolationWorkspaceFactory(factory)
    expect(selected).toBe(factory)
    await expect<unknown>(selected.bind(binding)).rejects.toBe(rejection)
    expect(factory.calls).toEqual([binding])
    expect(factory.calls[0]).toBe(binding)
  })
})

test('native create, snapshot, merge and restart restore retain topology and real row identity', async () => {
  const canon = mkdtempSync(join(tmpdir(), 'aw-rfc370-scope-canon-'))
  const storageRootRef = mkdtempSync(join(tmpdir(), 'aw-rfc370-scope-home-'))
  try {
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 't@e.com'],
      ['config', 'user.name', 'T'],
    ])
      expect((await runGit(canon, args)).exitCode).toBe(0)
    writeFileSync(join(canon, 'base.txt'), 'base\n')
    expect((await runGit(canon, ['add', '.'])).exitCode).toBe(0)
    expect((await runGit(canon, ['commit', '-q', '-m', 'init'])).exitCode).toBe(0)
    const scene: IsolationWorkspaceBinding = {
      taskId: 'rfc370-native-scope',
      storageRootRef,
      repositories: [{ repositoryRef: canon, workspaceRef: canon, mount: '', baseBranch: 'main' }],
    }
    const scope = await createLocalIsolationWorkspaceFactory().bind(scene)
    const chosen = await scope.chooseGeneration('actual-run-2')
    expect(chosen).toEqual({ key: 'actual-run-2', generation: 0, reclaimed: 0 })
    const workspace = await scope.create({ key: chosen.key, dbNodeRunId: 'actual-run' })
    expect(workspace.key).toBe('actual-run-2')
    expect(workspace.dbNodeRunId).toBe('actual-run')
    const repo = workspace.repositories[0]!
    expect(await scope.submodulePresence(repo.workspaceRef)).toBe(false)
    expect((await scope.head(repo.workspaceRef)).stdout.trim()).toBe(repo.taskBaseHead)
    writeFileSync(join(repo.workspaceRef, 'base.txt'), 'scope edit\n')
    expect(await scope.changedFiles(repo.workspaceRef, repo.taskBaseHead)).toContain('base.txt')
    const hashes = await scope.blobHashes(repo.workspaceRef, ['base.txt', 'deleted.txt'])
    expect(hashes['base.txt']).toMatch(/^[a-f0-9]{40}$/)
    expect(hashes['deleted.txt']).toBe('deleted')
    expect(
      await scope.undoShard({
        workspaceRef: repo.workspaceRef,
        priorNodeCommit: undefined,
        priorBaseCommit: repo.baseSnapshot,
      }),
    ).toBe(false)
    const snapshot = await scope.snapshot(workspace)
    expect(snapshot.workspace).toBe(workspace)
    const restoredScope = await createLocalIsolationWorkspaceFactory().bind(scene)
    const key = await restoredScope.recoverKey(workspace.workspaceRef, workspace.dbNodeRunId)
    const restored = await restoredScope.restore({
      key,
      dbNodeRunId: workspace.dbNodeRunId,
      workspaceRef: workspace.workspaceRef,
      baseSnapshots: { '': repo.baseSnapshot },
      taskBaseHeads: { '': repo.taskBaseHead },
      submodules: {
        '': {
          submoduleBases: repo.submoduleBases,
          poolRefs: repo.poolRefs,
          pendingSubResolutions: repo.pendingSubResolutions,
        },
      },
    })
    expect(restored).toEqual(workspace)
    const merged = await restoredScope.merge(restored, snapshot.trees)
    expect(merged.clean).toBe(true)
    expect(merged.conflicts).toEqual([])
    expect(readFileSync(join(canon, 'base.txt'), 'utf8')).toBe('scope edit\n')
    expect((await restoredScope.head(canon)).stdout.trim()).toBe(repo.taskBaseHead)
    await restoredScope.discard(restored)
    expect(existsSync(repo.workspaceRef)).toBe(false)
    expect(existsSync(canon)).toBe(true)
  } finally {
    removeTempDirSync(storageRootRef)
    removeTempDirSync(canon)
  }
}, 60_000)

test('diagnostic conversion preserves old printable values and never replaces a rejection', () => {
  expect(describeEffectError(new Error('original error'))).toBe('original error')
  expect(describeEffectError('original string')).toBe('original string')
  expect(describeEffectError(42)).toBe('42')
  const unprintable = [
    Object.create(null),
    {
      [Symbol.toPrimitive]() {
        throw new Error('conversion failed')
      },
    },
    Object.defineProperty(new Error(), 'message', {
      get() {
        throw new Error('message failed')
      },
    }),
  ]
  for (const value of unprintable)
    expect(describeEffectError(value)).toBe('unavailable error description')
})
