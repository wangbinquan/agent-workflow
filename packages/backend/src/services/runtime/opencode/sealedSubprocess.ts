// RFC-224 — the only shell/local-MCP subprocess boundary admitted by the
// verified OpenCode launcher. The tiny on-disk wrapper re-enters this binary;
// this module then constructs bwrap argv directly (no model-controlled shell
// interpolation) and rebuilds the child environment from an allowlist.

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { IS_EMBEDDED } from '@/embed'
import { executionIdentityFailure } from './failure'

const SAFE_ENV_NAME =
  /^(?:LANG|LC_ALL|LC_CTYPE|TERM|TZ|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL|[A-Z][A-Z0-9_]{0,127})$/
const DANGEROUS_ENV_NAME =
  /^(?:OPENCODE_|NODE_OPTIONS$|NODE_PATH$|BUN_|DENO_|PYTHON|RUBY|PERL|LD_|DYLD_|BASH_ENV$|ENV$|ZDOTDIR$|GIT_CONFIG|GIT_EXEC|GIT_SSH|SSH_AUTH_SOCK$|DISPLAY$|WAYLAND_DISPLAY$|ELECTRON_RUN_AS_NODE$|NPM_CONFIG_SCRIPT_SHELL$|COREPACK_|EDITOR$|VISUAL$|PAGER$)/i
const BWRAP_CAPABILITY_TIMEOUT_MS = 5_000
const BWRAP_CAPABILITY_STOP_GRACE_MS = 250
const BWRAP_CAPABILITY_STOP_POLL_MS = 25
const BWRAP_CAPABILITY_REPORT_LIMIT_BYTES = 512
const BWRAP_CAPABILITY_WATCHDOG_MS = 10_000
const BWRAP_CAPABILITY_RELEASE_MARGIN_MS = 2_000
const BWRAP_CAPABILITY_CONTROL_LIMIT_BYTES = 512
const BWRAP_CAPABILITY_SUPERVISOR_SUBCOMMAND = '__opencode-bwrap-capability-supervisor'
const NANOSECONDS_PER_MILLISECOND = 1_000_000n

interface RootOwnedBwrapStopState {
  groupExited: boolean
}

type RootOwnedBwrapSignalState = 'owned' | 'releasing' | 'released'

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0') && resolve(value) === value)

export const NetlessSubprocessManifestSchema = z
  .object({
    codec: z.literal(1),
    mode: z.enum(['shell', 'mcp']),
    bwrapPath: AbsolutePathSchema,
    worktreePath: AbsolutePathSchema,
    scratchPath: AbsolutePathSchema,
    appHome: AbsolutePathSchema,
    realHome: AbsolutePathSchema,
    bindReadOnly: z.array(AbsolutePathSchema).max(256),
    env: z.record(z.string()),
    command: z.array(z.string()).min(1).max(256),
  })
  .strict()

export type NetlessSubprocessManifest = z.infer<typeof NetlessSubprocessManifestSchema>

function shellQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function verifiedSelfCommand(subcommand: string, args: readonly string[]): string[] {
  if (!/^__[a-z0-9-]+$/.test(subcommand)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  if (IS_EMBEDDED) return [process.execPath, subcommand, ...args]
  const mainPath = resolve(import.meta.dir, '../../../main.ts')
  return [process.execPath, 'run', mainPath, subcommand, ...args]
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function writeExclusiveRegular(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    mode,
  )
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  } finally {
    await handle.close()
  }
  await chmod(path, mode)
}

export function sanitizeNetlessEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      !SAFE_ENV_NAME.test(name) ||
      DANGEROUS_ENV_NAME.test(name)
    ) {
      if (value !== undefined && DANGEROUS_ENV_NAME.test(name)) {
        return executionIdentityFailure('execution-identity-mismatch')
      }
      continue
    }
    output[name] = value
  }
  return output
}

export interface RootOwnedBwrapCapabilityProcess {
  readonly exited: Promise<number>
  killGroup(signal: NodeJS.Signals): void
  isGroupAlive(): boolean
  hasSignalOwnership?(): boolean
}

export interface RootOwnedBwrapDependencies {
  spawn?: (command: readonly string[]) => RootOwnedBwrapCapabilityProcess
  timeout?: (milliseconds: number) => Promise<void>
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds)
    timer.unref?.()
  })
}

function remainingMilliseconds(deadline: bigint): number {
  const remaining = deadline - process.hrtime.bigint()
  if (remaining <= 0n) return 0
  return Math.max(
    1,
    Number((remaining + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND),
  )
}

async function settleBefore<T>(
  promise: Promise<T>,
  deadline: bigint,
  timeoutMessage: string,
): Promise<T> {
  const remaining = remainingMilliseconds(deadline)
  if (remaining === 0) throw new Error(timeoutMessage)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), remaining)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function isSafeRootOwnedBwrapMode(mode: number): boolean {
  return (
    Number.isSafeInteger(mode) &&
    mode >= 0 &&
    (mode & 0o6000) === 0 &&
    (mode & 0o022) === 0 &&
    (mode & 0o111) !== 0
  )
}

function killCurrentProcessGroup(): never {
  try {
    process.kill(-process.pid, 'SIGKILL')
  } finally {
    // SIGKILL is delivered synchronously to the owned group. This fallback
    // only terminates the supervisor if the platform unexpectedly rejects the
    // group signal; it is never used to target a child by a reusable PID.
    process.exit(125)
  }
}

async function readBoundedSupervisorControl(): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let value = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      value += decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(value, 'utf8') > BWRAP_CAPABILITY_CONTROL_LIMIT_BYTES) {
        throw new Error('bwrap capability supervisor control exceeded its bound')
      }
    }
    value += decoder.decode()
    return value
  } finally {
    reader.releaseLock()
  }
}

/**
 * Hidden RFC-224 process-group anchor. It is the real parent of bwrap, watches
 * the daemon-owned control pipe from the moment it starts, and kills its whole
 * group on EOF, malformed control, or the hard deadline. The parent therefore
 * never needs a positive-PID fallback and bwrap's --die-with-parent refers to
 * this still-live, verified-self supervisor.
 */
export async function runRootOwnedBwrapCapabilitySupervisor(
  nonce: string,
  watchdogMilliseconds: number,
  command: readonly string[],
): Promise<number> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce) ||
    watchdogMilliseconds !== BWRAP_CAPABILITY_WATCHDOG_MS ||
    command.length === 0 ||
    command.length > 64 ||
    command.some((value) => value.length === 0 || value.includes('\0'))
  ) {
    return 125
  }

  // Caught dispositions reset to default across exec, so the bwrap child
  // remains TERM-responsive while this group leader survives host TERM long
  // enough to authenticate and report the exact capability outcome.
  const ignoreSignal = () => undefined
  process.on('SIGHUP', ignoreSignal)
  process.on('SIGINT', ignoreSignal)
  process.on('SIGTERM', ignoreSignal)

  const expectedControl = `RFC224_BWRAP_ACK ${nonce}\n`
  const control = readBoundedSupervisorControl().then(
    (value) => {
      if (value !== expectedControl) return killCurrentProcessGroup()
    },
    () => killCurrentProcessGroup(),
  )
  void control.catch(() => undefined)

  const watchdog = setTimeout(killCurrentProcessGroup, watchdogMilliseconds)
  const output = Bun.stdout.writer()
  let code = 125
  try {
    const child = Bun.spawn({
      cmd: [...command],
      cwd: '/',
      env: {},
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    code = await child.exited
  } catch {
    // A spawn failure is an ordinary negative capability result. It still
    // traverses the authenticated report/release protocol before this group
    // leader exits.
  }

  try {
    output.write(`RFC224_BWRAP_EXIT ${nonce} ${code}\n`)
    await output.flush()
    await control
    output.write(`RFC224_BWRAP_RELEASE ${nonce}\n`)
    await output.flush()
    clearTimeout(watchdog)
    return killCurrentProcessGroup()
  } catch {
    return killCurrentProcessGroup()
  }
}

function spawnRootOwnedBwrapCapability(
  command: readonly string[],
): RootOwnedBwrapCapabilityProcess {
  const nonce = randomUUID()
  const child = Bun.spawn({
    cmd: verifiedSelfCommand(BWRAP_CAPABILITY_SUPERVISOR_SUBCOMMAND, [
      '--nonce',
      nonce,
      '--watchdog-ms',
      String(BWRAP_CAPABILITY_WATCHDOG_MS),
      '--',
      ...command,
    ]),
    cwd: '/',
    env: {},
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    detached: true,
  })
  const releaseDeadline =
    process.hrtime.bigint() +
    BigInt(BWRAP_CAPABILITY_WATCHDOG_MS + BWRAP_CAPABILITY_RELEASE_MARGIN_MS) *
      NANOSECONDS_PER_MILLISECOND
  let signalState: RootOwnedBwrapSignalState = 'owned'
  let groupExited = false
  const exited = (async () => {
    let reader: ReturnType<typeof child.stdout.getReader> | undefined
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    let bwrapCode: number | undefined
    let protocolFailure: unknown = null
    try {
      const acquiredReader = child.stdout.getReader()
      reader = acquiredReader
      for (;;) {
        const next = await settleBefore(
          acquiredReader.read(),
          releaseDeadline,
          'bwrap capability supervisor report deadline exceeded',
        )
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        if (Buffer.byteLength(buffered, 'utf8') > BWRAP_CAPABILITY_REPORT_LIMIT_BYTES) {
          throw new Error('bwrap capability supervisor report exceeded its bound')
        }
        const newline = buffered.indexOf('\n')
        if (newline < 0) continue
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const match = new RegExp(`^RFC224_BWRAP_EXIT ${nonce} ([0-9]{1,3})$`).exec(line)
        const parsedCode = match?.[1] === undefined ? Number.NaN : Number(match[1])
        if (
          !Number.isSafeInteger(parsedCode) ||
          parsedCode < 0 ||
          parsedCode > 255 ||
          buffered !== ''
        ) {
          throw new Error('invalid bwrap capability supervisor report')
        }
        bwrapCode = parsedCode
        break
      }
      if (bwrapCode === undefined) {
        throw new Error('bwrap capability supervisor exited before its report')
      }

      // The verified-self supervisor cannot exit before receiving this exact
      // EOF-delimited ACK. Relinquish host signaling synchronously before the
      // first byte: from here, its control guardian and hard watchdog are the
      // only cleanup authorities, so a racing timeout cannot hit a reused PGID.
      signalState = 'releasing'
      await settleBefore(
        Promise.resolve(child.stdin.write(`RFC224_BWRAP_ACK ${nonce}\n`)),
        releaseDeadline,
        'bwrap capability supervisor ACK write deadline exceeded',
      )
      await settleBefore(
        Promise.resolve(child.stdin.flush()),
        releaseDeadline,
        'bwrap capability supervisor ACK flush deadline exceeded',
      )
      await settleBefore(
        Promise.resolve(child.stdin.end()),
        releaseDeadline,
        'bwrap capability supervisor ACK close deadline exceeded',
      )

      let releaseReceived = false
      for (;;) {
        const next = await settleBefore(
          acquiredReader.read(),
          releaseDeadline,
          'bwrap capability supervisor release deadline exceeded',
        )
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        if (Buffer.byteLength(buffered, 'utf8') > BWRAP_CAPABILITY_REPORT_LIMIT_BYTES) {
          throw new Error('bwrap capability supervisor release exceeded its bound')
        }
        const newline = buffered.indexOf('\n')
        if (newline < 0) continue
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (releaseReceived || line !== `RFC224_BWRAP_RELEASE ${nonce}` || buffered !== '') {
          throw new Error('invalid bwrap capability supervisor release')
        }
        releaseReceived = true
      }
      buffered += decoder.decode()
      if (!releaseReceived || buffered !== '') {
        throw new Error('partial trailing bwrap capability supervisor output')
      }
    } catch (error) {
      protocolFailure = error
    } finally {
      try {
        await settleBefore(
          Promise.resolve(child.stdin.end()),
          releaseDeadline,
          'bwrap capability supervisor control close deadline exceeded',
        )
      } catch (error) {
        protocolFailure ??= error
      }
      if (reader !== undefined) {
        try {
          reader.releaseLock()
        } catch (error) {
          protocolFailure ??= error
        }
      }
    }

    let supervisorCode: number | undefined
    try {
      supervisorCode = await settleBefore(
        child.exited,
        releaseDeadline,
        'bwrap capability supervisor exit deadline exceeded',
      )
    } catch (error) {
      protocolFailure ??= error
    }

    // Do not settle the exported protocol promise until the real direct
    // supervisor is reaped and this owned PGID has been observed absent.
    // Once absent is latched, a later same-number group is never considered.
    while (!groupExited && remainingMilliseconds(releaseDeadline) > 0) {
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          groupExited = true
          break
        }
      }
      if (!groupExited) {
        await delay(
          Math.min(
            BWRAP_CAPABILITY_STOP_POLL_MS,
            Math.max(1, remainingMilliseconds(releaseDeadline)),
          ),
        )
      }
    }
    if (!groupExited) {
      protocolFailure ??= new Error('bwrap capability supervisor group release deadline exceeded')
    }
    signalState = 'released'

    if (protocolFailure !== null) throw protocolFailure
    if (bwrapCode === undefined || supervisorCode !== 137) {
      throw new Error('bwrap capability supervisor exit mismatch')
    }
    return bwrapCode
  })()
  void exited.catch(() => undefined)
  return {
    exited,
    killGroup: (signal) => {
      if (signalState !== 'owned' || groupExited) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        // ESRCH/unknown never justify a positive-PID fallback.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupExited = true
      }
    },
    isGroupAlive: () => {
      if (groupExited) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        // ESRCH is the only proof that this PGID is absent. Treat permission
        // and unknown failures as live so cleanup remains fail-closed.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
        groupExited = true
        return false
      }
    },
    hasSignalOwnership: () => signalState === 'owned',
  }
}

function rootOwnedBwrapGroupAlive(child: RootOwnedBwrapCapabilityProcess): boolean {
  try {
    return child.isGroupAlive()
  } catch {
    // Unknown liveness is not proof that the process group is absent.
    return true
  }
}

function rootOwnedBwrapHasSignalOwnership(
  child: RootOwnedBwrapCapabilityProcess,
  isDirectSettled: () => boolean,
): boolean {
  try {
    return child.hasSignalOwnership?.() ?? !isDirectSettled()
  } catch {
    return false
  }
}

async function waitForRootOwnedBwrapCapabilityStop(
  child: RootOwnedBwrapCapabilityProcess,
  isDirectSettled: () => boolean,
  timeout: (milliseconds: number) => Promise<void>,
  state: RootOwnedBwrapStopState,
): Promise<boolean> {
  const polls = Math.ceil(BWRAP_CAPABILITY_STOP_GRACE_MS / BWRAP_CAPABILITY_STOP_POLL_MS)
  for (let index = 0; index <= polls; index += 1) {
    const directSettled = isDirectSettled()
    if (!state.groupExited) {
      state.groupExited = !rootOwnedBwrapGroupAlive(child)
    }
    if (directSettled && state.groupExited) return true
    if (index < polls) await timeout(BWRAP_CAPABILITY_STOP_POLL_MS)
  }
  return false
}

async function terminateRootOwnedBwrapCapability(
  child: RootOwnedBwrapCapabilityProcess,
  isDirectSettled: () => boolean,
  timeout: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const state: RootOwnedBwrapStopState = { groupExited: false }
  if (!rootOwnedBwrapHasSignalOwnership(child, isDirectSettled)) return false
  child.killGroup('SIGTERM')
  if (await waitForRootOwnedBwrapCapabilityStop(child, isDirectSettled, timeout, state)) {
    return true
  }
  // A settled direct leader no longer gives us an owned numeric PGID. If the
  // old number still appears live, treat it as ambiguous (including immediate
  // PGID reuse) and fail closed without signaling it again.
  if (
    isDirectSettled() ||
    state.groupExited ||
    !rootOwnedBwrapHasSignalOwnership(child, isDirectSettled)
  ) {
    return false
  }
  child.killGroup('SIGKILL')
  return waitForRootOwnedBwrapCapabilityStop(child, isDirectSettled, timeout, state)
}

export async function requireRootOwnedBwrap(
  path = Bun.which('bwrap'),
  dependencies: RootOwnedBwrapDependencies = {},
): Promise<string> {
  const spawn = dependencies.spawn ?? spawnRootOwnedBwrapCapability
  const timeout = dependencies.timeout ?? delay
  let child: RootOwnedBwrapCapabilityProcess | undefined
  let exited = false
  let resolvedPath: string | undefined
  let failed = false
  let cleanupFailed = false
  try {
    if (path === null || !isAbsolute(path)) {
      executionIdentityFailure('execution-identity-sandbox-required')
    }
    const resolved = await realpath(path)
    const before = await lstat(resolved)
    const metadata = await stat(resolved)
    if (
      before.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      !isSafeRootOwnedBwrapMode(metadata.mode)
    ) {
      executionIdentityFailure('execution-identity-sandbox-required')
    }
    child = spawn([
      resolved,
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
    const code = await Promise.race([
      child.exited.then(
        (value) => {
          exited = true
          return value
        },
        (error: unknown) => {
          exited = true
          throw error
        },
      ),
      timeout(BWRAP_CAPABILITY_TIMEOUT_MS).then(() => null),
    ])
    if (code !== 0 || rootOwnedBwrapGroupAlive(child)) {
      executionIdentityFailure('execution-identity-sandbox-required')
    }
    resolvedPath = resolved
  } catch {
    failed = true
  } finally {
    if (child !== undefined && rootOwnedBwrapGroupAlive(child)) {
      if (exited) {
        // Never signal a numeric PGID after its direct leader has settled.
        cleanupFailed = true
      } else if (!rootOwnedBwrapHasSignalOwnership(child, () => exited)) {
        // ACK release is outcome-unknown until the guardian/watchdog reaps the
        // real supervisor and latches PGID absence. Wait for that authority;
        // never signal the numeric group during or after this handoff.
        try {
          await child.exited
        } catch {
          // A negative/invalid capability result is expected on this path.
        }
        cleanupFailed = rootOwnedBwrapGroupAlive(child)
      } else {
        try {
          let stopped = await terminateRootOwnedBwrapCapability(child, () => exited, timeout)
          if (!stopped && !exited && !rootOwnedBwrapHasSignalOwnership(child, () => exited)) {
            try {
              await child.exited
            } catch {
              // The handoff can complete with a negative capability result.
            }
            stopped = !rootOwnedBwrapGroupAlive(child)
          }
          cleanupFailed = !stopped
        } catch {
          cleanupFailed = true
        }
      }
    }
  }
  if (failed || cleanupFailed || resolvedPath === undefined) {
    return executionIdentityFailure('execution-identity-sandbox-required')
  }
  return resolvedPath
}

export interface MaterializeNetlessWrapperInput {
  wrapperPath: string
  manifestPath: string
  manifest: NetlessSubprocessManifest
}

export async function materializeNetlessWrapper(
  input: MaterializeNetlessWrapperInput,
): Promise<void> {
  const manifest = NetlessSubprocessManifestSchema.parse(input.manifest)
  if (!contained(dirname(input.wrapperPath), input.manifestPath)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await writeExclusiveRegular(input.manifestPath, JSON.stringify(manifest), 0o400)
  const command = verifiedSelfCommand('__opencode-netless-subprocess', [
    '--manifest',
    input.manifestPath,
  ])
  const script = `#!/bin/sh\nexec ${command.map(shellQuote).join(' ')} "$@"\n`
  await writeExclusiveRegular(input.wrapperPath, script, 0o500)
}

async function readManifest(path: string): Promise<NetlessSubprocessManifest> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1024 * 1024) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
  )
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const value = JSON.parse(await handle.readFile('utf8')) as unknown
    return NetlessSubprocessManifestSchema.parse(value)
  } catch {
    return executionIdentityFailure('execution-identity-store-unsafe')
  } finally {
    await handle.close()
  }
}

function uniqueMaskRoots(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length)
  return sorted.filter((candidate, index) =>
    sorted.slice(0, index).every((parent) => !contained(parent, candidate)),
  )
}

function parentDirs(maskRoot: string, target: string): string[] {
  if (!contained(maskRoot, target) || target === maskRoot) return []
  const result: string[] = []
  let cursor = dirname(target)
  while (cursor !== maskRoot && contained(maskRoot, cursor)) {
    result.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return result.reverse()
}

export function renderNetlessBwrapArgs(
  manifest: NetlessSubprocessManifest,
  passthroughArgs: readonly string[],
): string[] {
  const parsed = NetlessSubprocessManifestSchema.parse(manifest)
  if (passthroughArgs.some((entry) => entry.includes('\0'))) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const masks = uniqueMaskRoots([parsed.realHome, parsed.appHome, '/tmp', '/var/tmp'])
  const writable = [parsed.worktreePath, parsed.scratchPath]
  for (const target of [...writable, ...parsed.bindReadOnly]) {
    // A later bind of an ancestor would hide an earlier tmpfs mask and
    // re-expose the secret tree wholesale. Descendants are intentional:
    // parentDirs recreates only their path and the final bind exposes exactly
    // that file/tree (for example one frozen skill or one MCP executable).
    if (masks.some((mask) => contained(target, mask))) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  }
  for (const target of parsed.bindReadOnly) {
    // RO overlays are applied after RW worktree/scratch allow-backs. Never let
    // a broad read-only target replace either writable root; an exact child
    // file remains admissible.
    if (writable.some((root) => contained(target, root))) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  }
  const args = [
    '--die-with-parent',
    '--unshare-net',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
  ]
  for (const mask of masks) args.push('--tmpfs', mask)
  for (const target of [...writable, ...parsed.bindReadOnly]) {
    for (const dir of masks.flatMap((mask) => parentDirs(mask, target))) {
      args.push('--dir', dir)
    }
  }
  for (const target of writable) args.push('--bind', target, target)
  for (const target of parsed.bindReadOnly) args.push('--ro-bind', target, target)
  args.push('--chdir', parsed.worktreePath)
  for (const [name, value] of Object.entries(parsed.env).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    args.push('--setenv', name, value)
  }
  args.push('--')
  if (parsed.mode === 'shell') {
    args.push(...parsed.command, ...passthroughArgs)
  } else {
    if (passthroughArgs.length > 0) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    args.push(...parsed.command)
  }
  return args
}

export async function runNetlessSubprocess(
  manifestPath: string,
  passthroughArgs: readonly string[],
): Promise<number> {
  const manifest = await readManifest(manifestPath)
  const cmd = [manifest.bwrapPath, ...renderNetlessBwrapArgs(manifest, passthroughArgs)]
  const child = Bun.spawn({
    cmd,
    cwd: manifest.worktreePath,
    env: {},
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exited
}
