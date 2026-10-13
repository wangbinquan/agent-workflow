import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { createLocalSystemAgentRetainedContents } from '../src/modules/runtime-management/infrastructure/local/systemAgentRetainedContents'
import { composeLocalSystemAgentRunFamily } from '../src/modules/task-execution/composition/localSystemAgentRunFamily'
import {
  createLocalAgentExecutionRecoveryReferences,
  encodeLocalAgentExecutionRecoveryReference,
  encodeLocalPreparedExecutionRecoveryReference,
} from '../src/modules/task-execution/infrastructure/local/agentExecutionRecoveryReference'
import { platformSpawnOptionsForHost } from '../src/util/platformExec'
import { killProcessTree } from '../src/util/process'
import { eventually } from './helpers/eventually'
import type { ExecutionStartReceipt } from '../src/modules/task-execution/application/ports/executionEffect'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function home() {
  const root = mkdtempSync(join(tmpdir(), 'aw-durable-recovery-'))
  roots.push(root)
  return root
}

test('a recreated content owner releases only the persisted original material generation', async () => {
  const root = home(),
    owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const scope = owner.workspaces.capture({ namespace: 'shared', name: 'original-generation' })
  const opened = owner.open({ scope, feature: () => 'memory-distill', seedFiles: () => undefined })
  await opened.workspace.prepare()
  const retainedRef = JSON.parse(JSON.stringify(opened.workspace.retainedRef)) as string
  expect(existsSync(opened.locations.root)).toBe(true)
  const rebuilt = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const rebuiltScope = rebuilt.workspaces.capture({ namespace: 'shared', name: scope.name })
  expect(await rebuilt.contents.release({ scope: rebuiltScope, retainedRef })).toEqual({
    removed: true,
  })
  expect(existsSync(opened.locations.root)).toBe(false)
  expect(await rebuilt.contents.release({ scope: rebuiltScope, retainedRef })).toEqual({
    removed: true,
  })
})

test('a persisted old reference cannot delete a replacement generation at the same native path', async () => {
  const root = home(),
    owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const scope = owner.workspaces.capture({ namespace: 'shared', name: 'same-logical-name' })
  const first = owner.open({ scope, feature: () => 'memory-distill', seedFiles: () => undefined })
  await first.workspace.prepare()
  const oldRef = first.workspace.retainedRef
  const rebuilt = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const nextScope = rebuilt.workspaces.capture({ namespace: 'shared', name: scope.name })
  const next = rebuilt.open({
    scope: nextScope,
    feature: () => 'memory-distill',
    seedFiles: () => undefined,
  })
  await next.workspace.prepare()
  const marker = join(next.locations.workingDirectory, 'replacement.txt')
  writeFileSync(marker, 'replacement')
  expect(await rebuilt.contents.release({ scope: nextScope, retainedRef: oldRef })).toEqual({
    removed: false,
    reason: 'unsafe-path',
  })
  expect(readFileSync(marker, 'utf8')).toBe('replacement')
  expect(
    await rebuilt.contents.release({ scope: nextScope, retainedRef: next.workspace.retainedRef }),
  ).toEqual({ removed: true })
})

test('material inspection proves the original generation without releasing it', async () => {
  const root = home(),
    owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const scope = owner.workspaces.capture({ namespace: 'shared', name: 'resume-original' })
  const opened = owner.open({ scope, feature: () => 'memory-distill', seedFiles: () => undefined })
  await opened.workspace.prepare()
  const rebuilt = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const restoredScope = rebuilt.workspaces.capture({ namespace: 'shared', name: scope.name })
  expect(
    await rebuilt.contents.inspect({
      scope: restoredScope,
      retainedRef: opened.workspace.retainedRef,
    }),
  ).toEqual({ available: true })
  expect(existsSync(opened.locations.root)).toBe(true)
  const replacement = rebuilt.open({
    scope: restoredScope,
    feature: () => 'memory-distill',
    seedFiles: () => undefined,
  })
  await replacement.workspace.prepare()
  expect(
    await rebuilt.contents.inspect({
      scope: restoredScope,
      retainedRef: opened.workspace.retainedRef,
    }),
  ).toEqual({ available: false })
  expect(
    await rebuilt.contents.inspect({
      scope: restoredScope,
      retainedRef: replacement.workspace.retainedRef,
    }),
  ).toEqual({ available: true })
  expect(existsSync(replacement.locations.root)).toBe(true)
})

// RFC-370 implementation gate: preparing an uncommitted follow-up must not
// invalidate the only material reference already persisted in the journal.
test('a follow-up keeps the original durable material generation across a recreated owner', async () => {
  const root = home(),
    owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const scope = owner.workspaces.capture({ namespace: 'shared', name: 'original-protocol-chain' })
  const first = owner.open({ scope, feature: () => 'memory-distill', seedFiles: () => undefined })
  await first.workspace.prepare()
  const marker = join(first.locations.root, '.aw-system-content-owner.json')
  const originalMarker = readFileSync(marker, 'utf8')
  const next = owner.open({
    scope,
    resumeRetainedRef: first.workspace.retainedRef,
    feature: () => 'memory-distill',
    seedFiles: () => undefined,
  })
  await next.workspace.prepare()
  expect(next.workspace.runContent).not.toEqual(first.workspace.runContent)
  expect(next.workspace.retainedRef).toBe(first.workspace.retainedRef)
  expect(readFileSync(marker, 'utf8')).toBe(originalMarker)
  const rebuilt = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const restoredScope = rebuilt.workspaces.capture({ namespace: 'shared', name: scope.name })
  expect(
    await rebuilt.contents.inspect({
      scope: restoredScope,
      retainedRef: first.workspace.retainedRef,
    }),
  ).toEqual({ available: true })
  const resumed = rebuilt.open({
    scope: restoredScope,
    resumeRetainedRef: first.workspace.retainedRef,
    feature: () => 'memory-distill',
    seedFiles: () => undefined,
  })
  await resumed.workspace.prepare()
  expect(readFileSync(marker, 'utf8')).toBe(originalMarker)
  expect(
    await rebuilt.contents.release({
      scope: restoredScope,
      retainedRef: resumed.workspace.retainedRef,
    }),
  ).toEqual({ removed: true })
})

test('a failed real System continuation preserves the replacement material generation during setup cleanup', async () => {
  const root = home(),
    owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
  const scope = owner.workspaces.capture({ namespace: 'shared', name: 'replaced-protocol-chain' })
  const first = owner.open({ scope, feature: () => 'memory-distill', seedFiles: () => undefined })
  await first.workspace.prepare()
  const replacement = owner.open({
    scope,
    feature: () => 'memory-distill',
    seedFiles: () => [{ path: 'original.txt', content: 'replacement material remains' }],
  })
  await replacement.workspace.prepare()
  const marker = join(replacement.locations.root, '.aw-system-content-owner.json')
  const originalMarker = readFileSync(marker, 'utf8')
  let preparedReceipts = 0,
    observations = 0
  const native = composeLocalSystemAgentRunFamily({
    appHome: () => root,
    observations: () => {
      observations += 1
      throw new Error('failed setup may not start an invocation')
    },
  })
  const selectedScope = native.family.workspaces.capture({ namespace: 'shared', name: scope.name })
  const result = await native.family.run({
    feature: 'memory-distill',
    agentName: 'aw-memory-distiller',
    systemPrompt: 'original system prompt',
    prompt: 'original follow-up',
    protocol: 'opencode',
    workspaceScope: selectedScope,
    resumeRetainedRef: first.workspace.retainedRef,
    executionReceipts: {
      async prepared() {
        preparedReceipts += 1
      },
      async started() {
        throw new Error('failed setup may not activate an invocation')
      },
    },
  })
  expect(result.status).toBe('spawn-failed')
  expect(result.stderrTail).toContain('system-content-resume-generation-unavailable')
  expect(result.executionReceipt).toBeUndefined()
  expect({ preparedReceipts, observations }).toEqual({ preparedReceipts: 0, observations: 0 })
  expect(readFileSync(marker, 'utf8')).toBe(originalMarker)
  expect(readFileSync(join(replacement.locations.workingDirectory, 'original.txt'), 'utf8')).toBe(
    'replacement material remains',
  )
  expect(
    await native.family.retainedContents.inspect({
      scope: selectedScope,
      retainedRef: replacement.workspace.retainedRef,
    }),
  ).toEqual({ available: true })
})

test.each(['foreign-installation', 'wrong-name', 'wrong-namespace', 'missing-owner-file'] as const)(
  'persisted material recovery refuses %s and preserves the original files',
  async (failure) => {
    const root = home(),
      owner = createLocalSystemAgentRetainedContents({ appHome: () => root })
    const scope = owner.workspaces.capture({ namespace: 'shared', name: 'original' })
    const opened = owner.open({
      scope,
      feature: () => 'memory-distill',
      seedFiles: () => undefined,
    })
    await opened.workspace.prepare()
    if (failure === 'missing-owner-file')
      rmSync(join(opened.locations.root, '.aw-system-content-owner.json'))
    const rebuilt = createLocalSystemAgentRetainedContents({
      appHome: () => (failure === 'foreign-installation' ? home() : root),
    })
    const selected = rebuilt.workspaces.capture({
      namespace: failure === 'wrong-namespace' ? 'intent' : 'shared',
      name: failure === 'wrong-name' ? 'replacement' : 'original',
    })
    expect(
      await rebuilt.contents.release({
        retainedRef: opened.workspace.retainedRef,
        scope: selected,
      }),
    ).toEqual({ removed: false, reason: 'unsafe-path' })
    expect(existsSync(opened.locations.root)).toBe(true)
  },
)

test('a recovery reference with missing/foreign identity never gains authority from decoding', async () => {
  const owner = createLocalAgentExecutionRecoveryReferences()
  const token = encodeLocalAgentExecutionRecoveryReference('original', {
    pid: process.pid,
    spawnedAt: Date.now(),
    spawnBinaryPath: process.execPath,
    launchNonce: 'original-nonce',
  })!
  expect(
    await owner.recoverReference({ executionRef: 'replacement', recoveryRef: token }),
  ).toMatchObject({ state: 'unknown' })
  expect(
    await owner.recoverReference({
      executionRef: 'original',
      recoveryRef: 'aw-local-execution-recovery-v1:broken',
    }),
  ).toMatchObject({ state: 'unknown' })
  const payload = JSON.parse(
    Buffer.from(token.split(':')[1]!, 'base64url').toString('utf8'),
  ) as Record<string, unknown>
  payload.hostname = hostname() + ':another-host'
  const foreign =
    'aw-local-execution-recovery-v1:' + Buffer.from(JSON.stringify(payload)).toString('base64url')
  expect(
    await owner.recoverReference({ executionRef: 'original', recoveryRef: foreign }),
  ).toMatchObject({ state: 'unknown' })
})

test('a prepared reservation remains unknown while its original daemon is alive', async () => {
  const token = encodeLocalPreparedExecutionRecoveryReference(
    'original-prepared',
    crypto.randomUUID(),
  )
  const recovery = createLocalAgentExecutionRecoveryReferences()
  expect(
    await recovery.recoverReference({ executionRef: 'original-prepared', recoveryRef: token }),
  ).toMatchObject({ state: 'unknown' })
  expect(
    await recovery.recoverReference({ executionRef: 'replacement', recoveryRef: token }),
  ).toMatchObject({ state: 'unknown' })
})

test('a new process retires the original prepared helper after daemon crash without activating its target', async () => {
  const root = home(),
    marker = join(root, 'must-not-issue'),
    fixture = join(import.meta.dir, 'fixtures')
  const original = Bun.spawn(
    [process.execPath, join(fixture, 'rfc370-original-prepared-process-owner.ts'), marker],
    {
      ...platformSpawnOptionsForHost(),
      cwd: join(import.meta.dir, '..'),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const reader = original.stdout.getReader()
  let started: ExecutionStartReceipt | undefined
  try {
    let text = ''
    while (text.split('\n').length < 3) {
      const chunk = await reader.read()
      if (chunk.done)
        throw new Error(
          'original daemon exited before its held gate: ' +
            (await new Response(original.stderr).text()),
        )
      text += new TextDecoder().decode(chunk.value, { stream: true })
    }
    const lines = text.split('\n'),
      prepared = JSON.parse(lines[0]!) as { executionRef: string; recoveryRef: string }
    started = JSON.parse(lines[1]!) as ExecutionStartReceipt
    expect(prepared.recoveryRef).toStartWith('aw-local-prepared-recovery-v1:')
    expect(existsSync(marker)).toBe(false)
    original.kill('SIGKILL')
    await original.exited
    const recovered = Bun.spawn(
      [
        process.execPath,
        join(fixture, 'rfc370-recover-process-reference.ts'),
        JSON.stringify(prepared),
      ],
      {
        ...platformSpawnOptionsForHost(),
        cwd: join(import.meta.dir, '..'),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const output = new Response(recovered.stdout).text(),
      errors = new Response(recovered.stderr).text()
    expect(await recovered.exited).toBe(0)
    expect(await errors).toBe('')
    expect(JSON.parse(await output)).toEqual({
      executionRef: prepared.executionRef,
      state: 'reaped',
    })
    expect(existsSync(marker)).toBe(false)
  } finally {
    reader.releaseLock()
    original.kill('SIGKILL')
    await original.exited
    if (started?.recoveryRef) {
      const receipt = JSON.parse(
        Buffer.from(started.recoveryRef.split(':')[1]!, 'base64url').toString('utf8'),
      ) as { pid: number }
      killProcessTree(receipt.pid, 'SIGKILL')
    }
  }
}, 30_000)

test('a new Bun process recovers the real original receipt after its daemon crashes', async () => {
  const root = home(),
    marker = join(root, 'issued'),
    fixture = join(import.meta.dir, 'fixtures')
  const original = Bun.spawn(
    [process.execPath, join(fixture, 'rfc370-original-process-owner.ts'), marker],
    {
      ...platformSpawnOptionsForHost(),
      cwd: join(import.meta.dir, '..'),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const reader = original.stdout.getReader()
  let receipt: ExecutionStartReceipt | undefined
  try {
    let text = ''
    while (!text.includes('\n')) {
      const chunk = await reader.read()
      if (chunk.done)
        throw new Error(
          'original daemon exited without a spawn receipt: ' +
            (await new Response(original.stderr).text()),
        )
      text += new TextDecoder().decode(chunk.value, { stream: true })
    }
    receipt = JSON.parse(text.slice(0, text.indexOf('\n'))) as ExecutionStartReceipt
    expect(receipt.recoveryRef).toBeString()
    await eventually(
      async () => (existsSync(marker) ? readFileSync(marker, 'utf8') : ''),
      (value) => value === 'issued',
      { what: 'original target activation', timeoutMs: 10000 },
    )
    original.kill('SIGKILL')
    await original.exited
    const recovered = Bun.spawn(
      [
        process.execPath,
        join(fixture, 'rfc370-recover-process-reference.ts'),
        JSON.stringify(receipt),
      ],
      {
        ...platformSpawnOptionsForHost(),
        cwd: join(import.meta.dir, '..'),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const output = new Response(recovered.stdout).text()
    const errors = new Response(recovered.stderr).text()
    expect(await recovered.exited).toBe(0)
    expect(await errors).toBe('')
    const result = JSON.parse(await output) as { executionRef: string; state: string }
    expect(result.executionRef).toBe(receipt.executionRef)
    const nativeReceipt = JSON.parse(
      Buffer.from(receipt.recoveryRef!.split(':')[1]!, 'base64url').toString('utf8'),
    ) as { jobOwnerPid?: number }
    const provable = process.platform !== 'win32' || nativeReceipt.jobOwnerPid !== undefined
    expect(result.state).toBe(provable ? 'reaped' : 'unknown')
    expect(readFileSync(marker, 'utf8')).toBe('issued')
  } finally {
    reader.releaseLock()
    original.kill('SIGKILL')
    await original.exited
    if (receipt?.recoveryRef) {
      const raw = JSON.parse(
        Buffer.from(receipt.recoveryRef.split(':')[1]!, 'base64url').toString('utf8'),
      ) as { pid: number }
      killProcessTree(raw.pid, 'SIGKILL')
    }
  }
}, 30000)
