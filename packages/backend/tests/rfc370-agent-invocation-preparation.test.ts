import { describe, expect, test } from 'bun:test'
import { createAgentInvocationPreparation } from '../src/modules/task-execution/composition/agentInvocationPreparation'
import { createLocalAgentInvocationPreparation } from '../src/modules/task-execution/composition/localAgentInvocationPreparation'
import { bindNativeAgentProtocol } from '../src/modules/runtime-management/infrastructure/local/agentProtocol'
import { bindNativeAgentMaterialReference } from '../src/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import type { NativeAgentMaterialEvidenceHooks } from '../src/modules/runtime-management/infrastructure/local/agentMaterialEvidence'
import type { RuntimeSessionCapturePersistence } from '../src/modules/task-execution/application/ports/runtimeSessionCapturePersistence'
import type {
  AgentProcessRequest,
  AgentProcessResult,
} from '../src/platform/execution/local/agentProcess'
import type { AgentSpawnPlan } from '../src/services/runtime/types'
import { getRuntimeDriver } from '../src/services/runtime'
import { NOOP_HANDLE } from '../src/services/runtime/opencode/subagentLiveCapture'
import type { AgentInvocationBinding } from '../src/modules/task-execution/application/ports/agentInvocation'
import type {
  AgentMaterialCompiler,
  AgentMaterialIntent,
  PreparedAgentMaterial,
} from '../src/modules/runtime-management/application/ports/agentMaterial'
import type { AgentMaterialWorkspace } from '../src/modules/runtime-management/application/ports/agentMaterialWorkspace'
import { emptyDeclaredManifest } from '../src/services/execution/agentInjection'
import { createLogger } from '../src/util/log'

function unavailable(): never {
  throw new Error('unselected physical implementation')
}

const workspace: AgentMaterialWorkspace = {
  workspace: { owner: 'source-control', reference: 'selected:working', version: 11 },
  runContent: { owner: 'runtime-management', reference: 'selected:run', version: 5 },
  retainedRef: 'selected:retained',
  prepare: unavailable,
  discard: unavailable,
}

function intent(): AgentMaterialIntent {
  return {
    protocol: 'opencode',
    injection: { mcps: [] },
    prompt: '最终 prompt\0中文\n',
    agentName: 'selected-agent',
    systemPrompt: 'original system prompt',
    injectedMemoryBlock: 'original memory',
    resolvedProfiles: [
      [
        'selected-agent',
        {
          model: 'selected-model',
          variant: 'original-variant',
          temperature: 0,
          steps: null,
          maxSteps: null,
          isSandbox: false,
        },
      ],
    ],
    workspace: workspace.workspace,
    runContent: workspace.runContent,
    taskMounts: [workspace.workspace],
    extraArgs: ['original-arg', ''],
    freshAgentRun: false,
    nativeSessionId: 'selected-session',
    resumeSessionId: 'original-resume',
    gitUserName: 'original user',
    gitUserEmail: 'original@example.test',
    nodeRunId: 'selected-node-run',
    log: createLogger('invocation-preparation-test'),
  }
}

function material(materialRef = 'selected:compiled'): PreparedAgentMaterial {
  return {
    materialRef,
    declared: emptyDeclaredManifest(),
    evidenceCapabilities: {
      usageNormalizer: false,
      nativeUsageCapture: false,
      spanCapture: true,
      sessionCapture: true,
      inventory: false,
      finalEvents: false,
      liveCapture: false,
      sessionSinkCapture: false,
    },
  }
}

/** The generic preparation must not inspect or execute the selected binding. */
function binding(): AgentInvocationBinding {
  return { bindExecution: unavailable } as unknown as AgentInvocationBinding
}

describe('RFC-370 selected invocation preparation', () => {
  // R1's functional gate found shallow spreads discarded valid prototype
  // members. Exercise the actual local preparation and native binder together.
  test('native preparation keeps prototype binding and private scope receivers through late execution and evidence', async () => {
    const calls: string[] = []
    const fullIntent = intent()
    const nativePlan: AgentSpawnPlan = {
      cmd: ['before-bind'],
      env: { SELECTED: 'before-bind' },
      stdin: { mode: 'pipe', data: 'original\0stdin\n' },
      declared: emptyDeclaredManifest(),
      cleanup() {
        expect(this).toBe(nativePlan)
        calls.push('cleanup')
      },
    }
    const compiledMaterial = {
      ...material(bindNativeAgentMaterialReference(nativePlan)),
      declared: nativePlan.declared,
    }
    const nativeMaterial = {
      compiler: {
        async compile(actual: AgentMaterialIntent) {
          expect(this).toBe(nativeMaterial.compiler)
          expect(actual).toBe(fullIntent)
          calls.push('compile')
          return compiledMaterial
        },
      },
      nativePlan(reference: string) {
        expect(this).toBe(nativeMaterial)
        expect(reference).toBe(compiledMaterial.materialRef)
        calls.push('plan')
        return nativePlan
      },
    }
    const persistence: RuntimeSessionCapturePersistence = {
      resolveTaskId: async () => 'task',
      listSiblingCapturedSessionIds: async () => new Set(),
      appendEvents: async () => {},
    }
    const captureRequest = {
      rootSessionId: 'root',
      nodeRunId: 'node',
      taskId: 'task',
      persistence,
      log: fullIntent.log,
    }
    const hooks: NativeAgentMaterialEvidenceHooks = {
      async captureSessions(actual) {
        expect(this).toBe(hooks)
        expect(actual).toEqual({
          ...captureRequest,
          worktreePath: '/selected-working',
          configDirEnv: 'SELECTED_CONFIG',
        })
        calls.push('capture')
      },
      async readInventory(actual) {
        expect(this).toBe(hooks)
        expect(actual).toEqual({ runRoot: '/selected-run', nodeKind: 'agent-single' })
        calls.push('inventory')
        return null
      },
      prepareUsageNormalizer(actual) {
        expect(this).toBe(hooks)
        expect(actual.env).toBe(nativePlan.env)
        calls.push('usage')
        return () => ({ measurements: [], diagnostics: [] })
      },
      startLiveCapture(actual) {
        expect(this).toBe(hooks)
        expect(actual.opencodeDbPath).toBe('/selected-live.db')
        expect(actual.persistence).toBe(persistence)
        calls.push('live')
        return NOOP_HANDLE
      },
    }
    const protocol = bindNativeAgentProtocol(getRuntimeDriver('opencode'))
    const startOwner = {
      onSpawned(actual: { pid: number | null; spawnedAt: number; spawnBinaryPath: string }) {
        expect(this).toBe(startOwner)
        expect(actual).toEqual({ pid: 719, spawnedAt: 31, spawnBinaryPath: 'late-command' })
        calls.push('receipt')
      },
    }
    let nativeRequest: AgentProcessRequest | undefined
    class SelectedBinding {
      #cwd = '/selected-working'
      get protocol() {
        calls.push('protocol')
        return protocol
      }
      get workspace() {
        calls.push('workspace')
        return workspace
      }
      get evidenceHooks() {
        calls.push('hooks')
        return hooks
      }
      get cleanupReceiver(): 'material' {
        calls.push('cleanupReceiver')
        return 'material'
      }
      get requireSpawnReceipt(): true {
        return true
      }
      get nativeStartOwner() {
        return startOwner
      }
      workingDirectory() {
        calls.push('cwd')
        return this.#cwd
      }
      async runNative(actual: AgentProcessRequest): Promise<AgentProcessResult> {
        expect(actual.cwd).toBe(this.#cwd)
        nativeRequest = actual
        calls.push('run')
        await actual.onSpawned?.({
          pid: 719,
          spawnedAt: 31,
          spawnBinaryPath: 'late-command',
        })
        return {
          outcome: 'ok',
          exitCode: 0,
          pid: 719,
          rawStdout: '',
          stderrTail: '',
          durationMs: 1,
        }
      }
    }
    class SelectedScope {
      #runRoot = '/selected-run'
      #worktreePath = '/selected-working'
      #livePath = '/selected-live.db'
      runContent() {
        calls.push('runContent')
        return this.#runRoot
      }
      sessionLocation() {
        calls.push('sessionLocation')
        return { worktreePath: this.#worktreePath, configDirEnv: 'SELECTED_CONFIG' }
      }
      get liveLocation() {
        calls.push('liveLocationLookup')
        return function (this: SelectedScope) {
          calls.push('liveLocation')
          return { opencodeDbPath: this.#livePath }
        }
      }
    }
    const preparation = createLocalAgentInvocationPreparation({
      material: nativeMaterial,
      binding: new SelectedBinding(),
      evidenceScope: new SelectedScope(),
      taskSnapshot: true,
    })
    expect(calls).toEqual(['workspace'])
    const compiled = await preparation.compile(fullIntent)
    expect(calls).toEqual(['workspace', 'compile'])
    expect(compiled.declared).toBe(compiledMaterial.declared)
    expect(compiled.evidenceCapabilities).toBe(compiledMaterial.evidenceCapabilities)
    const command = ['late-command', 'original']
    const environment = { SELECTED: 'late-bind' }
    nativePlan.cmd = command
    nativePlan.env = environment
    const invocation = compiled.bind()
    expect(invocation.materialRef).toBe(compiledMaterial.materialRef)
    expect(invocation.declared).toBe(compiledMaterial.declared)
    expect(invocation.protocol).toBe(protocol)
    expect(invocation.workspace).toBe(workspace)
    expect(calls).toEqual(['workspace', 'compile', 'plan', 'hooks', 'protocol', 'workspace'])
    nativePlan.cmd = ['after-bind']
    nativePlan.env = { SELECTED: 'after-bind' }
    invocation.evidence.prepareUsageNormalizer!()
    const execution = invocation.bindExecution()
    await execution.effect.submit({
      executionRef: execution.executionRef,
      materialRef: execution.materialRef,
      workspaceRef: execution.workspaceRef,
      onStarted: (receipt) => execution.acknowledgeOwner!(receipt),
    })
    expect(nativeRequest?.cmd).toBe(command)
    expect(nativeRequest?.env).toBe(environment)
    expect(nativeRequest?.stdin).toBe(nativePlan.stdin)
    expect(nativeRequest?.requireSpawnReceipt).toBe(true)
    await invocation.evidence.captureSessions(captureRequest)
    expect(await invocation.evidence.readInventory!({ nodeKind: 'agent-single' })).toBeNull()
    expect(calls).not.toContain('liveLocationLookup')
    expect(
      invocation.evidence.startLiveCapture!({
        ...captureRequest,
        nodeId: 'workflow-node',
        getRootSessionId: () => 'root',
        pollMs: 0,
        consecutiveFailureLimit: 3,
      }),
    ).toBe(NOOP_HANDLE)
    await invocation.lifecycle.cleanup!()
    expect(calls).toEqual([
      'workspace',
      'compile',
      'plan',
      'hooks',
      'protocol',
      'workspace',
      'usage',
      'cwd',
      'run',
      'receipt',
      'sessionLocation',
      'capture',
      'runContent',
      'inventory',
      'liveLocationLookup',
      'liveLocation',
      'live',
      'cleanupReceiver',
      'cleanup',
    ])
    expect(() => compiled.bind()).toThrow('agent-invocation-material-already-bound')
  })

  test('an absent optional prototype location stays lazy and never supplies an alternate native path', async () => {
    let locationReads = 0
    const nativePlan: AgentSpawnPlan = {
      cmd: ['unused-native'],
      env: {},
      declared: emptyDeclaredManifest(),
    }
    const compiledMaterial = material(bindNativeAgentMaterialReference(nativePlan))
    class SelectedScope {
      #worktreePath = '/selected-working'
      runContent = unavailable
      sessionLocation() {
        return { worktreePath: this.#worktreePath }
      }
      get liveLocation(): undefined {
        expect(this.#worktreePath).toBe('/selected-working')
        locationReads++
        return undefined
      }
    }
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      startLiveCapture(actual) {
        expect(actual).not.toHaveProperty('opencodeDbPath')
        return NOOP_HANDLE
      },
    }
    const preparation = createLocalAgentInvocationPreparation({
      material: {
        compiler: { compile: async () => compiledMaterial },
        nativePlan: () => nativePlan,
      },
      binding: {
        protocol: bindNativeAgentProtocol(getRuntimeDriver('opencode')),
        workspace,
        evidenceHooks: hooks,
        workingDirectory: unavailable,
        cleanupReceiver: 'material',
        runNative: unavailable,
      },
      evidenceScope: new SelectedScope(),
    })
    const invocation = (await preparation.compile(intent())).bind()
    expect(invocation.evidence.readInventory).toBeUndefined()
    expect(locationReads).toBe(0)
    const persistence: RuntimeSessionCapturePersistence = {
      resolveTaskId: async () => 'task',
      listSiblingCapturedSessionIds: async () => new Set(),
      appendEvents: async () => {},
    }
    expect(
      invocation.evidence.startLiveCapture!({
        nodeRunId: 'node',
        taskId: 'task',
        nodeId: 'workflow-node',
        getRootSessionId: () => 'root',
        persistence,
        pollMs: 0,
        consecutiveFailureLimit: 3,
      }),
    ).toBe(NOOP_HANDLE)
    expect(locationReads).toBe(1)
  })

  test('compile waits for exactly one complete intent and binding stays at the later boundary', async () => {
    const calls: string[] = []
    const fullIntent = intent()
    const compiledMaterial = material()
    const selectedBinding = binding()
    let complete!: (value: PreparedAgentMaterial) => void
    const pending = new Promise<PreparedAgentMaterial>((resolve) => {
      complete = resolve
    })
    const compiler: AgentMaterialCompiler = {
      compile(actual) {
        expect(this).toBe(compiler)
        expect(actual).toBe(fullIntent)
        expect(actual).not.toHaveProperty('configDir')
        expect(actual.extraArgs).toEqual(['original-arg', ''])
        calls.push('compile')
        return pending
      },
    }
    const selected = {
      compiler,
      workspace,
      bind(actual: PreparedAgentMaterial) {
        expect(this).toBe(selected)
        expect(actual).toBe(compiledMaterial)
        calls.push('bind')
        return selectedBinding
      },
    }
    const preparation = createAgentInvocationPreparation(selected)
    expect(calls).toEqual([])
    expect(preparation.workspace).toBe(workspace)
    const preparedPromise = preparation.compile(fullIntent)
    expect(calls).toEqual(['compile'])
    complete(compiledMaterial)
    const prepared = await preparedPromise
    expect(calls).toEqual(['compile'])
    expect(prepared.materialRef).toBe(compiledMaterial.materialRef)
    expect(prepared.declared).toBe(compiledMaterial.declared)
    expect(prepared.evidenceCapabilities).toBe(compiledMaterial.evidenceCapabilities)
    expect(prepared).not.toHaveProperty('plan')
    expect(prepared).not.toHaveProperty('cmd')
    expect(prepared).not.toHaveProperty('env')
    expect(prepared.bind()).toBe(selectedBinding)
    expect(calls).toEqual(['compile', 'bind'])
    expect(() => prepared.bind()).toThrow('agent-invocation-material-already-bound')
    expect(calls).toEqual(['compile', 'bind'])
  })

  test('the selected compiler, workspace and binder are retained across material preparation', async () => {
    const compiledMaterial = material()
    const selectedBinding = binding()
    const selected = {
      compiler: { compile: async () => compiledMaterial } satisfies AgentMaterialCompiler,
      workspace,
      bind: (_actual: PreparedAgentMaterial) => selectedBinding,
    }
    const preparation = createAgentInvocationPreparation(selected)
    selected.compiler = { compile: unavailable }
    selected.workspace = { ...workspace, prepare: unavailable }
    selected.bind = unavailable
    const prepared = await preparation.compile(intent())
    expect(preparation.workspace).toBe(workspace)
    expect(prepared.bind()).toBe(selectedBinding)
  })

  test('a compilation rejection retains the original prepare error and never binds or operates on content', async () => {
    const original = new Error('selected prepare failed')
    let bindCalls = 0
    const preparation = createAgentInvocationPreparation({
      compiler: { compile: () => Promise.reject(original) },
      workspace,
      bind() {
        bindCalls++
        return binding()
      },
    })
    await expect(preparation.compile(intent())).rejects.toBe(original)
    expect(bindCalls).toBe(0)
  })

  test('a binding error remains outside compilation and cannot select or retry another implementation', async () => {
    const original = new Error('selected binding failed')
    let compileCalls = 0
    let bindCalls = 0
    const preparation = createAgentInvocationPreparation({
      compiler: {
        async compile() {
          compileCalls++
          return material()
        },
      },
      workspace,
      bind() {
        bindCalls++
        throw original
      },
    })
    const prepared = await preparation.compile(intent())
    expect(compileCalls).toBe(1)
    expect(bindCalls).toBe(0)
    expect(() => prepared.bind()).toThrow(original)
    expect(() => prepared.bind()).toThrow('agent-invocation-material-already-bound')
    expect(compileCalls).toBe(1)
    expect(bindCalls).toBe(1)
  })

  test('separate invocation compilations bind their own exact material without sharing one-shot state', async () => {
    const first = material('selected:first')
    const second = material('selected:second')
    const firstBinding = binding()
    const secondBinding = binding()
    const remaining = [first, second]
    const bound: PreparedAgentMaterial[] = []
    const preparation = createAgentInvocationPreparation({
      compiler: { compile: async () => remaining.shift()! },
      workspace,
      bind(actual) {
        bound.push(actual)
        return actual === first ? firstBinding : secondBinding
      },
    })
    const a = await preparation.compile(intent())
    const b = await preparation.compile({ ...intent(), protocol: 'claude-code' })
    expect(b.bind()).toBe(secondBinding)
    expect(a.bind()).toBe(firstBinding)
    expect(bound).toEqual([second, first])
    expect(a.materialRef).toBe('selected:first')
    expect(b.materialRef).toBe('selected:second')
    expect(() => a.bind()).toThrow('agent-invocation-material-already-bound')
    expect(() => b.bind()).toThrow('agent-invocation-material-already-bound')
    expect(bound).toEqual([second, first])
  })

  test('material cleanup stays lazy, keeps the selected receiver and original error, and does not recompile', async () => {
    const compiledMaterial = material()
    const original = new Error('selected cleanup failed')
    const calls: string[] = []
    const selected = {
      compiler: {
        async compile() {
          calls.push('compile')
          return compiledMaterial
        },
      },
      workspace,
      bind: unavailable,
      async cleanupMaterial(actual: PreparedAgentMaterial) {
        expect(this).toBe(selected)
        expect(actual).toBe(compiledMaterial)
        calls.push('cleanup')
        throw original
      },
    }
    const preparation = createAgentInvocationPreparation(selected)
    const compiled = await preparation.compile(intent())
    expect(calls).toEqual(['compile'])
    selected.cleanupMaterial = unavailable
    await expect(compiled.cleanup!()).rejects.toBe(original)
    expect(calls).toEqual(['compile', 'cleanup'])
  })
})
