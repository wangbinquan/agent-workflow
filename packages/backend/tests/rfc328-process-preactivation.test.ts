// RFC-328 T19 regression: a task-owned runtime must not execute before its
// durable PID/nonce receipt commits. The hidden launcher is the load-bearing
// barrier; delaying stdin alone would still let script nodes mutate early.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runManagedProcess } from '../src/services/execution/managedProcess'

const roots: string[] = []
const compiledTarget = process.env.AW_RFC328_COMPILED_TARGET ?? ''

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc328-process-gate-'))
  roots.push(root)
  return root
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RFC-328 managed-process pre-activation launcher', () => {
  test('real command cannot run until the durable receipt callback returns', async () => {
    const root = fixtureRoot()
    const marker = join(root, 'activated')
    const receiptEntered = deferred()
    const allowReceiptCommit = deferred()

    const resultPromise = runManagedProcess({
      argv: [
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(marker)}, 'activated'); process.stdout.write('ready')`,
      ],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
      requireSpawnReceipt: true,
      captureRawStdout: true,
      onSpawned: async ({ launchNonce }) => {
        expect(launchNonce).toBeString()
        expect(existsSync(marker)).toBe(false)
        receiptEntered.resolve()
        await allowReceiptCommit.promise
      },
    })

    await receiptEntered.promise
    expect(existsSync(marker)).toBe(false)
    allowReceiptCommit.resolve()
    const result = await resultPromise

    expect(result.outcome).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(result.rawStdout).toBe('ready')
    expect(readFileSync(marker, 'utf8')).toBe('activated')
  })

  test('receipt failure closes the gate and reaps without executing target', async () => {
    const root = fixtureRoot()
    const marker = join(root, 'must-not-exist')
    const result = await runManagedProcess({
      argv: [process.execPath, '-e', `await Bun.write(${JSON.stringify(marker)}, 'bad')`],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
      killEscalationGraceMs: 20,
      requireSpawnReceipt: true,
      onSpawned: () => {
        throw new Error('receipt-db-failed')
      },
    })

    expect(result.outcome).toBe('spawn-failed')
    expect(result.spawnError).toContain('receipt-db-failed')
    expect(existsSync(marker)).toBe(false)
  })

  test('activation forwards task stdin byte-for-byte after receipt', async () => {
    const root = fixtureRoot()
    const payload = 'line one\nline two\n'
    const result = await runManagedProcess({
      argv: [process.execPath, '-e', 'process.stdout.write(await Bun.stdin.text())'],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
      stdin: { mode: 'pipe', data: payload },
      requireSpawnReceipt: true,
      captureRawStdout: true,
      onSpawned: () => {},
    })

    expect(result.outcome).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(result.rawStdout).toBe(payload)
  })

  test('launcher drains large target stdout and stderr before reporting exit', async () => {
    const root = fixtureRoot()
    const stdoutBytes = 256 * 1024
    const stderrLine = 'launcher-stderr-before-exit'
    const result = await runManagedProcess({
      argv: [
        process.execPath,
        '-e',
        `const { writeSync } = require('node:fs'); writeSync(1, 'x'.repeat(${stdoutBytes})); writeSync(2, '${stderrLine}\\n')`,
      ],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
      requireSpawnReceipt: true,
      captureRawStdout: true,
      onSpawned: () => {},
    })

    expect(result.outcome).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(result.rawStdout).toHaveLength(stdoutBytes)
    expect(result.rawStdout.startsWith('x'.repeat(64))).toBe(true)
    expect(result.stderrTail).toContain(stderrLine)
    expect(result.stderrTail).not.toContain('AW_MANAGED_PROCESS_LAUNCH_')
  })

  test.skipIf(process.platform !== 'win32' || compiledTarget.length === 0)(
    'compiled Bun target stdout and stderr survive the Windows launcher',
    async () => {
      const root = fixtureRoot()
      const baseEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      )
      const stdoutResult = await runManagedProcess({
        argv: [compiledTarget, '--version'],
        cwd: root,
        env: { ...baseEnv, AW_STUB_MODE: 'basic' },
        requireSpawnReceipt: true,
        captureRawStdout: true,
        onSpawned: () => {},
      })

      expect(stdoutResult.outcome).toBe('exited')
      expect(stdoutResult.exitCode).toBe(0)
      expect(stdoutResult.rawStdout).toContain('stub-opencode custom-build')
      expect(stdoutResult.stderrTail).not.toContain('AW_MANAGED_PROCESS_LAUNCH_')

      const stderrResult = await runManagedProcess({
        argv: [compiledTarget, '--version'],
        cwd: root,
        env: { ...baseEnv, AW_STUB_MODE: '__rfc328_missing__' },
        requireSpawnReceipt: true,
        onSpawned: () => {},
      })

      expect(stderrResult.outcome).toBe('exited')
      expect(stderrResult.exitCode).toBe(2)
      expect(stderrResult.stderrTail).toContain('unknown AW_STUB_MODE')
      expect(stderrResult.stderrTail).not.toContain('AW_MANAGED_PROCESS_LAUNCH_')
    },
  )

  test('missing target is surfaced as spawn-failed, not a business nonzero exit', async () => {
    const root = fixtureRoot()
    const result = await runManagedProcess({
      argv: [join(root, 'missing-runtime')],
      cwd: root,
      env: {},
      requireSpawnReceipt: true,
      onSpawned: () => {},
    })

    expect(result.outcome).toBe('spawn-failed')
    expect(result.exitCode).toBeNull()
    expect(result.spawnError).toContain('missing-runtime')
  })

  test('business timeout starts after target readiness and launcher records stay private', async () => {
    const root = fixtureRoot()
    const stderrLines: string[] = []
    const result = await runManagedProcess({
      argv: [
        process.execPath,
        '-e',
        "await Bun.sleep(100); process.stderr.write('runtime-stderr\\n')",
      ],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
      timeoutMs: 750,
      requireSpawnReceipt: true,
      onSpawned: () => {},
      onStderrLine: (line) => void stderrLines.push(line),
    })

    expect(result.outcome).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(stderrLines).toEqual(['runtime-stderr'])
    expect(result.stderrTail).toContain('runtime-stderr')
    expect(result.stderrTail).not.toContain('AW_MANAGED_PROCESS_LAUNCH_')
  })
})
