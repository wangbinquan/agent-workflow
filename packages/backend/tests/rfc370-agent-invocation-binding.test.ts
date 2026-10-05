import { describe, expect, test } from 'bun:test'
import {
  bindNativeAgentInvocation,
  bindNativeAgentProtocol,
} from '../src/modules/runtime-management/infrastructure/local/agentInvocationBinding'
import { bindNativeAgentMaterialReference } from '../src/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import type { AgentInvocationProtocol } from '../src/modules/runtime-management/application/ports/agentInvocationBinding'
import type { AgentMaterialWorkspace } from '../src/modules/runtime-management/application/ports/agentMaterialWorkspace'
import type { NativeAgentMaterialEvidenceHooks } from '../src/modules/runtime-management/infrastructure/local/agentMaterialEvidence'
import type { AgentExecutionParticipants } from '../src/modules/task-execution/application/ports/agentExecutionBinding'
import type { ExecutionEffectRequest } from '../src/modules/task-execution/application/ports/executionEffect'
import type { TaskExecutionEffectPersistence } from '../src/modules/task-execution/application/ports/taskExecutionEffectStore'
import type { NodeExecutionPersistence } from '../src/modules/task-execution/application/ports/nodeExecutionPersistence'
import { bindLocalAgentExecutionParticipants } from '../src/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { requestHash } from '../src/modules/task-execution/domain/executionEffect'
import { sha256Hex } from '../src/modules/task-execution/domain/digest'
import type { AgentProcessRequest } from '../src/platform/execution/local/agentProcess'
import type { AgentSpawnPlan, RuntimeDriver } from '../src/services/runtime/types'
import { getRuntimeDriver } from '../src/services/runtime'
import { emptyDeclaredManifest } from '../src/services/execution/agentInjection'
const unavailable = () => {
  throw new Error('unselected physical scope read')
}
const workspace: AgentMaterialWorkspace = {
  workspace: { owner: 'source-control', reference: 'selected-working-ref', version: 7 },
  runContent: { owner: 'runtime-management', reference: 'selected-run-ref', version: 3 },
  retainedRef: 'selected-retained-ref',
  prepare: unavailable,
  discard: unavailable,
}
function plan(): AgentSpawnPlan {
  return {
    cmd: ['selected-binary', 'original', '中文\0bytes'],
    env: { SELECTED: 'original' },
    stdin: { mode: 'pipe', data: '原始\0stdin\n' },
    declared: emptyDeclaredManifest(),
  }
}
function makeBinding(
  material: AgentSpawnPlan,
  options: Partial<Parameters<typeof bindNativeAgentInvocation>[0]> = {},
) {
  const driver = getRuntimeDriver('opencode')
  return bindNativeAgentInvocation({
    plan: material,
    protocol: bindNativeAgentProtocol(driver),
    workspace,
    cleanupReceiver: 'material',
    workingDirectory: () => '/selected-working',
    evidenceHooks: driver,
    evidenceScope: {
      environment: () => material.env,
      runContent: () => '/selected-run',
      sessionLocation: () => ({ worktreePath: '/selected-working' }),
    },
    ...options,
  })
}
function request(
  binding: ReturnType<ReturnType<typeof makeBinding>['bindExecution']>,
  rest: Omit<ExecutionEffectRequest, 'executionRef' | 'materialRef' | 'workspaceRef'> = {},
): ExecutionEffectRequest {
  return {
    executionRef: binding.executionRef,
    materialRef: binding.materialRef,
    workspaceRef: binding.workspaceRef,
    ...rest,
  }
}

describe('RFC-370 complete native invocation binding', () => {
  test('construction is lazy and wraps the same compiled declaration and workspace without materializing again', () => {
    const material = plan()
    let declarationReads = 0
    const declared = material.declared
    Object.defineProperty(material, 'declared', {
      get() {
        declarationReads++
        return declared
      },
    })
    const materialRef = bindNativeAgentMaterialReference(material)
    let hookReads = 0
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      get readInventory() {
        hookReads++
        return undefined
      },
    }
    const binding = makeBinding(material, {
      workingDirectory: unavailable,
      evidenceHooks: hooks,
      evidenceScope: {
        environment: unavailable,
        runContent: unavailable,
        sessionLocation: unavailable,
      },
    })
    expect(declarationReads).toBe(0)
    expect(hookReads).toBe(0)
    expect(binding.materialRef).toBe(materialRef)
    expect(binding.workspace).toBe(workspace)
    expect(binding.declared).toBe(declared)
    expect(declarationReads).toBe(1)
    expect(binding.evidence.readInventory).toBeUndefined()
    expect(hookReads).toBe(1)
    expect(binding).not.toHaveProperty('cmd')
    expect(binding).not.toHaveProperty('env')
    expect(binding).not.toHaveProperty('workingDirectory')
  })

  test('Task keeps early cmd/env identity, lazy evidence env and original late fingerprint/resources/receipt writes', async () => {
    const material = plan()
    const command = material.cmd
    const environment = material.env
    const changedEnv = { SELECTED: 'after-wrap' }
    const reads: string[] = []
    const patches: unknown[] = []
    const nodeExecution = {
      async patch(input: Parameters<NodeExecutionPersistence['patch']>[0]) {
        patches.push(input)
      },
    } as unknown as NodeExecutionPersistence
    const persistence = {} as TaskExecutionEffectPersistence
    const normalize = () => ({ measurements: [], diagnostics: [] })
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      prepareUsageNormalizer(input) {
        expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
        expect(input.env).toBe(changedEnv)
        return normalize
      },
    }
    let nativeRequest: AgentProcessRequest | undefined
    const binding = makeBinding(material, {
      taskSnapshot: { command, environment },
      requireSpawnReceipt: true,
      evidenceHooks: hooks,
      workingDirectory() {
        reads.push('cwd')
        return '/selected-working'
      },
      async runNative(input) {
        nativeRequest = input
        await input.onSpawned?.({
          pid: 719,
          spawnedAt: 31,
          spawnBinaryPath: 'selected-binary',
          launchNonce: 'original-nonce',
        })
        return {
          outcome: 'ok',
          exitCode: 0,
          pid: 719,
          rawStdout: '',
          stderrTail: '',
          durationMs: 1,
        }
      },
    })
    material.cmd = ['after-wrap-command']
    material.env = changedEnv
    expect(reads).toEqual([])
    expect(binding.evidence.prepareUsageNormalizer?.()).toBe(normalize)
    const participants: AgentExecutionParticipants = bindLocalAgentExecutionParticipants({
      persistence,
      nodeExecution: () => nodeExecution,
      readOnlyWorkspace() {
        reads.push('policy')
        return false
      },
    })
    const execution = binding.bindExecution(participants)
    expect(reads).toEqual(['cwd', 'policy', 'cwd'])
    expect(execution.projection?.describe()).toEqual({
      requestHash: requestHash({
        v: 1,
        processKind: 'agent',
        argv: command,
        cwd: '/selected-working',
      }),
      resourceKeys: [`workspace:${sha256Hex('/selected-working')}`],
      recoveryClass: 'managed-process-preactivation',
      classifierVersion: 'rfc328-managed-process-v1',
      transportPolicyVersion: 'rfc328-preactivation-v1',
    })
    await execution.effect.submit(
      request(execution, {
        onStarted: (receipt) => execution.recordTaskReceipt(receipt, 'node-run'),
      }),
    )
    expect(nativeRequest?.cmd).toBe(command)
    expect(nativeRequest?.env).toBe(environment)
    expect(nativeRequest?.stdin).toBe(material.stdin)
    expect(nativeRequest?.requireSpawnReceipt).toBe(true)
    expect(patches).toEqual([
      {
        nodeRunId: 'node-run',
        values: {
          pid: 719,
          spawnBinaryPath: 'selected-binary',
          spawnLaunchNonce: 'original-nonce',
        },
      },
    ])
    expect(execution.materialRef).toBe(binding.materialRef)
    expect(() => binding.bindExecution()).toThrow('agent-invocation-execution-already-bound')
  })

  test('System owner ACK preserves receiver and rejection; ownerless Smoke keeps both native flags absent', async () => {
    const failure = new Error('original owner ACK failed')
    const owner = {
      onSpawned(receipt: { pid: number | null; spawnedAt: number; spawnBinaryPath: string }) {
        expect(this).toBe(owner)
        expect(receipt).toEqual({ pid: 719, spawnedAt: 31, spawnBinaryPath: 'selected-binary' })
        throw failure
      },
    }
    const binding = makeBinding(plan(), {
      nativeStartOwner: owner,
      async runNative(input) {
        expect(input.requireSpawnReceipt).toBeUndefined()
        await input.onSpawned?.({ pid: 719, spawnedAt: 31, spawnBinaryPath: 'selected-binary' })
        throw new Error('receipt rejection did not propagate')
      },
    })
    const execution = binding.bindExecution()
    await expect(
      execution.effect.submit(request(execution, { onStarted: execution.acknowledgeOwner })),
    ).rejects.toBe(failure)
    const smoke = makeBinding(plan(), {
      cleanupReceiver: 'executor',
      async runNative(input) {
        expect(input).not.toHaveProperty('requireSpawnReceipt')
        expect(input).not.toHaveProperty('onSpawned')
        return {
          outcome: 'ok',
          exitCode: 0,
          pid: 719,
          rawStdout: '',
          stderrTail: '',
          durationMs: 1,
        }
      },
    }).bindExecution()
    expect((await smoke.effect.submit(request(smoke))).outcome).toBe('ok')
    await expect(
      smoke.recordTaskReceipt({ executionRef: smoke.executionRef, startedAt: 31 }, 'n'),
    ).rejects.toThrow('execution-task-receipt-participant-unavailable')
  })

  test('incompatible owner participant is rejected before native creation; read-only original resources stay empty', () => {
    const unselected = makeBinding(plan(), {
      workingDirectory: unavailable,
      runNative: unavailable,
    })
    expect(() =>
      unselected.bindExecution({
        taskEffect: Object.freeze({}) as NonNullable<AgentExecutionParticipants['taskEffect']>,
      }),
    ).toThrow('agent-execution-task-participant-unavailable')
    const reads: string[] = []
    const selected = makeBinding(plan(), {
      workingDirectory() {
        reads.push('cwd')
        return '/selected-read-only'
      },
    })
    const execution = selected.bindExecution(
      bindLocalAgentExecutionParticipants({
        persistence: {} as TaskExecutionEffectPersistence,
        nodeExecution: unavailable,
        readOnlyWorkspace() {
          reads.push('policy')
          return true
        },
      }),
    )
    expect(reads).toEqual(['cwd', 'policy'])
    expect(execution.projection?.describe().resourceKeys).toEqual([])
  })

  test('material cleanup keeps the original plan receiver, Promise and throw; Smoke forwards the original function', async () => {
    const failure = new Error('original cleanup')
    const material = plan()
    const promise = Promise.resolve()
    material.cleanup = function (this: AgentSpawnPlan) {
      expect(this).toBe(material)
      return promise
    }
    const binding = makeBinding(material)
    expect(binding.lifecycle.cleanup?.()).toBe(promise)
    const smoke = makeBinding(material, { cleanupReceiver: 'executor' })
    expect(smoke.lifecycle.cleanup).toBe(material.cleanup)
    material.cleanup = function (this: AgentSpawnPlan) {
      expect(this).toBe(material)
      throw failure
    }
    expect(() => binding.lifecycle.cleanup?.()).toThrow(failure)
    material.cleanup = undefined
    expect(binding.lifecycle.cleanup).toBeUndefined()
    expect(binding.lifecycle.beforeStart).toBeUndefined()
  })

  for (const kind of ['opencode', 'claude-code'] as const) {
    test(`${kind}: pure protocol matches the selected driver without reading physical or unsupported hooks`, () => {
      const driver = getRuntimeDriver(kind)
      const protocol = bindNativeAgentProtocol(driver)
      expect(protocol.kind).toBe(kind)
      expect(protocol.capabilities).toBe(driver.capabilities)
      for (const line of [
        '',
        '{}',
        'plain 中文',
        '{"type":"result","is_error":true,"result":"failed"}',
      ]) {
        expect(protocol.parseEvent(line)).toEqual(driver.parseEvent(line))
        expect(protocol.observeSystemEvent?.(line)).toEqual(driver.observeSystemEvent?.(line))
        expect(protocol.parseTerminalResultError?.(line)).toEqual(
          driver.parseTerminalResultError?.(line),
        )
      }
      expect(protocol.normalizeUsage).toBe(driver.normalizeUsage)
      expect(protocol).not.toHaveProperty('buildSpawn')
      expect(protocol).not.toHaveProperty('captureSessions')
    })
  }

  test('pure parser receiver and accessor failure stay at original consumption; no driver fallback occurs', () => {
    const failure = new Error('selected optional parser getter failed')
    const selected = {
      kind: 'claude-code',
      get capabilities() {
        throw failure
      },
      parseEvent(line: string) {
        expect(this).toBe(selected)
        expect(line).toBe('selected-line')
        throw failure
      },
      get observeSystemEvent() {
        throw failure
      },
      get buildSpawn() {
        throw new Error('physical driver read')
      },
    } as unknown as RuntimeDriver
    const protocol: AgentInvocationProtocol = bindNativeAgentProtocol(selected)
    expect(protocol.kind).toBe('claude-code')
    expect(() => protocol.parseEvent('selected-line')).toThrow(failure)
    expect(() => protocol.observeSystemEvent).toThrow(failure)
    expect(() => protocol.capabilities).toThrow(failure)
    expect(protocol.parseTerminalResultError).toBeUndefined()
    const material = plan()
    const binding = makeBinding(material, { protocol, workingDirectory: unavailable })
    expect(binding.protocol).toBe(protocol)
    expect(binding.declared).toBe(material.declared)
  })
})
