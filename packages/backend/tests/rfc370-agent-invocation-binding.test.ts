import { describe, expect, test } from 'bun:test'
import { bindNativeAgentInvocation } from '../src/modules/task-execution/composition/agentInvocation'
import { bindNativeAgentProtocol } from '../src/modules/runtime-management/infrastructure/local/agentProtocol'
import { bindNativeAgentMaterialReference } from '../src/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import type { AgentInvocationProtocol } from '../src/modules/runtime-management/application/ports/agentProtocol'
import type { AgentMaterialWorkspace } from '../src/modules/runtime-management/application/ports/agentMaterialWorkspace'
import type { NativeAgentMaterialEvidenceHooks } from '../src/modules/runtime-management/infrastructure/local/agentMaterialEvidence'
import type { AgentExecutionParticipants } from '../src/modules/task-execution/application/ports/agentExecutionBinding'
import type {
  AgentExecutionRecord,
  AgentExecutionSink,
} from '../src/modules/task-execution/application/ports/agentExecution'
import type { TaskExecutionEffectPersistence } from '../src/modules/task-execution/application/ports/taskExecutionEffectStore'
import type { NodeExecutionPersistence } from '../src/modules/task-execution/application/ports/nodeExecutionPersistence'
import {
  bindLocalAgentExecutionEffect,
  bindLocalAgentExecutionParticipants,
} from '../src/modules/task-execution/infrastructure/local/agentExecutionEffect'
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
function quietSink(): AgentExecutionSink {
  return { record: async () => {}, diagnostic: async () => {}, checkpoint: async () => {} }
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
    const meter = {
      observe: () => false,
      snapshot: () => ({ state: 'partial' as const, models: [] }),
    }
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      usageMeter(input) {
        expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
        expect(input.env).toBe(changedEnv)
        return meter
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
    expect(binding.evidence.prepareUsageMeter?.({ resumed: false, configuredModel: null })).toBe(
      meter,
    )
    const participants: AgentExecutionParticipants = bindLocalAgentExecutionParticipants({
      persistence,
      nodeExecution: () => nodeExecution,
      readOnlyWorkspace() {
        reads.push('policy')
        return false
      },
    })
    const outcome = await binding.execute(
      { task: { participants, taskId: 'task', nodeRunId: 'node-run' } },
      quietSink(),
    )
    // The effect fingerprint reads cwd / policy / cwd, then the child spawns there.
    expect(reads).toEqual(['cwd', 'policy', 'cwd', 'cwd'])
    expect(outcome.result).toBe('ok')
    expect(nativeRequest?.cmd).toBe(command)
    expect(nativeRequest?.env).toBe(environment)
    expect(nativeRequest?.stdin).toBe(material.stdin)
    expect(nativeRequest?.requireSpawnReceipt).toBe(true)
    // Without a durable task execution context the receipt patches the node run.
    expect(patches).toEqual([
      {
        nodeRunId: 'node-run',
        values: {
          runtime: {
            pid: 719,
            spawnBinaryPath: 'selected-binary',
            spawnLaunchNonce: 'original-nonce',
          },
        },
      },
    ])
    await expect(binding.execute({}, quietSink())).rejects.toThrow(
      'agent-invocation-execution-already-bound',
    )
  })

  test('the local effect keeps the original fingerprint and writer resources (read-only stays empty)', () => {
    const effect = (readOnly: boolean) =>
      bindLocalAgentExecutionEffect({
        materialRef: 'material',
        command: () => ['selected-binary', 'original'],
        workingDirectory: () => '/selected-working',
        environment: () => ({}),
        stdin: () => undefined,
        taskEffect: {
          persistence: {} as TaskExecutionEffectPersistence,
          nodeExecution: unavailable,
          argv: ['selected-binary', 'original'],
          cwd: '/selected-working',
          resourceKeys: readOnly ? [] : { writerWorkspace: '/selected-working' },
        },
      })
    expect(effect(false).projection?.describe()).toEqual({
      requestHash: requestHash({
        v: 1,
        processKind: 'agent',
        argv: ['selected-binary', 'original'],
        cwd: '/selected-working',
      }),
      resourceKeys: [`workspace:${sha256Hex('/selected-working')}`],
      recoveryClass: 'managed-process-preactivation',
      classifierVersion: 'rfc328-managed-process-v1',
      transportPolicyVersion: 'rfc328-preactivation-v1',
    })
    expect(effect(true).projection?.describe().resourceKeys).toEqual([])
  })

  test('records are interpreted through the selected protocol and delivered in order with checkpoints', async () => {
    const driver = getRuntimeDriver('claude-code')
    const resultError = '{"type":"result","subtype":"error","is_error":true,"result":"denied"}'
    const binding = makeBinding(plan(), {
      protocol: bindNativeAgentProtocol(driver),
      async runNative(input) {
        await input.capture?.onStdoutLine?.('plain 中文')
        await input.capture?.onStdoutLine?.(resultError)
        await input.capture?.onStdoutChunkEnd?.()
        await input.capture?.onStderrLine?.('warn')
        await input.capture?.onStderrChunkEnd?.()
        return { outcome: 'ok', exitCode: 0, pid: 1, rawStdout: '', stderrTail: '', durationMs: 1 }
      },
    })
    const seen: Array<string | AgentExecutionRecord> = []
    await binding.execute(
      {},
      {
        record: async (record) => {
          seen.push(record)
        },
        diagnostic: async (line) => {
          seen.push(`diagnostic:${line}`)
        },
        checkpoint: async (stream) => {
          seen.push(`checkpoint:${stream}`)
        },
      },
    )
    expect(seen).toEqual([
      {
        raw: 'plain 中文',
        event: driver.parseEvent('plain 中文'),
        ...(driver.observeSystemEvent === undefined
          ? {}
          : { observation: driver.observeSystemEvent('plain 中文') }),
      },
      {
        raw: resultError,
        event: driver.parseEvent(resultError),
        ...(driver.observeSystemEvent === undefined
          ? {}
          : { observation: driver.observeSystemEvent(resultError) }),
        terminalError: driver.parseTerminalResultError!(resultError)!,
      },
      'checkpoint:records',
      'diagnostic:warn',
      'checkpoint:diagnostics',
    ])
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
    await expect(binding.execute({ acknowledgeStart: true }, quietSink())).rejects.toBe(failure)
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
    })
    expect((await smoke.execute({}, quietSink())).result).toBe('ok')
  })

  test('an incompatible owner participant is rejected before native creation', async () => {
    const unselected = makeBinding(plan(), {
      workingDirectory: unavailable,
      runNative: unavailable,
    })
    await expect(
      unselected.execute(
        {
          task: {
            participants: {
              taskEffect: Object.freeze({}) as NonNullable<
                AgentExecutionParticipants['taskEffect']
              >,
            },
            taskId: 'task',
            nodeRunId: 'node-run',
          },
        },
        quietSink(),
      ),
    ).rejects.toThrow('agent-execution-task-participant-unavailable')
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
      // RFC-371 v2: the stream-only meter delegates to the same driver.
      expect(protocol.usageMeter === undefined).toBe(driver.usageMeter === undefined)
      const meter = protocol.usageMeter?.({ resumed: false, configuredModel: null })
      expect(meter?.snapshot()).toEqual(
        driver.usageMeter?.({ resumed: false, configuredModel: null }).snapshot(),
      )
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
