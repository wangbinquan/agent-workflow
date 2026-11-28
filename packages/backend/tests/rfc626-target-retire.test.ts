// RFC-626 §4.2 "退掉旧的新库不能依赖当前二进制的目标契约" and §5
// (design/RFC-626-upgrade-no-refusal-minimal-time/design.md), on a real target database.
// When the conversion material changes after a target was built — another candidate build, a
// newer converter, a different target contract — the upgrade starts a new run and has to give
// up the target of the old one. Opening a target requires its generation to carry the
// contract and plan digests of the running binary, so a binary with a different target
// contract could never retire the half-built target of its predecessor. The target port
// therefore retires a generation by the identity the journal stored for it: the generation id
// and the kind of database, nothing else. It runs the retirement the opened handle runs and
// touches migration metadata only.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { markFirstLiveWrite } from '@/platform/persistence/schema/history/markers'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import type { MigrationMetaStore } from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createTargetGenerationPort } from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import { SYSTEM_USER } from './rfc626-engine-fixtures.test'
import {
  convertedTarget,
  fixtureHandle,
  fixtureHead,
  installFixtureTarget,
  seedRows,
  targetIds,
} from './rfc626-target-fixtures.test'

// Installing the fixture schema and opening the target a second time takes a few seconds per
// case on a CI-scaled PostgreSQL; 60 s leaves the margin the other target tests use.
setDefaultTimeout(60_000)

const RETIRED_AT = 999

describeV3Providers('RFC-626 retiring a target generation by its stored identity', (h) => {
  /**
   * The port of a binary whose target contract is not the one this generation was built
   * with: the product schema, while the generation holds the synthetic one.
   */
  function port() {
    return createTargetGenerationPort({
      appHome: h.appHome,
      registry: persistenceSchema,
      head: h.head,
      catalogCache: h.catalogCache,
      now: () => RETIRED_AT,
      postgresql: {
        open: async () => openConversionTarget({ runtime: h.runtime }),
        preflight: async () => {
          throw new Error('unused-preflight')
        },
      },
    })
  }
  const identity = (generationId: string = h.generationId) => ({
    generationId,
    provider: h.targetProvider,
    location: h.targetLocation,
  })
  /** The generation row a target port writes when it creates the target. */
  async function register(
    meta: MigrationMetaStore,
    options: { readonly runId?: string; readonly provider?: DatabaseProvider } = {},
  ): Promise<void> {
    await h.target.transaction((tx) =>
      meta.withConnection(tx).insert('generations', {
        generationId: h.generationId,
        schemaEpoch: 2,
        role: 'converted',
        state: 'prepared',
        provider: options.provider ?? h.targetProvider,
        operationId: h.operationId,
        runId: options.runId ?? null,
        sourceGenerationId: 'dbg_rfc626_fixture_source',
        contractDigest: fixtureHead.contract.contract.digest,
        planDigest: fixtureHead[h.targetProvider].digest,
        activationReceiptDigest: null,
        createdAt: 123,
        activatedAt: null,
        retiredAt: null,
      }),
    )
  }
  const generation = async (meta: MigrationMetaStore) =>
    (await meta.select('generations', { generationId: h.generationId }))[0]!

  test('a generation built for another target contract cannot be opened and can be retired', async () => {
    const f = await convertedTarget(h, seedRows)
    await register(f.meta, { runId: f.runId })
    expect(fixtureHead.contract.contract.digest).not.toBe(h.head.contract.contract.digest)
    await expect(port().open(identity())).rejects.toThrow('v3-target-generation-mismatch')

    expect(await port().retire(identity())).toBe('retired')
    expect(await generation(f.meta)).toMatchObject({
      state: 'retired',
      retiredAt: RETIRED_AT,
      // What the generation was built with stays on record.
      contractDigest: fixtureHead.contract.contract.digest,
      planDigest: fixtureHead[h.targetProvider].digest,
    })
    // Its run is retired with it; business rows are not touched.
    expect((await f.meta.migrationRun(f.runId))?.state).toBe('retired')
    expect(await targetIds(h, 'fx_users')).toEqual([SYSTEM_USER])
    expect(await fixtureHandle(h).firstLiveWriteAt()).toBeNull()

    // Asked again — after a restart, say — it says so and changes nothing.
    expect(await port().retire(identity())).toBe('already-retired')
    expect(await generation(f.meta)).toMatchObject({ state: 'retired', retiredAt: RETIRED_AT })
  })

  test('it is the retirement an opened handle runs', async () => {
    const meta = await installFixtureTarget(h)
    await register(meta)
    expect(await fixtureHandle(h).retireIfUnwritten()).toBe('retired')
    expect(await port().retire(identity())).toBe('already-retired')
  })

  test('a generation that has taken its first write is not retired', async () => {
    const meta = await installFixtureTarget(h)
    await register(meta)
    await h.target.transaction((tx) => markFirstLiveWrite(tx, h.generationId, 456))
    expect(await port().retire(identity())).toBe('written')
    expect(await generation(meta)).toMatchObject({ state: 'prepared', retiredAt: null })
  })

  test('a generation the database does not hold is absent', async () => {
    const meta = await installFixtureTarget(h)
    await register(meta)
    expect(await port().retire(identity('dbg_rfc626_never_built'))).toBe('absent')
    expect(await generation(meta)).toMatchObject({ state: 'prepared', retiredAt: null })
  })

  // The target contract and plan are not compared; the kind of database still is.
  test('a generation stored for the other kind of database is not the one asked for', async () => {
    const other: DatabaseProvider = h.targetProvider === 'sqlite' ? 'postgresql' : 'sqlite'
    const meta = await installFixtureTarget(h)
    await register(meta, { provider: other })
    await expect(port().retire(identity())).rejects.toThrow('v3-target-generation-mismatch')
    expect(await generation(meta)).toMatchObject({ state: 'prepared', retiredAt: null })
    // A location that does not belong to the provider named is refused before anything is opened.
    await expect(port().retire({ ...identity(), provider: other })).rejects.toThrow(
      'v3-target-provider-mismatch',
    )
  })

  test.skipIf(h.targetProvider !== 'sqlite')(
    'no database at the stored location: absent, and none is created',
    async () => {
      const relativePath = 'databases/dbg_rfc626_never_created/db.sqlite'
      expect(
        await port().retire({
          generationId: 'dbg_rfc626_never_created',
          provider: 'sqlite',
          location: { kind: 'sqlite-file', relativePath },
        }),
      ).toBe('absent')
      expect(existsSync(join(h.appHome, relativePath))).toBe(false)
    },
  )

  // The database was created and the process died before the install transaction committed:
  // the location exists and holds nothing, so the generation the journal names is not there.
  test('a database that was created and never installed holds no such generation: absent', async () => {
    expect(await port().retire(identity())).toBe('absent')
  })
})
