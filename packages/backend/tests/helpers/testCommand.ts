import { nonInteractiveGitEnv } from '../../src/util/git'

const DEFAULT_ERROR_OUTPUT_LIMIT = 4_096
const TIMED_OUT = Symbol('timed-out')

export interface TestCommandOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs: number
  label?: string
}

/**
 * Run a real test-fixture command without blocking Bun's event loop.
 *
 * A synchronous child_process timeout cannot help when the runtime itself is
 * wedged inside the blocking call: bun:test's timeout and the suite watchdog
 * never get a turn. Keep the subprocess asynchronous, race it against a real
 * timer, SIGKILL on expiry, and wait for the child to be reaped before failing.
 */
export async function runTestCommand(cmd: string[], opts: TestCommandOptions): Promise<string> {
  if (cmd.length === 0) throw new Error('test command must not be empty')
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(`test command timeout must be positive: ${opts.timeoutMs}`)
  }

  const label = opts.label ?? cmd[0]!
  const proc = Bun.spawn({
    cmd,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const completed = Promise.all([stdoutPromise, stderrPromise, proc.exited])
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs)
  })

  try {
    const outcome = await Promise.race([completed, deadline])
    if (outcome === TIMED_OUT) {
      proc.kill('SIGKILL')
      await proc.exited
      await Promise.allSettled([stdoutPromise, stderrPromise])
      throw new Error(`${label} timed out after ${opts.timeoutMs}ms`)
    }

    const [stdout, stderr, exitCode] = outcome
    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, DEFAULT_ERROR_OUTPUT_LIMIT)
      throw new Error(`${label} exited with code ${exitCode}${detail === '' ? '' : `: ${detail}`}`)
    }
    return stdout
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function runTestGit(args: string[], timeoutMs: number): Promise<string> {
  return runTestCommand(['git', ...args], {
    timeoutMs,
    label: 'git fixture command',
    env: nonInteractiveGitEnv(),
  })
}
