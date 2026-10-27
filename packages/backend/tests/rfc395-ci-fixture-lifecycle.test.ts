// RFC-395 CIP-A: templates preserve all rows/DDL, and timeout cleanup releases real session locks.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import { Rfc395FixtureGeneration } from './helpers/rfc395FixtureGeneration'

const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
const sourceUrl = urlEnv ? process.env[urlEnv] : undefined
for (const provider of resolveTestProviders(process.env))
  describe(`RFC-395 immutable fixture templates [${provider}]`, () => {
    let root: string
    let generation: Rfc395FixtureGeneration
    let builds = 0
    const table = provider === 'sqlite' ? 'fixture_rows' : 'agent_workflow.fixture_rows'
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'aw-r395-fixture-regression-'))
      generation = new Rfc395FixtureGeneration(provider, root, sourceUrl)
    }, 5_000)
    beforeEach(() => generation.reset(), 5_000)
    afterEach(() => generation.closeCurrent(), 5_000)
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
    if (provider === 'postgresql')
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
  })
