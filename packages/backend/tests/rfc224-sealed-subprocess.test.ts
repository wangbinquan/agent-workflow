// RFC-224 regression: root ownership and safe mode bits do not prove that the
// host permits bwrap to create its required namespaces. Admission must execute
// one bounded, exact-surface capability trial before trusting the sandbox TCB.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  isSafeRootOwnedBwrapMode,
  renderNetlessBwrapArgs,
  renderNetlessSeatbeltProfile,
  requireRootOwnedBwrap,
  sanitizeNetlessEnvironment,
  type NetlessSubprocessManifest,
  type RootOwnedBwrapCapabilityProcess,
  type RootOwnedBwrapDependencies,
  type RootOwnedBwrapPathDependencies,
} from '@/services/runtime/opencode/sealedSubprocess'
import { NO_POSIX_CONTAINMENT } from './fixtures/platformScope'

const ROOT_OWNED_EXECUTABLE = '/usr/bin/true'
const TEST_ROOT_OWNED_PATHS = new Set([ROOT_OWNED_EXECUTABLE, '/usr/bin', '/usr', '/'])

function testRootOwnedPathMetadata(path: string) {
  if (!TEST_ROOT_OWNED_PATHS.has(path)) {
    throw new Error(`unexpected root-owned test path: ${path}`)
  }
  const executable = path === ROOT_OWNED_EXECUTABLE
  return {
    uid: 0,
    mode: executable ? 0o100755 : 0o040755,
    isSymbolicLink: () => false,
    isFile: () => executable,
    isDirectory: () => !executable,
  }
}

const TEST_ROOT_OWNED_PATH_METADATA: RootOwnedBwrapPathDependencies = {
  realpath: async (path) => {
    if (path !== ROOT_OWNED_EXECUTABLE) {
      throw new Error(`unexpected root-owned executable: ${path}`)
    }
    return path
  },
  lstat: async (path) => testRootOwnedPathMetadata(path),
  stat: async (path) => testRootOwnedPathMetadata(path),
}

function requireTestRootOwnedBwrap(
  dependencies: Omit<RootOwnedBwrapDependencies, 'pathMetadata'> = {},
): Promise<string> {
  return requireRootOwnedBwrap(ROOT_OWNED_EXECUTABLE, {
    ...dependencies,
    pathMetadata: TEST_ROOT_OWNED_PATH_METADATA,
  })
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let value = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) throw new Error('stream closed before line')
      value += decoder.decode(next.value, { stream: true })
      const newline = value.indexOf('\n')
      if (newline >= 0) return value.slice(0, newline)
    }
  } finally {
    reader.releaseLock()
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

async function closeSupervisorControl(
  child: ReturnType<typeof Bun.spawn>,
  maximumWaitMilliseconds = 12_000,
): Promise<void> {
  try {
    if (child.stdin !== undefined && typeof child.stdin !== 'number') {
      await child.stdin.end()
    }
  } catch {
    // EOF guardian or watchdog remains the only cleanup authority.
  }
  await Promise.race([
    child.exited.then(
      () => undefined,
      () => undefined,
    ),
    Bun.sleep(maximumWaitMilliseconds),
  ])
}

function manifest(patch: Partial<NetlessSubprocessManifest> = {}): NetlessSubprocessManifest {
  return {
    codec: 1,
    mode: 'mcp',
    provider: {
      providerId: 'linux-bwrap',
      config: { bwrapPath: '/usr/bin/bwrap' },
    },
    worktreePath: '/home/operator/worktree',
    scratchPath: '/srv/agent-workflow/runs/run-a/scratch',
    appHome: '/srv/agent-workflow',
    realHome: '/home/operator',
    gitCommonDirs: ['/srv/agent-workflow/repos/project.git'],
    bindReadOnly: [
      '/srv/agent-workflow/runs/run-a/seal/skills/skill-a',
      '/home/operator/bin/mcp-a',
    ],
    env: {
      HOME: '/srv/agent-workflow/stores/store-a/home',
      TMPDIR: '/srv/agent-workflow/stores/store-a/tmp',
      PATH: '/usr/bin:/bin',
    },
    command: ['/home/operator/bin/mcp-a', '--stdio'],
    ...patch,
  }
}

function capabilityProcess(input: {
  code?: number
  pending?: boolean
  groupAlive?: boolean | (() => boolean)
  signals: NodeJS.Signals[]
}): RootOwnedBwrapCapabilityProcess {
  return {
    exited:
      input.pending === true ? new Promise<number>(() => {}) : Promise.resolve(input.code ?? 0),
    killGroup: (signal) => input.signals.push(signal),
    isGroupAlive: () =>
      typeof input.groupAlive === 'function' ? input.groupAlive() : (input.groupAlive ?? false),
  }
}

describe('RFC-224 sealed model-reachable subprocess boundary', () => {
  test.skipIf(NO_POSIX_CONTAINMENT)(
    'requires a real root-owned bwrap capability trial with the complete namespace boundary',
    async () => {
      const signals: NodeJS.Signals[] = []
      let command: readonly string[] = []
      await expect(
        requireTestRootOwnedBwrap({
          spawn: (value) => {
            command = value
            return capabilityProcess({ signals })
          },
          timeout: () => new Promise(() => {}),
        }),
      ).resolves.toBe(ROOT_OWNED_EXECUTABLE)

      expect(command).toEqual([
        ROOT_OWNED_EXECUTABLE,
        '--die-with-parent',
        '--new-session',
        '--unshare-net',
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--clearenv',
        '--',
        '/bin/true',
      ])
      expect(signals).toEqual([])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'filesystem qualification proves only the outer boundary and omits network namespace demand',
    async () => {
      let command: readonly string[] = []
      await expect(
        requireTestRootOwnedBwrap({
          trial: 'filesystem',
          spawn: (value) => {
            command = value
            return capabilityProcess({ signals: [] })
          },
          timeout: () => new Promise(() => {}),
        }),
      ).resolves.toBe(ROOT_OWNED_EXECUTABLE)

      expect(command).toContain('--unshare-pid')
      expect(command).not.toContain('--unshare-net')
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'uses an ownership-holding supervisor for the real capability process',
    async () => {
      await expect(requireTestRootOwnedBwrap()).resolves.toBe(ROOT_OWNED_EXECUTABLE)
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'relinquishes host signaling before writing the first ACK byte',
    async () => {
      const realSpawn = Bun.spawn
      const realKill = process.kill
      const parentSignals: NodeJS.Signals[] = []
      let interceptedChild: ReturnType<typeof Bun.spawn> | undefined
      let resumeWrite: (() => void) | undefined
      let writeDeadline: ReturnType<typeof setTimeout> | undefined
      let resolveWriteEntered!: () => void
      let resolveTrialTimeout!: () => void
      const writeEntered = new Promise<void>((resolvePromise) => {
        resolveWriteEntered = resolvePromise
      })
      const trialTimeout = new Promise<void>((resolvePromise) => {
        resolveTrialTimeout = resolvePromise
      })

      Bun.spawn = ((options: Parameters<typeof Bun.spawn>[0]) => {
        const child = realSpawn(options as never)
        const command =
          typeof options === 'object' && options !== null && 'cmd' in options
            ? options.cmd
            : undefined
        if (
          !Array.isArray(command) ||
          !command.includes('__opencode-bwrap-capability-supervisor') ||
          child.stdin === undefined ||
          typeof child.stdin === 'number'
        ) {
          return child
        }
        interceptedChild = child
        const realSink = child.stdin as unknown as {
          write(value: string | Uint8Array): number | Promise<number>
        }
        const sink = new Proxy(realSink, {
          get(target, property) {
            if (property === 'write') {
              return (value: string | Uint8Array) => {
                resolveWriteEntered()
                resolveTrialTimeout()
                return new Promise<number>((resolvePromise, reject) => {
                  resumeWrite = () => {
                    resumeWrite = undefined
                    try {
                      Promise.resolve(realSink.write(value)).then(resolvePromise, reject)
                    } catch (error) {
                      reject(error)
                    }
                  }
                })
              }
            }
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function'
              ? (...args: unknown[]) => Reflect.apply(value, target, args)
              : value
          },
        })
        return new Proxy(child, {
          get(target, property) {
            if (property === 'stdin') return sink
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function'
              ? (...args: unknown[]) => Reflect.apply(value, target, args)
              : value
          },
        })
      }) as typeof Bun.spawn
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        if (
          interceptedChild !== undefined &&
          pid === -interceptedChild.pid &&
          signal !== undefined &&
          signal !== 0
        ) {
          parentSignals.push(signal as NodeJS.Signals)
        }
        return realKill(pid, signal)
      }) as typeof process.kill

      try {
        const admission = requireTestRootOwnedBwrap({
          timeout: (milliseconds) =>
            milliseconds === 5_000 ? trialTimeout : Bun.sleep(milliseconds),
        })
        let admissionSettled = false
        void admission.then(
          () => {
            admissionSettled = true
          },
          () => {
            admissionSettled = true
          },
        )

        await Promise.race([
          writeEntered,
          new Promise<never>((_, reject) => {
            // The production capability timeout is the injected logical promise
            // above. This separate bound only gives a coverage-loaded CI runner
            // enough time to start the real TypeScript supervisor process.
            writeDeadline = setTimeout(
              () => reject(new Error('capability supervisor did not reach its ACK write')),
              12_000,
            )
          }),
        ])
        // The trial timeout wins while the ACK write is still blocked before its
        // first byte. The host must already have handed signaling authority to
        // the supervisor guardian, so it can only await that release.
        await Bun.sleep(25)
        expect(parentSignals).toEqual([])
        expect(admissionSettled).toBe(false)
        resumeWrite?.()
        await expect(admission).rejects.toMatchObject({
          code: 'execution-identity-containment-required',
        })
        expect(parentSignals).toEqual([])
        expect(interceptedChild).toBeDefined()
        const group = { absent: false }
        await expectProcessGroupAbsent(interceptedChild!.pid, group)
      } finally {
        if (writeDeadline !== undefined) clearTimeout(writeDeadline)
        resumeWrite?.()
        process.kill = realKill
        Bun.spawn = realSpawn
        if (interceptedChild !== undefined) {
          await closeSupervisorControl(interceptedChild)
        }
      }
    },
    30_000,
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'supervisor control EOF kills its still-owned process group',
    async () => {
      const mainPath = resolve(import.meta.dir, '../src/main.ts')
      const nonce = '22222222-2222-4222-8222-222222222222'
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          'run',
          mainPath,
          '__opencode-bwrap-capability-supervisor',
          '--nonce',
          nonce,
          '--watchdog-ms',
          '10000',
          '--',
          ROOT_OWNED_EXECUTABLE,
        ],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      })
      const group = { absent: false }

      try {
        await expect(readLine(child.stdout)).resolves.toBe(`RFC224_BWRAP_EXIT ${nonce} 0`)
        await child.stdin.end()
        await expect(child.exited).resolves.toBe(137)
        await expectProcessGroupAbsent(child.pid, group)
      } finally {
        await closeSupervisorControl(child)
      }
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'authenticated release kills a ready same-group descendant before protocol settlement',
    async () => {
      const mainPath = resolve(import.meta.dir, '../src/main.ts')
      const nonce = '44444444-4444-4444-8444-444444444444'
      const directory = await mkdtemp(join(tmpdir(), 'rfc224-bwrap-supervisor-'))
      const marker = join(directory, 'descendant.pid')
      const target = [
        "const child = Bun.spawn({ cmd: ['/bin/sleep', '5'],",
        "stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });",
        `await Bun.write(${JSON.stringify(marker)}, String(child.pid));`,
        'process.exit(0);',
      ].join('')
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          'run',
          mainPath,
          '__opencode-bwrap-capability-supervisor',
          '--nonce',
          nonce,
          '--watchdog-ms',
          '10000',
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
      const group = { absent: false }

      try {
        await expect(readLine(child.stdout)).resolves.toBe(`RFC224_BWRAP_EXIT ${nonce} 0`)
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
        expect(() => process.kill(descendantPid, 0)).not.toThrow()
        expect(() => process.kill(-child.pid, 0)).not.toThrow()
        await child.stdin.write(`RFC224_BWRAP_ACK ${nonce}\n`)
        await child.stdin.flush()
        await child.stdin.end()
        await expect(readLine(child.stdout)).resolves.toBe(`RFC224_BWRAP_RELEASE ${nonce}`)
        await expect(child.exited).resolves.toBe(137)
        await expectProcessGroupAbsent(child.pid, group)
      } finally {
        await closeSupervisorControl(child)
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'daemon EOF kills a running capability child before any report',
    async () => {
      const mainPath = resolve(import.meta.dir, '../src/main.ts')
      const nonce = '33333333-3333-4333-8333-333333333333'
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          'run',
          mainPath,
          '__opencode-bwrap-capability-supervisor',
          '--nonce',
          nonce,
          '--watchdog-ms',
          '10000',
          '--',
          '/bin/sleep',
          '30',
        ],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      })
      const group = { absent: false }

      try {
        await child.stdin.end()
        await expect(child.exited).resolves.toBe(137)
        expect(await new Response(child.stdout).text()).toBe('')
        await expectProcessGroupAbsent(child.pid, group)
      } finally {
        await closeSupervisorControl(child)
      }
    },
  )

  test('rejects setuid/setgid and unsafe writable bwrap modes', () => {
    expect(isSafeRootOwnedBwrapMode(0o100755)).toBe(true)
    for (const mode of [0o104755, 0o102755, 0o106755, 0o100775, 0o100757, 0o100644]) {
      expect(isSafeRootOwnedBwrapMode(mode)).toBe(false)
    }
  })

  test('maps a non-zero bwrap capability trial to sandbox-required', async () => {
    const signals: NodeJS.Signals[] = []
    await expect(
      requireTestRootOwnedBwrap({
        spawn: () => capabilityProcess({ code: 1, signals }),
        timeout: () => new Promise(() => {}),
      }),
    ).rejects.toMatchObject({
      code: 'execution-identity-containment-required',
    })
    expect(signals).toEqual([])
  })

  test('maps a bwrap capability spawn failure to sandbox-required', async () => {
    await expect(
      requireTestRootOwnedBwrap({
        spawn: () => {
          throw new Error('private bwrap spawn diagnostic')
        },
      }),
    ).rejects.toMatchObject({
      code: 'execution-identity-containment-required',
    })
  })

  test('maps bwrap metadata lookup failure to sandbox-required', async () => {
    await expect(requireRootOwnedBwrap('/definitely-missing-rfc224-bwrap')).rejects.toMatchObject({
      code: 'execution-identity-containment-required',
    })
  })

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'ACK flush failure fails closed and leaves no supervisor process group',
    async () => {
      const realSpawn = Bun.spawn
      let supervisorPid: number | undefined
      const group = { absent: false }
      Bun.spawn = ((options: Parameters<typeof Bun.spawn>[0]) => {
        const child = realSpawn(options as never)
        const command =
          typeof options === 'object' && options !== null && 'cmd' in options
            ? options.cmd
            : undefined
        if (
          !Array.isArray(command) ||
          !command.includes('__opencode-bwrap-capability-supervisor') ||
          child.stdin === undefined ||
          typeof child.stdin === 'number'
        ) {
          return child
        }
        supervisorPid = child.pid
        const realSink = child.stdin
        const sink = new Proxy(realSink, {
          get(target, property) {
            if (property === 'flush') {
              return async () => {
                throw new Error('injected-flush-failure')
              }
            }
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function'
              ? (...args: unknown[]) => Reflect.apply(value, target, args)
              : value
          },
        })
        return new Proxy(child, {
          get(target, property) {
            if (property === 'stdin') return sink
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function'
              ? (...args: unknown[]) => Reflect.apply(value, target, args)
              : value
          },
        })
      }) as typeof Bun.spawn

      try {
        await expect(requireTestRootOwnedBwrap()).rejects.toMatchObject({
          code: 'execution-identity-containment-required',
        })
        expect(supervisorPid).toBeNumber()
        await expectProcessGroupAbsent(supervisorPid!, group)
      } finally {
        Bun.spawn = realSpawn
      }
    },
  )

  test('maps a rejected exit settlement without signaling its observed process group', async () => {
    const signals: NodeJS.Signals[] = []
    await expect(
      requireTestRootOwnedBwrap({
        spawn: () => ({
          exited: Promise.reject(new Error('private bwrap exit diagnostic')),
          killGroup: (signal) => signals.push(signal),
          isGroupAlive: () => false,
        }),
        timeout: () => new Promise(() => {}),
      }),
    ).rejects.toMatchObject({
      code: 'execution-identity-containment-required',
    })
    expect(signals).toEqual([])
  })

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'rejects an ambiguous live PGID after direct exit without signaling the old number',
    async () => {
      const signals: NodeJS.Signals[] = []
      const timeouts: number[] = []
      await expect(
        requireTestRootOwnedBwrap({
          spawn: () => ({
            exited: Promise.resolve(0),
            killGroup: (signal) => signals.push(signal),
            isGroupAlive: () => true,
          }),
          timeout: (milliseconds) => {
            timeouts.push(milliseconds)
            return milliseconds === 5_000 ? new Promise(() => {}) : Promise.resolve()
          },
        }),
      ).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(timeouts).toEqual([5_000])
      expect(signals).toEqual([])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'waits for released supervisor settlement and PGID absence without signaling',
    async () => {
      const signals: NodeJS.Signals[] = []
      let signalOwned = true
      let groupAlive = true
      let settleExit!: (code: number) => void
      let releaseOwnership!: () => void
      const ownershipReleased = new Promise<void>((resolve) => {
        releaseOwnership = resolve
      })
      const exited = new Promise<number>((resolve) => {
        settleExit = resolve
      })

      const admission = requireTestRootOwnedBwrap({
        spawn: () => ({
          exited,
          killGroup: (signal) => signals.push(signal),
          isGroupAlive: () => {
            if (signalOwned) {
              signalOwned = false
              releaseOwnership()
            }
            return groupAlive
          },
          hasSignalOwnership: () => signalOwned,
        }),
        timeout: async () => undefined,
      })
      let settled = false
      void admission.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )

      await ownershipReleased
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(signals).toEqual([])

      groupAlive = false
      settleExit(0)
      await expect(admission).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(signals).toEqual([])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'stops after SIGTERM only when the direct process settles and its group disappears',
    async () => {
      const signals: NodeJS.Signals[] = []
      const timeouts: number[] = []
      let groupAlive = true
      let settleExit!: (code: number) => void
      const exited = new Promise<number>((resolve) => {
        settleExit = resolve
      })

      await expect(
        requireTestRootOwnedBwrap({
          spawn: () => ({
            exited,
            killGroup: (signal) => {
              signals.push(signal)
              if (signal === 'SIGTERM') {
                groupAlive = false
                settleExit(143)
              }
            },
            isGroupAlive: () => groupAlive,
          }),
          timeout: async (milliseconds) => {
            timeouts.push(milliseconds)
          },
        }),
      ).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(timeouts[0]).toBe(5_000)
      expect(timeouts.slice(1)).toEqual([25])
      expect(signals).toEqual(['SIGTERM'])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'escalates to SIGKILL and stops only after the direct process and group disappear',
    async () => {
      const signals: NodeJS.Signals[] = []
      const timeouts: number[] = []
      let groupAlive = true
      let settleExit!: (code: number) => void
      const exited = new Promise<number>((resolve) => {
        settleExit = resolve
      })

      await expect(
        requireTestRootOwnedBwrap({
          spawn: () => ({
            exited,
            killGroup: (signal) => {
              signals.push(signal)
              if (signal === 'SIGKILL') {
                groupAlive = false
                settleExit(137)
              }
            },
            isGroupAlive: () => groupAlive,
          }),
          timeout: async (milliseconds) => {
            timeouts.push(milliseconds)
          },
        }),
      ).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(timeouts[0]).toBe(5_000)
      expect(timeouts.filter((value) => value === 25).length).toBeGreaterThan(10)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'does not SIGKILL an ambiguous PGID once the direct process settles after TERM',
    async () => {
      const signals: NodeJS.Signals[] = []
      const timeouts: number[] = []
      let settleExit!: (code: number) => void
      const exited = new Promise<number>((resolve) => {
        settleExit = resolve
      })

      await expect(
        requireTestRootOwnedBwrap({
          spawn: () => ({
            exited,
            killGroup: (signal) => {
              signals.push(signal)
              if (signal === 'SIGTERM') settleExit(143)
            },
            isGroupAlive: () => true,
          }),
          timeout: async (milliseconds) => {
            timeouts.push(milliseconds)
          },
        }),
      ).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(timeouts[0]).toBe(5_000)
      expect(timeouts.filter((value) => value === 25)).toHaveLength(10)
      expect(signals).toEqual(['SIGTERM'])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'latches the first absent PGID and never signals a later same-number group',
    async () => {
      const signals: NodeJS.Signals[] = []
      const timeouts: number[] = []
      let groupProbe = 0

      await expect(
        requireTestRootOwnedBwrap({
          spawn: () => ({
            exited: new Promise<number>(() => {}),
            killGroup: (signal) => signals.push(signal),
            isGroupAlive: () => {
              groupProbe += 1
              // The finally admission check still owns the original live group.
              // The first post-TERM probe observes ESRCH. Any later `true` is a
              // simulated same-number PGID reuse and must never trigger SIGKILL.
              return groupProbe !== 2
            },
          }),
          timeout: async (milliseconds) => {
            timeouts.push(milliseconds)
          },
        }),
      ).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(timeouts[0]).toBe(5_000)
      expect(timeouts.filter((value) => value === 25)).toHaveLength(10)
      expect(groupProbe).toBe(2)
      expect(signals).toEqual(['SIGTERM'])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'fails closed when the process group remains alive after SIGKILL',
    async () => {
      const signals: NodeJS.Signals[] = []
      const timeouts: number[] = []
      let settleExit!: (code: number) => void
      const exited = new Promise<number>((resolve) => {
        settleExit = resolve
      })
      await expect(
        requireTestRootOwnedBwrap({
          spawn: () => ({
            exited,
            killGroup: (signal) => {
              signals.push(signal)
              if (signal === 'SIGKILL') settleExit(137)
            },
            isGroupAlive: () => true,
          }),
          timeout: async (milliseconds) => {
            timeouts.push(milliseconds)
          },
        }),
      ).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(timeouts[0]).toBe(5_000)
      expect(timeouts.filter((value) => value === 25)).toHaveLength(20)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'does not treat an extinct group with a never-settling direct process as stopped',
    async () => {
      const signals: NodeJS.Signals[] = []
      const timeouts: number[] = []
      let groupAlive = true
      await expect(
        requireTestRootOwnedBwrap({
          spawn: () => ({
            exited: new Promise<number>(() => {}),
            killGroup: (signal) => {
              signals.push(signal)
              if (signal === 'SIGTERM') groupAlive = false
            },
            isGroupAlive: () => groupAlive,
          }),
          timeout: async (milliseconds) => {
            timeouts.push(milliseconds)
          },
        }),
      ).rejects.toMatchObject({
        code: 'execution-identity-containment-required',
      })
      expect(timeouts[0]).toBe(5_000)
      expect(timeouts.filter((value) => value === 25)).toHaveLength(10)
      expect(signals).toEqual(['SIGTERM'])
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'masks secret roots and rebinds only exact Git metadata and MCP executable paths',
    () => {
      const args = renderNetlessBwrapArgs(manifest(), [])
      expect(args).toContain('--unshare-net')
      expect(args).toContain('--unshare-pid')
      expect(args).toContain('--proc')

      const mounts: Array<[string, string, string]> = []
      for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--ro-bind') {
          mounts.push([args[index]!, args[index + 1]!, args[index + 2]!])
        }
      }
      expect(mounts).toContainEqual([
        '--ro-bind',
        '/home/operator/bin/mcp-a',
        '/home/operator/bin/mcp-a',
      ])
      expect(mounts).not.toContainEqual(['--ro-bind', '/home/operator/bin', '/home/operator/bin'])
      expect(args).toContain('/srv/agent-workflow/repos/project.git')
      expect(args).not.toContain('/srv/agent-workflow/secret.key')
      expect(args).toContain('/srv/agent-workflow/runs/run-a/seal/skills/skill-a')
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'rejects a read-only bind that can replace a secret mask or writable root',
    () => {
      for (const bindReadOnly of [
        ['/home'],
        ['/home/operator'],
        ['/srv'],
        ['/srv/agent-workflow'],
        ['/home/operator/worktree'],
        ['/srv/agent-workflow/runs/run-a'],
      ]) {
        expect(() => renderNetlessBwrapArgs(manifest({ bindReadOnly }), [])).toThrow(
          'execution-identity-store-unsafe',
        )
      }
    },
  )

  test.skipIf(NO_POSIX_CONTAINMENT)('rejects duplicate or broad Git common-dir projections', () => {
    expect(() =>
      renderNetlessBwrapArgs(
        manifest({
          gitCommonDirs: [
            '/srv/agent-workflow/repos/project.git',
            '/srv/agent-workflow/repos/project.git',
          ],
        }),
        [],
      ),
    ).toThrow('execution-identity-store-unsafe')
    for (const gitCommonDirs of [['/'], ['/home/operator'], ['/srv/agent-workflow']]) {
      expect(() => renderNetlessBwrapArgs(manifest({ gitCommonDirs }), [])).toThrow(
        'execution-identity-store-unsafe',
      )
    }
  })

  test.skipIf(NO_POSIX_CONTAINMENT)(
    'macOS provider profile denies child network and restores only exact writable/read-only roots',
    () => {
      const profile = renderNetlessSeatbeltProfile(
        manifest({
          provider: {
            providerId: 'macos-seatbelt',
            config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
          },
        }),
      )
      expect(profile).toContain('(deny network*)')
      expect(profile).toContain('(deny file-read* file-write* (subpath "/home/operator"))')
      expect(profile).toContain('(allow file-read-metadata (literal "/home/operator"))')
      expect(profile).toContain('(allow file-read-metadata (literal "/srv/agent-workflow"))')
      expect(profile).toContain('(allow file-read-metadata (literal "/srv/agent-workflow/runs"))')
      expect(profile).toContain(
        '(allow file-read* file-write* (subpath "/home/operator/worktree"))',
      )
      expect(profile).toContain(
        '(allow file-read* file-write* (subpath "/srv/agent-workflow/repos/project.git"))',
      )
      expect(profile).not.toContain(
        '(allow file-read* file-write* (subpath "/srv/agent-workflow"))',
      )
      expect(profile).not.toContain('(allow file-read* (subpath "/srv/agent-workflow"))')
      expect(profile).toContain('(deny file-write* (subpath "/home/operator/bin/mcp-a"))')
    },
  )

  test('rebuilds env and rejects loader, OpenCode, Git-exec, and shell-startup injection', () => {
    // RFC-254 T32 — `lower` is the one entry where the platforms legitimately
    // disagree, so both answers are asserted rather than one being skipped.
    //
    // The allowlist matches an ALL-CAPS SHAPE, and T2 made it fold the name
    // through `canonicalEnvKey` first because Windows env names are
    // case-INSENSITIVE: `SystemRoot`, `Temp` and `ProgramData` are spelled
    // mixed-case there, and a child that loses `SystemRoot` cannot even
    // initialise winsock. Folding therefore also admits `lower` on Windows.
    //
    // That admits nothing extra, which is why it is acceptable: on Windows
    // `lower` and `LOWER` ARE THE SAME VARIABLE, and the all-caps spelling was
    // always admitted, so no value becomes reachable that was not already. On
    // POSIX the two names are distinct and the shape filter drops the lowercase
    // one exactly as before. `DANGEROUS_ENV_NAME` is unaffected either way — it
    // already carried the `i` flag, so the refusals below hold on both.
    const rebuilt = sanitizeNetlessEnvironment({
      LANG: 'C.UTF-8',
      SAFE_TOKEN: 'allowed-by-explicit-MCP-policy',
      lower: 'ignored',
    })
    expect(rebuilt).toEqual(
      process.platform === 'win32'
        ? {
            LANG: 'C.UTF-8',
            SAFE_TOKEN: 'allowed-by-explicit-MCP-policy',
            lower: 'ignored',
          }
        : {
            LANG: 'C.UTF-8',
            SAFE_TOKEN: 'allowed-by-explicit-MCP-policy',
          },
    )
    for (const name of [
      'OPENCODE_SERVER_PASSWORD',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'BASH_ENV',
      'GIT_EXEC_PATH',
      'SSH_AUTH_SOCK',
    ]) {
      expect(() => sanitizeNetlessEnvironment({ [name]: 'secret' })).toThrow(
        'execution-identity-mismatch',
      )
    }
  })
})
