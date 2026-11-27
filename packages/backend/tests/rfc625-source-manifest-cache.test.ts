// RFC-625: complete source catalogs may be shared; admission, case state and deadlines may not.
import { beforeAll, expect, test } from 'bun:test'
import { deserialize, serialize } from 'bun:jsc'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  loadFrozenEpoch1History,
  type FrozenEpoch1History,
} from '@/platform/persistence/migration/epoch1/bundle'
import {
  loadSupportedSourceManifest,
  type SupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import {
  prepareRfc395SourceManifest,
  sourceManifestCacheInputs,
  sourceManifestImplementationDigest,
  type SourceManifestFixtureOptions,
  type SourceManifestIdentity,
} from './helpers/rfc395SourceManifestFixture'
import { fixtureCacheKey, fixtureDigest } from './helpers/testFixtureCache'
import { expectCompleteSourceManifest } from './helpers/rfc625SourceManifestAssertions'

let history: FrozenEpoch1History
let originalManifest: SupportedSourceManifest
beforeAll(async () => {
  history = await loadFrozenEpoch1History()
  originalManifest = await loadSupportedSourceManifest()
}, 90_000)

const identity: SourceManifestIdentity = {
  runtime: {
    bunVersion: 'fixture-bun',
    bunRevision: 'fixture-revision',
    executableDigest: 'fixture-executable',
    platform: 'fixture-platform',
    architecture: 'fixture-architecture',
    sqliteVersion: 'fixture-sqlite',
    sqliteSourceId: 'fixture-sqlite-source',
    sqliteCompileOptions: ['option-a', 'option-b'],
  },
  implementationDigest: 'fixture-implementation',
  releasedFiles: { 'root/contract.json': 'contract', 'root/catalog.json': 'catalog' },
}
const pg = {
  version: 170012,
  major: 17,
  encoding: 'UTF8',
  collation: 'C',
  ctype: 'C',
  settings: { standard_conforming_strings: 'on' },
}
const options = (cacheRoot: string | null): SourceManifestFixtureOptions => ({
  provider: 'sqlite',
  cacheRoot,
  admitHistory: async () => history,
  identity: async () => identity,
  build: async () => originalManifest,
})
async function directory(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aw-r625-source-cache-'))
  try {
    await work(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('complete warm results keep shared references and give each consumer a fresh graph', async () => {
  await directory(async (root) => {
    let builds = 0
    let admissions = 0
    const input = {
      ...options(join(root, 'cache')),
      admitHistory: async () => {
        admissions++
        return history
      },
      build: async () => {
        builds++
        return originalManifest
      },
    }
    const cold = await prepareRfc395SourceManifest(input)
    const warm = await prepareRfc395SourceManifest(input)
    expectCompleteSourceManifest(cold, originalManifest)
    expectCompleteSourceManifest(warm, originalManifest)
    expect(warm).not.toBe(cold)
    expect(warm.sources).not.toBe(cold.sources)
    expect(warm.sources[0]!.catalog[0]).not.toBe(cold.sources[0]!.catalog[0])
    Object.assign(cold.sources[0]!.catalog[0]!, { definition: 'one consumer changed its copy' })
    const third = await prepareRfc395SourceManifest(input)
    expectCompleteSourceManifest(third, originalManifest)
    expectCompleteSourceManifest(warm, originalManifest)
    expect(builds).toBe(1)
    expect(admissions).toBe(3)
  })
}, 30_000)

test('disabled caching calls the original builder without identity, serialization or a cache directory', async () => {
  let calls = 0
  const result = await prepareRfc395SourceManifest({
    ...options(null),
    identity: async () => {
      throw new Error('disabled cache must not compute identity')
    },
    async build(original) {
      calls++
      return original()
    },
  })
  expectCompleteSourceManifest(result, originalManifest)
  expect(calls).toBe(1)
}, 30_000)

test('a warm artifact never bypasses a rejected frozen admission', async () => {
  await directory(async (root) => {
    await prepareRfc395SourceManifest(options(root))
    let identityReads = 0
    await expect(
      prepareRfc395SourceManifest({
        ...options(root),
        admitHistory: async () => {
          throw new Error('actual frozen input changed')
        },
        identity: async () => {
          identityReads++
          return identity
        },
      }),
    ).rejects.toThrow('actual frozen input changed')
    expect(identityReads).toBe(0)
  })
})

test('the real key includes every environment, compiler, released and parsed-history dimension', () => {
  const key = (input: Parameters<typeof sourceManifestCacheInputs>) =>
    fixtureCacheKey('rfc395-source-manifest', sourceManifestCacheInputs(...input))
  const original = key(['postgresql', history, identity, pg])
  for (const field of Object.keys(identity.runtime) as (keyof typeof identity.runtime)[]) {
    const runtime = {
      ...identity.runtime,
      [field]: field === 'sqliteCompileOptions' ? ['different'] : 'different',
    }
    expect(key(['postgresql', history, { ...identity, runtime }, pg])).not.toBe(original)
  }
  for (const field of Object.keys(pg) as (keyof typeof pg)[])
    expect(
      key([
        'postgresql',
        history,
        identity,
        {
          ...pg,
          [field]:
            field === 'settings'
              ? { standard_conforming_strings: 'off' }
              : typeof pg[field] === 'number'
                ? Number(pg[field]) + 1
                : 'different',
        },
      ]),
    ).not.toBe(original)
  expect(key(['sqlite', history, identity, null])).not.toBe(original)
  expect(
    key(['postgresql', history, { ...identity, implementationDigest: 'changed' }, pg]),
  ).not.toBe(original)
  expect(
    key([
      'postgresql',
      history,
      { ...identity, releasedFiles: { ...identity.releasedFiles, 'root/catalog.json': 'changed' } },
      pg,
    ]),
  ).not.toBe(original)
  for (const changed of [
    { ...history, chainDigest: 'changed-chain' },
    { ...history, sqliteTags: [...history.sqliteTags].reverse() },
    {
      ...history,
      sqlite: [
        { ...history.sqlite[0]!, sql: [...history.sqlite[0]!.sql, 'SELECT 625'] },
        ...history.sqlite.slice(1),
      ],
    },
    {
      ...history,
      sqlite: [
        { ...history.sqlite[0]!, folderMillis: history.sqlite[0]!.folderMillis + 1 },
        ...history.sqlite.slice(1),
      ],
    },
    {
      ...history,
      postgresql: {
        ...history.postgresql,
        head: {
          ...history.postgresql.head,
          contract: { ...history.postgresql.head.contract, digest: 'changed-head' },
        },
      },
    },
    {
      ...history,
      postgresql: {
        ...history.postgresql,
        versions: [
          {
            ...history.postgresql.versions[0]!,
            plan: { ...history.postgresql.versions[0]!.plan, digest: 'changed-plan' },
          },
          ...history.postgresql.versions.slice(1),
        ],
      },
    },
  ])
    expect(key(['postgresql', changed, identity, pg])).not.toBe(original)
  expect(() => sourceManifestCacheInputs('postgresql', history, identity, null)).toThrow(
    'provider identity',
  )
})

test('implementation input hashing includes modified, added and removed actual source paths', async () => {
  await directory(async (root) => {
    const configurations = [
      'tsconfig.base.json',
      'packages/backend/tsconfig.json',
      'packages/shared/tsconfig.json',
    ]
    const files = [
      'packages/backend/src/entry.ts',
      'packages/shared/src/value.ts',
      'packages/backend/tests/helpers/rfc395SourceManifestFixture.ts',
      'packages/backend/tests/helpers/testFixtureCache.ts',
      'packages/backend/tests/helpers/rfc395V1Harness.ts',
      'package.json',
      'packages/backend/package.json',
      'packages/shared/package.json',
      'bun.lock',
      ...configurations,
    ]
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), file)
    }
    const first = await sourceManifestImplementationDigest(root)
    for (const configuration of configurations) {
      await writeFile(
        join(root, configuration),
        JSON.stringify({ compilerOptions: { paths: { '@/*': ['alternate/*'] } } }),
      )
      expect(await sourceManifestImplementationDigest(root)).not.toBe(first)
      await writeFile(join(root, configuration), configuration)
      expect(await sourceManifestImplementationDigest(root)).toBe(first)
    }
    await writeFile(join(root, files[0]!), 'modified in the shared worktree')
    const modified = await sourceManifestImplementationDigest(root)
    expect(modified).not.toBe(first)
    const added = join(root, 'packages/shared/src/untracked.ts')
    await writeFile(added, 'new input')
    expect(await sourceManifestImplementationDigest(root)).not.toBe(modified)
    await rm(added)
    expect(await sourceManifestImplementationDigest(root)).toBe(modified)
    await rm(join(root, 'bun.lock'))
    await expect(sourceManifestImplementationDigest(root)).rejects.toThrow()
  })
})

test('changed identities really miss the artifact and build a new complete entry', async () => {
  await directory(async (root) => {
    let builds = 0
    const input = {
      ...options(root),
      build: async () => {
        builds++
        return originalManifest
      },
    }
    await prepareRfc395SourceManifest(input)
    await prepareRfc395SourceManifest(input)
    await prepareRfc395SourceManifest({
      ...input,
      identity: async () => ({ ...identity, implementationDigest: 'new implementation' }),
    })
    expect(builds).toBe(2)
    expect(
      (await readdir(root)).filter((name) => name.startsWith('rfc395-source-manifest-')),
    ).toHaveLength(2)
  })
})

test('the whole deadline includes admission before any identity or cache work', async () => {
  await directory(async (root) => {
    const cache = join(root, 'not-created')
    let identityReads = 0
    await expect(
      prepareRfc395SourceManifest({
        ...options(cache),
        timeoutMs: 20,
        admitHistory: async () => {
          await new Promise((done) => setTimeout(done, 40))
          return history
        },
        identity: async () => {
          identityReads++
          return identity
        },
      }),
    ).rejects.toThrow('deadline exceeded')
    expect(identityReads).toBe(0)
    expect(existsSync(cache)).toBe(false)
  })
})

test('time spent finding the key is not a fresh materialization budget', async () => {
  await directory(async (root) => {
    const cache = join(root, 'not-created')
    let builds = 0
    await expect(
      prepareRfc395SourceManifest({
        ...options(cache),
        timeoutMs: 20,
        identity: async () => {
          await new Promise((done) => setTimeout(done, 40))
          return identity
        },
        build: async () => {
          builds++
          return originalManifest
        },
      }),
    ).rejects.toThrow('deadline exceeded')
    expect(builds).toBe(0)
    expect(existsSync(cache)).toBe(false)
  })
})

test('a waiting consumer spends only the remaining prepare budget and leaves the owner intact', async () => {
  await directory(async (root) => {
    const entered = deferred(),
      release = deferred()
    const owner = prepareRfc395SourceManifest({
      ...options(root),
      build: async () => {
        entered.resolve()
        await release.promise
        return originalManifest
      },
    })
    const ownerOutcome = owner.catch((error: unknown) => error)
    try {
      await Promise.race([
        entered.promise,
        owner.then(() => {
          throw new Error('owner did not wait')
        }),
      ])
      let builds = 0
      await expect(
        prepareRfc395SourceManifest({
          ...options(root),
          timeoutMs: 500,
          admitHistory: async () => {
            await new Promise((done) => setTimeout(done, 250))
            return history
          },
          build: async () => {
            builds++
            return originalManifest
          },
        }),
      ).rejects.toThrow()
      expect(builds).toBe(0)
      expect((await readdir(root)).some((name) => name.endsWith('.lock'))).toBe(true)
    } finally {
      release.resolve()
      await ownerOutcome
    }
    expectCompleteSourceManifest(await owner, originalManifest)
    expect(await ownerOutcome).not.toBeInstanceOf(Error)
    expectCompleteSourceManifest(await prepareRfc395SourceManifest(options(root)), originalManifest)
  })
}, 30_000)

for (const cancellation of ['signal', 'deadline'] as const)
  test(`a ${cancellation} followed by a late builder result never publishes an artifact`, async () => {
    await directory(async (root) => {
      const entered = deferred(),
        release = deferred()
      const controller = new AbortController()
      const pending = prepareRfc395SourceManifest({
        ...options(root),
        signal: controller.signal,
        timeoutMs: cancellation === 'deadline' ? 1000 : 90_000,
        build: async () => {
          entered.resolve()
          await release.promise
          return originalManifest
        },
      })
      const rejected = pending.catch((error: unknown) => error)
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('builder did not wait')
        }),
      ])
      if (cancellation === 'signal') controller.abort(new Error('cancelled prepare'))
      else await new Promise((done) => setTimeout(done, 1020))
      release.resolve()
      expect(await rejected).toBeInstanceOf(Error)
      expect(await readdir(root)).toEqual([])
      expectCompleteSourceManifest(
        await prepareRfc395SourceManifest(options(root)),
        originalManifest,
      )
    })
  })

test('builder failure and incomplete population are not reusable; the next complete build succeeds', async () => {
  await directory(async (root) => {
    await expect(
      prepareRfc395SourceManifest({
        ...options(root),
        build: async () => {
          throw new Error('original build failure')
        },
      }),
    ).rejects.toThrow('original build failure')
    expect(await readdir(root)).toEqual([])
    await expect(
      prepareRfc395SourceManifest({
        ...options(root),
        build: async () => ({ ...originalManifest, sources: originalManifest.sources.slice(1) }),
      }),
    ).rejects.toThrow('population')
    expect(await readdir(root)).toEqual([])
    expectCompleteSourceManifest(await prepareRfc395SourceManifest(options(root)), originalManifest)
  })
})

for (const damage of ['bytes', 'envelope', 'population'] as const)
  test(`a ${damage} error is rejected on the actual artifact-consumer path`, async () => {
    await directory(async (root) => {
      await prepareRfc395SourceManifest(options(root))
      const [entry] = await readdir(root)
      const artifact = join(root, entry!, 'artifact')
      const metadataPath = join(root, entry!, 'manifest.json')
      let bytes: Buffer = await readFile(artifact)
      if (damage === 'bytes') bytes[0] = bytes[0]! ^ 1
      else {
        const envelope = deserialize(bytes) as {
          version: number
          manifest: SupportedSourceManifest
        }
        if (damage === 'envelope') envelope.version = 2
        else
          envelope.manifest = { ...envelope.manifest, sources: envelope.manifest.sources.slice(1) }
        bytes = serialize(envelope, { binaryType: 'nodebuffer' })
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
        await writeFile(
          metadataPath,
          JSON.stringify({ ...metadata, size: bytes.length, sha256: fixtureDigest(bytes) }),
        )
      }
      await writeFile(artifact, bytes)
      await expect(prepareRfc395SourceManifest(options(root))).rejects.toThrow(
        damage === 'bytes'
          ? 'digest mismatch'
          : damage === 'envelope'
            ? 'envelope mismatch'
            : 'population',
      )
    })
  })

test('preparation cannot request a larger timeout than the existing beforeAll', async () => {
  await expect(
    prepareRfc395SourceManifest({ ...options(null), timeoutMs: 90_001 }),
  ).rejects.toThrow('90s')
})
