import { spawn } from 'node:child_process'

export interface ProcessResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    input?: Buffer | string
    timeoutMs?: number
  } = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    function rejectOnce(error: unknown): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(error)
    }
    const timer = setTimeout(() => {
      rejectOnce(new Error(`${command} timed out after ${options.timeoutMs ?? 15_000}ms`))
    }, options.timeoutMs ?? 15_000)
    timer.unref?.()
    child.once('error', (error) => {
      rejectOnce(error)
    })
    // A CGI child is allowed to reject or stop reading a request body. Node's
    // child_process socket reports that normal early-close path asynchronously;
    // without a listener, EventEmitter treats EPIPE as an uncaught exception and
    // terminates the whole Playwright globalSetup process. The child's close
    // event remains authoritative for its exit code and captured diagnostics.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (isExpectedStdinClosure(error)) return
      rejectOnce(error)
    })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? -1,
      })
    })
    try {
      if (options.input === undefined) child.stdin.end()
      else child.stdin.end(options.input)
    } catch (error) {
      if (!isExpectedStdinClosure(error)) rejectOnce(error)
    }
  })
}

function isExpectedStdinClosure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED'
}

export async function runChecked(
  command: string,
  args: string[],
  options: Parameters<typeof runProcess>[2] = {},
): Promise<string> {
  const result = await runProcess(command, args, options)
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString('utf8')}`,
    )
  }
  return result.stdout.toString('utf8').trim()
}
