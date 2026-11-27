// RFC-395 CIP-A: templates preserve all rows/DDL, and timeout cleanup releases real session locks.
// RFC-624: selecting the first template before allocation skips only the unused empty generation.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import { Rfc395FixtureGeneration } from './helpers/rfc395FixtureGeneration'
import { createV1FixtureResolver } from './helpers/rfc395V1Harness'
import {
  createRfc395FixtureDatabase,
  type FixtureDatabase,
} from './helpers/rfc395FixturePostgresql'

describe('RFC-624 initial allocation keys and installation admission', () => {
  test('the initial key is lazy and repeated or concurrent requests share one verified result', async () => {
    let reads = 0
    let release!: (value: { key: string; version: number }) => void
    const pending = new Promise<{ key: string; version: number }>((resolve) => {
      release = resolve
    })
    const resolver = createV1FixtureResolver('head', () => {
      reads++
      return pending
    })
    expect(reads).toBe(0)
    const first = resolver.initialKey!()
    const concurrent = resolver.initialKey!()
    expect(concurrent).toBe(first)
    expect(reads).toBe(1)
    release({ key: 'verified-head', version: 1 })
    expect(await first).toBe('verified-head')
    expect(await concurrent).toBe('verified-head')
    expect(await resolver.initialKey!()).toBe('verified-head')
    expect(reads).toBe(1)
  })

  test('separate suite instances never share their initial key cache', async () => {
    let reads = 0
    const load = async () => ({ key: `verified-${++reads}`, version: reads })
    const first = createV1FixtureResolver('head', load)
    const second = createV1FixtureResolver('head', load)
    expect(await first.initialKey!()).toBe('verified-1')
    expect(await second.initialKey!()).toBe('verified-2')
    expect(await first.initialKey!()).toBe('verified-1')
    expect(reads).toBe(2)
  })

  test('a rejected initial lookup is shared while pending and retried on the next request', async () => {
    let reads = 0
    const resolver = createV1FixtureResolver('root', async (which) => {
      reads++
      if (reads === 1) throw new Error('source verification failed')
      return { key: `verified-${which}`, version: reads }
    })
    const first = resolver.initialKey!()
    const concurrent = resolver.initialKey!()
    expect(concurrent).toBe(first)
    await expect(first).rejects.toThrow('source verification failed')
    await expect(concurrent).rejects.toThrow('source verification failed')
    expect(reads).toBe(1)
    expect(await resolver.initialKey!()).toBe('verified-root')
    expect(await resolver.initialKey!()).toBe('verified-root')
    expect(reads).toBe(2)
  })

  test('every install re-verifies its requested version even after the initial key is cached', async () => {
    const versions: string[] = []
    const resolver = createV1FixtureResolver('head', async (which) => {
      versions.push(which)
      if (versions.length === 3) throw new Error('changed source rejected at installation')
      return { key: `verified-${which}`, version: versions.length }
    })
    expect(await resolver.initialKey!()).toBe('verified-head')
    expect(await resolver.forInstall('head')).toEqual({ key: 'verified-head', version: 2 })
    await expect(resolver.forInstall('head')).rejects.toThrow(
      'changed source rejected at installation',
    )
    expect(await resolver.forInstall('pre-seq')).toEqual({ key: 'verified-pre-seq', version: 4 })
    expect(await resolver.initialKey!()).toBe('verified-head')
    expect(versions).toEqual(['head', 'head', 'head', 'pre-seq'])
  })

  test('the default harness never resolves an initial key and still verifies every install', async () => {
    const versions: string[] = []
    const resolver = createV1FixtureResolver(undefined, async (which) => {
      versions.push(which)
      return { key: `verified-${which}`, version: versions.length }
    })
    expect(resolver.initialKey).toBeUndefined()
    expect(versions).toEqual([])
    expect(await resolver.forInstall('head')).toEqual({ key: 'verified-head', version: 1 })
    expect(await resolver.forInstall('root')).toEqual({ key: 'verified-root', version: 2 })
    expect(versions).toEqual(['head', 'root'])
  })
})

const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
const sourceUrl = urlEnv ? process.env[urlEnv] : undefined
for (const provider of resolveTestProviders(process.env))
  describe(`RFC-395 immutable fixture templates [${provider}]`, () => {
    let root: string
    let generation: Rfc395FixtureGeneration
    let builds = 0
    const allocations: { name: string; template: string | undefined }[] = []
    const drops: string[] = []
    let holdAllocation: ((database: FixtureDatabase) => Promise<void>) | undefined
    let releaseAllocation: (() => void) | undefined
    const table = provider === 'sqlite' ? 'fixture_rows' : 'agent_workflow.fixture_rows'
    const identity = async () =>
      provider === 'sqlite'
        ? generation.sqlite.filename
        : String((await generation.native.execute('SELECT current_database() AS name'))[0]!.name)
    const installRows = async () => {
      if (provider === 'postgresql') await generation.native.execute('CREATE SCHEMA agent_workflow')
      await generation.native.execute(
        `CREATE TABLE ${table} (id integer PRIMARY KEY, value text NOT NULL)`,
      )
      await generation.native.execute(`INSERT INTO ${table} VALUES (1, 'original')`)
    }
    const expectEmpty = async () => {
      expect(await generation.native.execute('SELECT 7 AS value')).toEqual([{ value: 7 }])
      expect(
        await generation.native.execute(
          provider === 'sqlite'
            ? "SELECT name FROM sqlite_master WHERE type='table'"
            : "SELECT table_name FROM information_schema.tables WHERE table_schema IN ('public', 'agent_workflow') AND table_type='BASE TABLE'",
        ),
      ).toEqual([])
    }
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'aw-r395-fixture-regression-'))
      generation = new Rfc395FixtureGeneration(provider, root, sourceUrl, async (url, template) => {
        // Observe real CREATE/DROP operations; all SQL and database contents remain native.
        const database = await createRfc395FixtureDatabase(url, template)
        allocations.push({ name: database.name, template: template?.name })
        const hold = holdAllocation
        holdAllocation = undefined
        await hold?.(database)
        return {
          ...database,
          async drop() {
            await database.drop()
            drops.push(database.name)
          },
        }
      })
    }, 5_000)
    beforeEach(() => generation.reset(), 5_000)
    afterEach(async () => {
      releaseAllocation?.()
      releaseAllocation = undefined
      holdAllocation = undefined
      await generation.closeCurrent()
    }, 5_000)
    afterAll(async () => {
      try {
        await generation.close()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 5_000)
    for (const mutation of ['rows', 'schema'])
      test(`${mutation} mutations cannot change the next clone or replay installation`, async () => {
        await generation.install('baseline', async () => {
          builds++
          if (provider === 'postgresql')
            await generation.native.execute('CREATE SCHEMA agent_workflow')
          await generation.native.execute(
            `CREATE TABLE ${table} (id integer PRIMARY KEY, value text NOT NULL)`,
          )
          await generation.native.execute(`INSERT INTO ${table} VALUES (1, 'original')`)
        })
        expect(builds).toBe(1)
        expect(await generation.native.execute(`SELECT * FROM ${table}`)).toEqual([
          { id: 1, value: 'original' },
        ])
        if (mutation === 'rows')
          await generation.native.execute(`INSERT INTO ${table} VALUES (2, 'changed')`)
        else await generation.native.execute(`ALTER TABLE ${table} ADD COLUMN changed text`)
        // A second installation in the same test must upgrade the current data, not reset it.
        await generation.install('next-version', async () => {
          await generation.native.execute(`UPDATE ${table} SET value='upgraded' WHERE id=1`)
        })
        expect(
          (await generation.native.execute(`SELECT value FROM ${table} WHERE id=1`))[0]!.value,
        ).toBe('upgraded')
        expect(await generation.native.execute(`SELECT id FROM ${table} ORDER BY id`)).toEqual(
          mutation === 'rows' ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }],
        )
      })
    test('default reset still exposes an independent usable empty database after a cached install', async () => {
      await expectEmpty()
      await generation.install('default-empty-contract', installRows)
      const installedIdentity = await identity()
      await generation.reset()
      expect(await identity()).not.toBe(installedIdentity)
      await expectEmpty()
      if (provider === 'postgresql')
        expect(await generation.runtime.providerPool().unsafe('SELECT 11 AS value')).toEqual([
          { value: 11 },
        ])
      else expect(generation.sqlite.query('SELECT 11 AS value').get()).toEqual({ value: 11 })
      await generation.native.execute('CREATE TABLE direct_access (id integer PRIMARY KEY)')
      await generation.native.execute('INSERT INTO direct_access VALUES (1)')
      expect(await generation.native.execute('SELECT * FROM direct_access')).toEqual([{ id: 1 }])
    })
    test('explicit cold and warm reset preserve clone isolation and consume the first install only once', async () => {
      const key = 'explicit-initial-baseline'
      let installations = 0
      await generation.reset(key)
      await expectEmpty()
      const coldIdentity = await identity()
      await generation.install(key, async () => {
        installations++
        await installRows()
      })
      expect(installations).toBe(1)
      expect(await identity()).toBe(coldIdentity)
      const allocationsBefore = allocations.length
      const dropsBefore = drops.length
      await generation.reset(key)
      const warmIdentity = await identity()
      expect(warmIdentity).not.toBe(coldIdentity)
      expect(await generation.native.execute(`SELECT * FROM ${table}`)).toEqual([
        { id: 1, value: 'original' },
      ])
      if (provider === 'postgresql') {
        expect(allocations.slice(allocationsBefore)).toEqual([
          { name: warmIdentity, template: expect.any(String) },
        ])
        expect(drops.slice(dropsBefore)).toEqual([coldIdentity])
      }
      const beforeAcknowledgement = { allocations: allocations.length, drops: drops.length }
      await generation.install(key, async () => {
        installations++
        await installRows()
      })
      expect(installations).toBe(1)
      expect(await identity()).toBe(warmIdentity)
      expect({ allocations: allocations.length, drops: drops.length }).toEqual(
        beforeAcknowledgement,
      )
      await generation.native.execute(`INSERT INTO ${table} VALUES (2, 'retained')`)
      await generation.native.execute(`ALTER TABLE ${table} ADD COLUMN changed text`)
      for (const nextKey of [key, 'another-version']) {
        await generation.install(nextKey, async () => {
          installations++
          await generation.native.execute(`UPDATE ${table} SET value='upgraded' WHERE id=1`)
        })
        expect(await identity()).toBe(warmIdentity)
        expect(
          await generation.native.execute(`SELECT id, value FROM ${table} ORDER BY id`),
        ).toEqual([
          { id: 1, value: 'upgraded' },
          { id: 2, value: 'retained' },
        ])
        expect(await generation.native.execute(`SELECT changed FROM ${table} WHERE id=1`)).toEqual([
          { changed: null },
        ])
      }
      expect(installations).toBe(3)
      expect({ allocations: allocations.length, drops: drops.length }).toEqual(
        beforeAcknowledgement,
      )
      await generation.reset(key)
      expect(await identity()).not.toBe(warmIdentity)
      expect(await generation.native.execute(`SELECT * FROM ${table}`)).toEqual([
        { id: 1, value: 'original' },
      ])
      await expect(generation.native.execute(`SELECT changed FROM ${table}`)).rejects.toThrow()
      await generation.install(key, async () => {
        throw new Error('a warm template must not replay installation')
      })
    })
    for (const cached of [false, true])
      test(`wrong initial key rejects before mutation or allocation (${cached ? 'warm' : 'cold'})`, async () => {
        const key = `initial-key-${cached}`
        if (cached) await generation.install(key, installRows)
        await generation.reset(key)
        const originalIdentity = await identity()
        const before = { allocations: allocations.length, drops: drops.length }
        let wrongInstallations = 0
        await expect(
          generation.install('wrong-key', async () => {
            wrongInstallations++
            await generation.native.execute('CREATE TABLE wrong_installation (id integer)')
          }),
        ).rejects.toThrow(`initial fixture key mismatch: expected ${key}, received wrong-key`)
        expect(wrongInstallations).toBe(0)
        expect(await identity()).toBe(originalIdentity)
        expect({ allocations: allocations.length, drops: drops.length }).toEqual(before)
        await expect(
          generation.native.execute('SELECT * FROM wrong_installation'),
        ).rejects.toThrow()
        if (cached)
          expect(await generation.native.execute(`SELECT * FROM ${table}`)).toEqual([
            { id: 1, value: 'original' },
          ])
        else await expectEmpty()
        let matchingInstallations = 0
        await generation.install(key, async () => {
          matchingInstallations++
          await installRows()
        })
        expect(matchingInstallations).toBe(cached ? 0 : 1)
        expect(await identity()).toBe(originalIdentity)
        expect(await generation.native.execute(`SELECT * FROM ${table}`)).toEqual([
          { id: 1, value: 'original' },
        ])
      })
    test('a failed cold initial install can retry the declared key without replacing the database', async () => {
      const key = 'failed-initial-install'
      await generation.reset(key)
      const originalIdentity = await identity()
      await expect(
        generation.install(key, async () => {
          throw new Error('initial installation failed')
        }),
      ).rejects.toThrow('initial installation failed')
      await expect(
        generation.install('different-key', async () => {
          throw new Error('wrong callback must not run')
        }),
      ).rejects.toThrow('initial fixture key mismatch')
      await generation.install(key, installRows)
      expect(await identity()).toBe(originalIdentity)
      expect(await generation.native.execute(`SELECT * FROM ${table}`)).toEqual([
        { id: 1, value: 'original' },
      ])
    })
    test('cleanup drains a late installation before the next generation can start', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const running = generation.install('cancelled-installation', async () => {
        await held
        await generation.native.execute('CREATE TABLE late_installation (id integer)')
      })
      const outcome = running.then(
        () => 'completed',
        () => 'cancelled',
      )
      const closing = generation.closeCurrent()
      release()
      expect(await outcome).toBe('cancelled')
      await closing
      await generation.reset()
      await expect(generation.native.execute('SELECT * FROM late_installation')).rejects.toThrow()
    })
    if (provider === 'postgresql') {
      test('cleanup drains a pending warm allocation and drops its clone after cancellation', async () => {
        const key = 'late-warm-clone'
        await generation.install(key, installRows)
        const template = allocations.at(-1)!.name
        await generation.closeCurrent()
        const held = new Promise<void>((resolve) => {
          releaseAllocation = resolve
        })
        let allocated!: (database: FixtureDatabase) => void
        const allocation = new Promise<FixtureDatabase>((resolve) => {
          allocated = resolve
        })
        holdAllocation = async (database) => {
          allocated(database)
          await held
        }
        const resetting = generation.reset(key)
        const outcome = resetting.then(
          () => 'completed',
          (error: unknown) => (error as Error).message,
        )
        const observer = new SQL(sourceUrl!, { max: 1, idleTimeout: 0 })
        let closing: Promise<void> | undefined
        try {
          const clone = await Promise.race([
            allocation,
            resetting.then(() => {
              throw new Error('warm reset completed without reaching the real allocation barrier')
            }),
          ])
          expect(allocations.at(-1)).toEqual({ name: clone.name, template })
          expect(() => generation.install(key, installRows)).toThrow('already in progress')
          let closed = false
          closing = generation.closeCurrent().then(() => {
            closed = true
          })
          expect(() => generation.reset(key)).toThrow('already in progress')
          expect(
            await observer.unsafe('SELECT datname FROM pg_database WHERE datname=$1', [clone.name]),
          ).toEqual([{ datname: clone.name }])
          expect(closed).toBe(false)
          expect(() => generation.runtime).toThrow('Not a live PostgreSQL fixture')
          releaseAllocation!()
          expect(await outcome).toBe('RFC-395 fixture setup was cancelled')
          await closing
          expect(drops).toContain(clone.name)
          expect(
            await observer.unsafe('SELECT datname FROM pg_database WHERE datname=$1', [clone.name]),
          ).toEqual([])
          expect(
            await observer.unsafe('SELECT datname FROM pg_database WHERE datname=$1', [template]),
          ).toEqual([{ datname: template }])
          await generation.reset(key)
          await generation.install(key, async () => {
            throw new Error('cancelling a clone must preserve its immutable template')
          })
          expect(await generation.native.execute(`SELECT * FROM ${table}`)).toEqual([
            { id: 1, value: 'original' },
          ])
        } finally {
          releaseAllocation?.()
          await resetting.catch(() => undefined)
          await closing?.catch(() => undefined)
          await observer.close()
        }
      })
      test('cleanup cancels in-flight SQL and releases a reserved migrator lock before database DROP', async () => {
        const runtime = generation.runtime
        const connection = await runtime.providerPool().reserve()
        const [identity] = await connection.unsafe(
          'SELECT current_database() AS name, pg_backend_pid() AS pid',
        )
        // A driver decorator must still reject real SQL/constraint mutations, never return canned rows.
        await connection.unsafe('CREATE TEMP TABLE cia_real_driver (id integer PRIMARY KEY)')
        await connection.unsafe('INSERT INTO cia_real_driver VALUES (1)')
        await expect(
          Promise.resolve(connection.unsafe('INSERT INTO cia_real_driver VALUES (1)')),
        ).rejects.toMatchObject({ errno: '23505' })
        await expect(
          Promise.resolve(connection.unsafe('SELECT missing_column FROM cia_real_driver')),
        ).rejects.toMatchObject({ errno: '42703' })
        await connection.unsafe(
          "SELECT pg_advisory_lock(hashtextextended('rfc359-schema-upgrade', 0))",
        )
        const running = Promise.resolve(connection.unsafe('SELECT pg_sleep(60)')).then(
          () => 'completed',
          () => 'cancelled',
        )
        await runtime.close()
        expect(await running).toBe('cancelled')
        const observer = new SQL(sourceUrl!, { max: 1, idleTimeout: 0 })
        try {
          expect(
            await observer.unsafe('SELECT 1 FROM pg_database WHERE datname=$1', [identity!.name]),
          ).toHaveLength(1)
          expect(
            await observer.unsafe("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [
              identity!.pid,
            ]),
          ).toHaveLength(0)
          const url = new URL(sourceUrl!)
          url.pathname = `/${String(identity!.name)}`
          const next = new SQL(url.toString(), { max: 1, idleTimeout: 0 })
          try {
            expect(
              (
                await next.unsafe(
                  "SELECT pg_try_advisory_lock(hashtextextended('rfc359-schema-upgrade', 0)) AS acquired",
                )
              )[0]!.acquired,
            ).toBe(true)
          } finally {
            await next.close()
          }
        } finally {
          await observer.close()
          connection.release()
        }
      })
    }
  })
