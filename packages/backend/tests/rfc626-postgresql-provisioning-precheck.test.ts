// RFC-626 §3.5 (plan T1): whether the databases of an automatic upgrade can be provided is
// asked before the upgrade is recorded.
//
// Why this file exists: a role without CREATEDB used to be found out by `prepare`, after the
// session had recorded its intent and after the allocation files were written — the refusal
// with the statements to run came with a session that had to be resumed. The read-only
// `precheck` answers the same question first. It must predict exactly what `prepare` would do:
// the same database names from the same ledger (without writing to it), the same statements,
// nothing when the operator named the databases or created them by hand, and it must leave no
// file behind. The first test needs no server: the module's port offers the check only when the
// provisioner has one (SQLite has none).
import { composeAutomaticUpgradeProvisioning } from '@/bootstrap/epochMigrationAuto'
import { SQL } from 'bun'
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseProvisioning } from '@/platform/persistence/migration/databaseProvisioning'
import { PostgresqlProvisioningError } from '@/platform/persistence/migration/postgresqlProvisioning'
import { createAutoUpgradeProvisioning } from '@/modules/system-operations/infrastructure/epochSwitch/autoUpgradeProvisioning'
import { describeRfc398Postgresql, pgQuote, rfc398Postgresql } from './helpers/rfc398Postgresql'

const request = {
  sessionOperationId: 'dbm_e2_rfc626_precheck',
  runId: 'emr_rfc626_first',
  generationId: 'dbg_rfc626_first',
}

test('the session is offered the check only by a provisioner that has one', async () => {
  const base: DatabaseProvisioning = {
    async prepare() {
      throw new Error('not asked')
    },
    retained: async () => [],
  }
  const without = createAutoUpgradeProvisioning(base)
  expect(Object.hasOwn(without, 'precheck')).toBe(false)
  const answer = {
    ok: false as const,
    code: 'postgresql-create-database-denied',
    message: 'postgresql-create-database-denied: {"statements":["CREATE DATABASE \\"x\\""]}',
    detail: { statements: ['CREATE DATABASE "x"'] },
  }
  let asked = 0
  const port = createAutoUpgradeProvisioning({
    ...base,
    async precheck() {
      asked++
      return answer
    },
  })
  expect(await port.precheck!()).toEqual(answer)
  expect(asked).toBe(1)
})

describeRfc398Postgresql('RFC-626 PostgreSQL provisioning precheck', () => {
  test('a role that may create databases passes, and nothing is written', async () => {
    const f = await rfc398Postgresql()
    try {
      const source = await f.create()
      const port = composeAutomaticUpgradeProvisioning({
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
        env: { SOURCE: source.url },
      })
      expect(await port.precheck!()).toEqual({ ok: true })
      expect(existsSync(join(f.root, 'database-migrations'))).toBe(false)
    } finally {
      await f.close()
    }
  }, 90_000)

  test('a restricted role is told the statements prepare would run; a DBA runs them and both the check and prepare pass', async () => {
    const f = await rfc398Postgresql()
    const role = `rfc626_${randomUUID().replaceAll('-', '')}`
    const password = randomUUID()
    const otherHome = mkdtempSync(join(tmpdir(), 'aw-rfc626-precheck-'))
    try {
      const source = await f.create()
      await f.admin.unsafe(`CREATE ROLE ${pgQuote(role)} LOGIN NOCREATEDB PASSWORD '${password}'`)
      await f.admin.unsafe(
        `GRANT CONNECT ON DATABASE ${pgQuote(source.database)} TO ${pgQuote(role)}`,
      )
      const url = new URL(source.url)
      url.username = role
      url.password = password
      const options = {
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
        env: { SOURCE: url.toString() },
      }
      const port = composeAutomaticUpgradeProvisioning(options)
      const refused = await port.precheck!()
      if (refused.ok) throw new Error('a role without CREATEDB must be refused')
      expect(refused.code).toBe('postgresql-create-database-denied')
      const statements = refused.detail.statements as string[]
      expect(statements).toHaveLength(2)
      // The names `prepare` derives for the first target and the first scratch of a ledger.
      expect(statements[0]).toStartWith(`CREATE DATABASE ${pgQuote(`${source.database}_epoch2`)} `)
      expect(statements[1]).toStartWith(
        `CREATE DATABASE ${pgQuote(`${source.database}_epoch2_scratch`)} `,
      )
      for (const statement of statements) {
        expect(statement).toContain(`OWNER ${pgQuote(role)}`)
        // The message a person reads carries the statements themselves.
        expect(refused.message).toContain(JSON.stringify(statement).slice(1, -1))
      }
      // Read-only: no allocation, no provisioning record, no directory.
      expect(existsSync(join(f.root, 'database-migrations'))).toBe(false)

      // What `prepare` refuses with for the same role in a home of its own — the same
      // statements, but only after it has written its allocations.
      const error = await composeAutomaticUpgradeProvisioning({ ...options, appHome: otherHome })
        .prepare(request)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(PostgresqlProvisioningError)
      expect((error as PostgresqlProvisioningError).code).toBe(refused.code)
      expect((error as PostgresqlProvisioningError).detail.statements).toEqual(statements)
      expect((error as PostgresqlProvisioningError).message).toBe(refused.message)
      expect(
        existsSync(join(otherHome, 'database-migrations', 'auto-upgrade', 'allocations')),
      ).toBe(true)

      for (const statement of statements) {
        await f.admin.unsafe(statement)
        f.databases.add(/^CREATE DATABASE "([^"]+)"/.exec(statement)![1]!)
      }
      // The databases exist now: nothing has to be created, so nothing is refused.
      expect(await port.precheck!()).toEqual({ ok: true })
      expect(existsSync(join(f.root, 'database-migrations'))).toBe(false)
      const receipt = await port.prepare(request)
      expect(receipt.target.database).toBe(`${source.database}_epoch2`)
      expect(receipt.scratch.database).toBe(`${source.database}_epoch2_scratch`)
      expect(receipt.target.created).toBe(false)
      expect(receipt.scratch.created).toBe(false)
    } finally {
      rmSync(otherHome, { recursive: true, force: true })
      await f.close()
      const cleanup = new SQL(f.url)
      try {
        await cleanup.unsafe(`DROP ROLE IF EXISTS ${pgQuote(role)}`)
      } finally {
        await cleanup.close()
      }
    }
  }, 90_000)

  test('databases the operator named are not asked for; only the missing kind is', async () => {
    const f = await rfc398Postgresql()
    const role = `rfc626_${randomUUID().replaceAll('-', '')}`
    const password = randomUUID()
    try {
      const source = await f.create()
      const target = await f.create()
      const scratch = await f.create()
      await f.admin.unsafe(`CREATE ROLE ${pgQuote(role)} LOGIN NOCREATEDB PASSWORD '${password}'`)
      await f.admin.unsafe(
        `GRANT CONNECT ON DATABASE ${pgQuote(source.database)} TO ${pgQuote(role)}`,
      )
      const url = new URL(source.url)
      url.username = role
      url.password = password
      const options = {
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
      }
      expect(
        await composeAutomaticUpgradeProvisioning({
          ...options,
          env: {
            SOURCE: url.toString(),
            AGENT_WORKFLOW_EPOCH_TARGET_URL: target.url,
            AGENT_WORKFLOW_EPOCH_SCRATCH_URL: scratch.url,
          },
        }).precheck!(),
      ).toEqual({ ok: true })
      const partial = await composeAutomaticUpgradeProvisioning({
        ...options,
        env: { SOURCE: url.toString(), AGENT_WORKFLOW_EPOCH_TARGET_URL: target.url },
      }).precheck!()
      if (partial.ok) throw new Error('the scratch database still has to be created')
      // The named target takes its number in the ledger; the scratch is the first of its kind.
      expect(partial.detail.statements).toEqual([
        expect.stringContaining(`CREATE DATABASE ${pgQuote(`${source.database}_epoch2_scratch`)} `),
      ])
      expect(existsSync(join(f.root, 'database-migrations'))).toBe(false)
    } finally {
      await f.close()
      const cleanup = new SQL(f.url)
      try {
        await cleanup.unsafe(`DROP ROLE IF EXISTS ${pgQuote(role)}`)
      } finally {
        await cleanup.close()
      }
    }
  }, 90_000)
})
