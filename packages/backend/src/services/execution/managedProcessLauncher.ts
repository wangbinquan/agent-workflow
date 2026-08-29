// RFC-328 — pre-activation launcher for task-owned managed processes.
//
// The launcher itself may exist before the durable PID receipt, but it cannot
// execute the requested runtime until its parent sends one activation frame.
// If the daemon dies or closes the control pipe first, EOF makes the launcher
// exit without ever spawning the target command.

import { IS_EMBEDDED } from '@/embed'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MANAGED_PROCESS_LAUNCHER_SUBCOMMAND = '__managed-process-launcher'
export const MANAGED_PROCESS_LAUNCH_NONCE_FLAG = '--launch-nonce'
export const MANAGED_PROCESS_LAUNCH_NONCE_ENV = 'AW_MANAGED_PROCESS_LAUNCH_NONCE'
export const MANAGED_PROCESS_WINDOWS_STDOUT_FLAG = '--windows-stdout-path'
export const MANAGED_PROCESS_WINDOWS_STDERR_FLAG = '--windows-stderr-path'
export const MANAGED_PROCESS_WINDOWS_CONTROL_FLAG = '--windows-control-path'
export const MANAGED_PROCESS_TARGET_SEPARATOR = '--'
export const MANAGED_PROCESS_LAUNCH_ERROR_PREFIX = '\u001eAW_MANAGED_PROCESS_LAUNCH_ERROR:'
export const MANAGED_PROCESS_LAUNCH_READY_PREFIX = '\u001eAW_MANAGED_PROCESS_LAUNCH_READY:'
export const MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX = '\u001eMANAGED_PROCESS_LAUNCH_OUTPUT:'

export interface WindowsManagedProcessOutputPaths {
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly controlPath: string
}

export interface ManagedProcessActivationFrame {
  readonly v: 1
  readonly launchNonce: string
  readonly targetArgv?: readonly string[]
  readonly stdin: Readonly<{ mode: 'ignore' }> | Readonly<{ mode: 'pipe'; data: string }>
  /**
   * Windows output destinations are repeated in the post-receipt frame. Bun's
   * compiled executable argv can omit application flags before `--`; the
   * activation pipe is the authoritative functional handoff once the durable
   * receipt has committed. The argv copy remains available for pre-frame error
   * reporting.
   */
  readonly windowsOutputPaths?: WindowsManagedProcessOutputPaths
}

function selfInvocation(): string[] {
  if (IS_EMBEDDED) return [process.execPath, MANAGED_PROCESS_LAUNCHER_SUBCOMMAND]
  // Development/test launches do not need to import the daemon's complete CLI
  // graph for every runtime attempt.  Invoke this deliberately small module
  // directly; the embedded binary keeps using main.ts's hidden subcommand.
  return [process.execPath, 'run', import.meta.path, MANAGED_PROCESS_LAUNCHER_SUBCOMMAND]
}

export function managedProcessLauncherArgv(input: {
  launchNonce: string
  targetArgv: readonly string[]
  windowsOutputPaths?: WindowsManagedProcessOutputPaths
}): string[] {
  if (input.launchNonce.length === 0 || input.targetArgv.length === 0) {
    throw new Error('managed process launcher requires a nonce and target argv')
  }
  return [
    ...selfInvocation(),
    MANAGED_PROCESS_LAUNCH_NONCE_FLAG,
    input.launchNonce,
    ...(input.windowsOutputPaths === undefined
      ? []
      : [
          MANAGED_PROCESS_WINDOWS_STDOUT_FLAG,
          input.windowsOutputPaths.stdoutPath,
          MANAGED_PROCESS_WINDOWS_STDERR_FLAG,
          input.windowsOutputPaths.stderrPath,
          MANAGED_PROCESS_WINDOWS_CONTROL_FLAG,
          input.windowsOutputPaths.controlPath,
        ]),
    MANAGED_PROCESS_TARGET_SEPARATOR,
    ...input.targetArgv,
  ]
}

function parseLauncherRequest(argv: readonly string[]): {
  launchNonce: string
  targetArgv: readonly string[]
  windowsOutputPaths?: WindowsManagedProcessOutputPaths
} {
  const subcommandIndex = argv.indexOf(MANAGED_PROCESS_LAUNCHER_SUBCOMMAND)
  const nonceFlagIndex = argv.indexOf(MANAGED_PROCESS_LAUNCH_NONCE_FLAG, subcommandIndex + 1)
  const separatorIndex = argv.indexOf(MANAGED_PROCESS_TARGET_SEPARATOR, nonceFlagIndex + 2)
  const launchNonce = nonceFlagIndex < 0 ? undefined : argv[nonceFlagIndex + 1]
  const targetArgv = separatorIndex < 0 ? [] : argv.slice(separatorIndex + 1)
  if (
    subcommandIndex < 0 ||
    nonceFlagIndex < 0 ||
    separatorIndex < 0 ||
    typeof launchNonce !== 'string' ||
    launchNonce.length === 0 ||
    targetArgv.length === 0
  ) {
    throw new Error('invalid managed process launcher argv')
  }
  const launcherArgValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag, nonceFlagIndex + 2)
    if (index < 0 || index >= separatorIndex) return undefined
    const value = argv[index + 1]
    if (typeof value !== 'string' || value.length === 0 || index + 1 >= separatorIndex) {
      throw new Error(`invalid managed process launcher ${flag}`)
    }
    return value
  }
  const stdoutPath = launcherArgValue(MANAGED_PROCESS_WINDOWS_STDOUT_FLAG)
  const stderrPath = launcherArgValue(MANAGED_PROCESS_WINDOWS_STDERR_FLAG)
  const controlPath = launcherArgValue(MANAGED_PROCESS_WINDOWS_CONTROL_FLAG)
  const windowsPathCount = [stdoutPath, stderrPath, controlPath].filter(
    (value) => value !== undefined,
  ).length
  if (windowsPathCount !== 0 && windowsPathCount !== 3) {
    throw new Error('managed process launcher requires all Windows output paths')
  }
  return {
    launchNonce,
    targetArgv,
    ...(windowsPathCount === 3
      ? {
          windowsOutputPaths: {
            stdoutPath: stdoutPath!,
            stderrPath: stderrPath!,
            controlPath: controlPath!,
          },
        }
      : {}),
  }
}

function parseActivationFrame(raw: string, launchNonce: string): ManagedProcessActivationFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid managed process activation frame')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('invalid managed process activation frame')
  }
  const value = parsed as {
    v?: unknown
    launchNonce?: unknown
    targetArgv?: unknown
    stdin?: { mode?: unknown; data?: unknown }
    windowsOutputPaths?: {
      stdoutPath?: unknown
      stderrPath?: unknown
      controlPath?: unknown
    } | null
  }
  if (
    value.v !== 1 ||
    value.launchNonce !== launchNonce ||
    value.stdin === null ||
    typeof value.stdin !== 'object' ||
    (value.stdin.mode !== 'ignore' && value.stdin.mode !== 'pipe') ||
    (value.stdin.mode === 'pipe' && typeof value.stdin.data !== 'string')
  ) {
    throw new Error('managed process activation frame does not match launcher nonce')
  }
  if (
    value.targetArgv !== undefined &&
    (!Array.isArray(value.targetArgv) ||
      value.targetArgv.length === 0 ||
      value.targetArgv.some((part) => typeof part !== 'string'))
  ) {
    throw new Error('invalid managed process activation frame target argv')
  }
  const rawWindowsOutputPaths = value.windowsOutputPaths
  if (
    rawWindowsOutputPaths !== undefined &&
    (rawWindowsOutputPaths === null ||
      typeof rawWindowsOutputPaths !== 'object' ||
      typeof rawWindowsOutputPaths.stdoutPath !== 'string' ||
      rawWindowsOutputPaths.stdoutPath.length === 0 ||
      typeof rawWindowsOutputPaths.stderrPath !== 'string' ||
      rawWindowsOutputPaths.stderrPath.length === 0 ||
      typeof rawWindowsOutputPaths.controlPath !== 'string' ||
      rawWindowsOutputPaths.controlPath.length === 0)
  ) {
    throw new Error('invalid managed process activation frame Windows output paths')
  }
  const windowsOutputPaths =
    rawWindowsOutputPaths === undefined
      ? undefined
      : {
          stdoutPath: rawWindowsOutputPaths.stdoutPath as string,
          stderrPath: rawWindowsOutputPaths.stderrPath as string,
          controlPath: rawWindowsOutputPaths.controlPath as string,
        }
  return {
    v: 1,
    launchNonce,
    ...(value.targetArgv === undefined ? {} : { targetArgv: value.targetArgv as string[] }),
    stdin:
      value.stdin.mode === 'pipe'
        ? { mode: 'pipe', data: value.stdin.data as string }
        : { mode: 'ignore' },
    ...(windowsOutputPaths === undefined ? {} : { windowsOutputPaths }),
  }
}

function requestedControlPathFromArgv(argv: readonly string[]): string | undefined {
  const index = argv.indexOf(MANAGED_PROCESS_WINDOWS_CONTROL_FLAG)
  const value = index < 0 ? undefined : argv[index + 1]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function writeLaunchControlRecord(path: string | undefined, record: string): void {
  if (path !== undefined) {
    appendFileSync(path, record)
    return
  }
  writeTextToFd(2, record)
}

function reportLaunchError(launchNonce: string, error: unknown, controlPath?: string): void {
  const message = error instanceof Error ? error.message : String(error)
  writeLaunchControlRecord(
    controlPath,
    `${MANAGED_PROCESS_LAUNCH_ERROR_PREFIX}${launchNonce}:${JSON.stringify(message)}\n`,
  )
}

function writeAllToFd(fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
    if (written <= 0) throw new Error(`managed process output relay made no progress on fd ${fd}`)
    offset += written
  }
}

function writeTextToFd(fd: 1 | 2, text: string): void {
  if (process.platform !== 'win32') {
    ;(fd === 1 ? process.stdout : process.stderr).write(text)
    return
  }
  writeAllToFd(fd, new TextEncoder().encode(text))
}

export interface WindowsOutputSpool {
  readonly root: string
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly controlPath: string
  stdoutWriteFd: number | undefined
  stderrWriteFd: number | undefined
}

type WindowsOutputWriterKey = 'stdoutWriteFd' | 'stderrWriteFd'

function closeWindowsOutputWriter(spool: WindowsOutputSpool, key: WindowsOutputWriterKey): void {
  const fd = spool[key]
  if (fd === undefined) return
  closeSync(fd)
  spool[key] = undefined
}

export function createWindowsOutputSpool(openWriters = false): WindowsOutputSpool {
  const root = mkdtempSync(join(tmpdir(), 'aw-managed-process-output-'))
  const spool: WindowsOutputSpool = {
    root,
    stdoutPath: join(root, 'stdout'),
    stderrPath: join(root, 'stderr'),
    controlPath: join(root, 'control'),
    stdoutWriteFd: undefined,
    stderrWriteFd: undefined,
  }
  try {
    if (openWriters) {
      // The compiled launcher owns these handles until its target exits. This
      // keeps Windows handle inheritance complete before close while the outer
      // daemon/launcher boundary remains path-based rather than inheriting fd1/2.
      spool.stdoutWriteFd = openSync(spool.stdoutPath, 'w')
      spool.stderrWriteFd = openSync(spool.stderrPath, 'w')
    } else {
      writeFileSync(spool.stdoutPath, '')
      writeFileSync(spool.stderrPath, '')
    }
    writeFileSync(spool.controlPath, '')
    return spool
  } catch (error) {
    cleanupWindowsOutputSpool(spool)
    throw error
  }
}

function closeWindowsOutputWriters(spool: WindowsOutputSpool): void {
  closeWindowsOutputWriter(spool, 'stdoutWriteFd')
  closeWindowsOutputWriter(spool, 'stderrWriteFd')
}

export function cleanupWindowsOutputSpool(spool: WindowsOutputSpool | undefined): void {
  if (spool === undefined) return
  for (const key of ['stdoutWriteFd', 'stderrWriteFd'] as const) {
    try {
      closeWindowsOutputWriter(spool, key)
    } catch {
      // Best effort after the process is already terminal.
    }
  }
  try {
    rmSync(spool.root, { recursive: true, force: true })
  } catch {
    // Windows can briefly retain a just-closed child handle. The OS temp root
    // is the fallback owner when immediate removal is unavailable.
  }
}

function drainSpoolPath(
  path: string,
  targetFd: number,
  startOffset: number,
  buffer: Uint8Array,
): number {
  let offset = startOffset
  // Bun 1.4 on Windows can leave a regular-file descriptor at a sticky EOF
  // while another process later extends that file. Reopen on every poll so a
  // pre-output read cannot hide the target's eventual bytes. The explicit
  // offset keeps delivery byte-exact and prevents duplicates.
  const readFd = openSync(path, 'r')
  try {
    for (;;) {
      const count = readSync(readFd, buffer, 0, buffer.byteLength, offset)
      if (count === 0) return offset
      writeAllToFd(targetFd, buffer.subarray(0, count))
      offset += count
    }
  } finally {
    closeSync(readFd)
  }
}

async function relayWindowsOutputSpool(
  spool: WindowsOutputSpool,
  writersClosed: Promise<void>,
  destinationPaths?: WindowsManagedProcessOutputPaths,
): Promise<{ stdoutBytes: number; stderrBytes: number }> {
  let writersAreClosed = false
  const observedClosure = writersClosed.then(
    () => {
      writersAreClosed = true
    },
    (error) => {
      writersAreClosed = true
      throw error
    },
  )
  // The main await below owns propagation; this handler only prevents a
  // close failure from becoming temporarily unhandled while the child runs.
  void observedClosure.catch(() => {})
  const stdoutFd = destinationPaths === undefined ? 1 : openSync(destinationPaths.stdoutPath, 'a')
  const stderrFd = destinationPaths === undefined ? 2 : openSync(destinationPaths.stderrPath, 'a')
  try {
    const stdoutBuffer = new Uint8Array(64 * 1024)
    const stderrBuffer = new Uint8Array(64 * 1024)
    let stdoutOffset = 0
    let stderrOffset = 0
    while (!writersAreClosed) {
      stdoutOffset = drainSpoolPath(spool.stdoutPath, stdoutFd, stdoutOffset, stdoutBuffer)
      stderrOffset = drainSpoolPath(spool.stderrPath, stderrFd, stderrOffset, stderrBuffer)
      await Promise.race([observedClosure, Bun.sleep(10)])
    }
    await observedClosure

    // Bun 1.4 can report a compiled Windows child exited just before its final
    // regular-file growth becomes visible to a fresh reader. Require two empty
    // post-close polls; any observed growth resets the bounded stability count.
    let stablePolls = 0
    while (stablePolls < 2) {
      const priorStdoutOffset = stdoutOffset
      const priorStderrOffset = stderrOffset
      stdoutOffset = drainSpoolPath(spool.stdoutPath, stdoutFd, stdoutOffset, stdoutBuffer)
      stderrOffset = drainSpoolPath(spool.stderrPath, stderrFd, stderrOffset, stderrBuffer)
      stablePolls =
        stdoutOffset === priorStdoutOffset && stderrOffset === priorStderrOffset
          ? stablePolls + 1
          : 0
      if (stablePolls < 2) await Bun.sleep(10)
    }
    return { stdoutBytes: stdoutOffset, stderrBytes: stderrOffset }
  } finally {
    if (destinationPaths !== undefined) {
      closeSync(stdoutFd)
      closeSync(stderrFd)
    }
  }
}

/** Hidden CLI entry. Never logs ordinary daemon output or reads product state. */
export async function runManagedProcessLauncher(
  argv: readonly string[] = Bun.argv,
): Promise<number> {
  const environmentLaunchNonce = process.env[MANAGED_PROCESS_LAUNCH_NONCE_ENV]
  const requestedControlPath = requestedControlPathFromArgv(argv)
  let request: ReturnType<typeof parseLauncherRequest> | undefined
  try {
    request = parseLauncherRequest(argv)
  } catch (error) {
    if (environmentLaunchNonce === undefined || environmentLaunchNonce.length === 0) {
      reportLaunchError('invalid', error, requestedControlPath)
      return 125
    }
  }
  const launchNonce = environmentLaunchNonce ?? request!.launchNonce
  if (request !== undefined && request.launchNonce !== launchNonce) {
    reportLaunchError(
      launchNonce,
      'managed process launcher nonce channels disagree',
      requestedControlPath,
    )
    return 125
  }

  // EOF before a valid frame is the parent-death/receipt-failure path. The
  // target has not been spawned, so this is a clean definitely-not-activated
  // exit rather than an orphan runtime.
  const raw = await Bun.stdin.text().catch(() => '')
  if (raw.length === 0) return 125

  let frame: ManagedProcessActivationFrame
  try {
    frame = parseActivationFrame(raw, launchNonce)
  } catch (error) {
    reportLaunchError(launchNonce, error, request?.windowsOutputPaths?.controlPath)
    return 125
  }
  const targetArgv = frame.targetArgv ?? request?.targetArgv
  const windowsOutputPaths = frame.windowsOutputPaths ?? request?.windowsOutputPaths
  if (targetArgv === undefined || targetArgv.length === 0) {
    reportLaunchError(
      launchNonce,
      'managed process activation frame has no target argv',
      windowsOutputPaths?.controlPath,
    )
    return 125
  }

  let child: Bun.Subprocess
  let outputSpool: WindowsOutputSpool | undefined
  // Hosted Windows proved that Bun 1.4 can return an empty target pipe when a
  // compiled Bun daemon launches this compiled launcher, which then launches a
  // second compiled Bun executable. A direct Bun -e target does not reproduce
  // it. Use regular files for that one inner hop and tail them into the
  // parent-owned final paths while the target runs. POSIX retains direct
  // inheritance and its existing zero-copy behaviour.
  try {
    outputSpool = process.platform === 'win32' ? createWindowsOutputSpool(true) : undefined
    child = Bun.spawn({
      cmd: [...targetArgv],
      ...platformSpawnOptionsForHost(),
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return entry[0] !== MANAGED_PROCESS_LAUNCH_NONCE_ENV && typeof entry[1] === 'string'
        }),
      ),
      stdout: outputSpool?.stdoutWriteFd ?? 'inherit',
      stderr: outputSpool?.stderrWriteFd ?? 'inherit',
      stdin: frame.stdin.mode === 'pipe' ? 'pipe' : 'ignore',
      // The launcher is already the detached process-group leader. The target
      // deliberately stays in that group so TERM→KILL reaches the whole tree.
      detached: false,
    })
  } catch (error) {
    cleanupWindowsOutputSpool(outputSpool)
    reportLaunchError(launchNonce, error, windowsOutputPaths?.controlPath)
    return 127
  }

  const childExited = child.exited
  const activeOutputSpool = outputSpool
  // The launcher keeps its own copies open until the target is terminal. Their
  // explicit close is the inner relay's final-flush boundary.
  const outputWritersClosed =
    activeOutputSpool === undefined
      ? Promise.resolve()
      : childExited.then(() => closeWindowsOutputWriters(activeOutputSpool))
  const outputRelay =
    activeOutputSpool === undefined
      ? Promise.resolve(undefined)
      : relayWindowsOutputSpool(activeOutputSpool, outputWritersClosed, windowsOutputPaths)
  // The relay can observe a broken destination before the target exits. Attach
  // a handler immediately; the same promise is awaited and reported below.
  void outputRelay.catch(() => {})

  try {
    if (frame.stdin.mode === 'pipe') {
      const sink = child.stdin as { write: (data: string) => void; end: () => void }
      sink.write(frame.stdin.data)
      sink.end()
    }

    // This is a timing boundary, not a new admission policy: the target exists
    // and its stdin has been delivered, so only now may its business timeout
    // begin.  The parent consumes this private record instead of surfacing it as
    // runtime stderr.
    writeLaunchControlRecord(
      windowsOutputPaths?.controlPath,
      `${MANAGED_PROCESS_LAUNCH_READY_PREFIX}${launchNonce}\n`,
    )
    const exitCode = await childExited
    const outputBytes = await outputRelay
    if (outputBytes !== undefined) {
      // This is both the relay completion barrier and the layer diagnostic: it
      // tells the parent exactly how many bytes the compiled launcher observed
      // in the compiled target's private files before closing its final writers.
      writeLaunchControlRecord(
        windowsOutputPaths?.controlPath,
        `${MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX}${launchNonce}:${JSON.stringify(outputBytes)}\n`,
      )
    }
    return exitCode
  } catch (error) {
    reportLaunchError(launchNonce, error, windowsOutputPaths?.controlPath)
    try {
      child.kill(15)
    } catch {
      // The child may already have exited.
    }
    await childExited.catch(() => {})
    await outputRelay.catch(() => {})
    return 126
  } finally {
    cleanupWindowsOutputSpool(outputSpool)
  }
}

if (import.meta.main) {
  process.exit(await runManagedProcessLauncher(Bun.argv))
}
