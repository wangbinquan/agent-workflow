// A human-gate successor must cross every nested wrapper without publishing
// completion, promoting empty outputs, or leaving admitted sibling work behind.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'
import { runScope } from '../src/modules/task-execution/composition/taskDagScope'
import { createWrapperRunLedger } from '../src/modules/task-execution/composition/wrapperRunLifecycle'
import type { WrapperDataPort } from '../src/modules/task-execution/application/ports/wrapperData'
import type { WrapperRunLedgerPort } from '../src/modules/task-execution/application/ports/wrapperRunLedger'
import type { WrapperScopeDriverPort } from '../src/modules/task-execution/application/ports/wrapperScopeDriver'
import type { WrapperWorkspacePort } from '../src/modules/task-execution/application/ports/wrapperWorkspace'
import { createExecutionScopeIndex } from '../src/modules/task-execution/domain/executionScope'
import { TaskScopeHandoffSignal } from '../src/modules/task-execution/domain/taskEngine'
import type { WrapperStrategyMap } from '../src/modules/task-execution/domain/wrapperExecution'
import { GitStrategy } from '../src/modules/task-execution/engine/wrapper/gitStrategy'
import { LoopStrategy } from '../src/modules/task-execution/engine/wrapper/loopStrategy'
import { WrapperRuntime } from '../src/modules/task-execution/engine/wrapper/wrapperRuntime'
import type { TaskMechanicsState } from '../src/services/execution/taskMechanicsState'
import { createLogger } from '../src/util/log'
import { describeEachProvider } from './helpers/eachProvider'

function unexpected(operation: string): never {
  throw new Error(`unexpected effect during handoff: ${operation}`)
}

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    $schema_version: 6,
    inputs: [],
    nodes,
    edges: nodes.some((node) => node.id === 'loop')
      ? [
          {
            id: 'return',
            boundary: 'wrapper-output',
            source: { nodeId: 'worker', portName: 'answer' },
            target: { nodeId: 'loop', portName: 'result' },
          },
        ]
      : [],
  }
}

const nestedDefinition = definition([
  { id: 'git', kind: 'wrapper-git', nodeIds: ['loop'] },
  {
    id: 'loop',
    kind: 'wrapper-loop',
    nodeIds: ['worker'],
    maxIterations: 2,
    exitCondition: { kind: 'port-not-empty', portName: 'result' },
  },
  { id: 'worker', kind: 'agent-single', agentId: 'unused-worker' },
])

function strategyPorts(value: WorkflowDefinition, events: string[]) {
  const data: WrapperDataPort = {
    definition: value,
    fanoutMaxShardTotal: 4,
    fanoutAgentKey: () => null,
    resolveFanoutAgent: async () => ({ kind: 'missing' }),
    sourcePortKind: async () => null,
    consumedProvenanceMatches: () => true,
    reportDiagnostic() {},
    async persistProgress(runId, progress) {
      events.push(`progress:${runId}:${progress.kind}`)
    },
    async readPort() {
      return unexpected('readPort')
    },
    async resolveInputs() {
      return unexpected('resolveInputs')
    },
    async recordConsumed() {
      return unexpected('recordConsumed')
    },
    async priorFanoutConsumed() {
      return unexpected('priorFanoutConsumed')
    },
    async outputOf() {
      return unexpected('outputOf')
    },
    async upsertOutput() {
      return unexpected('upsertOutput')
    },
  }
  const workspace: WrapperWorkspacePort = {
    async open(generation) {
      return { key: Symbol(generation.runId), kind: generation.kind, passthrough: false }
    },
    async captureGitEntry() {
      return { baselines: { '': 'frozen-base' }, preDirtyByRepo: {}, primaryMount: '' }
    },
    async changedFiles() {
      return unexpected('changedFiles')
    },
    async merge() {
      return unexpected('merge')
    },
  }
  return { data, workspace }
}

function ledger(
  events: string[],
  acknowledgement: Promise<void> = Promise.resolve(),
): WrapperRunLedgerPort {
  return {
    async openGeneration(kind, request) {
      return { kind, runId: request.node.id, resumed: false, enteredRunning: true, previous: null }
    },
    async settle(generation, settlement) {
      events.push(`settle-enter:${generation.runId}:${settlement.rowStatus}`)
      await acknowledgement
      events.push(`settle-ack:${generation.runId}:${settlement.rowStatus}`)
    },
  }
}

function runtime(
  value: WorkflowDefinition,
  driver: WrapperScopeDriverPort,
  events: string[],
  acknowledgement?: Promise<void>,
) {
  const ports = strategyPorts(value, events)
  return new WrapperRuntime(
    {
      'wrapper-git': new GitStrategy(ports.data, driver, ports.workspace),
      'wrapper-loop': new LoopStrategy(ports.data, driver, ports.workspace),
      'wrapper-fanout': {
        kind: 'wrapper-fanout',
        async prepare() {
          return unexpected('fanout')
        },
      },
    },
    ledger(events, acknowledgement),
    {
      publish(receipt) {
        events.push(`publish:${receipt.nodeId}:${receipt.status}`)
      },
    },
  )
}

// This scope fixture uses real frontier, gateway and wrapper runtime, but only
// wrapper nodes. Its unused agent/physical capabilities are deliberately absent.
function scopeState(
  value: WorkflowDefinition,
  pending: () => boolean = () => false,
  owned = false,
  autoCommitPush = false,
) {
  const index = createExecutionScopeIndex(value)
  const reads = { node: 0, collaboration: 0 }
  const state = {
    taskId: 'scope-task',
    task: { autoCommitPush },
    definition: value,
    log: createLogger('rfc370-wrapper-handoff'),
    containerOf: new Map(index.parentOf),
    wrapperScopes: { find: index.wrapper },
    opts: {
      ...(owned ? { executionContext: {} } : {}),
      taskDagCollaboration: {
        async autoDispatchDeferredQuestions() {
          reads.collaboration += 1
        },
        async loadOpenClarifyEvidence() {
          return { clarifyNodeIds: new Set<string>(), askingRunIds: new Set<string>() }
        },
        async loadUndispatchedParkTargets() {
          return new Set<string>()
        },
      },
      persistence: {
        nodeExecution: {
          async list() {
            reads.node += 1
            return []
          },
        },
        intents: {
          async hasPendingGateSuccessor() {
            return pending()
          },
        },
      },
    },
  } as unknown as TaskMechanicsState
  return { state, index, reads }
}

for (const kind of ['wrapper-git', 'wrapper-loop'] as const) {
  test(`${kind} waits for interrupted receipt before propagating handoff, with no terminal effects`, async () => {
    const events: string[] = []
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const value = runtime(
      nestedDefinition,
      {
        async drive() {
          entered.resolve()
          return { kind: 'handoff' }
        },
      },
      events,
      release.promise,
    )
    const id = kind === 'wrapper-git' ? 'git' : 'loop'
    const index = createExecutionScopeIndex(nestedDefinition)
    const node = nestedDefinition.nodes.find((item) => item.id === id)!
    let settled = false
    const running = value
      .execute(kind, {
        node: node as typeof node & { kind: typeof kind },
        task: { taskId: 'task' },
        scope: index.wrapper(id, kind),
        containerRunId: null,
        iteration: 0,
        execution: {},
      })
      .then(
        () => {
          throw new Error('handoff was returned as node completion')
        },
        (error: unknown) => {
          settled = true
          return error
        },
      )
    try {
      await entered.promise
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(events).not.toContain(`publish:${id}:interrupted`)
      release.resolve()
      expect(await running).toBeInstanceOf(TaskScopeHandoffSignal)
      expect(events.slice(-3)).toEqual([
        `settle-enter:${id}:interrupted`,
        `settle-ack:${id}:interrupted`,
        `publish:${id}:interrupted`,
      ])
      expect(events.some((event) => event.endsWith(':done'))).toBe(false)
    } finally {
      release.resolve()
      await running
    }
  })
}

test('real nested scopes carry a gate handoff through loop-in-Git and yield the root', async () => {
  const events: string[] = []
  let gatePending = false
  const { state, index } = scopeState(nestedDefinition, () => gatePending, true)
  const value = runtime(
    nestedDefinition,
    {
      async drive(input) {
        if (input.scope.wrapperId === 'loop') gatePending = true
        return runScope(
          state,
          {
            scopeId: input.scope.wrapperId,
            scopeIds: new Set(input.scope.directNodeIds),
            containerRunId: input.containerRunId,
            iteration: input.iteration,
            log: state.log,
          },
          () => value,
        )
      },
    },
    events,
  )
  const result = await runScope(
    state,
    {
      scopeId: null,
      scopeIds: new Set(index.rootNodeIds),
      containerRunId: null,
      iteration: 0,
      log: state.log,
    },
    () => value,
  )
  expect(result).toEqual({ kind: 'handoff' })
  expect(events.filter((event) => event.startsWith('publish:'))).toEqual([
    'publish:git:running',
    'publish:loop:running',
    'publish:loop:interrupted',
    'publish:git:interrupted',
  ])
  expect(events.some((event) => event.endsWith(':done'))).toBe(false)
})

for (const autoCommitPush of [false, true]) {
  test(`a nested handoff drains siblings and freezes admission with autoCommitPush=${autoCommitPush}`, async () => {
    const value = definition([
      { id: 'yielding', kind: 'wrapper-git', nodeIds: [] },
      { id: 'sibling', kind: 'wrapper-loop', nodeIds: [] },
    ])
    const { state, index, reads } = scopeState(value, () => false, false, autoCommitPush)
    Object.defineProperty(state, 'topLevelIds', {
      get() {
        return unexpected('auto commit publication admission')
      },
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    const events: string[] = []
    const strategies: WrapperStrategyMap = {
      'wrapper-git': {
        kind: 'wrapper-git',
        async prepare() {
          return {
            kind: 'ready',
            async execute() {
              return { rowStatus: 'interrupted', outcome: { kind: 'handoff' } }
            },
          }
        },
      },
      'wrapper-loop': {
        kind: 'wrapper-loop',
        async prepare() {
          return {
            kind: 'ready',
            async execute() {
              entered.resolve()
              await release.promise
              return { rowStatus: 'done', outcome: { kind: 'ok', summary: '', message: '' } }
            },
          }
        },
      },
      'wrapper-fanout': {
        kind: 'wrapper-fanout',
        async prepare() {
          return unexpected('fanout')
        },
      },
    }
    const valueRuntime = new WrapperRuntime(strategies, ledger(events), {
      publish(receipt) {
        if (receipt.status === 'interrupted') interrupted.resolve()
      },
    })
    let settled = false
    const running = runScope(
      state,
      {
        scopeId: null,
        scopeIds: new Set(index.rootNodeIds),
        containerRunId: null,
        iteration: 0,
        log: state.log,
      },
      () => valueRuntime,
    ).then((result) => {
      settled = true
      return result
    })
    try {
      await entered.promise
      await interrupted.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      release.resolve()
      expect(await running).toEqual({ kind: 'handoff' })
      expect(events).toContain('settle-ack:sibling:done')
      expect(reads).toEqual({ node: 1, collaboration: 1 })
    } finally {
      release.resolve()
      await running
    }
  })
}

test('an ordinary rejection after handoff waits for every admitted sibling ACK before rethrowing', async () => {
  const value = definition([
    { id: 'yielding', kind: 'wrapper-git', nodeIds: [] },
    { id: 'failing', kind: 'wrapper-loop', nodeIds: [] },
    { id: 'held', kind: 'wrapper-loop', nodeIds: [] },
  ])
  const { state, index, reads } = scopeState(value)
  const interrupted = Promise.withResolvers<void>()
  const releaseFailure = Promise.withResolvers<void>()
  const releaseHeld = Promise.withResolvers<void>()
  const failure = new Error('ordinary admitted sibling failure')
  const events: string[] = []
  const strategies: WrapperStrategyMap = {
    'wrapper-git': {
      kind: 'wrapper-git',
      async prepare() {
        return {
          kind: 'ready',
          async execute() {
            return { rowStatus: 'interrupted', outcome: { kind: 'handoff' } }
          },
        }
      },
    },
    'wrapper-loop': {
      kind: 'wrapper-loop',
      async prepare() {
        return {
          kind: 'ready',
          async execute(generation) {
            if (generation.runId === 'failing') {
              await releaseFailure.promise
              throw failure
            }
            await releaseHeld.promise
            return { rowStatus: 'done', outcome: { kind: 'ok', summary: '', message: '' } }
          },
        }
      },
    },
    'wrapper-fanout': {
      kind: 'wrapper-fanout',
      async prepare() {
        return unexpected('fanout')
      },
    },
  }
  const valueRuntime = new WrapperRuntime(strategies, ledger(events), {
    publish(receipt) {
      if (receipt.status === 'interrupted') interrupted.resolve()
    },
  })
  let settled = false
  const running = runScope(
    state,
    {
      scopeId: null,
      scopeIds: new Set(index.rootNodeIds),
      containerRunId: null,
      iteration: 0,
      log: state.log,
    },
    () => valueRuntime,
  ).then(
    (result) => {
      settled = true
      return result
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    await interrupted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFailure.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(events).not.toContain('settle-ack:held:done')
    releaseHeld.resolve()
    expect(await running).toBe(failure)
    expect(events).toContain('settle-ack:held:done')
    expect(reads).toEqual({ node: 1, collaboration: 1 })
  } finally {
    releaseFailure.resolve()
    releaseHeld.resolve()
    await running
  }
})

test('ordinary node exceptions remain exceptions rather than becoming a gate handoff', async () => {
  const value = definition([{ id: 'broken', kind: 'wrapper-git', nodeIds: [] }])
  const { state, index } = scopeState(value)
  const failure = new Error('ordinary adapter failure')
  const strategies: WrapperStrategyMap = {
    'wrapper-git': {
      kind: 'wrapper-git',
      async prepare() {
        throw failure
      },
    },
    'wrapper-loop': {
      kind: 'wrapper-loop',
      async prepare() {
        return unexpected('loop')
      },
    },
    'wrapper-fanout': {
      kind: 'wrapper-fanout',
      async prepare() {
        return unexpected('fanout')
      },
    },
  }
  const valueRuntime = new WrapperRuntime(strategies, ledger([]), { publish() {} })
  await expect(
    runScope(
      state,
      {
        scopeId: null,
        scopeIds: new Set(index.rootNodeIds),
        containerRunId: null,
        iteration: 0,
        log: state.log,
      },
      () => valueRuntime,
    ),
  ).rejects.toBe(failure)
})

describeEachProvider('RFC-370 wrapper handoff durable generation', (harness) => {
  test('interruption preserves progress and resumes the same frame after control is handed off', async () => {
    const taskId = ulid()
    const runId = ulid()
    const progress = JSON.stringify({ kind: 'loop', iteration: 1, phase: 'inner-running' })
    const workflowId = ulid()
    await harness.db.insert(workflows).values({
      id: workflowId,
      name: 'handoff workflow fixture',
      definition: JSON.stringify(nestedDefinition),
    })
    await harness.db.insert(tasks).values({
      id: taskId,
      name: 'handoff fixture',
      workflowId,
      inputs: '{}',
      startedAt: Date.now(),
      status: 'running',
      repoPath: 'installation:selected',
      worktreePath: 'workspace:selected',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      workflowSnapshot: JSON.stringify(nestedDefinition),
    })
    await harness.db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'loop',
      status: 'running',
      iteration: 0,
      wrapperProgressJson: progress,
      startedAt: Date.now(),
    })
    const state = {
      taskId,
      opts: { persistence: createTaskExecutionPersistence(harness.db) },
    } as unknown as TaskMechanicsState
    const value = createWrapperRunLedger(state)
    await value.settle(
      { kind: 'wrapper-loop', runId, resumed: false, enteredRunning: true, previous: null },
      {
        rowStatus: 'interrupted',
        outcome: { kind: 'handoff' },
      },
    )
    const interrupted = (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.wrapperProgressJson).toBe(progress)
    expect(interrupted.finishedAt).toBeNull()
    const index = createExecutionScopeIndex(nestedDefinition)
    const resumed = await value.openGeneration('wrapper-loop', {
      node: { id: 'loop', kind: 'wrapper-loop' },
      task: { taskId },
      scope: index.wrapper('loop', 'wrapper-loop'),
      containerRunId: null,
      iteration: 0,
      execution: {},
    })
    expect(resumed.runId).toBe(runId)
    expect(resumed.resumed).toBe(true)
    expect(resumed.previous?.wrapperProgressJson).toBe(progress)
    expect(
      (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]?.status,
    ).toBe('running')
  })
})
