// RFC-328 — pre-activation launcher for task-owned managed processes.
//
// The launcher itself may exist before the durable PID receipt, but it cannot
// execute the requested runtime until its parent sends one activation frame.
// If the daemon dies or closes the control pipe first, EOF makes the launcher
// exit without ever spawning the target command.

import { IS_EMBEDDED } from '@/embed'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import {
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
export const MANAGED_PROCESS_TARGET_SEPARATOR = '--'
export const MANAGED_PROCESS_LAUNCH_ERROR_PREFIX = '\u001eAW_MANAGED_PROCESS_LAUNCH_ERROR:'
export const MANAGED_PROCESS_LAUNCH_READY_PREFIX = '\u001eAW_MANAGED_PROCESS_LAUNCH_READY:'

export interface ManagedProcessActivationFrame {
  readonly v: 1
  readonly launchNonce: string
  readonly stdin: Readonly<{ mode: 'ignore' }> | Readonly<{ mode: 'pipe'; data: string }>
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
}): string[] {
  if (input.launchNonce.length === 0 || input.targetArgv.length === 0) {
    throw new Error('managed process launcher requires a nonce and target argv')
  }
  return [
    ...selfInvocation(),
    MANAGED_PROCESS_LAUNCH_NONCE_FLAG,
    input.launchNonce,
    MANAGED_PROCESS_TARGET_SEPARATOR,
    ...input.targetArgv,
  ]
}

function parseLauncherRequest(argv: readonly string[]): {
  launchNonce: string
  targetArgv: readonly string[]
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
  return { launchNonce, targetArgv }
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
    stdin?: { mode?: unknown; data?: unknown }
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
  return value.stdin.mode === 'pipe'
    ? { v: 1, launchNonce, stdin: { mode: 'pipe', data: value.stdin.data as string } }
    : { v: 1, launchNonce, stdin: { mode: 'ignore' } }
}

function reportLaunchError(launchNonce: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  writeTextToFd(
    2,
    `${MANAGED_PROCESS_LAUNCH_ERROR_PREFIX}${launchNonce}:${JSON.stringify(message)}\n`,
  )
}

function writeAllToFd(fd: 1 | 2, bytes: Uint8Array): void {
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
}

export function createWindowsOutputSpool(): WindowsOutputSpool {
  const root = mkdtempSync(join(tmpdir(), 'aw-managed-process-output-'))
  const spool: WindowsOutputSpool = {
    root,
    stdoutPath: join(root, 'stdout'),
    stderrPath: join(root, 'stderr'),
  }
  try {
    // Create both paths before the relay can poll. Bun.file below owns the
    // actual child redirection handles; no numeric descriptor crosses a
    // compiled Windows process boundary.
    writeFileSync(spool.stdoutPath, '')
    writeFileSync(spool.stderrPath, '')
    return spool
  } catch (error) {
    cleanupWindowsOutputSpool(spool)
    throw error
  }
}

export function cleanupWindowsOutputSpool(spool: WindowsOutputSpool | undefined): void {
  if (spool === undefined) return
  try {
    rmSync(spool.root, { recursive: true, force: true })
  } catch {
    // Windows can briefly retain a just-closed child handle. The OS temp root
    // is the fallback owner when immediate removal is unavailable.
  }
}

function drainSpoolPath(
  path: string,
  targetFd: 1 | 2,
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
): Promise<void> {
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
  const stdoutBuffer = new Uint8Array(64 * 1024)
  const stderrBuffer = new Uint8Array(64 * 1024)
  let stdoutOffset = 0
  let stderrOffset = 0
  while (!writersAreClosed) {
    stdoutOffset = drainSpoolPath(spool.stdoutPath, 1, stdoutOffset, stdoutBuffer)
    stderrOffset = drainSpoolPath(spool.stderrPath, 2, stderrOffset, stderrBuffer)
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
    stdoutOffset = drainSpoolPath(spool.stdoutPath, 1, stdoutOffset, stdoutBuffer)
    stderrOffset = drainSpoolPath(spool.stderrPath, 2, stderrOffset, stderrBuffer)
    stablePolls =
      stdoutOffset === priorStdoutOffset && stderrOffset === priorStderrOffset ? stablePolls + 1 : 0
    if (stablePolls < 2) await Bun.sleep(10)
  }
}

/** Hidden CLI entry. Never logs ordinary daemon output or reads product state. */
export async function runManagedProcessLauncher(
  argv: readonly string[] = Bun.argv,
): Promise<number> {
  let request: ReturnType<typeof parseLauncherRequest>
  try {
    request = parseLauncherRequest(argv)
  } catch (error) {
    reportLaunchError('invalid', error)
    return 125
  }

  // EOF before a valid frame is the parent-death/receipt-failure path. The
  // target has not been spawned, so this is a clean definitely-not-activated
  // exit rather than an orphan runtime.
  const raw = await Bun.stdin.text().catch(() => '')
  if (raw.length === 0) return 125

  let frame: ManagedProcessActivationFrame
  try {
    frame = parseActivationFrame(raw, request.launchNonce)
  } catch (error) {
    reportLaunchError(request.launchNonce, error)
    return 125
  }

  let child: Bun.Subprocess
  let outputSpool: WindowsOutputSpool | undefined
  // Hosted Windows proved that Bun 1.4 can return an empty target pipe when a
  // compiled Bun daemon launches this compiled launcher, which then launches a
  // second compiled Bun executable. A direct Bun -e target does not reproduce
  // it. Use regular files for that one inner hop and tail them into the
  // launcher's parent pipes while the target runs. POSIX retains direct
  // inheritance and its existing zero-copy behaviour.
  try {
    outputSpool = process.platform === 'win32' ? createWindowsOutputSpool() : undefined
    child = Bun.spawn({
      cmd: [...request.targetArgv],
      ...platformSpawnOptionsForHost(),
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
      stdout: outputSpool === undefined ? 'inherit' : Bun.file(outputSpool.stdoutPath),
      stderr: outputSpool === undefined ? 'inherit' : Bun.file(outputSpool.stderrPath),
      stdin: frame.stdin.mode === 'pipe' ? 'pipe' : 'ignore',
      // The launcher is already the detached process-group leader. The target
      // deliberately stays in that group so TERM→KILL reaches the whole tree.
      detached: false,
    })
  } catch (error) {
    cleanupWindowsOutputSpool(outputSpool)
    reportLaunchError(request.launchNonce, error)
    return 127
  }

  const childExited = child.exited
  const activeOutputSpool = outputSpool
  // `Bun.file(path)` makes Bun own the redirection handle at spawn time. This
  // avoids both the nested pipe loss and numeric-fd inheritance loss observed
  // in compiled Windows daemons; child terminal is the final-flush boundary.
  const outputWritersClosed = childExited.then(() => {})
  const outputRelay =
    activeOutputSpool === undefined
      ? Promise.resolve()
      : relayWindowsOutputSpool(activeOutputSpool, outputWritersClosed)
  // The relay can observe a broken parent pipe before the target exits. Attach
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
    writeTextToFd(2, `${MANAGED_PROCESS_LAUNCH_READY_PREFIX}${request.launchNonce}\n`)
    const exitCode = await childExited
    await outputRelay
    return exitCode
  } catch (error) {
    reportLaunchError(request.launchNonce, error)
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
