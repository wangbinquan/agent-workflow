import { composeAutomaticUpgradeProvisioning } from '@/bootstrap/epochMigrationAuto'
// RFC-398 §7.6: real servers, executable DBA instructions and durable cross-run allocation.
import { postgresqlAutoUpgradeFixture } from './helpers/rfc398AutoUpgradePostgresql'
import { businessRoundTrip } from './helpers/rfc398AutoUpgrade'
import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import {
  autoUpgradeDatabaseName,
  createPostgresqlDatabaseStatement,
  type PostgresqlDatabaseProperties,
} from '@/platform/persistence/migration/postgresqlProvisioningPolicy'
import {
  PostgresqlProvisioningError,
  readPostgresqlDatabaseProperties,
} from '@/platform/persistence/migration/postgresqlProvisioning'
import { postgresqlSqlState } from '@/platform/persistence/capabilities'
import { preparePostgresqlScratch } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { createEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import { epochRunIdentity } from '@/modules/system-operations/domain/epochSwitch/transitions'
import { makeSwitchFixture } from './helpers/rfc395V3SwitchFixture'
import { describeRfc398Postgresql, rfc398Postgresql, pgQuote } from './helpers/rfc398Postgresql'
import type { PostgresqlPool } from '@/platform/persistence/postgresqlRuntime'

const request = {
  sessionOperationId: 'dbm_e2_rfc398_session',
  runId: 'emr_rfc398_first',
  generationId: 'dbg_rfc398_first',
}
const properties: PostgresqlDatabaseProperties = {
  major: 15,
  encoding: 'UTF8',
  provider: 'libc',
  collate: 'C',
  ctype: 'C',
  locale: null,
  icuRules: null,
}
// Regression: Bun.SQL's PostgresError keeps the SQLSTATE in `errno` and sets `code` to
// ERR_POSTGRES_SERVER_ERROR, so a restricted role's 42501 escaped as a raw driver error instead of
// the DBA statements (RFC-398 §3.3), and concurrent 42P04 / missing 3D000 were not recognised.
test('provisioning reads SQLSTATE from Bun errno through the shared classifier', () => {
  expect(postgresqlSqlState({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '42501' })).toBe('42501')
  expect(postgresqlSqlState({ code: '42P04' })).toBe('42P04')
  expect(postgresqlSqlState(new Error('wrapped', { cause: { errno: '3D000' } }))).toBe('3D000')
  expect(postgresqlSqlState(new Error('boom'))).toBeUndefined()
  const source = readFileSync(
    join(import.meta.dir, '../src/platform/persistence/migration/postgresqlProvisioning.ts'),
    'utf8',
  )
  // Every SQLSTATE branch goes through the shared helper; a bare `.code === '4…'` misses Bun's errno.
  expect(source.match(/postgresqlSqlState\(error\)/g)?.length).toBe(3)
  expect(source).not.toMatch(/\.code\s*[!=]==\s*'[0-9A-Z]{5}'/)
})
test('derived identifiers preserve special characters and UTF-8 bounds', () => {
  expect(autoUpgradeDatabaseName('库"x', 'target', 1, true)).toBe('库"x_epoch2')
  const a = autoUpgradeDatabaseName('库'.repeat(40), 'scratch', 999999, false)
  expect(Buffer.byteLength(a)).toBeLessThanOrEqual(63)
  expect(a).toMatch(/_[a-f0-9]{8}_epoch2_scratch_999999$/)
  expect(a).not.toContain('�')
})
test('CREATE DATABASE covers each supported provider/version and quotes owner', () => {
  for (const major of [15, 16, 17, 18]) {
    const source = {
      ...properties,
      major,
      provider: 'icu' as const,
      locale: 'en-US',
      icuRules: major >= 16 ? '&a<b' : null,
    }
    const statement = createPostgresqlDatabaseStatement({
      database: 'db"name',
      source,
      owner: 'app"role',
    })
    expect(statement).toContain('LOCALE_PROVIDER icu')
    expect(statement).toContain("ICU_LOCALE E'en-US'")
    expect(statement).toContain('OWNER "app""role"')
    expect(statement.includes('ICU_RULES')).toBe(major >= 16)
  }
  expect(
    createPostgresqlDatabaseStatement({
      database: 'builtin',
      source: { ...properties, major: 17, provider: 'builtin', locale: 'C.UTF-8' },
      owner: 'role',
    }),
  ).toContain("BUILTIN_LOCALE E'C.UTF-8'")
  expect(() =>
    createPostgresqlDatabaseStatement({
      database: 'bad',
      source: { ...properties, provider: 'builtin', locale: 'C' },
      owner: 'role',
    }),
  ).toThrow('unsupported')
})

describeRfc398Postgresql('RFC-398 PostgreSQL provisioning', () => {
  test('a generation owned by this session/run is reusable; a retired or different generation is refused', async () => {
    const f = await rfc398Postgresql()
    try {
      const source = await f.create()
      const port = composeAutomaticUpgradeProvisioning({
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
        env: { SOURCE: source.url },
      })
      const first = await port.prepare(request)
      for (const row of [first.target, first.scratch]) f.databases.add(row.database)
      const target = f.connect(first.target.database)
      await target.unsafe('CREATE SCHEMA agent_workflow_meta')
      await target.unsafe(
        'CREATE TABLE agent_workflow_meta.generations (generation_id text PRIMARY KEY, state text NOT NULL, activation_receipt_digest text, operation_id text, run_id text)',
      )
      await target.unsafe(
        "INSERT INTO agent_workflow_meta.generations VALUES ($1,'prepared',NULL,$2,$3)",
        [request.generationId, request.sessionOperationId, request.runId],
      )
      expect(await port.prepare(request)).toEqual(first)
      await expect(port.prepare({ ...request, generationId: 'dbg_wrong' })).rejects.toMatchObject({
        code: 'postgresql-target-not-empty',
      })
      await target.unsafe("UPDATE agent_workflow_meta.generations SET state='retired'")
      await expect(port.prepare(request)).rejects.toMatchObject({
        code: 'postgresql-target-not-empty',
      })
      expect(
        (
          await f.admin.unsafe('SELECT 1 FROM pg_database WHERE datname=$1', [
            first.target.database,
          ])
        ).length,
      ).toBe(1)
    } finally {
      await f.close()
    }
  }, 90_000)

  test('append-only allocation survives sessions, retains scratch and refuses occupied targets', async () => {
    const f = await rfc398Postgresql()
    try {
      const source = await f.create()
      const options = {
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
        env: { SOURCE: source.url },
      }
      const port = composeAutomaticUpgradeProvisioning(options)
      const first = await port.prepare(request)
      for (const row of [first.target, first.scratch]) f.databases.add(row.database)
      expect(first.target.database).toBe(`${source.database}_epoch2`)
      const ledger = join(f.root, 'database-migrations/auto-upgrade/allocations')
      // readdir order is filesystem-defined (APFS is not lexicographic); the ledger is ordered by name.
      const bytes = readdirSync(ledger)
        .sort()
        .map((name) => readFileSync(join(ledger, name), 'utf8'))
      expect(await composeAutomaticUpgradeProvisioning(options).prepare(request)).toEqual(first)
      const scratch = f.runtime(first.scratch.database)
      await preparePostgresqlScratch({
        runtime: scratch,
        sourceFingerprint: null,
        owner: request.sessionOperationId,
        bindingDigest: 'first',
        reset: true,
      })
      const second = await port.prepare({
        ...request,
        runId: 'emr_second',
        generationId: 'dbg_second',
      })
      f.databases.add(second.target.database)
      expect(second.scratch.n).toBe(first.scratch.n)
      expect(second.target.database).not.toBe(first.target.database)
      const third = await composeAutomaticUpgradeProvisioning(options).prepare({
        ...request,
        sessionOperationId: 'dbm_e2_second_session',
      })
      for (const row of [third.target, third.scratch]) f.databases.add(row.database)
      expect(third.scratch.database).not.toBe(first.scratch.database)
      expect(
        readdirSync(ledger)
          .sort()
          .slice(0, 2)
          .map((name) => readFileSync(join(ledger, name), 'utf8')),
      ).toEqual(bytes)
      await f.connect(first.target.database).unsafe('CREATE TABLE occupied(id integer)')
      await expect(port.prepare(request)).rejects.toMatchObject({
        code: 'postgresql-target-not-empty',
      })
      const retained = await port.retained()
      expect(retained.every((row) => row.bytes! > 0)).toBe(true)
      expect(retained.find((row) => row.n === first.scratch.n)?.purpose).toContain('trace --replay')
    } finally {
      await f.close()
    }
  }, 90_000)

  test('ICU source with libc template0 creates matching target and scratch when ICU is available', async () => {
    const f = await rfc398Postgresql()
    try {
      const available =
        (await f.admin.unsafe("SELECT 1 FROM pg_collation WHERE collprovider='i' LIMIT 1")).length >
        0
      if (!available) return // Capability absence, not a skipped PostgreSQL lane.
      expect(
        (
          await f.admin.unsafe("SELECT datlocprovider FROM pg_database WHERE datname='template0'")
        )[0]?.datlocprovider,
      ).toBe('c')
      const source = await f.create(
        "TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LC_COLLATE 'C' LC_CTYPE 'C'",
      )
      const result = await composeAutomaticUpgradeProvisioning({
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
        env: { SOURCE: source.url },
      }).prepare(request)
      for (const row of [result.target, result.scratch]) {
        f.databases.add(row.database)
        expect(
          await readPostgresqlDatabaseProperties(f.runtime(row.database).providerPool()),
        ).toEqual(await readPostgresqlDatabaseProperties(f.runtime(source.database).providerPool()))
      }
    } finally {
      await f.close()
    }
  }, 90_000)

  test('restricted role receives both OWNER statements; DBA executes them and the same run resumes', async () => {
    const f = await rfc398Postgresql()
    const role = `rfc398_${randomUUID().replaceAll('-', '')}`
    const password = randomUUID()
    try {
      const source = await f.create()
      await f.admin.unsafe(`CREATE ROLE ${pgQuote(role)} LOGIN NOCREATEDB PASSWORD '${password}'`)
      await f.admin.unsafe(
        `GRANT CONNECT ON DATABASE ${pgQuote(source.database)} TO ${pgQuote(role)}`,
      )
      const url = new URL(source.url)
      url.username = role
      url.password = password
      const port = composeAutomaticUpgradeProvisioning({
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
        env: { SOURCE: url.toString() },
      })
      const error = await port.prepare(request).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(PostgresqlProvisioningError)
      expect((error as PostgresqlProvisioningError).code).toBe('postgresql-create-database-denied')
      const statements = (error as PostgresqlProvisioningError).detail.statements as string[]
      expect(statements).toHaveLength(2)
      for (const statement of statements) {
        expect(statement).toContain(`OWNER ${pgQuote(role)}`)
        await f.admin.unsafe(statement)
        f.databases.add(/^CREATE DATABASE "([^"]+)"/.exec(statement)![1]!)
      }
      const result = await port.prepare(request)
      expect(result.target.created).toBe(false)
      expect(result.scratch.created).toBe(false)
    } finally {
      await f.close()
      const { SQL } = await import('bun')
      const cleanup = new SQL(f.url)
      try {
        await cleanup.unsafe(`DROP ROLE IF EXISTS ${pgQuote(role)}`)
      } finally {
        await cleanup.close()
      }
    }
  }, 90_000)

  test('explicit env targets bind one run and foreign scratch markers are refused', async () => {
    const f = await rfc398Postgresql()
    try {
      const source = await f.create(),
        target = await f.create(),
        scratch = await f.create()
      const env = {
        SOURCE: source.url,
        AGENT_WORKFLOW_EPOCH_TARGET_URL: target.url,
        AGENT_WORKFLOW_EPOCH_SCRATCH_URL: scratch.url,
      }
      const port = composeAutomaticUpgradeProvisioning({
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
        env,
      })
      const receipt = await port.prepare(request)
      expect(receipt.target.profileRef).toBe('env:AGENT_WORKFLOW_EPOCH_TARGET_URL')
      await expect(
        port.prepare({ ...request, runId: 'next', generationId: 'dbg_next_run' }),
      ).rejects.toMatchObject({ code: 'postgresql-target-not-empty' })
      await preparePostgresqlScratch({
        runtime: f.runtime(scratch.database),
        sourceFingerprint: null,
        owner: 'another-session',
        bindingDigest: 'x',
        reset: true,
      })
      await expect(port.prepare(request)).rejects.toMatchObject({
        code: 'postgresql-scratch-not-empty',
      })
    } finally {
      await f.close()
    }
  }, 90_000)

  // Implementation gate r1 P2-4 (design §3.1/§8 「目标被占」): after the derived target is refused
  // as occupied, the operator's explicit target variable must take over on the next start; it
  // used to return the refused allocation forever. A provisioned location never moves.
  test('an occupied derived target is replaced by the explicit variable until provisioning binds it', async () => {
    const f = await rfc398Postgresql()
    try {
      const source = await f.create()
      const occupied = `${source.database}_epoch2`
      await f.admin.unsafe(
        `CREATE DATABASE ${pgQuote(occupied)} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'`,
      )
      f.databases.add(occupied)
      await f.connect(occupied).unsafe('CREATE TABLE foreign_data(id integer)')
      const options = {
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: null,
      }
      const derived = composeAutomaticUpgradeProvisioning({
        ...options,
        env: { SOURCE: source.url },
      })
      await expect(derived.prepare(request)).rejects.toMatchObject({
        code: 'postgresql-target-not-empty',
      })
      const explicit = await f.create()
      const env = { SOURCE: source.url, AGENT_WORKFLOW_EPOCH_TARGET_URL: explicit.url }
      const receipt = await composeAutomaticUpgradeProvisioning({ ...options, env }).prepare(
        request,
      )
      f.databases.add(receipt.scratch.database)
      expect(receipt.target).toMatchObject({
        profileRef: 'env:AGENT_WORKFLOW_EPOCH_TARGET_URL',
        database: explicit.database,
      })
      const ledger = join(f.root, 'database-migrations/auto-upgrade/allocations')
      const rows = readdirSync(ledger)
        .sort()
        .map((name) => JSON.parse(readFileSync(join(ledger, name), 'utf8')) as { database: string })
      // The refused name stays allocated (never reused); the explicit row is appended after it.
      expect(rows.map((row) => row.database)).toEqual([
        occupied,
        receipt.scratch.database,
        explicit.database,
      ])
      // Same run, explicit binding now provisioned: replaying keeps it.
      expect(
        await composeAutomaticUpgradeProvisioning({ ...options, env }).prepare(request),
      ).toEqual(receipt)
      // Once provisioned, a different explicit database cannot silently move this run.
      const other = await f.create()
      await expect(
        composeAutomaticUpgradeProvisioning({
          ...options,
          env: { ...env, AGENT_WORKFLOW_EPOCH_TARGET_URL: other.url },
        }).prepare(request),
      ).rejects.toMatchObject({ code: 'postgresql-allocation-binding-changed' })
    } finally {
      await f.close()
    }
  }, 90_000)

  test('nextTargetLocation persists next.runId before journal replacement and planning', async () => {
    const f = await rfc398Postgresql()
    const fixture = makeSwitchFixture()
    try {
      const source = await f.create()
      const options = {
        appHome: f.root,
        sourceProfileRef: 'env:SOURCE',
        config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv: 'SOURCE' }),
        env: { SOURCE: source.url },
      }
      const initialPlan = await fixture.app.plan({
        target: { provider: 'postgresql', urlEnv: 'TARGET' },
      })
      const initial = (await fixture.deps.journal.read(initialPlan.operationId))!
      const identity = epochRunIdentity(initial.payload.operationId, 0)
      const port = composeAutomaticUpgradeProvisioning({
        ...options,
        async recordProvisioned(receipt) {
          for (const row of [receipt.target, receipt.scratch]) f.databases.add(row.database)
          const persisted = await fixture.deps.journal.read(initialPlan.operationId)
          expect(persisted!.payload.run?.runId).not.toBe(receipt.runId)
        },
      })
      const first = await composeAutomaticUpgradeProvisioning(options).prepare({
        sessionOperationId: initial.payload.operationId,
        ...identity,
      })
      for (const row of [first.target, first.scratch]) f.databases.add(row.database)
      const bound = createEpochSwitchJournal({
        ...initial.payload,
        revision: initial.payload.revision + 1,
        previousDigest: initial.digest,
        target: {
          ...initial.payload.target,
          generationId: identity.generationId,
          location: { kind: 'postgresql-target', profileRef: first.target.profileRef },
        },
        inputs: { ...initial.payload.inputs, scratchProfileRef: first.scratch.profileRef },
      })
      await fixture.deps.journal.compareAndSwap(
        {
          operationId: initial.payload.operationId,
          revision: initial.payload.revision,
          digest: initial.digest,
        },
        bound,
      )
      const preflight = fixture.deps.target.preflight
      fixture.deps.target.preflight = async (input) => {
        const journal = (await fixture.deps.journal.read(initialPlan.operationId))!
        expect(journal.payload.target.location).toEqual(input.location)
        const allocations = readdirSync(
          join(f.root, 'database-migrations/auto-upgrade/allocations'),
        ).map((name) =>
          JSON.parse(
            readFileSync(
              join(f.root, 'database-migrations/auto-upgrade/allocations', name),
              'utf8',
            ),
          ),
        )
        const allocated = allocations.find(
          (row) => row.runId === journal.payload.run!.runId && row.kind === 'target',
        )
        expect(allocated.profileRef).toBe((input.location as { profileRef: string }).profileRef)
        expect(
          (
            await readPostgresqlDatabaseProperties(
              f.admin as unknown as PostgresqlPool,
              allocated.database,
            )
          )?.encoding,
        ).toBe('UTF8')
        expect(journal.payload.target.generationId).toBe(
          epochRunIdentity(journal.payload.operationId, journal.payload.run!.ordinal).generationId,
        )
        return preflight(input)
      }
      const app = createEpochSwitchApplication({
        ...fixture.deps,
        nextTargetLocation: port.nextTargetLocation,
      })
      await app.run({ operationId: initialPlan.operationId, newRun: true })
    } finally {
      fixture.close()
      await f.close()
    }
  }, 90_000)
})

describeRfc398Postgresql('same-environment automatic retry', () => {
  test('verification rollback → repair → --retry allocates fresh target and scratch and boots', async () => {
    const f = await postgresqlAutoUpgradeFixture()
    try {
      f.flag('negative-health')
      expect(await f.start().exited).toBe(1)
      const first = f.journals()[0]!
      expect(first.payload.status).toBe('rolled-back')
      const old = f.allocations()
      expect(old).toHaveLength(2)
      const target = old.find((r) => r.kind === 'target')!
      expect(
        (
          await f.pg
            .connect(target.database)
            .unsafe('SELECT state FROM agent_workflow_meta.generations WHERE generation_id=$1', [
              first.payload.target.generationId,
            ])
        )[0]!.state,
      ).toBe('retired')
      f.flag('negative-health', false)
      const refused = f.start()
      expect(await refused.exited).toBe(1)
      expect(refused.error).toContain('--retry')
      expect(f.allocations()).toEqual(old)
      const retry = f.spawn(['db', 'migration', 'auto', '--retry', '--json'])
      expect(await retry.exited).toBe(0)
      expect(f.sessions().map((s) => s.outcome)).toEqual(['failed', 'completed'])
      expect(f.allocations()).toHaveLength(4)
      expect(new Set(f.allocations().map((a) => a.database)).size).toBe(4)
      expect(
        (
          await f.source.sql.unsafe(
            "SELECT value FROM agent_workflow.maintenance_state WHERE key='rfc398-source'",
          )
        )[0]!.value,
      ).toBe('preserved')
      f.start()
      await f.ready()
      await businessRoundTrip(f)
    } finally {
      await f.close()
    }
  }, 300_000)
})
