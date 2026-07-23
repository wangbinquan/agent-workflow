// RFC-224 T7a — a matching version/hash is insufficient when OpenCode can
// silently fall back from bundled FFF to ripgrep. These tests lock the sealed
// one-file/no-network/no-rg proof and its fail-closed decoder.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  materializeFffCapabilityProbe,
  renderFffCapabilityProbeCommand,
  runFffCapabilityProbe,
  verifyFffCapabilityProbeArtifacts,
  type FffCapabilityProbeProcess,
} from '@/services/runtime/opencode/fffCapability'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import { removeSealedTree } from '@/services/runtime/opencode/sealedInputs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeSealedTree(root).catch(() => {})))
})

function root(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), 'rfc224-fff-'))
  roots.push(value)
  return value
}

async function fixture() {
  const base = root()
  const runRoot = join(base, 'run')
  await mkdir(runRoot, { mode: 0o700 })
  const materialized = await materializeFffCapabilityProbe({
    probeRoot: join(runRoot, 'probe'),
    bwrapPath: '/usr/bin/bwrap',
    random: (size) => new Uint8Array(size).fill(0xab),
  })
  return { base, runRoot, ...materialized }
}

function stream(value: string, close = true): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (value !== '') controller.enqueue(new TextEncoder().encode(value))
      if (close) controller.close()
    },
  })
}

function fakeProcess(input: {
  stdout: string
  stderr?: string
  code?: number
  close?: boolean
  onKill?: (signal: NodeJS.Signals) => void
}): FffCapabilityProbeProcess {
  return {
    pid: 4242,
    stdout: stream(input.stdout, input.close),
    stderr: stream(input.stderr ?? '', input.close),
    exited:
      input.close === false ? new Promise<number>(() => {}) : Promise.resolve(input.code ?? 0),
    killGroup: (signal) => input.onKill?.(signal),
  }
}

async function expectBootstrapFailure(operation: Promise<unknown>): Promise<void> {
  let error: unknown
  try {
    await operation
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ExecutionIdentityFailure)
  expect((error as ExecutionIdentityFailure).code).toBe('execution-identity-bootstrap-failed')
  expect(String(error)).not.toContain('rg')
}

describe('RFC-224 FFF capability artifact seal', () => {
  test('materializes a one-file cwd, empty read-only cache/PATH, and pinned codec', async () => {
    const value = await fixture()
    expect(value.codec).toBe(1)
    expect(value.probe.basename).toBe(`aw-fff-${'ab'.repeat(16)}.txt`)
    expect(await readdir(join(value.probe.root, 'cwd'))).toEqual([value.probe.basename])
    expect(await readdir(join(value.probe.root, 'cache', 'opencode', 'bin'))).toEqual([])
    expect(await readdir(join(value.probe.root, 'path'))).toEqual([])
    expect((await lstat(join(value.probe.root, 'cwd'))).mode & 0o777).toBe(0o500)
    expect((await lstat(join(value.probe.root, 'cache'))).mode & 0o777).toBe(0o500)
    expect((await lstat(join(value.probe.root, 'cwd', value.probe.basename))).mode & 0o777).toBe(
      0o400,
    )
    await expect(
      verifyFffCapabilityProbeArtifacts(value.runRoot, value.probe),
    ).resolves.toBeUndefined()
  })

  test('renders the exact no-network command without an rg-capable PATH', async () => {
    const value = await fixture()
    const command = renderFffCapabilityProbeCommand({
      binaryPath: '/sealed/opencode',
      probe: value.probe,
    })
    expect(command[0]).toBe('/usr/bin/bwrap')
    expect(command).toContain('--unshare-net')
    expect(command).toContain('--clearenv')
    const pathIndex = command.findIndex(
      (entry, index) => entry === '--setenv' && command[index + 1] === 'PATH',
    )
    expect(command[pathIndex + 2]).toBe(join(value.probe.root, 'path'))
    expect(command.join('\n')).not.toContain('OPENCODE_DISABLE_FFF')
    expect(command.slice(-5)).toEqual([
      '/sealed/opencode',
      'debug',
      'file',
      'search',
      value.probe.basename,
    ])
  })

  test('rejects a pre-populated fallback cache before spawning', async () => {
    const value = await fixture()
    const cacheBin = join(value.probe.root, 'cache', 'opencode', 'bin')
    await chmod(cacheBin, 0o700)
    await writeFile(join(cacheBin, 'rg'), 'forbidden cached fallback', { mode: 0o500 })
    await chmod(cacheBin, 0o500)

    let spawned = false
    await expectBootstrapFailure(
      runFffCapabilityProbe(
        {
          binaryPath: '/sealed/opencode',
          runRoot: value.runRoot,
          probe: value.probe,
          timeoutMs: 1_000,
        },
        {
          requireBwrap: async (path) => path,
          spawn: () => {
            spawned = true
            return fakeProcess({ stdout: '' })
          },
          timeout: () => new Promise(() => {}),
        },
      ),
    )
    expect(spawned).toBe(false)
  })
})

describe('RFC-224 FFF capability execution proof', () => {
  test('accepts only exit 0, empty stderr, and exactly one basename line', async () => {
    const value = await fixture()
    let spawnedCommand: readonly string[] = []
    let spawnedCwd = ''
    await runFffCapabilityProbe(
      {
        binaryPath: '/sealed/opencode',
        runRoot: value.runRoot,
        probe: value.probe,
        timeoutMs: 1_000,
      },
      {
        requireBwrap: async (path) => path,
        spawn: (command, cwd) => {
          spawnedCommand = command
          spawnedCwd = cwd
          return fakeProcess({ stdout: `${value.probe.basename}\n` })
        },
        timeout: () => new Promise(() => {}),
      },
    )

    expect(spawnedCwd).toBe(join(value.probe.root, 'cwd'))
    expect(spawnedCommand.slice(-5)).toEqual([
      '/sealed/opencode',
      'debug',
      'file',
      'search',
      value.probe.basename,
    ])
  })

  test('collapses exit/stdout/stderr drift to the stable bootstrap failure', async () => {
    for (const output of [
      { stdout: 'wrong\n' },
      { stdout: 'wrong\n', code: 1 },
      { stdout: '', stderr: 'private upstream diagnostic' },
      { stdout: 'x'.repeat(4 * 1024 + 1) },
    ]) {
      const value = await fixture()
      await expectBootstrapFailure(
        runFffCapabilityProbe(
          {
            binaryPath: '/sealed/opencode',
            runRoot: value.runRoot,
            probe: value.probe,
            timeoutMs: 1_000,
          },
          {
            requireBwrap: async (path) => path,
            spawn: () => fakeProcess(output),
            timeout: () => new Promise(() => {}),
          },
        ),
      )
    }
  })

  test('times out and terminates the dedicated probe process group', async () => {
    const value = await fixture()
    const signals: NodeJS.Signals[] = []
    await expectBootstrapFailure(
      runFffCapabilityProbe(
        {
          binaryPath: '/sealed/opencode',
          runRoot: value.runRoot,
          probe: value.probe,
          timeoutMs: 1_000,
        },
        {
          requireBwrap: async (path) => path,
          spawn: () =>
            fakeProcess({
              stdout: '',
              close: false,
              onKill: (signal) => signals.push(signal),
            }),
          timeout: async () => undefined,
        },
      ),
    )
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
