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
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 15_000}ms`))
    }, options.timeoutMs ?? 15_000)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? -1,
      })
    })
    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input)
  })
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
