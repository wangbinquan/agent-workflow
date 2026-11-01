// RFC-413: the pre-drive merge recovery, the wrapper iso create / merge-back, the wrapper workspace and the wrapper
// run ledger run on ports the composition binds over the execution state. These cases lock the bindings (values read
// from the current state, a fresh kernel / cleanup binding per read, the submodule topology conversion, the ledger's
// scheduler logger and consumed-inputs codec) and drive the moved engine bodies through fabricated ports: the frame
// recovery order and skip, and the git wrapper's entry snapshot, preDirty cap and changed-file subtraction.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Semaphore } from '@/platform/contracts/semaphore'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { IsolationMechanicsPorts } from '@/modules/task-execution/application/ports/isolationMechanics'
import { createIsolationMechanicsPorts } from '@/modules/task-execution/composition/isolationMechanicsBinding'
import type { TaskMechanicsState } from '@/modules/task-execution/composition/taskMechanicsState'
import { createWrapperRunLedgerPorts } from '@/modules/task-execution/composition/wrapperRuntime'
import { completeFrameMerges } from '@/modules/task-execution/engine/kernel/mergeRecovery'
import { createWrapperWorkspace } from '@/modules/task-execution/engine/wrapper/wrapperWorkspace'
import { prepareConsumedInputs } from '@/modules/task-execution/infrastructure/consumedInputsParticipant'

function logger(warnings: string[] = []) {
  const log = {
    info() {},
    warn(message: string) {
      warnings.push(message)
    },
    error() {},
    debug() {},
    child: () => log,
  }
  return log as never
}

const SCOPE_METHODS = [
  'recoverKey',
  'chooseGeneration',
  'create',
  'restore',
  'head',
  'submodulePresence',
  'changedFiles',
  'blobHashes',
  'snapshot',
  'merge',
  'undoShard',
  'discard',
  'resolveConflict',
  'completeHumanConflict',
] as const

function fakeState() {
  const restored: Record<string, unknown>[] = []
  const scope: Record<string, unknown> = Object.fromEntries(
    SCOPE_METHODS.map((name) => [name, async () => undefined]),
  )
  scope.restore = async (input: Record<string, unknown>) => {
    restored.push(input)
    return {
      taskId: 'task-1',
      key: input.key,
      dbNodeRunId: input.dbNodeRunId,
      workspaceRef: '/iso',
      passthrough: false,
      repositories: [],
    }
  }
  const persistence = {
    nodeExecution: { read: async () => null, list: async () => [] },
    mergeStates: { transition: async () => undefined, tryTransition: async () => true },
    artifactPaths: { forcedPaths: async () => [] },
    effects: {},
  }
  const raw = {
    taskId: 'task-1',
    repos: [
      { ordinal: 0, repoPath: '/repo', worktreePath: '/wt', mountPath: '', baseBranch: 'main' },
    ],
    writeSem: new Semaphore(1),
    log: logger(),
    opts: {
      appHome: '/app',
      executionContext: undefined as unknown,
      isolationWorkspaces: { bind: async () => scope },
      persistence,
    },
  }
  return { raw, restored, state: raw as unknown as TaskMechanicsState }
}

test('the isolation ports read the execution state on use and build a fresh kernel and cleanup binding per read', () => {
  const { raw, state } = fakeState()
  const ports = createIsolationMechanicsPorts(state)
  expect(ports.taskId).toBe('task-1')
  expect(ports.appHome).toBe('/app')
  expect(ports.repos).toBe(raw.repos as never)
  expect(ports.writeSem).toBe(raw.writeSem)
  expect(ports.log).toBe(raw.log)
  expect(ports.execution).toBeUndefined()
  raw.opts.executionContext = { sentinel: 'context-1' }
  expect(ports.execution).toEqual({ sentinel: 'context-1' } as never)
  raw.taskId = 'task-2'
  expect(ports.taskId).toBe('task-2')
  expect(ports.persistence.nodeExecution).toBe(raw.opts.persistence.nodeExecution as never)
  expect(ports.persistence.mergeStates).toBe(raw.opts.persistence.mergeStates as never)
  expect(ports.persistence.artifactPaths).toBe(raw.opts.persistence.artifactPaths as never)
  const first = ports.binding
  expect(ports.binding).not.toBe(first)
  expect(first.mergeStates).toBe(raw.opts.persistence.mergeStates as never)
  expect(first.artifactPaths).toBe(raw.opts.persistence.artifactPaths as never)
  expect(first.executionContext).toEqual({ sentinel: 'context-1' } as never)
  expect(ports.cleanup).not.toBe(ports.cleanup)
})

test('the restore binding converts a persisted submodule topology and omits it when the kernel passes none', async () => {
  const { restored, state } = fakeState()
  const ports = createIsolationMechanicsPorts(state)
  const request = {
    key: 'key-1',
    dbNodeRunId: 'run-1',
    workspaceRef: null,
    baseSnapshots: { '': 'base' },
    taskBaseHeads: { '': 'head' },
  }
  await ports.workspace.restore({
    ...request,
    submodules: {
      '': {
        subBases: { vendor: 'b' },
        poolDirs: { vendor: '/pool' },
        pendingSubResolves: ['vendor'],
      },
    },
  })
  await ports.workspace.restore(request)
  expect(restored[0]).toEqual({
    ...request,
    submodules: {
      '': {
        submoduleBases: { vendor: 'b' },
        poolRefs: { vendor: '/pool' },
        pendingSubResolutions: ['vendor'],
      },
    },
  })
  expect(restored[1]).toEqual(request)
  expect(Object.keys(restored[1]!)).not.toContain('submodules')
})

test('the merge agent ports and the human-conflict completion are bound at use, as the moved bodies built them', () => {
  const binding = readFileSync(
    resolve(
      import.meta.dir,
      '../src/modules/task-execution/composition/isolationMechanicsBinding.ts',
    ),
    'utf8',
  )
  expect(binding).toContain(
    'resolveMergeConflicts: (input) => resolveMergeConflicts(bindMergeConflictPorts(state), input),',
  )
  expect(binding).toContain('completeIsolatedHumanConflict(handle, nodeTrees, log)')
  expect(binding).toContain(
    'recoverBeforeScope: () => recoverMergesBeforeScope(createIsolationMechanicsPorts(state), log),',
  )
})

test('the ledger ports read the execution state on use, log to the scheduler logger and encode consumed inputs', () => {
  const definition = { nodes: [], edges: [] }
  const containerOf = new Map([['inner', 'loop']])
  const raw = {
    taskId: 'task-1',
    definition,
    containerOf,
    opts: {
      executionContext: undefined as unknown,
      persistence: { wrapperRuns: {}, nodeRuns: {}, nodeExecution: {} },
    },
  }
  const ports = createWrapperRunLedgerPorts(raw as unknown as TaskMechanicsState)
  expect(ports.taskId).toBe('task-1')
  expect(ports.definition).toBe(definition as never)
  expect(ports.containerOf).toBe(containerOf)
  expect(ports.execution).toBeUndefined()
  raw.opts.executionContext = { sentinel: 'context-1' }
  expect(ports.execution).toEqual({ sentinel: 'context-1' } as never)
  expect(ports.persistence.wrapperRuns).toBe(raw.opts.persistence.wrapperRuns as never)
  expect(ports.persistence.nodeRuns).toBe(raw.opts.persistence.nodeRuns as never)
  expect(ports.persistence.nodeExecution).toBe(raw.opts.persistence.nodeExecution as never)
  expect(typeof ports.log.info).toBe('function')
  expect(ports.consumedInputs({ a: 'run-a', b: 'run-b' })).toEqual(
    prepareConsumedInputs({ record: { a: 'run-a', b: 'run-b' } }),
  )
  const runtime = readFileSync(
    resolve(import.meta.dir, '../src/modules/task-execution/composition/wrapperRuntime.ts'),
    'utf8',
  )
  expect(runtime).toContain("return createLogger('scheduler')")
})

function handleFor(id: string, repos: IsoHandle['repos'] = []): IsoHandle {
  return {
    taskId: 'task-1',
    nodeRunId: id,
    dbNodeRunId: id,
    containerPath: `/iso/${id}`,
    passthrough: false,
    repos,
  }
}

function recoveryPorts(rows: { pinned: unknown[]; interrupted: unknown[] }) {
  const calls: string[] = []
  const events: string[] = []
  const restored: Record<string, unknown>[] = []
  const mergeStates = {
    transition: async (input: { nodeRunId: string; event: { kind: string; via?: string } }) => {
      events.push(
        `${input.nodeRunId}:${input.event.kind}${input.event.via ? `:${input.event.via}` : ''}`,
      )
    },
    tryTransition: async () => true,
  }
  const binding = {
    workspace: {
      acquire: async () => {
        throw new Error('not used by recovery')
      },
      snapshotIsolatedWorkspace: async (handle: IsoHandle) => {
        calls.push('snapshot:' + handle.dbNodeRunId)
        return { '': 'tree-' + handle.dbNodeRunId }
      },
      mergeIsolatedWorkspace: async (handle: IsoHandle) => {
        calls.push('merge:' + handle.dbNodeRunId)
        return { clean: true, conflicts: [] }
      },
      repoRelForcedPaths: () => [],
    },
    artifactPaths: { forcedPaths: async () => [] },
    mergeStates,
    nodeExecution: { patch: async () => undefined },
    createLocalEffectAttemptObserver: () => undefined,
  }
  const ports = {
    taskId: 'task-1',
    appHome: '/app',
    repos: [
      { ordinal: 0, repoPath: '/repo', worktreePath: '/wt', mountPath: '', baseBranch: 'main' },
    ],
    execution: undefined,
    writeSem: new Semaphore(1),
    log: logger(),
    binding,
    cleanup: {
      cleanupEffectFactory: () => undefined,
      discardIsolatedWorkspace: async (handle: IsoHandle) => {
        calls.push('discard:' + handle.dbNodeRunId)
      },
    },
    persistence: {
      nodeExecution: {
        read: async () => null,
        list: async (query: { mergeState: string }) => {
          calls.push('list:' + query.mergeState)
          return query.mergeState === 'pending-merge' ? rows.pinned : rows.interrupted
        },
      },
      mergeStates,
      artifactPaths: binding.artifactPaths,
    },
    workspace: {
      scope: async () => {
        calls.push('scope')
        return {
          head: async () => ({ stdout: 'head\n', stderr: '', exitCode: 0 }),
          recoverKey: async (_ref: string | null, id: string) => 'key-' + id,
          submodulePresence: async () => false,
        }
      },
      restore: async (request: Record<string, unknown>) => {
        restored.push(request)
        calls.push('restore:' + String(request.dbNodeRunId))
        return handleFor(String(request.dbNodeRunId))
      },
    },
    conflicts: { resolveMergeConflicts: async () => ({ allResolved: true, detail: '' }) },
    completeHumanConflict: async () => ({ allResolved: true, unresolvedRepos: [] }),
  }
  return { ports: ports as unknown as IsolationMechanicsPorts, calls, events, restored }
}

test('a frame with nothing to complete reads its two row sets and never opens the workspace scope', async () => {
  const { ports, calls } = recoveryPorts({ pinned: [], interrupted: [] })
  await completeFrameMerges(ports, { containerRunId: null, iteration: 0 }, logger())
  expect(calls).toEqual(['list:pending-merge', 'list:isolating'])
})

test('pinned rows replay before interrupted ones; each is restored by its physical key and discarded after merging', async () => {
  const pinned = {
    id: 'pinned',
    nodeId: 'a',
    iteration: 0,
    isoWorktreePath: '/iso/pinned',
    mergeState: 'pending-merge',
    checkpoints: [{ mountPath: '', isolationBase: 'base-p', nodeTree: 'tree-p' }],
  }
  const interrupted = {
    id: 'interrupted',
    nodeId: 'b',
    iteration: 0,
    isoWorktreePath: '/iso/interrupted',
    mergeState: 'isolating',
    checkpoints: [{ mountPath: '', isolationBase: 'base-i' }],
  }
  const { ports, calls, events, restored } = recoveryPorts({
    pinned: [pinned],
    interrupted: [interrupted],
  })
  await completeFrameMerges(ports, { containerRunId: null, iteration: 0 }, logger())
  expect(calls).toEqual([
    'list:pending-merge',
    'list:isolating',
    'scope',
    'restore:pinned',
    'merge:pinned',
    'discard:pinned',
    'restore:interrupted',
    'snapshot:interrupted',
    'merge:interrupted',
    'discard:interrupted',
  ])
  // The pinned trees drive the replay (no snapshot); the interrupted run is snapshotted, pinned, then merged.
  expect(events).toEqual([
    'pinned:mark-merged:replay',
    'interrupted:mark-pending-merge',
    'interrupted:mark-merged:replay',
  ])
  expect(restored[0]).toEqual({
    key: 'key-pinned',
    dbNodeRunId: 'pinned',
    workspaceRef: '/iso/pinned',
    baseSnapshots: { '': 'base-p' },
    taskBaseHeads: { '': 'head' },
    submodules: {},
    forcedContainerPaths: [],
  })
  expect(restored[1]).toMatchObject({ key: 'key-interrupted', baseSnapshots: { '': 'base-i' } })
})

function workspacePorts(git: {
  changedFiles: (path: string, baseline: string) => string[]
  blobHashes: (path: string, paths: string[]) => Record<string, string>
}) {
  const handle = handleFor('wrapper-1', [
    {
      repoPath: '/repo-app',
      canonWorktreePath: '/wt-app',
      isoWorktreePath: '/iso/app',
      mountPath: 'app',
      baseBranch: 'main',
      baseSnapshot: 'base-app',
      taskBaseHead: 'head-app',
      forcedRepoRelPaths: [],
      subBases: {},
      poolDirs: {},
      pendingSubResolves: [],
    },
    {
      repoPath: '/repo-lib',
      canonWorktreePath: '/wt-lib',
      isoWorktreePath: '/iso/lib',
      mountPath: 'lib',
      baseBranch: 'main',
      baseSnapshot: 'base-lib',
      taskBaseHead: 'head-lib',
      forcedRepoRelPaths: [],
      subBases: {},
      poolDirs: {},
      pendingSubResolves: [],
    },
  ])
  const events: string[] = []
  const binding = {
    workspace: {
      acquire: async () => ({
        chooseGeneration: async () => ({ key: 'wrapper-1', generation: 1, reclaimed: 0 }),
        create: async () => handle,
      }),
      snapshotIsolatedWorkspace: async () => ({}),
      mergeIsolatedWorkspace: async () => ({ clean: true, conflicts: [] }),
      repoRelForcedPaths: () => [],
    },
    artifactPaths: { forcedPaths: async () => [] },
    mergeStates: {
      transition: async (input: { event: { kind: string } }) => {
        events.push(input.event.kind)
      },
      tryTransition: async () => true,
    },
    nodeExecution: { patch: async () => undefined },
    createLocalEffectAttemptObserver: () => undefined,
  }
  const isolation = {
    taskId: 'task-1',
    appHome: '/app',
    repos: [
      {
        ordinal: 0,
        repoPath: '/repo-app',
        worktreePath: '/wt-app',
        mountPath: 'app',
        baseBranch: 'main',
        readonly: false,
      },
      {
        ordinal: 1,
        repoPath: '/repo-lib',
        worktreePath: '/wt-lib',
        mountPath: 'lib',
        baseBranch: 'main',
        readonly: true,
      },
    ],
    execution: undefined,
    writeSem: new Semaphore(1),
    log: logger(),
    binding,
    cleanup: {
      cleanupEffectFactory: () => undefined,
      discardIsolatedWorkspace: async () => undefined,
    },
    persistence: {
      nodeExecution: { read: async () => null, list: async () => [] },
      mergeStates: binding.mergeStates,
      artifactPaths: binding.artifactPaths,
    },
    workspace: {
      scope: async () => ({ recoverKey: async () => 'wrapper-1' }),
      restore: async () => handle,
    },
    conflicts: { resolveMergeConflicts: async () => ({ allResolved: true, detail: '' }) },
    completeHumanConflict: async () => ({ allResolved: true, unresolvedRepos: [] }),
  }
  const gitScope = {
    head: async (path: string) => ({ stdout: `base-of-${path}\n`, stderr: '', exitCode: 0 }),
    changedFiles: async (path: string, baseline: string) => git.changedFiles(path, baseline),
    blobHashes: async (path: string, paths: string[]) => git.blobHashes(path, paths),
  }
  const scopes: IsoHandle[] = []
  return {
    handle,
    events,
    scopes,
    ports: {
      isolation: isolation as unknown as IsolationMechanicsPorts,
      scopeOf: (opened: IsoHandle) => {
        scopes.push(opened)
        return gitScope as never
      },
    },
  }
}

const generation = {
  kind: 'wrapper-git' as const,
  runId: 'wrapper-1',
  resumed: false,
  enteredRunning: true,
  previous: null,
}

test('the git entry snapshot diffs only writable members and degrades an over-cap preDirty set to empty', async () => {
  const warnings: string[] = []
  const { ports, handle, events, scopes } = workspacePorts({
    changedFiles: () => Array.from({ length: 4097 }, (_, index) => `f${index}.txt`),
    blobHashes: () => {
      throw new Error('not reached past the entry cap')
    },
  })
  const workspace = createWrapperWorkspace(ports, logger(warnings))
  const scene = await workspace.port.open(generation)
  expect(scene.passthrough).toBe(false)
  expect(events).toEqual(['begin-isolation'])
  expect(workspace.resolve(scene)).toEqual({ handle, kind: 'wrapper-git' })
  const entry = await workspace.port.captureGitEntry(scene, true)
  expect(scopes).toEqual([handle])
  expect(entry).toEqual({
    baselines: { app: 'base-of-/iso/app' },
    preDirtyByRepo: { app: {} },
    primaryMount: 'app',
  })
  expect(warnings).toEqual([
    'git wrapper preDirty over entry cap — degrading to empty set (over-report)',
  ])
  expect(() => workspace.resolve({ ...scene, key: Symbol('other') })).toThrow(
    'wrapper-workspace-scene-missing:wrapper-git',
  )
})

test('changed files subtract only the pre-dirty paths whose blob is unchanged, prefixed by the member mount', async () => {
  let post: Record<string, string> = { 'a.txt': 'h1' }
  const { ports } = workspacePorts({
    changedFiles: (_path, baseline) =>
      baseline === 'base-of-/iso/app' ? ['a.txt'] : ['a.txt', 'b.txt'],
    blobHashes: () => post,
  })
  const workspace = createWrapperWorkspace(ports, logger())
  const scene = await workspace.port.open(generation)
  const entry = await workspace.port.captureGitEntry(scene, true)
  expect(entry.preDirtyByRepo).toEqual({ app: { 'a.txt': 'h1' } })
  expect(
    await workspace.port.changedFiles(scene, { app: 'other-base' }, entry.preDirtyByRepo),
  ).toEqual(['app/b.txt'])
  post = { 'a.txt': 'h2' }
  expect(
    await workspace.port.changedFiles(scene, { app: 'other-base' }, entry.preDirtyByRepo),
  ).toEqual(['app/a.txt', 'app/b.txt'])
  // Without a captured preDirty set nothing is subtracted.
  expect(await workspace.port.captureGitEntry(scene, false)).toEqual({
    baselines: { app: 'base-of-/iso/app' },
    preDirtyByRepo: { app: {} },
    primaryMount: 'app',
  })
})
