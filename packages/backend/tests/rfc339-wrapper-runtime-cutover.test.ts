import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { WRAPPER_NODE_KINDS, type WorkflowDefinition } from '@agent-workflow/shared'
import type { WrapperRunLedgerPort } from '../src/modules/task-execution/application/ports/wrapperRunLedger'
import type { WrapperStatusPublisherPort } from '../src/modules/task-execution/application/ports/wrapperStatusPublisher'
import {
  createExecutionScopeIndex,
  InvalidExecutionScopeError,
} from '../src/modules/task-execution/domain/executionScope'
import type { NodeStepOutcome } from '../src/modules/task-execution/domain/nodeExecution'
import {
  WrapperSupersededSignal,
  type WrapperExecutionRequest,
  type WrapperStrategyMap,
} from '../src/modules/task-execution/domain/wrapperExecution'
import { WrapperRuntime } from '../src/modules/task-execution/engine/wrapper/wrapperRuntime'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')
const ok: NodeStepOutcome = { kind: 'ok', summary: '', message: '' }

function tsFilesUnder(relativeDirectory: string): string[] {
  const files: string[] = []
  const visit = (relative: string): void => {
    for (const entry of readdirSync(resolve(ROOT, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(child)
    }
  }
  visit(relativeDirectory)
  return files.sort()
}

function workflow(nodes: unknown[]): WorkflowDefinition {
  return { version: 1, inputs: [], nodes, edges: [] } as unknown as WorkflowDefinition
}

function loopRequest(): WrapperExecutionRequest<'wrapper-loop'> {
  return {
    node: { id: 'loop', kind: 'wrapper-loop' } as WrapperExecutionRequest<'wrapper-loop'>['node'],
    task: { taskId: 'task' },
    scope: {
      wrapperId: 'loop',
      kind: 'wrapper-loop',
      parentScopeId: null,
      directNodeIds: [],
      path: [{ wrapperId: 'loop', kind: 'wrapper-loop' }],
    },
    iteration: 0,
    execution: {},
  }
}

function strategies(calls: string[] = []): WrapperStrategyMap {
  return {
    'wrapper-git': {
      kind: 'wrapper-git',
      async prepare() {
        return {
          kind: 'ready',
          async execute() {
            calls.push('wrapper-git')
            return { rowStatus: 'done', outcome: ok }
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
            calls.push('wrapper-loop')
            return { rowStatus: 'done', outcome: ok }
          },
        }
      },
    },
    'wrapper-fanout': {
      kind: 'wrapper-fanout',
      async prepare() {
        return {
          kind: 'ready',
          async execute() {
            calls.push('wrapper-fanout')
            return { rowStatus: 'done', outcome: ok }
          },
        }
      },
    },
  }
}

function lifecycle(events: string[] = []): {
  readonly ledger: WrapperRunLedgerPort
  readonly publisher: WrapperStatusPublisherPort
} {
  return {
    ledger: {
      async openGeneration(kind) {
        events.push('open')
        return {
          kind,
          runId: 'run',
          resumed: false,
          enteredRunning: true,
          previous: null,
        }
      },
      async settle(_generation, value) {
        events.push(`settle:${value.rowStatus}`)
      },
    },
    publisher: {
      publish(receipt) {
        events.push(`publish:${receipt.status}`)
      },
    },
  }
}

function wrapperRuntime(value: WrapperStrategyMap, events: string[] = []): WrapperRuntime {
  const ports = lifecycle(events)
  return new WrapperRuntime(value, ports.ledger, ports.publisher)
}

describe('RFC-339 WrapperRuntime cutover', () => {
  test('closed registry is exactly the shared wrapper catalog and rejects every drift shape', async () => {
    expect([...WRAPPER_NODE_KINDS].sort()).toEqual([
      'wrapper-fanout',
      'wrapper-git',
      'wrapper-loop',
    ])
    const calls: string[] = []
    const events: string[] = []
    const runtime = wrapperRuntime(strategies(calls), events)
    await runtime.execute('wrapper-loop', loopRequest())
    expect(calls).toEqual(['wrapper-loop'])
    expect(events).toEqual(['open', 'publish:running', 'settle:done', 'publish:done'])

    const all = strategies()
    const { 'wrapper-loop': _missing, ...missing } = all
    expect(() => wrapperRuntime(missing as WrapperStrategyMap)).toThrow(
      'wrapper-runtime-registry-mismatch',
    )
    expect(() =>
      wrapperRuntime({ ...all, unexpected: all['wrapper-loop'] } as WrapperStrategyMap),
    ).toThrow('wrapper-runtime-registry-mismatch')
    expect(() =>
      wrapperRuntime({
        ...all,
        'wrapper-loop': all['wrapper-git'],
      } as unknown as WrapperStrategyMap),
    ).toThrow('wrapper-runtime-strategy-kind-mismatch')
  })

  test('preparation rejection creates no durable generation or status publication', async () => {
    const events: string[] = []
    const rejected: NodeStepOutcome = {
      kind: 'failed',
      summary: '',
      message: 'wrapper-preflight-rejected',
    }
    const values = strategies()
    const runtime = wrapperRuntime(
      {
        ...values,
        'wrapper-loop': {
          kind: 'wrapper-loop',
          async prepare() {
            events.push('prepare')
            return { kind: 'rejected', outcome: rejected }
          },
        },
      },
      events,
    )

    await expect(runtime.execute('wrapper-loop', loopRequest())).resolves.toEqual(rejected)
    expect(events).toEqual(['prepare'])
  })

  test('resume, park and superseded settlement keep the common phase ordering', async () => {
    const events: string[] = []
    const values = strategies()
    const parked = new WrapperRuntime(
      {
        ...values,
        'wrapper-loop': {
          kind: 'wrapper-loop',
          async prepare() {
            return {
              kind: 'ready',
              async execute() {
                events.push('execute')
                return { rowStatus: 'awaiting_human', outcome: ok }
              },
            }
          },
        },
      },
      {
        async openGeneration(kind) {
          events.push('open:resumed-running')
          return {
            kind,
            runId: 'run',
            resumed: true,
            enteredRunning: false,
            previous: null,
          }
        },
        async settle(_generation, value) {
          events.push(`settle:${value.rowStatus}`)
        },
      },
      {
        publish(receipt) {
          events.push(`publish:${receipt.status}`)
        },
      },
    )
    await expect(parked.execute('wrapper-loop', loopRequest())).resolves.toEqual(ok)
    expect(events).toEqual([
      'open:resumed-running',
      'execute',
      'settle:awaiting_human',
      'publish:awaiting_human',
    ])

    events.length = 0
    const superseded: NodeStepOutcome = {
      kind: 'canceled',
      summary: '',
      message: 'wrapper-superseded-canceled',
    }
    const runtime = new WrapperRuntime(
      strategies(events),
      {
        async openGeneration(kind) {
          events.push('open')
          return {
            kind,
            runId: 'run',
            resumed: false,
            enteredRunning: true,
            previous: null,
          }
        },
        async settle() {
          events.push('settle:superseded')
          throw new WrapperSupersededSignal(superseded)
        },
      },
      {
        publish(receipt) {
          events.push(`publish:${receipt.status}`)
        },
      },
    )
    await expect(runtime.execute('wrapper-loop', loopRequest())).resolves.toEqual(superseded)
    expect(events).toEqual(['open', 'publish:running', 'wrapper-loop', 'settle:superseded'])
  })

  test('scope index owns direct membership and outer-to-inner paths', () => {
    const index = createExecutionScopeIndex(
      workflow([
        { id: 'outer', kind: 'wrapper-loop', nodeIds: ['inner', 'leaf-a'] },
        { id: 'inner', kind: 'wrapper-git', nodeIds: ['leaf-b'] },
        { id: 'leaf-a', kind: 'input' },
        { id: 'leaf-b', kind: 'output' },
        { id: 'root', kind: 'input' },
      ]),
    )
    expect([...index.rootNodeIds]).toEqual(['outer', 'root'])
    expect(index.wrapper('outer', 'wrapper-loop').directNodeIds).toEqual(['inner', 'leaf-a'])
    expect(index.wrapper('inner', 'wrapper-git').directNodeIds).toEqual(['leaf-b'])
    expect(index.pathOf('leaf-b')).toEqual([
      { wrapperId: 'outer', kind: 'wrapper-loop' },
      { wrapperId: 'inner', kind: 'wrapper-git' },
    ])
    expect(index.scopeOf('leaf-b')).toBe('inner')
    expect(Object.isFrozen(index)).toBe(true)
    expect(Object.isFrozen(index.wrapper('outer', 'wrapper-loop'))).toBe(true)
    expect(Object.isFrozen(index.wrapper('outer', 'wrapper-loop').directNodeIds)).toBe(true)
    expect(Object.isFrozen(index.wrapper('inner', 'wrapper-git').path)).toBe(true)
    expect(Object.isFrozen(index.wrapper('inner', 'wrapper-git').path[0])).toBe(true)
    expect('set' in index.parentOf).toBe(false)
    expect('add' in index.rootNodeIds).toBe(false)

    const rawMembershipReaders = tsFilesUnder('packages/backend/src/modules/task-execution').filter(
      (file) =>
        file !== 'packages/backend/src/modules/task-execution/domain/executionScope.ts' &&
        read(file).includes('nodeIds'),
    )
    expect(rawMembershipReaders).toEqual([])

    const runtimeFanoutSources = [
      read('packages/backend/src/modules/task-execution/domain/fanoutScope.ts'),
      read('packages/backend/src/modules/task-execution/engine/wrapper/fanoutStrategy.ts'),
    ].join('\n')
    expect(runtimeFanoutSources).toContain('findFanoutAggregatorInScope(')
    expect(runtimeFanoutSources).toContain('deriveWrapperFanoutOutputsInScope(')
    expect(runtimeFanoutSources).not.toMatch(/\bfindFanoutAggregator\(/)
    expect(runtimeFanoutSources).not.toMatch(/\bderiveWrapperFanoutOutputs\(/)
  })

  test('scope index rejects duplicate, multi-parent, missing and cyclic containment', () => {
    const invalid = [
      workflow([
        { id: 'w', kind: 'wrapper-loop', nodeIds: ['n', 'n'] },
        { id: 'n', kind: 'input' },
      ]),
      workflow([
        { id: 'a', kind: 'wrapper-loop', nodeIds: ['n'] },
        { id: 'b', kind: 'wrapper-git', nodeIds: ['n'] },
        { id: 'n', kind: 'input' },
      ]),
      workflow([{ id: 'w', kind: 'wrapper-loop', nodeIds: ['missing'] }]),
      workflow([
        { id: 'a', kind: 'wrapper-loop', nodeIds: ['b'] },
        { id: 'b', kind: 'wrapper-git', nodeIds: ['a'] },
      ]),
    ]
    for (const definition of invalid) {
      expect(() => createExecutionScopeIndex(definition)).toThrow(InvalidExecutionScopeError)
    }
  })

  test('legacy scheduler bridges and owners are extinct', () => {
    const scheduler = read('packages/backend/src/services/scheduler.ts')
    const nodeExecution = read(
      'packages/backend/src/modules/task-execution/composition/nodeExecution.ts',
    )
    const taskEngine = read(
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
    )
    const wrapperComposition = read(
      'packages/backend/src/modules/task-execution/composition/wrapperRuntime.ts',
    )
    const startDeps = read('packages/backend/src/services/startTaskDeps.ts')
    const legacySymbols = [
      'dispatchFanoutAggregator',
      'dispatchFanoutShard',
      'replayConflictHumanResolutions',
      'replayPendingMerges',
      'runGitWrapperNode',
      'runLoopWrapperNode',
      'runWrapperFanoutNode',
      'runWrapperGitNode',
      'runWrapperLoopNode',
      'runWrapperNode',
    ]
    for (const symbol of legacySymbols) expect(scheduler).not.toContain(symbol)
    expect(scheduler).not.toContain('@/modules/task-execution/composition/nodeMechanics')
    expect(scheduler).not.toMatch(
      /@\/modules\/task-execution\/(?:application|domain|engine|infrastructure|composition)\//,
    )
    expect(nodeExecution).not.toContain('@/services/scheduler')
    expect(nodeExecution).not.toContain('composeWrapperRuntime')
    expect(nodeExecution).toContain('wrapperRuntimeFactory(state)')
    expect(wrapperComposition).toContain('new WrapperRuntime')
    expect(taskEngine).not.toMatch(/replay(?:PendingMerges|ConflictHumanResolutions).*scheduler/)
    expect(taskEngine).not.toContain('composeExecutionMergeRecovery')
    expect(taskEngine).toContain('runtimeComponents.mergeRecoveryFactory(state, log)')
    expect(taskEngine).toContain('recoverBeforeScope()')
    expect(startDeps).not.toContain('createLegacyTaskExecutionTopology')
    expect(startDeps).not.toContain('taskEngineApplication')
  })

  test('canonical architecture has retired every W2-D exception', () => {
    const canonical = JSON.parse(read('architecture/cross-context-imports.json')) as {
      readonly architectureExceptions: readonly {
        readonly fromPath: string
        readonly toPath: string
        readonly removeAfterWave: string
      }[]
    }
    expect(
      canonical.architectureExceptions.filter((entry) => entry.removeAfterWave === 'W2-D'),
    ).toEqual([])

    const mutations = JSON.parse(read('architecture/mutation-entrypoints.json')) as {
      readonly taskExecutionAuthorityLedger: {
        readonly unknown: readonly unknown[]
        readonly entries: readonly {
          readonly file: string
          readonly consumer: string
          readonly authorityKind: string
        }[]
      }
    }
    expect(mutations.taskExecutionAuthorityLedger.unknown).toEqual([])
    expect(
      mutations.taskExecutionAuthorityLedger.entries
        .filter((entry) =>
          /modules\/task-execution\/composition\/wrapper(?:Mechanics|RunLifecycle)\.ts$/.test(
            entry.file,
          ),
        )
        .map((entry) => `${entry.consumer}:${entry.authorityKind}`)
        .sort(),
    ).toEqual([
      'clearWrapperReuseDisabled:worker-epoch',
      'dispatchFanoutShardAttempt:worker-epoch',
      'persistWrapperProgress:worker-epoch',
      'recordConsumed:worker-epoch',
      'upsertWrapperOutput:worker-epoch',
    ])
  })

  test('bootstrap is the only runtime composer and every continuation caller receives a public driver', () => {
    const server = read('packages/backend/src/server.ts')
    const cli = read('packages/backend/src/cli/start.ts')
    const runtime = read(
      'packages/backend/src/modules/task-execution/composition/taskExecutionRuntime.ts',
    )
    expect(server.match(/composeTaskExecutionRuntime\(/g)).toHaveLength(1)
    expect(cli.match(/composeTaskExecutionRuntime\(/g)).toHaveLength(1)
    expect(runtime.match(/export function composeTaskExecutionRuntime\(/g)).toHaveLength(1)
    expect(runtime).toContain('wrapperRuntimeFactory: composeWrapperRuntime')
    expect(runtime).toContain('mergeRecoveryFactory: composeExecutionMergeRecovery')
    expect(
      existsSync(resolve(ROOT, 'packages/backend/src/modules/task-execution/public/topology.ts')),
    ).toBe(false)
    expect(server).toContain('@/modules/task-execution/public/commands')
    expect(cli).not.toContain('@/modules/task-execution/public/topology')

    const callers = [
      'packages/backend/src/routes/agents.ts',
      'packages/backend/src/routes/clarify.ts',
      'packages/backend/src/routes/developmentMissions.ts',
      'packages/backend/src/routes/fusions.ts',
      'packages/backend/src/routes/reviews.ts',
      'packages/backend/src/routes/scheduledTasks.ts',
      'packages/backend/src/routes/taskQuestions.ts',
      'packages/backend/src/routes/tasks.ts',
      'packages/backend/src/routes/workgroupTasks.ts',
      'packages/backend/src/routes/workgroups.ts',
      'packages/backend/src/services/startTaskDeps.ts',
      'packages/backend/src/services/webhook/webhookDispatch.ts',
    ]
    for (const path of callers) {
      const source = read(path)
      expect(source, path).not.toContain(
        '@/modules/task-execution/composition/taskExecutionRuntime',
      )
      expect(source, path).not.toContain('createLegacyTaskExecutionTopology')
    }
    expect(server).toContain('schedulerDriver?: SchedulerDriverPort')
    expect(server).toContain('type RuntimeComposedAppDeps = AppDeps & {')
    expect(server).toContain('export type ComposedAppDeps = RuntimeComposedAppDeps &')
    expect(server).toContain('RepositoryBootstrap & {')
    expect(server).toContain('const effectiveDeps: ComposedAppDeps = {')
    expect(server).toContain('export function mountApiRoutes(')
    expect(server).toContain('deps: ComposedAppDeps')
    expect(server).toContain('identityAccess: IdentityAccessModule')
    expect(server).toContain('deps.schedulerDriver ?? taskExecutionRuntime?.schedulerDriver')
    expect(server).toContain('const schedulerDriver = deps.schedulerDriver')
    expect(server).toContain('taskExecutionRuntime?.readModels')
    expect(cli).toContain('taskExecutionReadModels: taskExecutionRuntime.readModels')

    const mcpServer = read('packages/backend/src/mcp/server.ts')
    expect(existsSync(resolve(ROOT, 'packages/backend/src/mcp/dispatch.ts'))).toBe(false)
    expect(mcpServer).toContain('export interface McpTransportDeps')
    expect(mcpServer).not.toContain("from '@/server'")

    for (const path of [
      'packages/backend/src/services/dispatchFrontier.ts',
      'packages/backend/src/services/execution/taskMechanicsState.ts',
      'packages/backend/src/services/structuralDiff/service.ts',
      'packages/backend/src/services/workflow.validator.ts',
    ]) {
      const source = read(path)
      expect(source, path).toContain('@/modules/task-execution/public/')
      expect(source, path).not.toMatch(
        /@\/modules\/task-execution\/(?:domain|application|engine|infrastructure|composition)\//,
      )
    }

    const publicTypes = read('packages/backend/src/modules/task-execution/public/types.ts')
    const taskMechanicsState = read('packages/backend/src/services/execution/taskMechanicsState.ts')
    expect(publicTypes).toContain('export interface WrapperExecutionScopeReadModel')
    expect(publicTypes).not.toContain('ExecutionScopeIndex')
    expect(publicTypes).not.toContain('ReadonlyMap')
    expect(publicTypes).not.toContain('ReadonlySet')
    expect(taskMechanicsState).toContain('readonly wrapperScopes: WrapperExecutionScopeReadModel')
    expect(taskMechanicsState).not.toContain('readonly scopeIndex:')

    const productionSources = tsFilesUnder('packages/backend/src')
    const containing = (needle: string): string[] =>
      productionSources.filter((path) => read(path).includes(needle))
    expect(containing('composeTaskExecutionRuntime(')).toEqual([
      'packages/backend/src/cli/start.ts',
      'packages/backend/src/modules/task-execution/composition/taskExecutionRuntime.ts',
      'packages/backend/src/server.ts',
    ])
    expect(containing('composeWrapperRuntime')).toEqual([
      'packages/backend/src/modules/task-execution/composition/taskExecutionRuntime.ts',
      'packages/backend/src/modules/task-execution/composition/wrapperRuntime.ts',
    ])
    expect(containing('composeExecutionMergeRecovery')).toEqual([
      'packages/backend/src/modules/task-execution/composition/executionMergeRecovery.ts',
      'packages/backend/src/modules/task-execution/composition/taskExecutionRuntime.ts',
    ])
    expect(containing('createExecutionScopeIndex(')).toEqual([
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
      'packages/backend/src/modules/task-execution/domain/executionScope.ts',
    ])
    expect(containing('createLegacyTaskExecutionTopology')).toEqual([])
  })

  test('recovery order and immutable wrapper membership stay single-owner', () => {
    const recovery = read(
      'packages/backend/src/modules/task-execution/composition/executionMergeRecovery.ts',
    )
    const taskEnginePorts = read(
      'packages/backend/src/modules/task-execution/application/ports/taskEngine.ts',
    )
    expect(recovery.indexOf('await replayPendingMerges(state, log)')).toBeLessThan(
      recovery.indexOf('await replayConflictHumanResolutions(state, log)'),
    )
    expect(taskEnginePorts).not.toContain('TaskPreDriveReplayPort')
    expect(taskEnginePorts).not.toContain('TaskReplayRequest')
    expect(taskEnginePorts).not.toContain('replayPendingMerges')
    expect(taskEnginePorts).not.toContain('replayConflictHumanResolutions')
    const mechanics = read(
      'packages/backend/src/modules/task-execution/composition/wrapperMechanics.ts',
    )
    const mergeHelper = mechanics.slice(mechanics.indexOf('async function mergeBackWrapperIso('))
    expect(mergeHelper).toContain("event: { kind: 'park-conflict-human', via: 'live' }")
    expect(mergeHelper).not.toContain('transitionNodeRunStatus(')
    expect(mergeHelper).not.toContain('broadcastNodeStatus(')
    const strategies = ['loopStrategy.ts', 'gitStrategy.ts', 'fanoutStrategy.ts']
      .map((file) => read(`packages/backend/src/modules/task-execution/engine/wrapper/${file}`))
      .join('\n')
    expect(
      strategies.match(/(?:request\.)?scope\.directNodeIds/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3)
    expect(mechanics).not.toContain("pickStringArray(node, 'nodeIds')")
    expect(strategies).not.toContain("pickStringArray(node, 'nodeIds')")
  })

  test('each strategy owns its business differences rather than forwarding to a generic shell', () => {
    const strategyMarkers = {
      'loopStrategy.ts': [
        'evaluateExitCondition(',
        "readWrapperOutputBindings(node, 'outputBindings')",
        'this.scopeDriver.drive(',
        'this.workspace.merge(',
      ],
      'gitStrategy.ts': [
        'decodeWrapperProgress(',
        'this.workspace.captureGitEntry(',
        'this.workspace.changedFiles(',
        "portName: 'git_diff'",
      ],
      'fanoutStrategy.ts': [
        'estimateShardTotal(',
        'computeShardScope(',
        'this.attempts.dispatchShard(',
        'this.attempts.dispatchAggregator(',
      ],
    } as const
    for (const [file, markers] of Object.entries(strategyMarkers)) {
      const source = read(`packages/backend/src/modules/task-execution/engine/wrapper/${file}`)
      expect(source.split('\n').length, file).toBeGreaterThan(150)
      expect(source, file).toContain('private async executePrepared(')
      for (const marker of markers) expect(source, `${file}:${marker}`).toContain(marker)
    }
    expect(
      existsSync(
        resolve(
          ROOT,
          'packages/backend/src/modules/task-execution/engine/wrapper/wrapperStrategy.ts',
        ),
      ),
    ).toBe(false)
  })

  test('all six purpose-specific wrapper ports are explicit and wired without a capability bag', () => {
    const portFiles = [
      ['wrapperRunLedger.ts', 'WrapperRunLedgerPort'],
      ['wrapperScopeDriver.ts', 'WrapperScopeDriverPort'],
      ['wrapperWorkspace.ts', 'WrapperWorkspacePort'],
      ['wrapperData.ts', 'WrapperDataPort'],
      ['fanoutAttempt.ts', 'FanoutAttemptPort'],
      ['wrapperStatusPublisher.ts', 'WrapperStatusPublisherPort'],
    ] as const
    for (const [file, symbol] of portFiles) {
      const source = read(`packages/backend/src/modules/task-execution/application/ports/${file}`)
      expect(source, file).toContain(`export interface ${symbol}`)
      expect(source, file).not.toMatch(/\b(?:DbClient|SchedulerState|LegacyTaskMechanicsState)\b/)
    }
    const mechanics = read(
      'packages/backend/src/modules/task-execution/composition/wrapperMechanics.ts',
    )
    for (const symbol of [
      'WrapperScopeDriverPort',
      'WrapperWorkspacePort',
      'WrapperDataPort',
      'FanoutAttemptPort',
    ]) {
      expect(mechanics, symbol).toContain(symbol)
    }
    const runtime = read(
      'packages/backend/src/modules/task-execution/engine/wrapper/wrapperRuntime.ts',
    )
    expect(runtime).toContain('WrapperRunLedgerPort')
    expect(runtime).toContain('WrapperStatusPublisherPort')
    expect(runtime).not.toMatch(/Record<string,\s*unknown>/)
    expect(
      existsSync(
        resolve(
          ROOT,
          'packages/backend/src/modules/task-execution/engine/wrapper/wrapperStrategy.ts',
        ),
      ),
    ).toBe(false)
  })

  test('wrapper engine and domain stay free of infrastructure bags', () => {
    const paths = [
      'packages/backend/src/modules/task-execution/domain/wrapperExecution.ts',
      'packages/backend/src/modules/task-execution/domain/executionScope.ts',
      ...readdirSync(resolve(ROOT, 'packages/backend/src/modules/task-execution/engine/wrapper'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `packages/backend/src/modules/task-execution/engine/wrapper/${name}`),
    ]
    for (const path of paths) {
      const source = read(path)
      expect(source, path).not.toMatch(
        /@\/services\/scheduler|@\/db\/schema|\b(?:DbClient|AppDeps|LegacyTaskMechanicsState)\b|from ['"]hono['"]|@\/ws\//,
      )
    }
    expect(existsSync(resolve(ROOT, 'packages/backend/src/services/wrapperProgress.ts'))).toBe(
      false,
    )
    expect(existsSync(resolve(ROOT, 'packages/backend/src/services/fanout.ts'))).toBe(false)
  })
})
