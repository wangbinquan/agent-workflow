// RFC-625: real full builders and different Bun processes consume the same job-local data artifact.
import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRfc395SourceManifest } from './helpers/rfc395SourceManifestFixture'
import { expectCompleteSourceManifest } from './helpers/rfc625SourceManifestAssertions'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import {
  createRfc395FixtureDatabase,
  createRfc395FixtureRuntime,
} from './helpers/rfc395FixturePostgresql'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { PostgresqlPool } from '@/platform/persistence/postgresqlRuntime'

const providers = resolveTestProviders(process.env)
const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
const sourceUrl = urlEnv ? process.env[urlEnv] : undefined

async function withReference<T>(
  provider: DatabaseProvider,
  work: (pool?: PostgresqlPool) => Promise<T>,
) {
  if (provider === 'sqlite') return work()
  const database = await createRfc395FixtureDatabase(sourceUrl!)
  const runtime = createRfc395FixtureRuntime({
    generationId: 'dbg_rfc625_manifest_reference',
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC625_REFERENCE_URL',
      poolMax: 1,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
    },
    env: { RFC625_REFERENCE_URL: database.url },
  })
  try {
    return await work(runtime.providerPool('migration'))
  } finally {
    try {
      await runtime.close()
    } finally {
      await database.drop()
    }
  }
}

for (const provider of providers) {
  test(`complete cold/warm/off manifests agree with the real ${provider} compiler`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-r625-native-manifest-'))
    try {
      await withReference(provider, async (referencePool) => {
        let builds = 0
        const input = {
          provider,
          referencePool,
          cacheRoot: root,
          async build(original: () => ReturnType<typeof prepareRfc395SourceManifest>) {
            builds++
            return original()
          },
        }
        const cold = await prepareRfc395SourceManifest(input)
        const warm = await prepareRfc395SourceManifest(input)
        expect(builds).toBe(1)
        const uncached = await prepareRfc395SourceManifest({ ...input, cacheRoot: null })
        expect(builds).toBe(2)
        expectCompleteSourceManifest(cold, uncached)
        expectCompleteSourceManifest(warm, uncached)
        expect(warm).not.toBe(cold)
        expect(warm.sources[0]).not.toBe(cold.sources[0])
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)

  test(`separate ${provider} Bun processes hit a full artifact after its builder has closed`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-r625-isolate-manifest-'))
    const helper = join(import.meta.dir, 'helpers/rfc395SourceManifestFixture.ts')
    const databaseHelper = join(import.meta.dir, 'helpers/rfc395FixturePostgresql.ts')
    const worker = join(root, 'worker.ts')
    await writeFile(
      worker,
      `
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareRfc395SourceManifest } from ${JSON.stringify(helper)}
import { createRfc395FixtureRuntime } from ${JSON.stringify(databaseHelper)}
const [root, provider] = process.argv.slice(2)
let runtime
try {
  if (provider === 'postgresql') {
    runtime = createRfc395FixtureRuntime({
      generationId: 'dbg_rfc625_child_reference',
      config: { provider: 'postgresql', urlEnv: 'RFC625_REFERENCE_URL', poolMax: 1, connectTimeoutMs: 10000, statementTimeoutMs: 30000, idleTimeoutMs: 30000 },
      env: { RFC625_REFERENCE_URL: process.env.RFC625_REFERENCE_URL }
    })
  }
  const manifest = await prepareRfc395SourceManifest({
    provider, referencePool: runtime?.providerPool('migration'), cacheRoot: join(root, 'cache'),
    async build(original) {
      await appendFile(join(root, 'builds'), 'original-builder\\n')
      return original()
    }
  })
  console.log('MANIFEST ' + JSON.stringify({ chain: manifest.chainDigest, head: manifest.headDigest, sources: manifest.sources.map(s => s.id) }))
} finally {
  await runtime?.close()
}
`,
    )
    const deadline = performance.now() + 80_000
    const run = async () => {
      const database =
        provider === 'postgresql' ? await createRfc395FixtureDatabase(sourceUrl!) : undefined
      let child: ReturnType<typeof Bun.spawn> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const childProcess = Bun.spawn(
          [
            process.execPath,
            '--tsconfig-override',
            join(import.meta.dir, '../tsconfig.json'),
            worker,
            root,
            provider,
          ],
          {
            cwd: join(import.meta.dir, '..'),
            env: { ...process.env, RFC625_REFERENCE_URL: database?.url },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        // A hung child must finish before the enclosing test's original 90s budget expires.
        child = childProcess
        timer = setTimeout(
          () => childProcess.kill('SIGKILL'),
          Math.max(1, deadline - performance.now()),
        )
        const [code, stdout, stderr] = await Promise.all([
          childProcess.exited,
          new Response(childProcess.stdout).text(),
          new Response(childProcess.stderr).text(),
        ])
        expect(code, stderr).toBe(0)
        const line = stdout.split('\n').find((value) => value.startsWith('MANIFEST '))
        expect(line).toBeDefined()
        return { line, stdout }
      } finally {
        clearTimeout(timer)
        child?.kill('SIGKILL')
        await child?.exited
        await database?.drop()
      }
    }
    try {
      const first = await run() // Own reference/runtime are closed before starting another isolate.
      const second = await run()
      expect(second.line).toBe(first.line)
      expect(first.stdout).toContain('rfc395-source-manifest miss')
      expect(second.stdout).toContain('rfc395-source-manifest hit')
      expect((await readFile(join(root, 'builds'), 'utf8')).trim().split('\n')).toEqual([
        'original-builder',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
}

describeV1Providers(
  'RFC-625 cached manifest preserves independent installed sources',
  (h) => {
    const databases = new Set<string>()
    afterAll(() => {
      expect(databases.size).toBe(2)
    })
    for (const name of ['first', 'second'])
      test(`${name} source has independent rows and DDL`, async () => {
        await h.install('head')
        const identity =
          h.provider === 'sqlite'
            ? h.sqlitePath
            : String((await h.native.execute('SELECT current_database() AS name'))[0]!.name)
        expect(databases.has(identity)).toBe(false)
        databases.add(identity)
        const reader = await h.source()
        expect((await reader.preflight()).fingerprint.provider).toBe(h.provider)
        const table = h.table('rfc625_private_fixture')
        await h.native.execute(
          `CREATE TABLE ${table} (id integer PRIMARY KEY, value text NOT NULL)`,
        )
        await h.native.execute(`INSERT INTO ${table} VALUES (1, '${name}')`)
        expect(await h.native.execute(`SELECT * FROM ${table}`)).toEqual([{ id: 1, value: name }])
      }, 40_000)
  },
  { initialSourceVersion: 'head' },
)
