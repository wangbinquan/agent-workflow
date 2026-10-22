// RFC-396 live acceptance: a compiled Bun 1.4.3 verifier ran PATH Bun 1.3.13.
// Keep process versions distinct, and invalidate evidence when the actual tool changes.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readVerificationEnvironment } from '@/modules/development-automation/infrastructure/local/verificationEnvironment'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function home() {
  const path = mkdtempSync(join(tmpdir(), 'rfc396-environment-'))
  homes.push(path)
  return path
}

test('verification process versions are explicitly separate from PATH runtime observations', async () => {
  const snapshot = await readVerificationEnvironment(home())
  const description = JSON.parse(snapshot.description)
  expect(description.verifierRuntime.bun).toBe(process.versions.bun)
  expect(description.pathRuntimes.bun.executable).toBe(Bun.which('bun'))
  expect(description.runtimeProbeScope).toContain('PATH bun/node only')
  expect(description.runtimes).toBeUndefined()
})

test.skipIf(process.platform === 'win32')(
  'PATH version drift changes evidence identity; absent, failed and timed-out probes never use embedded versions',
  async () => {
    const root = home(),
      bin = join(root, 'bin')
    mkdirSync(bin)
    const source = resolve(
      import.meta.dir,
      '../src/modules/development-automation/infrastructure/local/verificationEnvironment.ts',
    )
    const entry = join(root, 'observe.ts')
    writeFileSync(
      entry,
      `import { readVerificationEnvironment } from ${JSON.stringify(source)}; console.log(JSON.stringify(await readVerificationEnvironment(process.argv[2]!)))`,
    )
    function runtime(name: string, body: string) {
      const path = join(bin, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o755)
    }
    async function observe() {
      const child = Bun.spawn([process.execPath, entry, root], {
        env: { ...process.env, PATH: bin },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code) throw new Error(err)
      const snapshot = JSON.parse(out)
      return { digest: snapshot.digest, description: JSON.parse(snapshot.description) }
    }
    runtime('bun', "printf 'fixture-bun-v1\\n'")
    runtime('node', "printf 'fixture-node-v1\\n'")
    const first = await observe()
    expect(first.description.pathRuntimes.bun.version).toBe('fixture-bun-v1')
    expect(first.description.pathRuntimes.node.version).toBe('fixture-node-v1')
    expect((await observe()).digest).toBe(first.digest)
    runtime('bun', "printf 'fixture-bun-v2\\n'")
    const changed = await observe()
    expect(changed.digest).not.toBe(first.digest)
    expect(changed.description.pathRuntimes.bun.version).toBe('fixture-bun-v2')
    rmSync(join(bin, 'bun'))
    expect((await observe()).description.pathRuntimes.bun).toEqual({
      executable: null,
      status: 'missing',
      version: null,
    })
    runtime('bun', 'exit 7')
    const failed = await observe()
    expect(failed.description.pathRuntimes.bun.status).toBe('failed')
    expect(failed.description.pathRuntimes.bun.version).toBeNull()
    runtime('bun', 'exec /bin/sleep 10')
    const timedOut = await observe()
    expect(timedOut.description.pathRuntimes.bun.status).toBe('timeout')
    expect(timedOut.description.pathRuntimes.bun.version).toBeNull()
    expect(timedOut.digest).not.toBe(failed.digest)
  },
  20_000,
)
