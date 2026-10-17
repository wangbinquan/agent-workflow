// RFC-370 M0 — the hosted release migration Job and the serving instance on a
// real PostgreSQL (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §5.1).
//
// WHY THIS FILE EXISTS (regression intent): the first hosted `migrate` against a
// real PostgreSQL failed — the database generation fence rejected the copy of
// the initial rows, because nothing registered the hosted generation as the
// database's active one (a standalone database gets it at the RFC-349 cutover),
// and the serving instance's schema check could not tell a database that serves
// its generation from one that does not. The provider-neutral unit cases run on
// a harness database that was never installed by the migration history, so
// only this real cycle covers it.
//
// Locks: the Job installs the schema, registers the hosted installation copy and
// its generation, copies the initial rows once and is idempotent on retry; the
// serving instance verifies the schema and its generation, then writes through
// the fence; another service's Job or instance on the same database is refused;
// an instance never starts on a database the Job has not installed.
import { afterEach, expect, test } from 'bun:test'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { migrateForDeployment } from '@/cli/deployment'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { authLoginPolicy } from '@/db/schema'
import { prepareCrewStationDatabase } from '@/modules/system-operations/composition/crewstationDeployment'
import { createDatabaseApplicationConfiguration } from '@/modules/system-operations/infrastructure/databaseApplicationConfiguration'
import { readHostedDatabaseBackupProvenance } from '@/modules/system-operations/infrastructure/crewstation/databaseBackupProvenance'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { POSTGRESQL_METADATA_SCHEMA } from '@/platform/persistence/postgresqlSchema'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'

const PROJECT = 'agent-workflow'
const providers = resolveTestProviders(process.env)
// The hosted Job and instance select the PostgreSQL schema provider process-wide;
// restore it so a later file's SQLite cases do not inherit it (a following
// SQLite core read once failed only in that order).
const previousSchemaProvider = currentDatabaseSchemaProvider()
afterEach(() => {
  selectDatabaseSchemaProvider(previousSchemaProvider)
})

if (providers.includes('postgresql')) {
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  const databaseUrl = (): string => {
    const url = urlEnv === undefined ? undefined : process.env[urlEnv]
    if (url === undefined || url.length === 0) {
      throw new Error('the hosted PostgreSQL cycle requires the real harness PostgreSQL URL')
    }
    return url
  }
  const jobEnv = (service: string) => ({
    AW_DEPLOYMENT_MODE: 'crewstation',
    CS_PROJECT: PROJECT,
    CS_SERVICE: service,
    CS_DATABASE_URL: databaseUrl(),
  })
  const serve = (service: string) =>
    prepareCrewStationDatabase({
      environment: { project: PROJECT, service },
      schema: 'verify',
      env: jobEnv(service),
    })

  async function emptyDatabase(): Promise<void> {
    const runtime = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv }),
      generationId: 'dbg_rfc370_m0_hosted_reset',
    })
    try {
      await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
      await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
    } finally {
      await runtime.close()
    }
  }

  test('a serving instance never starts on a database the migration Job has not installed', async () => {
    await emptyDatabase()
    await expect(serve(PROJECT)).rejects.toMatchObject({ code: 'postgresql-schema-not-current' })
  }, 120_000)

  // RFC-370 v3 acceptance: hosted backups failed on the real M0 → v3 database with
  // `hosted-backup-installation-provenance-missing`. Its installing operation keeps
  // the M0 schema digest, while the v3 Job advanced only the generation's digest,
  // and provenance required the two to match.
  test('an installation upgraded after it was installed keeps its hosted backup provenance', async () => {
    await emptyDatabase()
    await migrateForDeployment(jobEnv(PROJECT))
    const meta = `"${POSTGRESQL_METADATA_SCHEMA}"`
    const probe = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv }),
      generationId: 'dbg_rfc370_provenance_probe',
    })
    const [active] = await probe
      .providerPool()
      .unsafe(`SELECT generation_id FROM ${meta}.database_generations WHERE state = 'active'`)
    await probe.close()
    const runtime = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv }),
      generationId: String(active!.generation_id),
    })
    try {
      const contract = buildLogicalSchemaContract()
      const pool = runtime.providerPool()
      expect(await readHostedDatabaseBackupProvenance(runtime, contract)).toEqual([])
      // As an earlier release's installation leaves it.
      await pool.unsafe(`UPDATE ${meta}.logical_copy_operations SET contract_digest = $1`, [
        `sha256:${'0'.repeat(64)}`,
      ])
      expect(await readHostedDatabaseBackupProvenance(runtime, contract)).toEqual([])
      // Rows that do not name the same hosted source still prove nothing.
      await pool.unsafe(
        `UPDATE ${meta}.database_generations SET source_generation_id = 'dbg_standalone_sqlite'`,
      )
      await expect(readHostedDatabaseBackupProvenance(runtime, contract)).rejects.toThrow(
        'hosted-backup-installation-provenance-missing',
      )
    } finally {
      await runtime.close()
    }
  }, 300_000)

  test('the Job installs, registers and seeds once; the instance verifies and writes; another service is refused', async () => {
    await emptyDatabase()
    const installed = await migrateForDeployment(jobEnv(PROJECT))
    expect(installed.output).toContain('PostgreSQL schema applied')
    expect(installed.output).toMatch(/initial rows installed \(\d+ rows in \d+ tables\)/)
    // A retried Job (or the next release's) changes nothing it already did.
    const retried = await migrateForDeployment(jobEnv(PROJECT))
    expect(retried.output).toContain('initial rows already installed')

    const serving = await serve(PROJECT)
    try {
      expect(serving.describeSchemaOutcome()).toContain('PostgreSQL schema verified')
      const db = serving.openBootstrapClient()
      const policy = (
        await db.select().from(authLoginPolicy).where(eq(authLoginPolicy.id, 'global'))
      )[0]
      // No first-administrator bootstrap behind the platform identity.
      expect(policy?.bootstrapCompletedAt).toBeGreaterThan(0)
      // A business write passes the database generation fence.
      const settings = createDatabaseApplicationConfiguration({
        db,
        managed: { database: serving.databaseConfig },
      })
      expect((await settings.applyPatch({ language: 'en-US' })).language).toBe('en-US')
    } finally {
      await serving.runtime.close()
    }

    await expect(migrateForDeployment(jobEnv('other'))).rejects.toMatchObject({
      code: 'postgresql-generation-conflict',
    })
    await expect(serve('other')).rejects.toMatchObject({ code: 'postgresql-schema-not-current' })
  }, 300_000)
}
