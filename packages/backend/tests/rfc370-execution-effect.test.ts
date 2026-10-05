// RFC-370 H4: the three agent lanes consume one neutral execution request.
// These regressions exercise the original native process mechanism through its
// new binding: task receipt-before-target, direct system receipt-after-target,
// ownerless smoke, byte-exact stdin/output, and unchanged native persistence.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExecutionEffectRequest,
  ExecutionEffectResult,
  ExecutionStartReceipt,
} from '../src/modules/task-execution/application/ports/executionEffect'
import type { NodeExecutionPersistence } from '../src/modules/task-execution/application/ports/nodeExecutionPersistence'
import type {
  TaskExecutionEffectPersistence,
  TaskEffectAttemptPreparation,
} from '../src/modules/task-execution/application/ports/taskExecutionEffectStore'
import { createProcessEffectAttemptObserver } from '../src/modules/task-execution/application/processEffectObserver'
import type { TaskExecutionContext } from '../src/modules/task-execution/application/taskExecutionContext'
import type { ProcessEffectProjection } from '../src/modules/task-execution/application/ports/processEffectProjection'
import { bindLocalAgentExecutionEffect } from '../src/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { requestHash } from '../src/modules/task-execution/domain/executionEffect'
import { sha256Hex } from '../src/modules/task-execution/domain/digest'
import type {
  AgentProcessRequest,
  AgentProcessResult,
} from '../src/platform/execution/local/agentProcess'
import { createLogger } from '../src/util/log'
import { createLocalAgentMaterialCompiler } from '../src/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import type { AgentMaterialIntent } from '../src/modules/runtime-management/application/ports/agentMaterial'
import { getNativeAgentMaterialReference } from '../src/services/runtime'
import { emptyDeclaredManifest } from '../src/services/execution/agentInjection'
import type { AgentSpawnPlan } from '../src/services/runtime/types'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function root() {
  const value = mkdtempSync(join(tmpdir(), 'aw-rfc370-execution-'))
  roots.push(value)
  return value
}
function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function waitForFile(directory: string, path: string) {
  let close: () => void = () => {}
  const promise = new Promise<void>((resolve, reject) => {
    const watcher = watch(directory, () => {
      if (existsSync(path)) {
        close()
        resolve()
      }
    })
    const timeout = setTimeout(() => {
      close()
      reject(new Error('native target did not start before receipt acknowledgement'))
    }, 10000)
    close = () => {
      watcher.close()
      clearTimeout(timeout)
    }
    if (existsSync(path)) {
      close()
      resolve()
    }
  })
  return { promise, close }
}
function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}
function request(
  binding: ReturnType<typeof bindLocalAgentExecutionEffect>,
  rest: Omit<ExecutionEffectRequest, 'executionRef' | 'materialRef' | 'workspaceRef'> = {},
): ExecutionEffectRequest {
  return {
    executionRef: binding.executionRef,
    materialRef: binding.materialRef,
    workspaceRef: binding.workspaceRef,
    ...rest,
  }
}
function nativeResult(rest: Partial<AgentProcessResult> = {}): AgentProcessResult {
  return {
    outcome: 'ok',
    exitCode: 0,
    pid: 731,
    launchNonce: 'original-native-nonce',
    rawStdout: 'original\n',
    stderrTail: 'stderr',
    durationMs: 17,
    ...rest,
  }
}

describe('RFC-370 selected native execution binding', () => {
  test('explicit logical resource resolution runs once at original effect acquisition and persists every selected resource', async () => {
    const preparations: TaskEffectAttemptPreparation[] = []
    let described = 0,
      resolved = 0
    const description = {
      requestHash: 'original-reference-hash',
      resourceKeys: ['selected-execution:run', 'selected-workspace:version'],
      recoveryClass: 'selected-reference-recovery',
      classifierVersion: 'selected-reference-classifier',
      transportPolicyVersion: 'selected-reference-transport',
    }
    const projection: ProcessEffectProjection<ExecutionStartReceipt, ExecutionEffectResult> = {
      describe() {
        described++
        return description
      },
      async recordSpawnReceipt() {},
      settlementReceipt(result) {
        return JSON.stringify(result)
      },
    }
    const persistence = {
      async readLineage() {
        return {
          executionLineageId: 'original-lineage',
          continuationSlotKey: 'original-slot',
          slotPathJson: 'legacy-row',
          workflowVersion: 7,
          nodeId: 'original-node',
          iteration: 2,
          retryIndex: 3,
          shardKey: 'original-shard',
        }
      },
      async nextOperationGeneration() {
        return 11
      },
      async prepareAndAcquire(input: TaskEffectAttemptPreparation) {
        preparations.push(input)
        return {
          effectId: 'original-effect',
          attemptId: 'original-attempt',
          attemptNo: 1,
          resourceKeys: input.resourceKeys,
        }
      },
    } satisfies Pick<
      TaskExecutionEffectPersistence,
      'readLineage' | 'nextOperationGeneration' | 'prepareAndAcquire'
    >
    const context = {
      intentId: 'original-intent',
      token: { taskId: 'original-task' },
    } as TaskExecutionContext
    const observer = createProcessEffectAttemptObserver({
      persistence: persistence as unknown as TaskExecutionEffectPersistence,
      context,
      taskId: 'original-task',
      nodeRunId: 'original-run',
      processKind: 'agent',
      projection,
      resourceKeys: (value) => {
        expect(value).toBe(description)
        resolved++
        return value.resourceKeys
      },
    })!
    expect(described).toBe(0)
    expect(resolved).toBe(0)
    expect(preparations).toEqual([])
    await observer.beforeSpawn()
    expect(described).toBe(1)
    expect(resolved).toBe(1)
    expect(preparations).toHaveLength(1)
    expect(preparations[0]).toMatchObject({
      intentId: 'original-intent',
      executionLineageId: 'original-lineage',
      operationGeneration: 11,
      requestHash: description.requestHash,
      recoveryClass: description.recoveryClass,
      classifierVersion: description.classifierVersion,
      transportPolicyVersion: description.transportPolicyVersion,
      resourceKeys: ['process:original-task:original-run', ...description.resourceKeys],
    })
    expect(description.resourceKeys).toEqual([
      'selected-execution:run',
      'selected-workspace:version',
    ])
  })

  test('execution consumes the material reference from the actual single compilation, including a derived system plan', async () => {
    let builds = 0
    const plan: AgentSpawnPlan = Object.freeze({
      // This immutable fixture keeps the original array identity; the legacy
      // native plan's mutable annotation is not a change to runtime behavior.
      cmd: Object.freeze(['selected-native']) as AgentSpawnPlan['cmd'],
      env: { SELECTED: 'original' },
      declared: emptyDeclaredManifest(),
    })
    const unavailable = () => {
      throw new Error('unselected material content read')
    }
    const selected = createLocalAgentMaterialCompiler({
      protocol: 'opencode',
      contents: {
        workspace: () => '/selected-workspace',
        runContent: () => '/selected-run',
        runtimeBinary: unavailable,
        skill: unavailable,
        plugin: unavailable,
      },
      evidenceCapabilities: {
        usageNormalizer: false,
        nativeUsageCapture: false,
        spanCapture: false,
        sessionCapture: false,
        inventory: false,
        finalEvents: false,
        liveCapture: false,
        sessionSinkCapture: false,
      },
      buildNative: async () => {
        builds++
        return plan
      },
    })
    const intent: AgentMaterialIntent = {
      protocol: 'opencode',
      injection: { mcps: [] },
      prompt: 'original prompt',
      agentName: 'root',
      systemPrompt: 'original system prompt',
      resolvedProfiles: [],
      workspace: { owner: 'source-control', reference: 'workspace', version: null },
      runContent: { owner: 'runtime-management', reference: 'run', version: null },
      freshAgentRun: false,
      nodeRunId: 'run',
      log: createLogger('rfc370-reference'),
    }
    const material = await selected.compiler.compile(intent)
    const native = selected.nativePlan(material.materialRef)
    expect(native).toBe(plan)
    expect(getNativeAgentMaterialReference(native)).toBe(material.materialRef)
    const composed = { ...native, cleanup: () => {} }
    expect(getNativeAgentMaterialReference(composed, native)).toBe(material.materialRef)
    expect(getNativeAgentMaterialReference(composed)).toBe(material.materialRef)
    expect(getNativeAgentMaterialReference({ ...native })).not.toBe(material.materialRef)
    expect(builds).toBe(1)
  })

  test('selected physical getters, optional fields and capture ACK callbacks reach the single native mechanism unchanged', async () => {
    const events: string[] = []
    const stdin = { mode: 'pipe' as const, data: 'original\ninput\r\n' }
    const env = { SELECTED: 'environment' }
    const command = Object.freeze(['selected-native', '--exact-arg'])
    const signal = new AbortController().signal
    const beforeStart = () => {
      events.push('before')
    }
    const cleanup = () => {
      events.push('cleanup')
    }
    const capture = {
      onStdoutLine: async () => {},
      onStdoutChunkEnd: async () => {},
      rawStdout: true,
    }
    const original = nativeResult({
      cleanupFailed: true,
      drainTimedOut: false,
      pumpError: 'first original reason',
    })
    let nativeRequest: AgentProcessRequest | undefined
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'selected-material',
      command: () => {
        events.push('command')
        return command
      },
      workingDirectory: () => {
        events.push('workspace')
        return '/selected-workspace'
      },
      environment: () => {
        events.push('environment')
        return env
      },
      stdin: () => {
        events.push('stdin')
        return stdin
      },
      requireSpawnReceipt: true,
      runNative: async (input) => {
        nativeRequest = input
        return original
      },
    })
    expect(events).toEqual([])
    const result = await selected.effect.submit(
      request(selected, {
        timeoutMs: 29,
        termGraceMs: 13,
        abortSignal: signal,
        beforeStart,
        capture,
        cleanup,
      }),
    )
    expect(events).toEqual(['command', 'workspace', 'environment', 'stdin', 'stdin'])
    expect(nativeRequest).toEqual({
      cmd: command,
      cwd: '/selected-workspace',
      env,
      timeoutMs: 29,
      termGraceMs: 13,
      abortSignal: signal,
      stdin,
      beforeSpawn: beforeStart,
      requireSpawnReceipt: true,
      capture,
      cleanup,
    })
    expect(nativeRequest!.cmd).toBe(command)
    expect(nativeRequest!.env).toBe(env)
    expect(nativeRequest!.capture).toBe(capture)
    expect(nativeRequest!.beforeSpawn).toBe(beforeStart)
    expect(nativeRequest!.cleanup).toBe(cleanup)
    expect(result).toEqual({
      executionRef: selected.executionRef,
      outcome: 'ok',
      exitCode: 0,
      rawStdout: original.rawStdout,
      stderrTail: original.stderrTail,
      durationMs: 17,
      cleanupFailed: true,
      drainTimedOut: false,
      pumpError: 'first original reason',
    })
    expect(result).not.toHaveProperty('pid')
    expect(result).not.toHaveProperty('launchNonce')
    expect(result).not.toHaveProperty('spawnBinaryPath')
  })

  test('mismatched references never resolve physical material, and one selected attempt cannot submit twice', async () => {
    let reads = 0,
      runs = 0
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'material',
      command: () => {
        reads++
        return ['native']
      },
      workingDirectory: () => '/',
      environment: () => ({}),
      stdin: () => undefined,
      runNative: async () => {
        runs++
        return nativeResult()
      },
    })
    for (const key of ['executionRef', 'materialRef', 'workspaceRef'] as const) {
      await expect(
        selected.effect.submit({ ...request(selected), [key]: 'unavailable' }),
      ).rejects.toThrow('execution-binding-reference-unavailable')
    }
    expect(reads).toBe(0)
    expect(runs).toBe(0)
    await selected.effect.submit(request(selected))
    await expect(selected.effect.submit(request(selected))).rejects.toThrow(
      'execution-binding-already-submitted',
    )
    expect(reads).toBe(1)
    expect(runs).toBe(1)
  })

  test('opaque start receipt keeps the original Task PID/nonce projection, v1 fingerprint and reaped receipt', async () => {
    const spawns: Parameters<TaskExecutionEffectPersistence['recordProcessSpawn']>[0][] = []
    const patches: Parameters<NodeExecutionPersistence['patch']>[0][] = []
    const effects = {
      async recordProcessSpawn(
        input: Parameters<TaskExecutionEffectPersistence['recordProcessSpawn']>[0],
      ) {
        spawns.push(input)
      },
    } satisfies Pick<TaskExecutionEffectPersistence, 'recordProcessSpawn'>
    const nodeExecution = {
      async patch(input: Parameters<NodeExecutionPersistence['patch']>[0]) {
        patches.push(input)
        return true
      },
    } satisfies Pick<NodeExecutionPersistence, 'patch'>
    const originalReceipt = {
      pid: 731,
      spawnedAt: 53,
      spawnBinaryPath: '/selected-native',
      launchNonce: 'original-native-nonce',
    }
    const original = nativeResult({
      outcome: 'aborted',
      exitCode: null,
      drainTimedOut: true,
      pumpError: 'first reason',
    })
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'material',
      command: () => ['native', '--original'],
      workingDirectory: () => '/workspace',
      environment: () => ({}),
      stdin: () => undefined,
      taskEffect: {
        persistence: effects as unknown as TaskExecutionEffectPersistence,
        nodeExecution: () => nodeExecution as unknown as NodeExecutionPersistence,
        argv: ['native', '--original'],
        cwd: '/workspace',
        resourceKeys: { writerWorkspace: '/workspace' },
      },
      runNative: async (input) => {
        await input.onSpawned!(originalReceipt)
        return original
      },
    })
    const facts = selected.projection!.describe()
    expect(facts).toEqual({
      requestHash: requestHash({
        v: 1,
        processKind: 'agent',
        argv: ['native', '--original'],
        cwd: '/workspace',
      }),
      resourceKeys: [`workspace:${sha256Hex('/workspace')}`],
      recoveryClass: 'managed-process-preactivation',
      classifierVersion: 'rfc328-managed-process-v1',
      transportPolicyVersion: 'rfc328-preactivation-v1',
    })
    let receipt: ExecutionStartReceipt | undefined
    const result = await selected.effect.submit(
      request(selected, {
        onStarted: (value) => {
          receipt = value
        },
      }),
    )
    expect(receipt).toEqual({ executionRef: selected.executionRef, startedAt: 53 })
    await selected.recordLegacyTaskReceipt(receipt!, 'run')
    expect(patches).toEqual([
      {
        nodeRunId: 'run',
        values: {
          pid: 731,
          spawnBinaryPath: '/selected-native',
          spawnLaunchNonce: 'original-native-nonce',
        },
      },
    ])
    const token = { taskId: 'task' } as Parameters<
      TaskExecutionEffectPersistence['recordProcessSpawn']
    >[0]['token']
    await selected.projection!.recordSpawnReceipt({
      receipt: receipt!,
      token,
      effectId: 'effect',
      attemptId: 'attempt',
      nodeRunId: 'run',
      runtimeParamsJson: 'original-profile',
      now: 67,
    })
    expect(spawns).toEqual([
      {
        token,
        effectId: 'effect',
        attemptId: 'attempt',
        nodeRunId: 'run',
        runtimeParamsJson: 'original-profile',
        now: 67,
        pid: 731,
        spawnBinaryPath: '/selected-native',
        launchNonce: 'original-native-nonce',
      },
    ])
    expect(selected.projection!.settlementReceipt(result)).toBe(
      JSON.stringify({
        v: 1,
        phase: 'reaped',
        outcome: original.outcome,
        exitCode: original.exitCode,
        pid: original.pid,
        launchNonce: original.launchNonce,
        drainTimedOut: true,
        pumpError: 'first reason',
      }),
    )
  })

  test('native system owner retains its receiver and original three-field receipt', async () => {
    let receipt: ExecutionStartReceipt | undefined
    const seen: unknown[] = []
    const owner = {
      onSpawned(value: { pid: number | null; spawnedAt: number; spawnBinaryPath: string }) {
        expect(this).toBe(owner)
        seen.push(value)
      },
    }
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'material',
      command: () => ['native'],
      workingDirectory: () => '/',
      environment: () => ({}),
      stdin: () => undefined,
      nativeStartOwner: owner,
      runNative: async (input) => {
        await input.onSpawned!({
          pid: 731,
          spawnedAt: 53,
          spawnBinaryPath: '/native',
          launchNonce: 'must-stay-native',
        })
        return nativeResult()
      },
    })
    await selected.effect.submit(
      request(selected, {
        onStarted: async (value) => {
          receipt = value
          await selected.acknowledgeNativeOwner(value)
        },
      }),
    )
    expect(receipt).toEqual({ executionRef: selected.executionRef, startedAt: 53 })
    expect(seen).toEqual([{ pid: 731, spawnedAt: 53, spawnBinaryPath: '/native' }])
  })

  test('real Task target and stdin remain held until opaque receipt acknowledgement, then capture is byte exact', async () => {
    const workspace = root(),
      marker = join(workspace, 'target-started')
    const entered = deferred(),
      allowReceipt = deferred()
    const payload = 'first line\r\n第二行\n'
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'task-material',
      command: () => [
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(marker)}, 'started'); process.stdout.write(await Bun.stdin.text())`,
      ],
      workingDirectory: () => workspace,
      environment,
      stdin: () => ({ mode: 'pipe', data: payload }),
      requireSpawnReceipt: true,
    })
    let resultPromise: Promise<ExecutionEffectResult> | undefined
    try {
      resultPromise = selected.effect.submit(
        request(selected, {
          timeoutMs: 20000,
          termGraceMs: 100,
          capture: { rawStdout: true },
          onStarted: async (receipt) => {
            expect(receipt).not.toHaveProperty('pid')
            entered.resolve()
            await allowReceipt.promise
          },
        }),
      )
      await entered.promise
      expect(existsSync(marker)).toBe(false)
    } finally {
      allowReceipt.resolve()
    }
    const result = await resultPromise!
    expect(result.outcome).toBe('ok')
    expect(readFileSync(marker, 'utf8')).toBe('started')
    expect(result.rawStdout).toBe(payload)
  }, 30000)

  test('real Task receipt rejection never activates target or reads output', async () => {
    const workspace = root(),
      marker = join(workspace, 'must-not-start')
    const lines: string[] = []
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'task-material',
      command: () => [
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(marker)}, 'bad'); process.stdout.write(await Bun.stdin.text())`,
      ],
      workingDirectory: () => workspace,
      environment,
      stdin: () => ({ mode: 'pipe', data: 'must-not-deliver' }),
      requireSpawnReceipt: true,
    })
    const result = await selected.effect.submit(
      request(selected, {
        timeoutMs: 20000,
        termGraceMs: 100,
        onStarted: () => {
          throw new Error('original-receipt-db-failed')
        },
        capture: {
          rawStdout: true,
          onStdoutLine: (line) => {
            lines.push(line)
          },
        },
      }),
    )
    expect(result.outcome).toBe('spawn-failed')
    expect(result.spawnError).toContain('original-receipt-db-failed')
    expect(existsSync(marker)).toBe(false)
    expect(lines).toEqual([])
    expect(result.rawStdout).toBe('')
  }, 30000)

  test('real direct system target exists before receipt ACK, with stdin and output pumping still held', async () => {
    const workspace = root(),
      started = join(workspace, 'started'),
      stdinRead = join(workspace, 'stdin-read')
    const activated = waitForFile(workspace, started),
      entered = deferred(),
      allowReceipt = deferred()
    const lines: string[] = []
    const owner = {
      async onSpawned(receipt: { pid: number | null; spawnedAt: number; spawnBinaryPath: string }) {
        expect(this).toBe(owner)
        expect(receipt.pid).toBeGreaterThan(0)
        expect(Object.keys(receipt).sort()).toEqual(['pid', 'spawnBinaryPath', 'spawnedAt'])
        entered.resolve()
        await allowReceipt.promise
      },
    }
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'system-material',
      command: () => [
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(started)}, 'started'); process.stdout.write('before-ack\\n'); const input = await Bun.stdin.text(); await Bun.write(${JSON.stringify(stdinRead)}, input); process.stdout.write(input)`,
      ],
      workingDirectory: () => workspace,
      environment,
      stdin: () => ({ mode: 'pipe', data: 'after-ack\n' }),
      nativeStartOwner: owner,
    })
    let resultPromise: Promise<ExecutionEffectResult> | undefined
    try {
      resultPromise = selected.effect.submit(
        request(selected, {
          timeoutMs: 20000,
          onStarted: async (receipt) => {
            await selected.acknowledgeNativeOwner(receipt)
          },
          capture: {
            rawStdout: true,
            onStdoutLine: (line) => {
              lines.push(line)
            },
          },
        }),
      )
      await entered.promise
      await activated.promise
      expect(readFileSync(started, 'utf8')).toBe('started')
      expect(existsSync(stdinRead)).toBe(false)
      expect(lines).toEqual([])
    } finally {
      activated.close()
      allowReceipt.resolve()
    }
    const result = await resultPromise!
    expect(result.outcome).toBe('ok')
    expect(readFileSync(stdinRead, 'utf8')).toBe('after-ack\n')
    expect(lines).toEqual(['before-ack', 'after-ack'])
    expect(result.rawStdout).toBe('before-ack\nafter-ack\n')
  }, 30000)

  test('real direct owner receipt rejection keeps output held until rejection and preserves the original abort drain', async () => {
    const workspace = root(),
      started = join(workspace, 'started'),
      stdinRead = join(workspace, 'stdin-read')
    const activated = waitForFile(workspace, started)
    const lines: string[] = []
    let receiptRejected = false
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'system-material',
      command: () => [
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(started)}, 'started'); process.stdout.write('buffered\\n'); await Bun.write(${JSON.stringify(stdinRead)}, await Bun.stdin.text())`,
      ],
      workingDirectory: () => workspace,
      environment,
      stdin: () => ({ mode: 'pipe', data: 'must-not-deliver' }),
    })
    let result: ExecutionEffectResult
    try {
      result = await selected.effect.submit(
        request(selected, {
          timeoutMs: 20000,
          termGraceMs: 100,
          onStarted: async () => {
            await activated.promise
            expect(lines).toEqual([])
            expect(existsSync(stdinRead)).toBe(false)
            // The original direct process already exists. Once the owner
            // callback rejects, its abort/reap path may drain buffered output;
            // no successful result or pre-rejection consumption is permitted.
            receiptRejected = true
            throw new Error('original-owner-no-longer-deliverable')
          },
          capture: {
            rawStdout: true,
            onStdoutLine: (line) => {
              expect(receiptRejected).toBe(true)
              lines.push(line)
            },
          },
        }),
      )
    } finally {
      activated.close()
    }
    expect(result.outcome).toBe('aborted')
    expect(readFileSync(started, 'utf8')).toBe('started')
    expect(existsSync(stdinRead)).toBe(false)
    expect(receiptRejected).toBe(true)
    expect(result.pumpError).toBeUndefined()
    expect(lines.every((line) => line === 'buffered')).toBe(true)
    expect(result.rawStdout).toBe(lines.map((line) => `${line}\n`).join(''))
  }, 30000)

  test('native unreaped identity stays in original diagnostics while the neutral result remains opaque', async () => {
    const calls: unknown[][] = []
    const log = {
      ...createLogger('rfc370-unreaped'),
      error: (...args: unknown[]) => {
        calls.push(args)
      },
    }
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'material',
      command: () => ['native'],
      workingDirectory: () => '/',
      environment: () => ({}),
      stdin: () => undefined,
      runNative: async () => nativeResult({ outcome: 'unreaped', exitCode: null }),
    })
    const result = await selected.effect.submit(request(selected))
    selected.reportUnreaped(result, { nodeRunId: 'run', deadlineMs: 67, log })
    expect(calls).toEqual([
      [
        'child survived SIGKILL escalation past reap deadline; abandoning',
        { nodeRunId: 'run', pid: 731, deadlineMs: 67 },
      ],
    ])
    expect(selected.unreapedMessage(result, 67)).toBe(
      'child-unkillable: pid 731 survived SIGTERM→SIGKILL escalation past 67ms; abandoned (detached process group left running)',
    )
    expect(result).not.toHaveProperty('pid')
  })

  test('real ownerless smoke remains direct and preserves stdin, stream and cleanup ordering', async () => {
    const workspace = root(),
      marker = join(workspace, 'finished')
    const order: string[] = []
    const payload = 'ownerless\n'
    const selected = bindLocalAgentExecutionEffect({
      materialRef: 'smoke-material',
      command: () => [
        process.execPath,
        '-e',
        `process.stdout.write(await Bun.stdin.text()); await Bun.write(${JSON.stringify(marker)}, 'finished')`,
      ],
      workingDirectory: () => workspace,
      environment,
      stdin: () => ({ mode: 'pipe', data: payload }),
    })
    const result = await selected.effect.submit(
      request(selected, {
        timeoutMs: 20000,
        beforeStart: () => {
          order.push('before')
        },
        capture: {
          rawStdout: true,
          onStdoutLine: (line) => {
            order.push(line)
          },
        },
        cleanup: () => {
          expect(readFileSync(marker, 'utf8')).toBe('finished')
          order.push('cleanup')
        },
      }),
    )
    expect(result.outcome).toBe('ok')
    expect(result.rawStdout).toBe(payload)
    expect(order).toEqual(['before', 'ownerless', 'cleanup'])
  }, 30000)
})
