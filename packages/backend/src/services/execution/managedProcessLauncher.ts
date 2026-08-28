// RFC-328 — pre-activation launcher for task-owned managed processes.
//
// The launcher itself may exist before the durable PID receipt, but it cannot
// execute the requested runtime until its parent sends one activation frame.
// If the daemon dies or closes the control pipe first, EOF makes the launcher
// exit without ever spawning the target command.

import { IS_EMBEDDED } from '@/embed'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import { writeSync } from 'node:fs'

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

async function relayStreamToFd(
  stream: ReadableStream<Uint8Array> | undefined,
  fd: 1 | 2,
): Promise<void> {
  if (stream === undefined) return
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined && value.byteLength > 0) writeAllToFd(fd, value)
    }
  } finally {
    reader.releaseLock()
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
  // Bun 1.4's Windows process backend can lose a grandchild's output when the
  // launcher inherits a stdout/stderr handle that is itself a pipe. Read the
  // target pipes explicitly there, synchronously forward every byte to the
  // launcher's parent pipe, and do not return until both streams reach EOF.
  // POSIX keeps direct inheritance and its existing zero-copy behavior.
  const relayTargetOutput = process.platform === 'win32'
  try {
    child = Bun.spawn({
      cmd: [...request.targetArgv],
      ...platformSpawnOptionsForHost(),
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      ),
      stdout: relayTargetOutput ? 'pipe' : 'inherit',
      stderr: relayTargetOutput ? 'pipe' : 'inherit',
      stdin: frame.stdin.mode === 'pipe' ? 'pipe' : 'ignore',
      // The launcher is already the detached process-group leader. The target
      // deliberately stays in that group so TERM→KILL reaches the whole tree.
      detached: false,
    })
  } catch (error) {
    reportLaunchError(request.launchNonce, error)
    return 127
  }

  if (frame.stdin.mode === 'pipe') {
    try {
      const sink = child.stdin as { write: (data: string) => void; end: () => void }
      sink.write(frame.stdin.data)
      sink.end()
    } catch (error) {
      reportLaunchError(request.launchNonce, error)
      try {
        child.kill(15)
      } catch {
        // The child may already have exited.
      }
      await child.exited.catch(() => {})
      return 126
    }
  }

  const outputRelays = relayTargetOutput
    ? [
        relayStreamToFd(child.stdout as ReadableStream<Uint8Array> | undefined, 1),
        relayStreamToFd(child.stderr as ReadableStream<Uint8Array> | undefined, 2),
      ]
    : []

  // This is a timing boundary, not a new admission policy: the target exists
  // and its stdin has been delivered, so only now may its business timeout
  // begin.  The parent consumes this private record instead of surfacing it as
  // runtime stderr.
  writeTextToFd(2, `${MANAGED_PROCESS_LAUNCH_READY_PREFIX}${request.launchNonce}\n`)
  const exitCode = await child.exited
  try {
    await Promise.all(outputRelays)
  } catch (error) {
    reportLaunchError(request.launchNonce, error)
    return 126
  }
  return exitCode
}

if (import.meta.main) {
  process.exit(await runManagedProcessLauncher(Bun.argv))
}
