// RFC-224 T7a — a matching version/hash is insufficient when OpenCode can
// silently fall back from bundled FFF to ripgrep. These tests lock the sealed
// one-file/no-network/no-rg proof and its fail-closed decoder.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  groupAlive?: boolean | (() => boolean)
  onKill?: (signal: NodeJS.Signals) => void
}): FffCapabilityProbeProcess {
  return {
    pid: 4242,
    stdout: stream(input.stdout, input.close),
    stderr: stream(input.stderr ?? '', input.close),
    exited:
      input.close === false ? new Promise<number>(() => {}) : Promise.resolve(input.code ?? 0),
    killGroup: (signal) => input.onKill?.(signal),
    isGroupAlive: () =>
      typeof input.groupAlive === 'function'
        ? input.groupAlive()
        : (input.groupAlive ?? input.close === false),
  }
}

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  releaseLock(): void
}

interface BufferedByteReader {
  reader: ByteReader
  decoder: TextDecoder
  buffered: string
}

function bufferedByteReader(reader: ByteReader): BufferedByteReader {
  return {
    reader,
    decoder: new TextDecoder('utf-8', { fatal: true }),
    buffered: '',
  }
}

async function readLine(input: BufferedByteReader): Promise<string> {
  for (;;) {
    const newline = input.buffered.indexOf('\n')
    if (newline >= 0) {
      const line = input.buffered.slice(0, newline)
      input.buffered = input.buffered.slice(newline + 1)
      return line
    }
    const next = await input.reader.read()
    if (next.done) throw new Error('stream closed before line')
    if (next.value === undefined) continue
    input.buffered += input.decoder.decode(next.value, { stream: true })
  }
}

async function readText(input: BufferedByteReader): Promise<string> {
  let value = input.buffered
  input.buffered = ''
  for (;;) {
    const next = await input.reader.read()
    if (next.done) return value + input.decoder.decode()
    if (next.value === undefined) continue
    value += input.decoder.decode(next.value, { stream: true })
  }
}

interface ProcessGroupObservation {
  absent: boolean
}

async function expectProcessGroupAbsent(
  pid: number,
  observation: ProcessGroupObservation,
): Promise<void> {
  const deadline = Date.now() + 1_000
  for (;;) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') observation.absent = true
      expect(error).toMatchObject({ code: 'ESRCH' })
      return
    }
    if (Date.now() >= deadline) throw new Error(`process group ${pid} remained live`)
    await Bun.sleep(10)
  }
}

async function expectProcessAbsent(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      expect(error).toMatchObject({ code: 'ESRCH' })
      return
    }
    if (Date.now() >= deadline) throw new Error(`process ${pid} remained live`)
    await Bun.sleep(10)
  }
}

async function closeSupervisorControlAndWait(
  child: { stdin: { end(): number | Promise<number> } },
  exited: Promise<number>,
): Promise<void> {
  try {
    await child.stdin.end()
  } catch {
    // The verified supervisor may already have completed its own release.
  }
  await Promise.race([
    exited.then(
      () => undefined,
      () => undefined,
    ),
    Bun.sleep(1_000),
  ])
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
  test('keeps the hidden supervisor out of help and rejects argv drift', async () => {
    const mainPath = resolve(import.meta.dir, '../src/main.ts')
    const nonce = '44444444-4444-4444-8444-444444444444'
    const help = Bun.spawn({
      cmd: [process.execPath, 'run', mainPath, 'help'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [helpCode, helpStdout, helpStderr] = await Promise.all([
      help.exited,
      new Response(help.stdout).text(),
      new Response(help.stderr).text(),
    ])
    expect(helpCode).toBe(0)
    expect(helpStdout).not.toContain('__opencode-fff-capability-supervisor')
    expect(helpStderr).toBe('')

    const prefix = [process.execPath, 'run', mainPath, '__opencode-fff-capability-supervisor']
    const invalidArguments = [
      [],
      ['--nonce', 'not-a-nonce', '--watchdog-ms', '5000', '--cwd', '/', '--', '/bin/true'],
      ['--nonce', nonce, '--watchdog-ms', '05000', '--cwd', '/', '--', '/bin/true'],
      ['--nonce', nonce, '--watchdog-ms', '1000', '--cwd', '/', '--', '/bin/true'],
      ['--nonce', nonce, '--watchdog-ms', '5000', '--cwd', 'relative', '--', '/bin/true'],
      ['--nonce', nonce, '--watchdog-ms', '5000', '--cwd', '/', '/bin/true'],
      ['--nonce', nonce, '--watchdog-ms', '5000', '--cwd', '/', '--'],
    ]
    for (const args of invalidArguments) {
      const invalid = Bun.spawn({
        cmd: [...prefix, ...args],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        invalid.exited,
        new Response(invalid.stdout).text(),
        new Response(invalid.stderr).text(),
      ])
      expect(code, args.join(' ')).toBe(1)
      expect(stdout, args.join(' ')).toBe('')
      expect(stderr, args.join(' ')).toBe('AW_OPENCODE_FAILURE execution-identity-store-unsafe\n')
    }
  })

  test('uses an authenticated supervisor release before exposing probe output', async () => {
    const cwd = root()
    const mainPath = resolve(import.meta.dir, '../src/main.ts')
    const nonce = '44444444-4444-4444-8444-444444444444'
    const expectedOutput = 'aw-fff-supervisor-proof.txt\n'
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        mainPath,
        '__opencode-fff-capability-supervisor',
        '--nonce',
        nonce,
        '--watchdog-ms',
        '5000',
        '--cwd',
        cwd,
        '--',
        '/usr/bin/printf',
        expectedOutput,
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    const rawExited = child.exited.then((code) => code)
    const supervisorStderr = new Response(child.stderr).text()
    const group = { absent: false }

    try {
      const stdoutReader = bufferedByteReader(child.stdout.getReader())
      await expect(readLine(stdoutReader)).resolves.toBe(
        `RFC224_FFF_RESULT ${nonce} 0 ${Buffer.from(expectedOutput).toString('base64')} -`,
      )
      expect(stdoutReader.buffered).toBe('')
      await child.stdin.write(`RFC224_FFF_ACK ${nonce}\n`)
      await child.stdin.flush()
      const releaseRead = stdoutReader.reader.read()
      const earlyRelease = await Promise.race([
        releaseRead.then((value) => ({ value })),
        Bun.sleep(150).then(() => null),
      ])
      expect(earlyRelease).toBeNull()
      await child.stdin.end()
      const firstReleaseChunk = await Promise.race([
        releaseRead,
        Bun.sleep(1_000).then(() => {
          throw new Error('supervisor did not release after authenticated ACK EOF')
        }),
      ])
      if (firstReleaseChunk.done || firstReleaseChunk.value === undefined) {
        throw new Error('supervisor closed stdout before RELEASE')
      }
      stdoutReader.buffered += stdoutReader.decoder.decode(firstReleaseChunk.value, {
        stream: true,
      })
      const [remainingStdout, rawCode, stderr] = await Promise.all([
        readText(stdoutReader),
        rawExited,
        supervisorStderr,
      ])
      expect(remainingStdout).toBe(`RFC224_FFF_RELEASE ${nonce}\n`)
      stdoutReader.reader.releaseLock()
      expect(rawCode).toBe(137)
      expect(stderr).toBe('')
      await expectProcessGroupAbsent(child.pid, group)
    } finally {
      await closeSupervisorControlAndWait(child, rawExited)
    }
  })

  test('kills the owned group without RELEASE for a non-exact ACK', async () => {
    const cwd = root()
    const mainPath = resolve(import.meta.dir, '../src/main.ts')
    const nonce = '66666666-6666-4666-8666-666666666666'
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        mainPath,
        '__opencode-fff-capability-supervisor',
        '--nonce',
        nonce,
        '--watchdog-ms',
        '5000',
        '--cwd',
        cwd,
        '--',
        '/usr/bin/true',
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    const rawExited = child.exited.then((code) => code)
    const supervisorStderr = new Response(child.stderr).text()
    const group = { absent: false }

    try {
      const stdoutReader = bufferedByteReader(child.stdout.getReader())
      await expect(readLine(stdoutReader)).resolves.toBe(`RFC224_FFF_RESULT ${nonce} 0 - -`)
      expect(stdoutReader.buffered).toBe('')
      await child.stdin.write(`RFC224_FFF_ACK 77777777-7777-4777-8777-777777777777\n`)
      await child.stdin.flush()
      await child.stdin.end()
      const [remainingStdout, rawCode, stderr] = await Promise.all([
        readText(stdoutReader),
        rawExited,
        supervisorStderr,
      ])
      stdoutReader.reader.releaseLock()
      expect(remainingStdout).toBe('')
      expect(rawCode).toBe(137)
      expect(stderr).toBe('')
      await expectProcessGroupAbsent(child.pid, group)
    } finally {
      await closeSupervisorControlAndWait(child, rawExited)
    }
  })

  test('daemon EOF kills a descendant holding probe pipes after its direct parent exits', async () => {
    const cwd = root()
    const marker = join(cwd, 'descendant.pid')
    const mainPath = resolve(import.meta.dir, '../src/main.ts')
    const nonce = '55555555-5555-4555-8555-555555555555'
    const target = [
      'const child = Bun.spawn({',
      "cmd: ['/bin/sleep', '30'],",
      "stdin: 'ignore', stdout: 'inherit', stderr: 'inherit'",
      '});',
      `await Bun.write(${JSON.stringify(marker)}, String(child.pid));`,
      'process.exit(0);',
    ].join('')
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        mainPath,
        '__opencode-fff-capability-supervisor',
        '--nonce',
        nonce,
        '--watchdog-ms',
        '5000',
        '--cwd',
        cwd,
        '--',
        process.execPath,
        '-e',
        target,
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    const rawExited = child.exited.then((code) => code)
    const supervisorStdout = new Response(child.stdout).text()
    const supervisorStderr = new Response(child.stderr).text()
    const group = { absent: false }

    try {
      let descendantPid = Number.NaN
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          descendantPid = Number(await readFile(marker, 'utf8'))
          break
        } catch {
          await Bun.sleep(10)
        }
      }
      expect(Number.isSafeInteger(descendantPid)).toBe(true)
      await Bun.sleep(100)
      expect(() => process.kill(descendantPid, 0)).not.toThrow()

      let supervisorSettled = false
      void rawExited.then(() => {
        supervisorSettled = true
      })
      await Promise.resolve()
      expect(supervisorSettled).toBe(false)

      await child.stdin.end()
      const [rawCode, stdout, stderr] = await Promise.all([
        rawExited,
        supervisorStdout,
        supervisorStderr,
      ])
      expect(rawCode).toBe(137)
      expect(stdout).toBe('')
      expect(stderr).toBe('')
      await expectProcessAbsent(descendantPid)
      await expectProcessGroupAbsent(child.pid, group)
    } finally {
      await closeSupervisorControlAndWait(child, rawExited)
    }
  })

  test('preserves only sandbox-required from the second bwrap capability admission', async () => {
    const value = await fixture()
    let spawned = false
    const input = {
      binaryPath: '/sealed/opencode',
      runRoot: value.runRoot,
      probe: value.probe,
      timeoutMs: 1_000,
    }

    await expect(
      runFffCapabilityProbe(input, {
        requireBwrap: async () => {
          throw new ExecutionIdentityFailure('execution-identity-sandbox-required')
        },
        spawn: () => {
          spawned = true
          return fakeProcess({ stdout: '' })
        },
      }),
    ).rejects.toMatchObject({
      code: 'execution-identity-sandbox-required',
    })
    expect(spawned).toBe(false)

    await expectBootstrapFailure(
      runFffCapabilityProbe(input, {
        requireBwrap: async () => {
          throw new ExecutionIdentityFailure('execution-identity-mismatch')
        },
        spawn: () => {
          spawned = true
          return fakeProcess({ stdout: '' })
        },
      }),
    )
    expect(spawned).toBe(false)
  })

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

  test('waits for native release after TERM handoff without signaling the PGID again', async () => {
    const value = await fixture()
    const signals: NodeJS.Signals[] = []
    let signalOwned = true
    let groupAlive = true
    let cleanupPolls = 0
    let settleExit!: (code: number) => void
    let closeStdout!: () => void
    let closeStderr!: () => void
    const exited = new Promise<number>((resolvePromise) => {
      settleExit = resolvePromise
    })
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStdout = () => controller.close()
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStderr = () => controller.close()
      },
    })

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
          spawn: () => ({
            pid: 4242,
            stdout,
            stderr,
            exited,
            killGroup: (signal) => {
              signals.push(signal)
              if (signal === 'SIGTERM') signalOwned = false
            },
            isGroupAlive: () => groupAlive,
            hasSignalOwnership: () => signalOwned,
          }),
          timeout: async (milliseconds) => {
            if (milliseconds !== 25) return
            cleanupPolls += 1
            if (cleanupPolls === 12) {
              groupAlive = false
              closeStdout()
              closeStderr()
              settleExit(137)
            }
          },
        },
      ),
    )
    expect(cleanupPolls).toBeGreaterThan(10)
    expect(signals).toEqual(['SIGTERM'])
  })

  test('never signals an old PGID after the direct leader settles with descendant-held pipes', async () => {
    const value = await fixture()
    const signals: NodeJS.Signals[] = []
    let groupChecks = 0
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
          spawn: () => ({
            pid: 4242,
            stdout: stream('', false),
            stderr: stream('', false),
            exited: Promise.resolve(0),
            killGroup: (signal) => signals.push(signal),
            isGroupAlive: () => {
              groupChecks += 1
              return true
            },
          }),
          timeout: async () => {
            await Promise.resolve()
          },
        },
      ),
    )
    expect(groupChecks).toBeGreaterThan(0)
    expect(signals).toEqual([])
  })
})
