// RFC-379: PostgreSQL's real standalone daemon emits the same canonical lifecycle order.
// This integration runs only with the CI-provided PostgreSQL URL; local SQLite runs skip it.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DAEMON_BOOT_STEPS } from '../src/cli/daemonLifecycleProgram'
import { describeEachProvider } from './helpers/eachProvider'

if (process.env.AW_TEST_POSTGRESQL_URL) {
  describeEachProvider(
    'RFC-379 real PostgreSQL daemon lifecycle',
    () => {
      test('standalone startup follows every declared step before announcing ready', async () => {
        const home = mkdtempSync(join(tmpdir(), 'aw-rfc379-pg-'))
        writeFileSync(
          join(home, 'config.json'),
          JSON.stringify({
            database: { provider: 'postgresql', urlEnv: 'AW_TEST_POSTGRESQL_URL' },
            bindHost: '127.0.0.1',
            bindPort: 0,
            autoResumeOnBoot: false,
          }),
        )
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            'run',
            resolve(import.meta.dir, '../src/main.ts'),
            'start',
            '--port',
            '0',
          ],
          env: { ...process.env, AGENT_WORKFLOW_HOME: home },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const errors = new Response(child.stderr).text()
        const reader = child.stdout.getReader(),
          decoder = new TextDecoder()
        let output = '',
          timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            (async () => {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) throw new Error(`daemon exited before ready: ${output} ${await errors}`)
                output += decoder.decode(value, { stream: true })
                if (/http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(output)) return
              }
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`daemon readiness timeout: ${output}`)),
                60_000,
              )
            }),
          ])
          expect(
            [...output.matchAll(/lifecycle step id=([^ ]+)/g)].map((match) => match[1]),
          ).toEqual(DAEMON_BOOT_STEPS.filter((step) => !('profile' in step)).map(({ id }) => id))
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          child.kill('SIGTERM')
          await child.exited
          reader.releaseLock()
          await errors
          rmSync(home, { recursive: true, force: true })
        }
      }, 90_000)
    },
    { providers: ['postgresql'] },
  )
} else {
  test.skip('RFC-379 real PostgreSQL lifecycle requires AW_TEST_POSTGRESQL_URL', () => {})
}
