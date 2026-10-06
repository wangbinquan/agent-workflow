// RFC-370: selected scopes must reach real Task receipts, wrappers and replay.
// The logical transport has no files; runtime execution is outside this A4 fixture.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  tasks,
  workflows,
  taskExecutionEffects,
  taskExecutionEffectAttempts,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import {
  createLocalEffectAttemptObserver,
  runTaskLocalEffect,
} from '@/modules/task-execution/application/localEffectObserver'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import {
  isolatedRunBinding,
  executeWorkgroupHostMechanics,
} from '@/modules/task-execution/composition/nodeMechanics'
import { createWrapperMechanicsPorts } from '@/modules/task-execution/composition/wrapperMechanics'
import { composeExecutionMergeRecovery } from '@/modules/task-execution/composition/executionMergeRecovery'
import { createIsoUnderLock, persistIsoBase, mergeBackAndSettle } from '@/services/isolatedAgentRun'
import { discardNodeIso } from '@/services/nodeIsolation'
import {
  workspaceRecord,
  snapshotIsolatedWorkspace,
  mergeIsolatedWorkspace,
  resolveIsolatedConflict,
} from '@/modules/task-execution/infrastructure/isolationWorkspaceView'
import { buildMergeAgent } from '@/services/mergeAgent'
import { resolveSyntheticTaskAgentInjection } from '@/services/execution/taskExecutionResources'
import { composeLocalTaskAgentRunFamily } from '@/modules/task-execution/composition/localTaskAgentRunFamily'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import type { CollaborationRuntimeMechanics } from '@/modules/collaboration/public/participants'
import type { Logger } from '@/util/log'
import { Semaphore } from '@/util/semaphore'
import { describeEachProvider } from './helpers/eachProvider'
import { held } from './helpers/portArtifactContent'
import { composeNodeRunRuntimePersistence } from './helpers/nodeRunRuntime'
import {
  MemoryIsolationFactory,
  MemoryIsolationStore,
  unprintableErrors,
} from './helpers/isolationWorkspace'

const EMPTY = { $schema_version: 6 as const, inputs: [], nodes: [], edges: [] }
const TIMEOUT = 30_000

async function fixture(db: ProviderNeutralDatabase, mounts = ['']) {
  const taskId = ulid(),
    workflowId = ulid(),
    intentId = ulid()
  const path = [{ stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 }]
  const slotPathJson = canonicalJson(path)
  await db.insert(workflows).values({
    id: workflowId,
    name: taskId,
    definition: JSON.stringify(EMPTY),
    version: 1,
    schemaVersion: 6,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(EMPTY),
    workflowVersion: 1,
    repoPath: `memory:repository:${taskId}`,
    worktreePath: `memory:canonical:${taskId}`,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    repoCount: mounts.length,
    status: 'running',
    startedAt: Date.now(),
    inputs: '{}',
    executionLineageId: taskId,
    lineageSlotPathJson: slotPathJson,
  })
  const original = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: 'scope-' + ulid(),
    persistence: original,
  })
  await original.intents.submit({
    intentId,
    request: {
      taskId,
      kind: 'launch',
      source: 'rest',
      actorUserId: 'scope-actor',
      expectedTaskRevision: 1,
      scope: {
        executionLineageId: taskId,
        continuationSlotKey: taskId + ':root',
        slotPath: path,
        operationGeneration: 0,
      },
      payload: { v: 1 },
    },
  })
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  let afterSettle: () => void | Promise<void> = () => {}
  const effects = new Proxy(original.effects, {
    get(target, key) {
      if (key === 'settle')
        return async (input: Parameters<typeof target.settle>[0]) => {
          const result = await target.settle(input)
          await afterSettle()
          return result
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const persistence = { ...original, effects }
  const context = createTaskExecutionContext({
    intentId,
    token: claimed.token,
    persistence,
    legacyConnection: db,
    compatibility: { db },
  })
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const log: Logger = {
    debug() {},
    info() {},
    error() {},
    warn(message, fields) {
      warnings.push({ message, fields })
    },
    child() {
      return log
    },
  }
  const store = new MemoryIsolationStore(),
    factory = Object.freeze(new MemoryIsolationFactory(store))
  const agent = { ...buildMergeAgent(), id: 'scope-worker' }
  const runOptions = {
    appHome: `memory:home:${taskId}`,
    persistence,
    executionContext: context,
    isolationWorkspaces: factory,
    nodeRunRuntime: new Proxy(composeNodeRunRuntimePersistence(db), {
      get(target, key) {
        if (key === 'withSelection')
          return async () => {
            throw new Error('fixture stopped before runtime execution')
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
    defaultNodeRetries: 0,
    operationConfiguration: {
      readBinaryPaths() {
        throw new Error('fixture stopped before runtime execution')
      },
      readCommitExcludePatterns() {
        return []
      },
    },
  }
  const unselectedContent = (): never => {
    throw new Error('isolation fixture unexpectedly reached agent content')
  }
  const taskAgentRuns = composeLocalTaskAgentRunFamily({
    appHome: runOptions.appHome,
    nodeRunRuntime: runOptions.nodeRunRuntime,
    operationConfiguration: runOptions.operationConfiguration,
    runtimeRegistry: composeRuntimeRegistryOperations(db),
    nodeRunPrompts: { store: unselectedContent, read: unselectedContent },
    portArtifacts: { archive: unselectedContent, read: unselectedContent },
  })
  const state = {
    taskId,
    task: {
      id: taskId,
      repoCount: mounts.length,
      baseBranch: 'main',
      worktreePath: `memory:canonical:${taskId}`,
      repoPath: `memory:repository:${taskId}`,
    },
    definition: EMPTY,
    log,
    opts: { ...runOptions, taskAgentRuns },
    taskExecutionResources: {
      async injection() {
        return resolveSyntheticTaskAgentInjection(agent, taskAgentRuns.materialReferences)
      },
    },
    repos: mounts.map((mount, repoIndex) => ({
      repoIndex,
      repoPath: `memory:repository:${taskId}:${mount}`,
      worktreePath: `memory:canonical:${taskId}:${mount}`,
      worktreeDirName: mount,
      mountPath: mount,
      readonly: false,
      baseBranch: 'main',
      baseCommit: null,
    })),
    scopeRoot: `memory:canonical:${taskId}`,
    agentSem: new Semaphore(1),
    subprocessSem: new Semaphore(2),
    writeSem: new Semaphore(1),
    async driveScope() {
      throw new Error('unexpected nested drive')
    },
  } as unknown as TaskMechanicsState
  async function row(nodeId = 'worker', extra: Partial<typeof nodeRuns.$inferInsert> = {}) {
    const id = ulid()
    await db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId,
      status: 'running',
      iteration: 0,
      retryIndex: 0,
      continuationSlotKey: `${taskId}:${id}`,
      lineageSlotPathJson: slotPathJson,
      ...extra,
    })
    return id
  }
  const read = async (id: string) =>
    (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
  const ledger = async () => {
    const records = await db
      .select()
      .from(taskExecutionEffects)
      .where(eq(taskExecutionEffects.taskId, taskId))
    const attempts = await db.select().from(taskExecutionEffectAttempts)
    return records.map((record) => ({
      ...record,
      attempts: attempts.filter((attempt) => attempt.effectId === record.id),
    }))
  }
  return {
    db,
    taskId,
    state,
    context,
    persistence,
    store,
    factory,
    warnings,
    agent,
    row,
    read,
    ledger,
    afterSettle(fn: typeof afterSettle) {
      afterSettle = fn
    },
    reset: () => module.resetForTesting(),
  }
}

async function create(f: Awaited<ReturnType<typeof fixture>>, id: string, state = f.state) {
  return await createIsoUnderLock({
    writeSem: state.writeSem,
    appHome: state.opts.appHome,
    taskId: f.taskId,
    isoKeyRunId: id,
    canonRepos: state.repos,
    binding: isolatedRunBinding(state),
    log: state.log,
  })
}

describeEachProvider('RFC-370 complete isolation scope in real Task mechanics', (harness) => {
  test(
    'held generation is before the durable fence; held create and settlement ACK are before base persistence',
    async () => {
      const f = await fixture(harness.db),
        id = await f.row()
      const bindEntered = held<void>(),
        bindAck = held<void>(),
        generationEntered = held<void>(),
        generationAck = held<void>(),
        createEntered = held<void>(),
        createAck = held<void>(),
        settleEntered = held<void>(),
        settleAck = held<void>()
      try {
        f.store.before = async (call) => {
          if (call.method === 'bind') {
            bindEntered.resolve()
            await bindAck.promise
          }
          if (call.method === 'chooseGeneration') {
            generationEntered.resolve()
            await generationAck.promise
          }
          if (call.method === 'create') {
            createEntered.resolve()
            await createAck.promise
          }
        }
        f.afterSettle(async () => {
          settleEntered.resolve()
          await settleAck.promise
        })
        const pending = runWithTaskExecutionContext(f.context, async () => {
          const handle = await create(f, id)
          await persistIsoBase(isolatedRunBinding(f.state), id, 1, handle)
          return handle
        })
        await bindEntered.promise
        expect(f.store.calls.map((call) => call.method)).toEqual(['bind'])
        expect(await f.ledger()).toEqual([])
        bindAck.resolve()
        await generationEntered.promise
        expect(await f.ledger()).toEqual([])
        generationAck.resolve()
        await createEntered.promise
        expect((await f.ledger())[0]!.attempts[0]!.state).toBe('acting')
        expect((await f.read(id)).isoWorktreePath).toBeNull()
        createAck.resolve()
        await settleEntered.promise
        expect((await f.ledger())[0]!.attempts[0]!.state).toBe('succeeded')
        expect((await f.read(id)).isoWorktreePath).toBeNull()
        settleAck.resolve()
        const handle = await pending
        expect(handle.nodeRunId).toBe(id + '-2')
        expect(handle.dbNodeRunId).toBe(id)
        expect((await f.read(id)).isoWorktreePath).toBe('memory:workspace:' + id + '-2')
        expect(f.store.calls.filter((call) => call.method === 'bind')).toHaveLength(1)
      } finally {
        bindAck.resolve()
        generationAck.resolve()
        createAck.resolve()
        settleAck.resolve()
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'snapshot and merge ACKs precede their original CAS; supplied replay trees bypass snapshot',
    async () => {
      const f = await fixture(harness.db),
        id = await f.row()
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          const handle = await create(f, id)
          await persistIsoBase(isolatedRunBinding(f.state), id, 1, handle)
          const snapshotEntered = held<void>(),
            snapshotAck = held<void>(),
            entered = held<void>(),
            ack = held<void>()
          f.store.before = async (call) => {
            if (call.method === 'snapshot') {
              snapshotEntered.resolve()
              await snapshotAck.promise
            }
            if (call.method === 'merge') {
              entered.resolve()
              await ack.promise
            }
          }
          const pending = mergeBackAndSettle({
            binding: isolatedRunBinding(f.state),
            writeSem: f.state.writeSem,
            handle,
            nodeRunId: id,
            repoCount: 1,
            via: 'live',
            conflictResolver: async () => ({ allResolved: true, detail: '' }),
          })
          try {
            await snapshotEntered.promise
            expect((await f.read(id)).mergeState).toBe('isolating')
            expect((await f.read(id)).isoNodeTree).toBeNull()
            snapshotAck.resolve()
            await entered.promise
            expect((await f.read(id)).mergeState).toBe('pending-merge')
            expect((await f.read(id)).isoNodeTree).toBe(`tree@${id}-2:`)
          } finally {
            snapshotAck.resolve()
            ack.resolve()
          }
          expect(await pending).toEqual({ kind: 'merged' })
          expect((await f.read(id)).mergeState).toBe('merged')
          const replayId = await f.row('replay', {
            mergeState: 'pending-merge',
            isoBaseSnapshot: 'old-base',
            isoNodeTree: 'pinned-tree',
            isoWorktreePath: 'memory:workspace:lost-physical-2',
          })
          const before = f.store.calls.filter((call) => call.method === 'snapshot').length
          await composeExecutionMergeRecovery(f.state, f.state.log).recoverBeforeScope()
          expect((await f.read(replayId)).mergeState).toBe('merged')
          expect(f.store.calls.filter((call) => call.method === 'snapshot')).toHaveLength(before)
          const restore = f.store.calls.find((call) => call.method === 'restore')!
          expect(restore.args[0]).toMatchObject({
            key: 'lost-physical-2',
            dbNodeRunId: replayId,
            workspaceRef: 'memory:workspace:lost-physical-2',
            baseSnapshots: { '': 'old-base' },
          })
          expect(f.store.discarded.at(-1)!.dbNodeRunId).toBe(replayId)
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'nested wrapper drives bind outer workspace refs and merge inner node then inner wrapper then outer canonical',
    async () => {
      const f = await fixture(harness.db),
        outerId = await f.row('outer'),
        innerId = await f.row('inner'),
        nodeId = await f.row('nested-node')
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          let depth = 0
          const state = {
            ...f.state,
            async driveScope(innerState: TaskMechanicsState) {
              depth += 1
              if (depth === 1) {
                const ports = createWrapperMechanicsPorts(innerState, f.state.log)
                const scene = await ports.workspace.open({
                  kind: 'wrapper-git',
                  runId: innerId,
                  resumed: false,
                  enteredRunning: true,
                  previous: null,
                })
                await ports.scopeDriver.drive({
                  workspace: scene,
                  scope: {
                    wrapperId: 'inner',
                    kind: 'wrapper-git',
                    parentScopeId: 'outer',
                    directNodeIds: ['nested-node'],
                    path: [],
                  },
                  containerRunId: innerId,
                  iteration: 0,
                })
                expect(
                  await ports.workspace.merge({
                    scene,
                    runId: innerId,
                    node: { id: 'inner', kind: 'wrapper-git', nodeIds: ['nested-node'] },
                    iteration: 0,
                  }),
                ).toEqual({ kind: 'merged' })
              } else {
                const handle = await create(f, nodeId, innerState)
                await persistIsoBase(isolatedRunBinding(innerState), nodeId, 1, handle)
                await mergeBackAndSettle({
                  binding: isolatedRunBinding(innerState),
                  writeSem: innerState.writeSem,
                  handle,
                  nodeRunId: nodeId,
                  repoCount: 1,
                  via: 'live',
                  conflictResolver: async () => ({ allResolved: true, detail: '' }),
                })
                await discardNodeIso(handle, innerState.log, innerState.writeSem)
              }
              return { kind: 'ok' as const }
            },
          }
          const ports = createWrapperMechanicsPorts(state, f.state.log)
          const scene = await ports.workspace.open({
            kind: 'wrapper-git',
            runId: outerId,
            resumed: false,
            enteredRunning: true,
            previous: null,
          })
          await ports.scopeDriver.drive({
            workspace: scene,
            scope: {
              wrapperId: 'outer',
              kind: 'wrapper-git',
              parentScopeId: null,
              directNodeIds: ['inner'],
              path: [],
            },
            containerRunId: outerId,
            iteration: 0,
          })
          expect(
            await ports.workspace.merge({
              scene,
              runId: outerId,
              node: { id: 'outer', kind: 'wrapper-git', nodeIds: ['inner'] },
              iteration: 0,
            }),
          ).toEqual({ kind: 'merged' })
          expect(
            f.store.calls
              .filter((call) => call.method === 'bind')
              .map((call) => call.binding.repositories[0]!.workspaceRef),
          ).toEqual([
            f.state.repos[0]!.worktreePath,
            'memory:workspace:' + outerId + '-2',
            'memory:workspace:' + innerId + '-2',
          ])
          expect(
            f.store.merged.map((workspace) => workspace.repositories[0]!.canonicalRef),
          ).toEqual([
            'memory:workspace:' + innerId + '-2',
            'memory:workspace:' + outerId + '-2',
            f.state.repos[0]!.worktreePath,
          ])
          for (const id of [outerId, innerId, nodeId])
            expect((await f.read(id)).mergeState).toBe('merged')
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'wrapper dirty subtraction uses complete hashes, deleted values and original mount order',
    async () => {
      const f = await fixture(harness.db, ['z', 'a']),
        id = await f.row('wrapper')
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          const ports = createWrapperMechanicsPorts(f.state, f.state.log)
          const scene = await ports.workspace.open({
            kind: 'wrapper-git',
            runId: id,
            resumed: false,
            enteredRunning: true,
            previous: null,
          })
          const refs = ['z', 'a'].map((mount) => `memory:workspace:${id}-2:${mount}`)
          for (const ref of refs) {
            f.store.changed.set(ref, ['same', 'rewritten', 'deleted'])
            f.store.hashes.set(ref, {
              same: 'same-hash',
              rewritten: 'old-hash',
              deleted: 'deleted',
            })
          }
          const entry = await ports.workspace.captureGitEntry(scene, true)
          expect(entry.primaryMount).toBe('z')
          expect(Object.keys(entry.baselines)).toEqual(['z', 'a'])
          f.store.hashes.set(refs[0]!, {
            same: 'same-hash',
            rewritten: 'new-hash',
            deleted: 'deleted',
          })
          f.store.hashes.set(refs[1]!, {
            same: 'same-hash',
            rewritten: 'new-hash',
            deleted: 'new-content',
          })
          expect(
            await ports.workspace.changedFiles(scene, entry.baselines, entry.preDirtyByRepo),
          ).toEqual(['z/rewritten', 'a/rewritten', 'a/deleted'])
          // Each fact is asynchronous and must finish before its projection returns.
          for (const method of ['head', 'changedFiles', 'blobHashes'] as const) {
            const entered = held<void>(),
              ack = held<void>()
            f.store.before = async (call) => {
              if (call.method === method) {
                entered.resolve()
                await ack.promise
              }
            }
            let completed = false
            const operation =
              method === 'head'
                ? ports.workspace.captureGitEntry(scene, false)
                : ports.workspace.changedFiles(scene, entry.baselines, entry.preDirtyByRepo)
            const pending = operation.then((result) => {
              completed = true
              return result
            })
            try {
              await entered.promise
              expect(completed).toBe(false)
            } finally {
              ack.resolve()
            }
            const result = await pending
            if (method === 'head') expect(result).toMatchObject({ primaryMount: 'z' })
            else expect(result).toEqual(['z/rewritten', 'a/rewritten', 'a/deleted'])
          }
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'unprintable dirty failures and both original caps still degrade to empty with diagnostics',
    async () => {
      const f = await fixture(harness.db),
        id = await f.row('wrapper')
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          const ports = createWrapperMechanicsPorts(f.state, f.state.log),
            scene = await ports.workspace.open({
              kind: 'wrapper-git',
              runId: id,
              resumed: false,
              enteredRunning: true,
              previous: null,
            }),
            ref = `memory:workspace:${id}-2`
          f.store.changed.set(ref, ['dirty'])
          for (const reason of unprintableErrors())
            for (const method of ['changedFiles', 'blobHashes'] as const) {
              f.store.before = (call) => {
                if (call.method === method) throw reason
              }
              expect((await ports.workspace.captureGitEntry(scene, true)).preDirtyByRepo).toEqual({
                '': {},
              })
              expect(f.warnings.at(-1)!.fields!.error).toBe('unavailable error description')
            }
          f.store.before = () => {}
          f.store.changed.set(
            ref,
            Array.from({ length: 4097 }, (_, index) => String(index)),
          )
          expect((await ports.workspace.captureGitEntry(scene, true)).preDirtyByRepo).toEqual({
            '': {},
          })
          expect(f.warnings.at(-1)!.fields!.cap).toBe(4096)
          f.store.changed.set(ref, ['dirty'])
          f.store.hashes.set(ref, { dirty: 'x'.repeat(256 * 1024) })
          expect((await ports.workspace.captureGitEntry(scene, true)).preDirtyByRepo).toEqual({
            '': {},
          })
          expect(f.warnings.at(-1)!.fields!.cap).toBe(256 * 1024)
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'fresh factory restores pinned human-conflict refs without the original handle or files',
    async () => {
      const f = await fixture(harness.db),
        id = await f.row('human', {
          mergeState: 'conflict-human',
          isoWorktreePath: 'memory:workspace:prior-key-2',
          isoBaseSnapshot: 'prior-base',
          isoNodeTree: 'pinned-node',
          isoSubmodulesJson: JSON.stringify({
            subBases: { sub: 'sub-base' },
            poolDirs: { sub: 'opaque:pin' },
            pendingSubResolves: ['sub'],
          }),
        })
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          const restarted = {
            ...f.state,
            opts: {
              ...f.state.opts,
              isolationWorkspaces: Object.freeze(new MemoryIsolationFactory(f.store)),
            },
          }
          const entered = held<void>(),
            ack = held<void>(),
            discardEntered = held<void>(),
            discardAck = held<void>()
          f.store.before = async (call) => {
            if (call.method === 'completeHumanConflict') {
              entered.resolve()
              await ack.promise
            } else if (call.method === 'discard') {
              discardEntered.resolve()
              await discardAck.promise
            }
          }
          let completed = false
          const pending = composeExecutionMergeRecovery(restarted, f.state.log)
            .recoverBeforeScope()
            .then(() => {
              completed = true
            })
          try {
            await entered.promise
            expect((await f.read(id)).mergeState).toBe('conflict-human')
            ack.resolve()
            await discardEntered.promise
            expect((await f.read(id)).mergeState).toBe('merged')
            expect(completed).toBe(false)
            expect(f.store.discarded).toEqual([])
          } finally {
            ack.resolve()
            discardAck.resolve()
          }
          await pending
          expect((await f.read(id)).mergeState).toBe('merged')
          const input = f.store.calls.find((call) => call.method === 'restore')!.args[0]
          expect(input).toMatchObject({
            key: 'prior-key-2',
            dbNodeRunId: id,
            workspaceRef: 'memory:workspace:prior-key-2',
            baseSnapshots: { '': 'prior-base' },
            submodules: {
              '': {
                submoduleBases: { sub: 'sub-base' },
                poolRefs: { sub: 'opaque:pin' },
                pendingSubResolutions: ['sub'],
              },
            },
          })
          expect(
            f.store.calls.filter((call) => call.method === 'create' || call.method === 'snapshot'),
          ).toEqual([])
          expect(f.store.discarded[0]!.dbNodeRunId).toBe(id)
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'selected rejection preserves raw identity, updated topology and cleanup progress through held fail ACK',
    async () => {
      const f = await fixture(harness.db),
        id = await f.row()
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          const handle = await create(f, id),
            reason = unprintableErrors()[0]
          const record = workspaceRecord(handle)
          f.store.before = (call) => {
            if (call.method === 'snapshot') {
              record.workspace.repositories[0]!.poolRefs = { new: 'opaque:new-pin' }
              throw reason
            }
          }
          await expect<unknown>(snapshotIsolatedWorkspace(handle)).rejects.toBe(reason)
          expect(handle.repos[0]!.poolDirs).toEqual({ new: 'opaque:new-pin' })
          const entered = held<void>(),
            ack = held<void>()
          f.afterSettle(async () => {
            entered.resolve()
            await ack.promise
          })
          f.store.before = (call) => {
            if (call.method === 'discard') throw reason
          }
          let rejected = false
          const pending = discardNodeIso(handle, f.state.log, f.state.writeSem).catch(
            (error: unknown) => {
              rejected = true
              throw error
            },
          )
          try {
            await entered.promise
            expect(rejected).toBe(false)
            const cleanup = (await f.ledger()).find(
              (effect) => effect.kind === 'workspace-cleanup',
            )!
            expect(cleanup.attempts[0]!.state).toBe('recovery-required')
            expect(JSON.parse(cleanup.attempts[0]!.receiptJson!)).toMatchObject({
              partialFailures: 2,
              repoCount: 1,
              error: 'unavailable error description',
            })
          } finally {
            ack.resolve()
          }
          await expect<unknown>(pending).rejects.toBe(reason)
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'actual host-node setup catches selected unprintable rejection and releases its pool',
    async () => {
      for (const reason of unprintableErrors()) {
        const f = await fixture(harness.db),
          id = await f.row()
        try {
          await runWithTaskExecutionContext(f.context, async () => {
            f.store.before = (call) => {
              if (call.method === 'create') throw reason
            }
            const result = await executeWorkgroupHostMechanics(
              f.state,
              { nodeRunId: id, nodeId: 'worker', agent: f.agent, promptTemplate: 'unused' },
              {} as CollaborationRuntimeMechanics,
            )
            expect(result).toMatchObject({
              status: 'failed',
              errorMessage: 'iso-setup-failed: unavailable error description',
            })
            expect((await f.ledger())[0]!.attempts[0]!.state).toBe('recovery-required')
            const permit = await f.state.agentSem.acquire()
            permit()
            expect(f.store.calls.map((call) => call.method)).toEqual([
              'bind',
              'chooseGeneration',
              'create',
            ])
          })
        } finally {
          f.reset()
        }
      }
    },
    TIMEOUT,
  )

  test(
    'actual fan-out passes the two distinct prior roles per repo and continues after an unprintable undo rejection',
    async () => {
      for (const reason of unprintableErrors()) {
        const f = await fixture(harness.db, ['a', 'b']),
          wrapperId = await f.row('fanout')
        try {
          await runWithTaskExecutionContext(f.context, async () => {
            await f.row('worker', {
              status: 'done',
              mergeState: 'merged',
              parentNodeRunId: wrapperId,
              containerRunId: wrapperId,
              shardKey: 'one',
              isoBaseSnapshotReposJson: JSON.stringify({ a: 'base-a', b: 'base-b' }),
              isoNodeTreeReposJson: JSON.stringify({ a: 'prior-a', b: 'prior-b' }),
            })
            await f.row('worker', {
              status: 'failed',
              parentNodeRunId: wrapperId,
              containerRunId: wrapperId,
              shardKey: 'one',
            })
            f.store.before = (call) => {
              if (
                call.method === 'undoShard' &&
                (call.args[0] as { workspaceRef: string }).workspaceRef.endsWith(':a')
              )
                throw reason
            }
            const result = await createWrapperMechanicsPorts(
              f.state,
              f.state.log,
            ).fanoutAttempts.dispatchShard({
              wrapperId: 'fanout',
              wrapperRunId: wrapperId,
              innerNode: { id: 'worker', kind: 'agent-single', agentId: f.agent.id },
              innerAgent: f.agent,
              iteration: 0,
              shard: { shardKey: 'one', value: 'new' },
              shardSourcePortName: 'items',
              boundaryEdges: [],
              broadcastInputs: {},
              reuseDisabled: true,
            })
            // Runtime stops deliberately after undo. A diagnostic exception would stop
            // at the first repo and replace this outcome with a conversion failure.
            expect(result).toMatchObject({
              kind: 'failed',
              message: 'fixture stopped before runtime execution',
            })
            expect(
              f.store.calls
                .filter((call) => call.method === 'undoShard')
                .map((call) => call.args[0]),
            ).toEqual([
              expect.objectContaining({ priorNodeCommit: 'prior-a', priorBaseCommit: 'base-a' }),
              expect.objectContaining({ priorNodeCommit: 'prior-b', priorBaseCommit: 'base-b' }),
            ])
            expect(
              f.warnings.find(
                (entry) => entry.message === 'T14 iso-undo failed — superimposition fallback',
              )!.fields!.error,
            ).toBe('unavailable error description')
            expect(f.store.discarded).toHaveLength(1)
            expect(f.store.calls.filter((call) => call.method === 'bind')).toHaveLength(1)
          })
        } finally {
          f.reset()
        }
      }
    },
    TIMEOUT,
  )

  test(
    'actual fan-out keeps missing prior roles distinct and proceeds through mixed undo results',
    async () => {
      const f = await fixture(harness.db, ['a', 'b', 'c']),
        wrapperId = await f.row('fanout')
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          await f.row('worker', {
            status: 'done',
            mergeState: 'merged',
            parentNodeRunId: wrapperId,
            containerRunId: wrapperId,
            shardKey: 'one',
            isoBaseSnapshotReposJson: JSON.stringify({ b: 'base-b', c: 'base-c' }),
            isoNodeTreeReposJson: JSON.stringify({ a: 'prior-a', b: 'prior-b' }),
          })
          await f.row('worker', {
            status: 'failed',
            parentNodeRunId: wrapperId,
            containerRunId: wrapperId,
            shardKey: 'one',
          })
          const result = await createWrapperMechanicsPorts(
            f.state,
            f.state.log,
          ).fanoutAttempts.dispatchShard({
            wrapperId: 'fanout',
            wrapperRunId: wrapperId,
            innerNode: { id: 'worker', kind: 'agent-single', agentId: f.agent.id },
            innerAgent: f.agent,
            iteration: 0,
            shard: { shardKey: 'one', value: 'new' },
            shardSourcePortName: 'items',
            boundaryEdges: [],
            broadcastInputs: {},
            reuseDisabled: true,
          })
          expect(result).toMatchObject({
            kind: 'failed',
            message: 'fixture stopped before runtime execution',
          })
          expect(
            f.store.calls.filter((call) => call.method === 'undoShard').map((call) => call.args[0]),
          ).toEqual([
            expect.objectContaining({ priorNodeCommit: 'prior-a', priorBaseCommit: undefined }),
            expect.objectContaining({ priorNodeCommit: 'prior-b', priorBaseCommit: 'base-b' }),
            expect.objectContaining({ priorNodeCommit: undefined, priorBaseCommit: 'base-c' }),
          ])
          expect(f.store.undoOutcomes.map((outcome) => outcome.result)).toEqual([
            false,
            true,
            false,
          ])
          expect(
            f.warnings.filter(
              (entry) => entry.message === 'T14 iso-undo failed — superimposition fallback',
            ),
          ).toEqual([])
          expect(f.store.discarded).toHaveLength(1)
          expect(f.store.calls.filter((call) => call.method === 'bind')).toHaveLength(1)
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'retained conflict scope keeps the Agent callback and waits for resolution ACK',
    async () => {
      const f = await fixture(harness.db),
        id = await f.row()
      try {
        await runWithTaskExecutionContext(f.context, async () => {
          const handle = await create(f, id)
          f.store.conflicts = [
            {
              mount: '',
              paths: ['conflicted'],
              mergedTree: 'merged-tree',
              rawConflictOutput: 'original output',
              base: 'base-tree',
              canonicalRef: f.state.repos[0]!.worktreePath,
              taskBaseHead: 'task-head',
              salvagedPaths: ['landed'],
              forcedRelativePaths: ['ignored-port'],
            },
          ]
          const merge = await mergeIsolatedWorkspace(handle, { '': 'node-tree' })
          const entered = held<void>(),
            ack = held<void>(),
            invocations: unknown[] = []
          f.store.invokeResolver = true
          f.store.before = async (call) => {
            if (call.method === 'resolveConflict') {
              entered.resolve()
              await ack.promise
            }
          }
          let completed = false
          const pending = resolveIsolatedConflict(merge.conflicts[0]!, {
            containerPath: handle.containerPath,
            runAgent: async (prompt, reference, manifest) => {
              invocations.push({ prompt, reference, manifest })
            },
          }).then((result) => {
            completed = true
            return result
          })
          try {
            await entered.promise
            expect(completed).toBe(false)
            expect(invocations).toEqual([])
          } finally {
            ack.resolve()
          }
          expect(await pending).toEqual({
            resolved: true,
            unresolved: [],
            resolveIsoPath: 'memory:resolve:',
          })
          expect(invocations).toEqual([
            {
              prompt: 'same resolver callback',
              reference: 'memory:resolve:',
              manifest: [{ worktreeDirName: '', path: 'conflicted', type: 'content' }],
            },
          ])
          expect(f.store.calls.filter((call) => call.method === 'bind')).toHaveLength(1)
        })
      } finally {
        f.reset()
      }
    },
    TIMEOUT,
  )

  test(
    'actual fail and retry receipts accept every unprintable value; printable text and 2000-character limit remain',
    async () => {
      for (const reason of [
        ...unprintableErrors(),
        new Error('ordinary'),
        'ordinary',
        'x'.repeat(2100),
      ]) {
        const f = await fixture(harness.db)
        try {
          await runWithTaskExecutionContext(f.context, async () => {
            await expect<unknown>(
              runTaskLocalEffect({
                persistence: f.persistence.effects,
                taskId: f.taskId,
                kind: 'repository',
                stableActionOrdinal: 'unprintable-fail',
                candidateId: 'fixture',
                request: { v: 1 },
                resourceKeys: ['failure:' + f.taskId],
                act: async () => {
                  throw reason
                },
              }),
            ).rejects.toBe(reason)
            const observer = createLocalEffectAttemptObserver({
              persistence: f.persistence.effects,
              taskId: f.taskId,
              kind: 'repository',
              stableActionOrdinal: 'unprintable-retry',
              candidateId: 'fixture',
              request: { v: 1 },
              resourceKeys: ['retry:' + f.taskId],
            })!
            await observer.beforeAct()
            await observer.retry(reason, 'transport-policy')
            await observer.succeed()
            const all = await f.ledger(),
              failed = all.find(
                (effect) => effect.attempts[0]?.failureCode === 'local-effect-threw',
              )!,
              retry = all.find((effect) => effect.attempts[0]?.state === 'retry-authorized')!
            const text =
              typeof reason === 'string'
                ? reason.slice(0, 2000)
                : reason instanceof Error &&
                    Object.getOwnPropertyDescriptor(reason, 'message')?.get === undefined
                  ? 'ordinary'
                  : 'unavailable error description'
            expect(JSON.parse(failed.attempts[0]!.receiptJson!).error).toBe(text)
            expect(JSON.parse(retry.attempts[0]!.receiptJson!).error).toBe(text)
            expect(retry.attempts[0]!.retryAuthority).toBe('transport-policy')
          })
        } finally {
          f.reset()
        }
      }
    },
    TIMEOUT,
  )
})
