// Runtime-safe process boundary: no converter or migration application imports.
import { resolve } from 'node:path'
import { IS_EMBEDDED } from '@/embed'
import { createLogger } from '@/util/log'
import { platformSpawnOptionsForHost } from '@/util/platformExec'

export async function runAutoUpgradeChild(): Promise<void> {
  const argv = IS_EMBEDDED
    ? [process.execPath]
    : [process.execPath, 'run', resolve(import.meta.dir, '..', 'main.ts')]
  const child = Bun.spawn([...argv, 'db', 'migration', 'auto', '--json'], {
    ...platformSpawnOptionsForHost(),
    env: { ...process.env, AGENT_WORKFLOW_EPOCH_LOCK_DELEGATION: String(process.pid) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const log = createLogger('epoch-upgrade')
  let signal: string | null = null
  const interrupt = () => {
    signal = 'SIGINT'
    child.kill('SIGINT')
  }
  const terminate = () => {
    signal = 'SIGTERM'
    child.kill('SIGTERM')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  const relay = async () => {
    const decoder = new TextDecoder()
    let pending = ''
    const line = (value: string) => {
      process.stderr.write(value + '\n')
      if (value.startsWith('WARN ')) log.warn(value.slice(5))
      else log.info(value)
    }
    for await (const chunk of child.stderr) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const value of lines) line(value)
    }
    pending += decoder.decode()
    if (pending) line(pending)
  }
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      relay(),
    ])
    if (signal)
      throw new Error(
        `Database upgrade interrupted by ${signal}; the child has exited. Start again to resume.`,
      )
    if (code !== 0) {
      process.stderr.write(stdout + (stdout.endsWith('\n') ? '' : '\n'))
      throw new Error(
        code === 3
          ? 'Automatic database upgrade refused; follow the conclusion above.'
          : `Automatic database upgrade child exited ${code}: ${stdout}`,
      )
    }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
