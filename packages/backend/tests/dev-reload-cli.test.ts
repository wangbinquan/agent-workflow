// Exercise Bun --hot through the original CLI entrypoint, including its real
// HTTP/control listeners, database preparation, source reload and shutdown.
// A save during the synchronous integrity scan previously invalidated the
// deferred runtime imports and exited with "Requested module is not instantiated yet".
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const saveDuringCheck of [false, true]) {
  test(`real CLI hot reload keeps its PID and serves after saves${saveDuringCheck ? ' including a save during initial integrity check' : ''}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-dev-cli-hot-'))
    const entry = join(root, 'entry.ts')
    const main = resolve(import.meta.dir, '..', 'src', 'main.ts')
    const source = (probe: string) =>
      `import ${JSON.stringify(main)};\nconsole.info(${JSON.stringify(probe)});\n`
    writeFileSync(entry, source('dev-cli-source-one'))
    const preload = join(root, 'slow-integrity.ts')
    if (saveDuringCheck) {
      writeFileSync(
        preload,
        `
import { Database } from 'bun:sqlite'
const query = Database.prototype.query
let paused = false
Database.prototype.query = function (sql, ...args) {
  if (!paused && sql === 'PRAGMA quick_check;') {
    paused = true
    console.info('dev-cli-integrity-blocked')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  }
  return query.call(this, sql, ...args)
}
`,
      )
    }
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        ...(saveDuringCheck ? ['--preload', preload] : []),
        '--hot',
        entry,
        'start',
      ],
      {
        cwd: resolve(import.meta.dir, '..'),
        env: {
          ...process.env,
          AGENT_WORKFLOW_HOME: root,
          AGENT_WORKFLOW_DEV_HOT_RELOAD: '1',
          AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS: '35000',
          AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    let output = ''
    const waiting = new Map<
      string,
      { matches(): boolean; ack: ReturnType<typeof Promise.withResolvers<void>> }
    >()
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const result = await reader.read()
        if (result.done) return
        output += decoder.decode(result.value, { stream: true })
        for (const [text, { matches, ack }] of waiting) {
          if (matches()) {
            waiting.delete(text)
            ack.resolve()
          }
        }
      }
    }
    const pumps = [consume(child.stdout), consume(child.stderr)]
    const waitFor = async (text: string, matches = () => output.includes(text)) => {
      if (matches()) return
      const ack = Promise.withResolvers<void>()
      waiting.set(text, { matches, ack })
      const deadline = setTimeout(() => {
        ack.reject(new Error(`CLI did not reach ${text}: ${output.slice(-5000)}`))
      }, 25_000)
      try {
        await Promise.race([
          ack.promise,
          child.exited.then((code) => {
            throw new Error(`CLI exited ${code} before ${text}: ${output.slice(-3000)}`)
          }),
        ])
      } finally {
        clearTimeout(deadline)
        waiting.delete(text)
      }
    }
    const readyGeneration = () => {
      const generations = [...output.matchAll(/source generation (\d+) ready/g)]
      return Number(generations.at(-1)?.[1] ?? 0)
    }
    // A save may produce several watch events. The real reloader coalesces them,
    // so completed generation numbers need not be consecutive.
    const waitForReadyAfter = (generation: number) =>
      waitFor(`a ready generation after ${generation}`, () => readyGeneration() > generation)
    const infoPath = join(root, '.daemon.info')
    const controlPath = join(root, '.daemon.control')
    try {
      if (saveDuringCheck) {
        await waitFor('dev-cli-integrity-blocked')
        writeFileSync(entry, source('dev-cli-source-during-check'))
        await waitFor('dev-cli-source-during-check')
        await waitForReadyAfter(1)
      }
      await waitForReadyAfter(0)
      const first = JSON.parse(readFileSync(infoPath, 'utf8')) as {
        pid: number
        url: string
        startedAt: string
      }
      const before = await fetch(`${first.url}health`, { signal: AbortSignal.timeout(5000) })
      expect(before.status).toBe(200)
      expect(((await before.json()) as { ok: boolean }).ok).toBe(true)
      const firstGeneration = readyGeneration()
      writeFileSync(entry, source('dev-cli-source-two'))
      await waitFor('dev-cli-source-two')
      await waitForReadyAfter(firstGeneration)
      const second = JSON.parse(readFileSync(infoPath, 'utf8')) as typeof first
      expect(second.pid).toBe(first.pid)
      expect(second.startedAt).not.toBe(first.startedAt)
      const after = await fetch(`${second.url}health`, { signal: AbortSignal.timeout(5000) })
      expect(after.status).toBe(200)
      expect(((await after.json()) as { ok: boolean }).ok).toBe(true)
      expect(output.match(/startup database quick_check completed/g)).toHaveLength(1)
      expect(output.match(/reusing database integrity check/g)?.length ?? 0).toBeGreaterThanOrEqual(
        saveDuringCheck ? 2 : 1,
      )
      expect(output).not.toContain('Requested module is not instantiated yet')
      const control = JSON.parse(readFileSync(controlPath, 'utf8')) as {
        url: string
        nonce: string
      }
      await fetch(`${control.url}/shutdown`, {
        method: 'POST',
        headers: { 'x-agent-workflow-control': control.nonce },
        signal: AbortSignal.timeout(5000),
      })
      const exitDeadline = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try {
        expect(await child.exited).toBe(0)
      } finally {
        clearTimeout(exitDeadline)
      }
      expect(existsSync(infoPath)).toBe(false)
      expect(existsSync(controlPath)).toBe(false)
    } catch (error) {
      throw new Error(`CLI hot-reload evidence: ${output.slice(-5000)}`, { cause: error })
    } finally {
      // Failure cleanup must not wait on the graceful shutdown being diagnosed.
      child.kill('SIGKILL')
      await child.exited
      await Promise.all(pumps)
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
}
