// RFC-370 H4: preserve the existing process-effect identity/activation receipt,
// while permitting an execution participant whose receipt is not a local PID.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessEffectAttemptObserver as createObserver } from '@/modules/task-execution/application/processEffectObserver'
import type {
  ProcessEffectProjection,
  ProcessEffectSpawnIdentity,
} from '@/modules/task-execution/application/ports/processEffectProjection'
import type {
  TaskExecutionEffectPersistence,
  TaskEffectAttemptPreparation,
  TaskEffectAttemptSettlement,
} from '@/modules/task-execution/application/ports/taskExecutionEffectStore'
import type { TaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createProcessEffectAttemptObserver as createLocalObserver } from '@/modules/task-execution/composition/processEffectObserver'
import { requestHash } from '@/modules/task-execution/domain/executionEffect'
import { sha256Hex } from '@/modules/task-execution/domain/digest'
import {
  createLocalProcessEffectProjection,
  type LocalProcessSettlement,
  type LocalProcessResources,
} from '@/modules/task-execution/infrastructure/local/processEffectProjection'
import { runAgentProcess } from '@/services/execution/agentProcess'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  const preparations: TaskEffectAttemptPreparation[] = []
  const settlements: TaskEffectAttemptSettlement[] = []
  const spawns: Parameters<TaskExecutionEffectPersistence['recordProcessSpawn']>[0][] = []
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
    async settle(input: TaskEffectAttemptSettlement) {
      settlements.push(input)
    },
    async recordProcessSpawn(
      input: Parameters<TaskExecutionEffectPersistence['recordProcessSpawn']>[0],
    ) {
      spawns.push(input)
    },
  } satisfies Pick<
    TaskExecutionEffectPersistence,
    | 'readLineage'
    | 'nextOperationGeneration'
    | 'prepareAndAcquire'
    | 'settle'
    | 'recordProcessSpawn'
  >
  // The coordinator only forwards this fixture's context to the selected
  // persistence participant. Actual provider/context admission is unchanged
  // and covered by RFC-359's existing dual-provider conformance suite.
  const context = {
    intentId: 'original-intent',
    token: { taskId: 'original-task' },
  } as TaskExecutionContext
  return {
    persistence: persistence as TaskExecutionEffectPersistence,
    context,
    preparations,
    settlements,
    spawns,
  }
}

type ReferenceReceipt = Readonly<{ executionRef: string }>
type ReferenceResult = Readonly<{ outcome: string; executionRef: string }>

function referenceProjection(
  recorded: ProcessEffectSpawnIdentity<ReferenceReceipt>[],
): ProcessEffectProjection<ReferenceReceipt, ReferenceResult> {
  return {
    describe() {
      return {
        requestHash: 'frozen-reference-request',
        resourceKeys: ['selected-execution:original-slot'],
        recoveryClass: 'fixture-execution-reference',
        classifierVersion: 'fixture-reference-v1',
        transportPolicyVersion: 'fixture-submit-v1',
      }
    },
    async recordSpawnReceipt(input) {
      recorded.push(input)
    },
    settlementReceipt(result) {
      return JSON.stringify({ executionRef: result.executionRef, outcome: result.outcome })
    },
  }
}

describe('RFC-370 selected process-effect projection', () => {
  test('reference-only participant keeps AW lineage/generation and never writes a PID receipt', async () => {
    const f = fixture()
    const recorded: ProcessEffectSpawnIdentity<ReferenceReceipt>[] = []
    const observer = createObserver({
      ...f,
      taskId: 'original-task',
      nodeRunId: 'original-run',
      processKind: 'agent',
      projection: referenceProjection(recorded),
    })!
    const receipt = { executionRef: 'fixture-execution-id' }
    await expect(observer.recordSpawnReceipt(receipt)).rejects.toThrow(
      'preceded effect preparation',
    )
    await observer.settle({ outcome: 'ok', executionRef: receipt.executionRef })
    expect(recorded).toEqual([])
    expect(f.settlements).toEqual([])
    await observer.beforeSpawn()
    await observer.recordSpawnReceipt(receipt, 'frozen-profile')
    await observer.settle({ outcome: 'ok', executionRef: receipt.executionRef })
    expect(f.preparations[0]).toMatchObject({
      token: f.context.token,
      intentId: 'original-intent',
      operationKey: 'original-slot:process:agent',
      executionLineageId: 'original-lineage',
      operationGeneration: 11,
      kind: 'process',
      requestHash: 'frozen-reference-request',
      candidateId: 'agent:original-run',
      recoveryClass: 'fixture-execution-reference',
      classifierVersion: 'fixture-reference-v1',
      transportPolicyVersion: 'fixture-submit-v1',
      retryAuthority: 'none',
      resourceKeys: ['process:original-task:original-run', 'selected-execution:original-slot'],
    })
    expect(recorded[0]).toMatchObject({
      token: f.context.token,
      effectId: 'original-effect',
      attemptId: 'original-attempt',
      nodeRunId: 'original-run',
      receipt,
      runtimeParamsJson: 'frozen-profile',
    })
    expect(recorded[0]?.receipt).toBe(receipt)
    expect(f.spawns).toEqual([])
    expect(f.settlements[0]).toMatchObject({
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
      failureCode: null,
      receiptJson: '{"executionRef":"fixture-execution-id","outcome":"ok"}',
    })
    await expect(observer.beforeSpawn()).rejects.toThrow('prepared twice')
  })

  test.each([
    ['ok', 'succeeded', 'applied', null],
    ['nonzero-exit', 'succeeded', 'applied', null],
    ['timeout', 'succeeded', 'applied', null],
    ['aborted', 'succeeded', 'applied', null],
    ['spawn-failed', 'failed-not-applied', 'definitely-not-applied', 'process-not-activated'],
    ['unreaped', 'recovery-required', 'ambiguous', 'process-child-unkillable'],
    ['child-unkillable', 'recovery-required', 'ambiguous', 'process-child-unkillable'],
  ])(
    'outcome %s retains application settlement %s',
    async (outcome, state, applicationEvidence, failureCode) => {
      const f = fixture()
      const observer = createObserver({
        ...f,
        taskId: 'original-task',
        nodeRunId: 'original-run',
        processKind: 'script',
        projection: referenceProjection([]),
      })!
      await observer.beforeSpawn()
      await observer.settle({ outcome: outcome!, executionRef: 'fixture-execution-id' })
      expect(f.settlements[0]).toMatchObject({
        state,
        applicationEvidence,
        failureCode,
        retryAuthority: 'none',
      })
    },
  )

  test('selected participant receiver, held receipt ACK and original rejection survive delegation', async () => {
    const f = fixture()
    const entered = deferred()
    const release = deferred()
    const projection = referenceProjection([])
    const expectedReceiver = projection
    const originalError = new Error('original-receipt-error')
    projection.recordSpawnReceipt = async function () {
      expect(this).toBe(expectedReceiver)
      entered.resolve()
      await release.promise
      throw originalError
    }
    const observer = createObserver({
      ...f,
      taskId: 'original-task',
      nodeRunId: 'original-run',
      processKind: 'agent',
      projection,
    })!
    await observer.beforeSpawn()
    let acknowledged = false
    const pending = observer
      .recordSpawnReceipt({ executionRef: 'fixture-execution-id' })
      .then(() => {
        acknowledged = true
      })
    const rejected = expect(pending).rejects.toBe(originalError)
    await entered.promise
    expect(acknowledged).toBe(false)
    expect(f.settlements).toEqual([])
    release.resolve()
    await rejected
    expect(acknowledged).toBe(false)
  })

  test('missing lineage keeps the original preparation failure without selecting local execution', async () => {
    const f = fixture()
    f.persistence.readLineage = async () => null
    const observer = createObserver({
      ...f,
      taskId: 'original-task',
      nodeRunId: 'original-run',
      processKind: 'agent',
      projection: referenceProjection([]),
    })!
    await expect(observer.beforeSpawn()).rejects.toMatchObject({ code: 'task-continuation-stale' })
    expect(f.preparations).toEqual([])
    expect(f.spawns).toEqual([])
  })
})

describe('RFC-370 local receipt compatibility', () => {
  const getterCases: Array<{
    name: string
    first: LocalProcessResources | undefined
    expected: readonly string[]
  }> = [
    { name: 'legacy array', first: ['workspace:original-a'], expected: ['workspace:original-a'] },
    {
      name: 'writer intent',
      first: { writerWorkspace: '/original/workspace' },
      expected: [`workspace:${sha256Hex('/original/workspace')}`],
    },
    { name: 'omitted resources', first: undefined, expected: [] },
  ]
  test.each(getterCases)(
    '$name getter is read once, after the original fingerprint inputs',
    ({ first, expected }) => {
      const f = fixture()
      const input = {
        persistence: f.persistence,
        processKind: 'agent' as const,
        argv: ['original-binary'],
        cwd: '/original/workspace',
      }
      const reads: string[] = []
      let resourceReads = 0
      Object.defineProperties(input, {
        argv: {
          get() {
            reads.push('argv')
            return ['original-binary']
          },
        },
        cwd: {
          get() {
            reads.push('cwd')
            return '/original/workspace'
          },
        },
        resourceKeys: {
          get() {
            expect(this).toBe(input)
            reads.push('resources')
            return ++resourceReads === 1 ? first : undefined
          },
        },
      })
      const description = createLocalProcessEffectProjection(input).describe()
      expect(description.resourceKeys).toEqual(expected)
      expect(description.requestHash).toBe(
        requestHash({
          v: 1,
          processKind: 'agent',
          argv: ['original-binary'],
          cwd: '/original/workspace',
        }),
      )
      expect(resourceReads).toBe(1)
      expect(reads).toEqual(['argv', 'cwd', 'resources'])
    },
  )

  const processKinds: ('agent' | 'script')[] = ['agent', 'script']
  test('legacy array entries remain the resources even when the array carries a writerWorkspace property', () => {
    const f = fixture()
    const resourceKeys = Object.assign(['workspace:original-a'], {
      writerWorkspace: '/array-metadata',
    })
    const projection = createLocalProcessEffectProjection({
      persistence: f.persistence,
      processKind: 'agent',
      argv: ['original-binary'],
      cwd: '/original/workspace',
      resourceKeys,
    })
    expect([...projection.describe().resourceKeys]).toEqual(['workspace:original-a'])
  })
  test.each(processKinds)(
    'retains the %s fingerprint, writer workspace key and recovery dialect',
    (processKind) => {
      const f = fixture()
      const argv = ['original-binary', 'run', '参数']
      const cwd = '/original/workspace'
      const projection = createLocalProcessEffectProjection({
        persistence: f.persistence,
        processKind,
        argv,
        cwd,
        resourceKeys: { writerWorkspace: cwd },
      })
      expect(projection.describe()).toEqual({
        requestHash: requestHash({ v: 1, processKind, argv, cwd }),
        resourceKeys: [`workspace:${sha256Hex(cwd)}`],
        recoveryClass: 'managed-process-preactivation',
        classifierVersion: 'rfc328-managed-process-v1',
        transportPolicyVersion: 'rfc328-preactivation-v1',
      })
      expect(
        createLocalProcessEffectProjection({
          persistence: f.persistence,
          processKind,
          argv,
          cwd,
        }).describe().resourceKeys,
      ).toEqual([])
      const legacyResourceKeys = ['workspace:original-a', 'workspace:original-b']
      expect(
        createLocalProcessEffectProjection({
          persistence: f.persistence,
          processKind,
          argv,
          cwd,
          resourceKeys: legacyResourceKeys,
        }).describe().resourceKeys,
      ).toEqual(legacyResourceKeys)
    },
  )

  test('keeps complete original settlement JSON bytes including null and evidence-loss fields', () => {
    const f = fixture()
    const projection = createLocalProcessEffectProjection({
      persistence: f.persistence,
      processKind: 'agent',
      argv: ['original-binary'],
      cwd: '/original/workspace',
    })
    const results: LocalProcessSettlement[] = [
      { outcome: 'ok', exitCode: 0, pid: 42 },
      { outcome: 'spawn-failed', exitCode: null, pid: null },
      {
        outcome: 'nonzero-exit',
        exitCode: 7,
        pid: 42,
        launchNonce: 'original-nonce',
        drainTimedOut: true,
        pumpError: 'original-first-error',
      },
    ]
    for (const result of results) {
      expect(projection.settlementReceipt(result)).toBe(
        JSON.stringify({
          v: 1,
          phase: 'reaped',
          outcome: result.outcome,
          exitCode: result.exitCode,
          pid: result.pid,
          launchNonce: result.launchNonce ?? null,
          drainTimedOut: result.drainTimedOut === true,
          pumpError: result.pumpError ?? null,
        }),
      )
    }
  })

  test('native participant still writes the same prepared effect, nonce and runtime profile', async () => {
    const f = fixture()
    const observer = createLocalObserver({
      ...f,
      taskId: 'original-task',
      nodeRunId: 'original-run',
      processKind: 'agent',
      argv: ['original-binary'],
      cwd: '/original/workspace',
    })!
    await observer.beforeSpawn()
    await expect(
      observer.recordSpawnReceipt({ pid: 42, spawnBinaryPath: 'original-binary' }),
    ).rejects.toThrow('launch nonce')
    await observer.recordSpawnReceipt(
      { pid: 42, spawnBinaryPath: 'original-binary', launchNonce: 'original-nonce' },
      'frozen-profile',
    )
    expect(f.spawns).toHaveLength(1)
    expect(f.spawns[0]).toMatchObject({
      token: f.context.token,
      effectId: 'original-effect',
      attemptId: 'original-attempt',
      nodeRunId: 'original-run',
      pid: 42,
      spawnBinaryPath: 'original-binary',
      launchNonce: 'original-nonce',
      runtimeParamsJson: 'frozen-profile',
    })
    expect(f.spawns[0]?.now).toBeNumber()
  })

  test('real Task target stays inactive until selected local receipt persistence ACK', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc370-effect-ack-'))
    const marker = join(root, 'activated')
    const f = fixture()
    const entered = deferred()
    const release = deferred()
    const persist = f.persistence.recordProcessSpawn
    f.persistence.recordProcessSpawn = async (input) => {
      entered.resolve()
      await release.promise
      await persist(input)
    }
    const cmd = [
      process.execPath,
      '-e',
      `await Bun.write(${JSON.stringify(marker)}, 'activated'); process.stdout.write('original-output')`,
    ]
    const observer = createLocalObserver({
      ...f,
      taskId: 'original-task',
      nodeRunId: 'original-run',
      processKind: 'agent',
      argv: cmd,
      cwd: root,
      resourceKeys: { writerWorkspace: root },
    })!
    const pending = runAgentProcess({
      cmd,
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      timeoutMs: 8000,
      beforeSpawn: () => observer.beforeSpawn(),
      requireSpawnReceipt: true,
      onSpawned: (receipt) => observer.recordSpawnReceipt(receipt),
      capture: { rawStdout: true },
    })
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`process finished before entering receipt persistence: ${result.outcome}`)
        }),
      ])
      expect(existsSync(marker)).toBe(false)
      expect(f.spawns).toEqual([])
      expect(f.settlements).toEqual([])
      release.resolve()
      const result = await pending
      await observer.settle(result)
      expect(result.outcome).toBe('ok')
      expect(result.rawStdout).toBe('original-output')
      expect(readFileSync(marker, 'utf8')).toBe('activated')
      expect(f.spawns).toHaveLength(1)
      expect(f.settlements[0]?.state).toBe('succeeded')
    } finally {
      release.resolve()
      await pending
      rmSync(root, { recursive: true, force: true })
    }
  }, 12_000)
})
