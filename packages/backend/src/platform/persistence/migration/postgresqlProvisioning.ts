import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseConfig } from '@agent-workflow/shared'
import {
  environmentPostgresqlProfileRef,
  parsePostgresqlProfileRef,
} from '@/platform/persistence/postgresqlProfileRef'
import { postgresqlRuntimeFor } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { writeDurableLogicalArtifact } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { postgresqlSqlState } from '@/platform/persistence/capabilities'
import {
  autoUpgradeDatabaseName,
  createPostgresqlDatabaseStatement,
  quotePostgresqlDatabaseIdentifier as quote,
  samePostgresqlDatabaseProperties,
  type PostgresqlDatabaseProperties,
} from './postgresqlProvisioningPolicy'
import type {
  DatabaseAllocation,
  DatabaseProvisioning,
  DatabaseProvisioningReceipt,
  DatabaseProvisioningRequest,
} from './databaseProvisioning'

export class PostgresqlProvisioningError extends Error {
  constructor(
    readonly code: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}: ${JSON.stringify(detail)}`)
    this.name = 'PostgresqlProvisioningError'
  }
}

/** Version-dependent catalog columns must not be mentioned on an older server. */
export async function readPostgresqlDatabaseProperties(
  pool: PostgresqlPool,
  database?: string,
): Promise<PostgresqlDatabaseProperties | null> {
  const major = Math.floor(
    Number(
      (await pool.unsafe("SELECT current_setting('server_version_num') AS version"))[0]?.version,
    ) / 10_000,
  )
  if (![15, 16, 17, 18].includes(major)) throw new Error('postgresql-target-major-unsupported')
  const row = (
    await pool.unsafe(
      `SELECT pg_encoding_to_char(encoding) AS encoding, datlocprovider, datcollate, datctype, ${major >= 17 ? 'datlocale' : 'daticulocale'} AS locale, ${major >= 16 ? 'daticurules' : 'NULL::text'} AS rules FROM pg_database WHERE datname = ${database === undefined ? 'current_database()' : '$1'}`,
      database === undefined ? [] : [database],
    )
  )[0]
  if (!row) return null
  const provider = { c: 'libc', i: 'icu', b: 'builtin' }[String(row.datlocprovider)] as
    | PostgresqlDatabaseProperties['provider']
    | undefined
  if (!provider) throw new Error('postgresql-locale-provider-unsupported')
  return {
    major,
    encoding: String(row.encoding),
    provider,
    collate: String(row.datcollate),
    ctype: String(row.datctype),
    locale: row.locale == null ? null : String(row.locale),
    icuRules: row.rules == null ? null : String(row.rules),
  }
}

const occupiedSql =
  "SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_workflow','agent_workflow_meta') UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')"

/** The auto session holds the daemon lock across allocation, provision and journal replacement. */
export function createPostgresqlProvisioning(input: {
  readonly appHome: string
  readonly readTargetEvidence: (
    connection: ReturnType<typeof postgresqlHistoryConnection>,
    generationId: string,
  ) => Promise<{ readonly state: string } | null>
  readonly sourceProfileRef: string
  readonly config: DatabaseConfig | null
  readonly env: Readonly<Record<string, string | undefined>>
  readonly recordProvisioned?: (receipt: DatabaseProvisioningReceipt) => Promise<void>
}): DatabaseProvisioning {
  const root = join(input.appHome, 'database-migrations', 'auto-upgrade')
  const allocations = join(root, 'allocations')
  const sourceProfile = parsePostgresqlProfileRef(input.sourceProfileRef)
  if (sourceProfile?.kind !== 'env') throw new Error('postgresql-auto-source-profile-required')
  const sourceUrlEnv = sourceProfile.urlEnv
  const runtime = (profileRef: string): PostgresqlDatabaseRuntime =>
    postgresqlRuntimeFor({
      profileRef,
      base: input.config,
      env: input.env,
      generationId: 'dbg_auto_provisioning',
    })
  const list = (): DatabaseAllocation[] =>
    existsSync(allocations)
      ? readdirSync(allocations)
          .filter((name) => /^\d{4,}\.json$/.test(name))
          .sort()
          .map(
            (name) =>
              JSON.parse(readFileSync(join(allocations, name), 'utf8')) as DatabaseAllocation,
          )
          .sort((a, b) => a.n - b.n)
      : []
  const provisionedAllocations = (): Set<number> => {
    const directory = join(root, 'provisioning')
    const bound = new Set<number>()
    if (!existsSync(directory)) return bound
    for (const name of readdirSync(directory).filter((entry) =>
      entry.endsWith('-provisioned.json'),
    )) {
      const receipt = JSON.parse(
        readFileSync(join(directory, name), 'utf8'),
      ) as DatabaseProvisioningReceipt
      bound.add(receipt.target.n).add(receipt.scratch.n)
    }
    return bound
  }
  const allocate = async (
    request: DatabaseProvisioningRequest,
    kind: DatabaseAllocation['kind'],
    sourceDatabase: string,
  ): Promise<DatabaseAllocation> => {
    const previous = list()
      .filter(
        (row) =>
          row.sessionOperationId === request.sessionOperationId &&
          row.kind === kind &&
          (kind === 'scratch' || row.runId === request.runId),
      )
      .at(-1)
    const variable =
      kind === 'target' ? 'AGENT_WORKFLOW_EPOCH_TARGET_URL' : 'AGENT_WORKFLOW_EPOCH_SCRATCH_URL'
    // §3.1 / §8: a derived database refused before any provisioning receipt bound it may be
    // replaced by the operator's explicit variable. The refused name stays in the ledger (never
    // reused) and a newer row takes over; a provisioned location never moves.
    const reselect =
      previous !== undefined &&
      previous.profileRef !== `env:${variable}` &&
      Boolean(input.env[variable]) &&
      !provisionedAllocations().has(previous.n)
    if (previous && !reselect) {
      // An explicit URL may change between retries; never silently point this run at another DB.
      if (previous.profileRef === `env:${variable}`) {
        const db = runtime(previous.profileRef)
        try {
          if (
            (await db.providerPool().unsafe('SELECT current_database() AS name'))[0]?.name !==
            previous.database
          )
            throw new PostgresqlProvisioningError('postgresql-allocation-binding-changed', {
              allocation: previous,
            })
        } finally {
          await db.close()
        }
      }
      return previous
    }
    let explicitDatabase: string | undefined
    if (input.env[variable]) {
      const db = runtime(`env:${variable}`)
      try {
        explicitDatabase = String(
          (await db.providerPool().unsafe('SELECT current_database() AS name'))[0]?.name,
        )
      } finally {
        await db.close()
      }
    }
    // No await between the ledger census and exclusive durable publication.
    const all = list()
    const n = (all.at(-1)?.n ?? 0) + 1
    const database =
      explicitDatabase ??
      autoUpgradeDatabaseName(sourceDatabase, kind, n, !all.some((row) => row.kind === kind))
    if (all.some((row) => row.database === database))
      throw new PostgresqlProvisioningError('postgresql-target-not-empty', {
        database,
        reason: 'database-name-already-allocated',
        instruction: `Point ${variable} at a new empty database.`,
      })
    const row: DatabaseAllocation = {
      n,
      kind,
      sessionOperationId: request.sessionOperationId,
      runId: request.runId,
      database,
      profileRef:
        explicitDatabase === undefined
          ? environmentPostgresqlProfileRef(sourceUrlEnv, database)
          : `env:${variable}`,
    }
    mkdirSync(allocations, { recursive: true })
    writeDurableLogicalArtifact(join(allocations, `${String(n).padStart(4, '0')}.json`), row)
    return row
  }
  const port: DatabaseProvisioning = {
    async prepare(request) {
      const source = runtime(input.sourceProfileRef)
      try {
        const pool = source.providerPool()
        const identity = (
          await pool.unsafe('SELECT current_database() AS database, current_user AS owner')
        )[0]!
        const properties = (await readPostgresqlDatabaseProperties(pool))!
        const target = await allocate(request, 'target', String(identity.database))
        const scratch = await allocate(request, 'scratch', String(identity.database))
        const statements = [target, scratch].map((allocation) =>
          createPostgresqlDatabaseStatement({
            database: allocation.database,
            source: properties,
            owner: String(identity.owner),
          }),
        )
        const prepare = async (allocation: DatabaseAllocation, statement: string) => {
          const createdPath = join(root, 'provisioning', `${allocation.n}-created.json`)
          let createdNow = false
          if (
            parsePostgresqlProfileRef(allocation.profileRef)?.kind === 'env' &&
            allocation.profileRef.includes('/')
          ) {
            if (!(await readPostgresqlDatabaseProperties(pool, allocation.database))) {
              try {
                await pool.unsafe(statement)
                createdNow = true
              } catch (error) {
                if (postgresqlSqlState(error) === '42501')
                  throw new PostgresqlProvisioningError('postgresql-create-database-denied', {
                    statements,
                  })
                if (postgresqlSqlState(error) !== '42P04') throw error
              }
            }
          }
          const db = runtime(allocation.profileRef)
          try {
            const health = await db.readiness()
            if (health.databaseFingerprint === (await source.readiness()).databaseFingerprint)
              throw new PostgresqlProvisioningError('postgresql-target-is-source', {
                database: allocation.database,
              })
            const observed = await readPostgresqlDatabaseProperties(db.providerPool())
            if (!observed || !samePostgresqlDatabaseProperties(properties, observed))
              throw new PostgresqlProvisioningError('postgresql-database-properties-mismatch', {
                database: allocation.database,
                source: properties,
                observed,
              })
            if ((await db.providerPool().unsafe(occupiedSql)).length) {
              if (allocation.kind === 'scratch') {
                const marker = (
                  await db
                    .providerPool()
                    .unsafe("SELECT to_regclass('public.aw_epoch1_upgrade_scratch') AS marker")
                )[0]?.marker
                const owner = marker
                  ? (
                      await db
                        .providerPool()
                        .unsafe(
                          'SELECT owner FROM public.aw_epoch1_upgrade_scratch WHERE singleton=1',
                        )
                    )[0]?.owner
                  : null
                if (owner !== request.sessionOperationId)
                  throw new PostgresqlProvisioningError('postgresql-scratch-not-empty', {
                    database: allocation.database,
                  })
              } else {
                const connection = await db.providerPool().reserve()
                try {
                  const marker = (
                    await connection.unsafe(
                      "SELECT to_regclass('agent_workflow_meta.generations') AS marker",
                    )
                  )[0]?.marker
                  const evidence = marker
                    ? await input.readTargetEvidence(
                        postgresqlHistoryConnection(connection),
                        request.generationId,
                      )
                    : null
                  const binding = evidence
                    ? (
                        await connection.unsafe(
                          'SELECT operation_id, run_id FROM agent_workflow_meta.generations WHERE generation_id=$1',
                          [request.generationId],
                        )
                      )[0]
                    : null
                  if (
                    !evidence ||
                    evidence.state === 'retired' ||
                    binding?.operation_id !== request.sessionOperationId ||
                    binding?.run_id !== request.runId
                  )
                    throw new PostgresqlProvisioningError('postgresql-target-not-empty', {
                      database: allocation.database,
                    })
                } finally {
                  connection.release()
                }
              }
            }
            if (createdNow) writeDurableLogicalArtifact(createdPath, allocation)
            return { ...allocation, created: createdNow || existsSync(createdPath) }
          } catch (error) {
            await db.close()
            if (
              createdNow &&
              error instanceof PostgresqlProvisioningError &&
              error.code === 'postgresql-database-properties-mismatch'
            )
              await pool.unsafe(`DROP DATABASE ${quote(allocation.database)}`)
            throw error
          } finally {
            await db.close()
          }
        }
        const preparedTarget = await prepare(target, statements[0]!)
        const preparedScratch = await prepare(scratch, statements[1]!)
        const receiptPath = join(root, 'provisioning', `${target.n}-provisioned.json`)
        const recorded = existsSync(receiptPath)
          ? (JSON.parse(readFileSync(receiptPath, 'utf8')) as DatabaseProvisioningReceipt)
          : null
        const receipt: DatabaseProvisioningReceipt = {
          ...request,
          target: preparedTarget,
          scratch: preparedScratch,
          retained:
            recorded?.retained ?? list().filter((row) => row.n !== target.n && row.n !== scratch.n),
        }
        writeDurableLogicalArtifact(receiptPath, receipt)
        await input.recordProvisioned?.(receipt)
        return receipt
      } finally {
        await source.close()
      }
    },
    async retained() {
      const rows = []
      for (const allocation of list()) {
        const profile = parsePostgresqlProfileRef(allocation.profileRef)
        if (profile?.kind !== 'env') throw new Error('postgresql-allocation-profile-invalid')
        // Explicit URL variables may now name a newer run. Measure the recorded database.
        const db = runtime(environmentPostgresqlProfileRef(profile.urlEnv, allocation.database))
        let bytes: number | null = null
        try {
          bytes = Number(
            (
              await db.providerPool().unsafe('SELECT pg_database_size(current_database()) AS bytes')
            )[0]?.bytes,
          )
        } catch (error) {
          if (postgresqlSqlState(error) !== '3D000') throw error
        } finally {
          await db.close()
        }
        rows.push({
          ...allocation,
          bytes,
          purpose:
            allocation.kind === 'scratch'
              ? 'Retained for migration trace --replay; manual removal after retention ends disables replay.'
              : 'Retained target generation, including retired runs.',
        })
      }
      return rows
    },
  }
  return port
}
