import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { AgentProcessResult } from '../src/platform/execution/local/agentProcess'
import { retainOriginalProcessRecovery } from '../src/platform/execution/local/originalProcessRecovery'
import { bindLocalAgentExecutionEffect } from '../src/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { platformSpawnOptionsForHost } from '../src/util/platformExec'
import {
  adoptSpawnedProcessTree,
  isProcessAlive,
  killProcessTree,
  processTreeOwnershipStatus,
  releaseProcessTreeOwnership,
} from '../src/util/process'

function result(input: Partial<AgentProcessResult> = {}): AgentProcessResult {
  return {
    outcome: 'unreaped',
    pid: null,
    exitCode: null,
    rawStdout: '',
    stderrTail: 'original unknown execution',
    durationMs: 1,
    ...input,
  }
}

function binding(runNative: Parameters<typeof bindLocalAgentExecutionEffect>[0]['runNative']) {
  return bindLocalAgentExecutionEffect({
    materialRef: 'original:material',
    command: () => ['original'],
    workingDirectory: () => process.cwd(),
    environment: () => ({}),
    stdin: () => undefined,
    runNative,
  })
}

function submit(selected: ReturnType<typeof binding>) {
  return selected.effect.submit({
    executionRef: selected.executionRef,
    materialRef: selected.materialRef,
    workspaceRef: selected.workspaceRef,
  })
}

test('an unknown execution without an original physical receipt remains unacknowledged', async () => {
  let calls = 0
  const selected = binding(async () => {
    calls += 1
    return result()
  })
  expect(
    await selected.effect.recoverOriginal({ executionRef: selected.executionRef }),
  ).toMatchObject({ state: 'unknown' })
  const original = await submit(selected)
  expect(
    await selected.effect.recoverOriginal({ executionRef: selected.executionRef }),
  ).toMatchObject({ state: 'unknown' })
  await expect(
    selected.effect.recoverOriginal({ executionRef: 'replacement:execution' }),
  ).rejects.toThrow('execution-binding-reference-unavailable')
  await expect(submit(selected)).rejects.toThrow('execution-binding-already-submitted')
  expect(original.outcome).toBe('unreaped')
  expect(original.exitCode).toBeNull()
  expect(calls).toBe(1)
})

test('the original native physical capability is retried and concurrent callers share its actual ACK', async () => {
  let physical = 0,
    permitted = false,
    runs = 0
  const originalResult = result({
    recoverOriginal: async () => {
      physical += 1
      return permitted
    },
  })
  const selected = binding(async () => {
    runs += 1
    return originalResult
  })
  const original = await submit(selected)
  expect(
    await selected.effect.recoverOriginal({ executionRef: selected.executionRef }),
  ).toMatchObject({ state: 'unknown' })
  permitted = true
  const one = selected.effect.recoverOriginal({ executionRef: selected.executionRef })
  expect(selected.effect.recoverOriginal({ executionRef: selected.executionRef })).toBe(one)
  expect(await one).toMatchObject({ executionRef: selected.executionRef, state: 'reaped' })
  expect(
    await selected.effect.recoverOriginal({ executionRef: selected.executionRef }),
  ).toMatchObject({ state: 'reaped' })
  expect(physical).toBe(2)
  expect(runs).toBe(1)
  expect(original).not.toHaveProperty('pid')
  expect(original).not.toHaveProperty('recoverOriginal')
  expect(original.outcome).toBe('unreaped')
})

test('the retained original child capability physically retires an owned Bun process without a new execution', async () => {
  const child = Bun.spawn(
    [process.execPath, '-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      detached: process.platform !== 'win32',
      ...platformSpawnOptionsForHost(),
    },
  )
  adoptSpawnedProcessTree(child.pid)
  let exited = false,
    runs = 0
  void child.exited.then(() => {
    exited = true
  })
  const recoverOriginal = retainOriginalProcessRecovery({
    pid: child.pid,
    originalChildExited: () => exited,
  })
  const selected = binding(async () => {
    runs += 1
    return result({ pid: child.pid, recoverOriginal })
  })
  try {
    const stdout = child.stdout.getReader()
    try {
      expect((await stdout.read()).done).toBe(false)
    } finally {
      stdout.releaseLock()
    }
    const original = await submit(selected)
    const recovery = await selected.effect.recoverOriginal({ executionRef: selected.executionRef })
    const provable = process.platform !== 'win32' || processTreeOwnershipStatus().available
    expect(recovery.state).toBe(provable ? 'reaped' : 'unknown')
    if (provable) {
      await child.exited
      expect(isProcessAlive(child.pid)).toBe(false)
    }
    expect(runs).toBe(1)
    expect(original.outcome).toBe('unreaped')
    expect(original.exitCode).toBeNull()
  } finally {
    killProcessTree(child.pid, 'SIGKILL')
    await child.exited
    releaseProcessTreeOwnership(child.pid)
  }
}, 10000)

test.each(['missing-nonce', 'nonce-mismatch', 'expired', 'terminal-mismatch'] as const)(
  'recovery refuses %s native identity and leaves the actual original child alive',
  async (failure) => {
    const nonce = randomUUID()
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
        nonce,
      ],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        detached: process.platform !== 'win32',
        ...platformSpawnOptionsForHost(),
      },
    )
    adoptSpawnedProcessTree(child.pid)
    const receiptNonce =
      failure === 'missing-nonce'
        ? undefined
        : failure === 'nonce-mismatch'
          ? 'different-launch'
          : nonce
    const spawnedAt = failure === 'expired' ? Date.now() - 365 * 24 * 3600 * 1000 : Date.now()
    const selected = binding(async (request) => {
      await request.onSpawned?.({
        pid: child.pid,
        spawnedAt,
        spawnBinaryPath: process.execPath,
        launchNonce: receiptNonce,
      })
      return result({
        pid: child.pid,
        launchNonce: failure === 'terminal-mismatch' ? 'different-terminal' : receiptNonce,
      })
    })
    try {
      const stdout = child.stdout.getReader()
      try {
        expect((await stdout.read()).done).toBe(false)
      } finally {
        stdout.releaseLock()
      }
      await submit(selected)
      expect(
        await selected.effect.recoverOriginal({ executionRef: selected.executionRef }),
      ).toMatchObject({ state: 'unknown' })
      expect(isProcessAlive(child.pid)).toBe(true)
    } finally {
      killProcessTree(child.pid, 'SIGKILL')
      await child.exited
      releaseProcessTreeOwnership(child.pid)
    }
  },
  10000,
)
