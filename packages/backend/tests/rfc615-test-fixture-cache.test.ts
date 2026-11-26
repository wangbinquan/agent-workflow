// RFC-615: --isolate must share only complete immutable preparation artifacts, never case state.
import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureCacheKey, materializeTestFixture } from './helpers/testFixtureCache'

async function directory(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aw-fixture-cache-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test('cache inputs are order-stable and reject lossy values or unsafe namespaces', () => {
  expect(fixtureCacheKey('sample', { b: 2, a: [1, 'x'] })).toBe(
    fixtureCacheKey('sample', { a: [1, 'x'], b: 2 }),
  )
  for (const changed of [
    { b: 3, a: [1, 'x'] },
    { b: 2, a: ['x', 1] },
  ])
    expect(fixtureCacheKey('sample', changed)).not.toBe(
      fixtureCacheKey('sample', { b: 2, a: [1, 'x'] }),
    )
  expect(() => fixtureCacheKey('../escape', {})).toThrow('kind')
  expect(() => fixtureCacheKey('sample', { number: Number.NaN })).toThrow('finite JSON')
  expect(() => fixtureCacheKey('sample', { number: Infinity })).toThrow('finite JSON')
})

test('a hit copies private bytes, and changed inputs build a new entry', async () => {
  await directory(async (root) => {
    let builds = 0
    const cacheRoot = join(root, 'cache')
    const make = (name: string, version = 1) =>
      materializeTestFixture({
        kind: 'sample',
        inputs: { version },
        cacheRoot,
        destination: join(root, name),
        async build(path) {
          builds++
          await writeFile(path, `artifact-${version}`)
        },
      })
    expect((await make('first')).cache).toBe('miss')
    expect((await make('second')).cache).toBe('hit')
    await writeFile(join(root, 'first'), 'private mutation')
    await rm(join(root, 'second'))
    expect((await make('third')).cache).toBe('hit')
    expect(await readFile(join(root, 'third'), 'utf8')).toBe('artifact-1')
    expect((await make('changed', 2)).cache).toBe('miss')
    expect(builds).toBe(2)
    expect(
      (await readdir(cacheRoot)).some(
        (name) => name.endsWith('.lock') || name.startsWith('.fixture-'),
      ),
    ).toBe(false)
  })
})

test('competing consumers wait asynchronously and cannot observe a partially built artifact', async () => {
  await directory(async (root) => {
    const entered = deferred(),
      release = deferred()
    let builds = 0
    const make = (name: string) =>
      materializeTestFixture({
        kind: 'partial',
        inputs: {},
        cacheRoot: join(root, 'cache'),
        destination: join(root, name),
        async build(path) {
          builds++
          await writeFile(path, 'incomplete')
          entered.resolve()
          await release.promise
          await writeFile(path, 'complete artifact')
        },
      })
    const first = make('first')
    await entered.promise
    const second = make('second')
    expect(existsSync(join(root, 'first'))).toBe(false)
    expect(existsSync(join(root, 'second'))).toBe(false)
    release.resolve()
    expect((await Promise.all([first, second])).map((r) => r.cache).sort()).toEqual(['hit', 'miss'])
    expect(builds).toBe(1)
    expect(await readFile(join(root, 'second'), 'utf8')).toBe('complete artifact')
  })
})

test('two real Bun processes sharing a job root build the same key exactly once', async () => {
  await directory(async (root) => {
    const helper = join(import.meta.dir, 'helpers/testFixtureCache.ts')
    const worker = join(root, 'worker.ts')
    await writeFile(
      worker,
      `
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { materializeTestFixture } from ${JSON.stringify(helper)}
const [root, name] = process.argv.slice(2)
const result = await materializeTestFixture({
  kind: 'processes', inputs: { version: 1 }, cacheRoot: join(root, 'cache'),
  destination: join(root, name),
  async build(path) {
    await appendFile(join(root, 'builds'), name + '\\n')
    await new Promise(resolve => setTimeout(resolve, 100))
    await writeFile(path, 'process artifact')
  }
})
console.log(result.cache)
`,
    )
    const children = ['first', 'second'].map((name) =>
      Bun.spawn([process.execPath, 'run', worker, root, name], { stdout: 'pipe', stderr: 'pipe' }),
    )
    try {
      const results = await Promise.all(
        children.map(async (child) => {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect(stderr).toBe('')
          expect(code).toBe(0)
          return stdout
        }),
      )
      expect(results.filter((text) => text.endsWith('miss\n'))).toHaveLength(1)
      expect(results.filter((text) => text.endsWith('hit\n'))).toHaveLength(1)
      expect((await readFile(join(root, 'builds'), 'utf8')).trim().split('\n')).toHaveLength(1)
      expect(await readFile(join(root, 'first'), 'utf8')).toBe('process artifact')
      expect(await readFile(join(root, 'second'), 'utf8')).toBe('process artifact')
    } finally {
      for (const child of children) child.kill('SIGKILL')
      await Promise.all(children.map((child) => child.exited))
    }
  })
}, 15_000)

test('failure and cancellation remove only owned preparation state and permit the next cold build', async () => {
  await directory(async (root) => {
    const cacheRoot = join(root, 'cache'),
      destination = join(root, 'case')
    await writeFile(destination, 'previous case bytes')
    await expect(
      materializeTestFixture({
        kind: 'failure',
        inputs: {},
        cacheRoot,
        destination,
        async build(path) {
          await writeFile(path, 'partial')
          throw new Error('original builder failure')
        },
      }),
    ).rejects.toThrow('original builder failure')
    expect(await readdir(cacheRoot)).toEqual([])
    expect(await readFile(destination, 'utf8')).toBe('previous case bytes')
    const controller = new AbortController(),
      entered = deferred()
    let drained = false
    const cancelled = materializeTestFixture({
      kind: 'failure',
      inputs: {},
      cacheRoot,
      destination,
      signal: controller.signal,
      async build(path, signal) {
        await writeFile(path, 'partial')
        entered.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        drained = true
        signal.throwIfAborted()
      },
    })
    const rejected = cancelled.catch((error: unknown) => error)
    await entered.promise
    controller.abort(new Error('cancelled fixture'))
    const error = await rejected
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('cancelled fixture')
    expect(drained).toBe(true)
    expect(await readdir(cacheRoot)).toEqual([])
    expect(
      (
        await materializeTestFixture({
          kind: 'failure',
          inputs: {},
          cacheRoot,
          destination,
          async build(path) {
            await writeFile(path, 'complete')
          },
        })
      ).cache,
    ).toBe('miss')
  })
})

test('an abandoned lock fails within its deadline without stealing or deleting the owner', async () => {
  await directory(async (root) => {
    const cacheRoot = join(root, 'cache')
    const lock = join(cacheRoot, `abandoned-${fixtureCacheKey('abandoned', {})}.lock`)
    await mkdir(lock, { recursive: true })
    const owner = JSON.stringify({ pid: 123456789, token: 'belongs-to-another-owner' })
    await writeFile(join(lock, 'owner.json'), owner)
    let built = false
    await expect(
      materializeTestFixture({
        kind: 'abandoned',
        inputs: {},
        cacheRoot,
        destination: join(root, 'case'),
        timeoutMs: 50,
        async build() {
          built = true
        },
      }),
    ).rejects.toThrow('belongs-to-another-owner')
    expect(built).toBe(false)
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(owner)
  })
})

for (const corruption of ['bytes', 'size', 'manifest', 'executable'] as const) {
  test(`a ${corruption} corruption cannot become a valid cache hit`, async () => {
    if (corruption === 'executable' && process.platform === 'win32') return
    await directory(async (root) => {
      const cacheRoot = join(root, 'cache')
      const make = (name: string) =>
        materializeTestFixture({
          kind: 'integrity',
          inputs: {},
          cacheRoot,
          destination: join(root, name),
          executable: true,
          async build(path) {
            await writeFile(path, 'original')
          },
        })
      const first = await make('first')
      const entry = join(cacheRoot, `integrity-${first.key}`)
      if (corruption === 'bytes') await writeFile(join(entry, 'artifact'), 'tampered')
      if (corruption === 'size') await writeFile(join(entry, 'artifact'), 'x')
      if (corruption === 'manifest') await writeFile(join(entry, 'manifest.json'), '{}')
      if (corruption === 'executable') await chmod(join(entry, 'artifact'), 0o644)
      await expect(make('second')).rejects.toThrow()
      expect(existsSync(join(root, 'second'))).toBe(false)
      expect(await readFile(join(root, 'first'), 'utf8')).toBe('original')
    })
  })
}

test('an explicitly disabled cache retains cold construction and publishes no shared entry', async () => {
  await directory(async (root) => {
    let builds = 0
    for (const name of ['first', 'second']) {
      const result = await materializeTestFixture({
        kind: 'local',
        inputs: {},
        cacheRoot: null,
        destination: join(root, name),
        async build(path) {
          builds++
          await writeFile(path, 'local')
        },
      })
      expect(result.cache).toBe('disabled')
    }
    expect(builds).toBe(2)
    expect((await readdir(root)).sort()).toEqual(['first', 'second'])
  })
})
