import { withNativeTransaction } from '@/platform/persistence/nativeTransaction'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { PostgresqlDatabaseConfigSchema, type DatabaseConfig } from '@agent-workflow/shared'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type SqlRows,
} from '../../postgresqlRuntime'
import type { TargetPreflight } from '../run/types'
import type { ConversionBlock } from '../conversion/types'
import type { OfflinePostgresqlDatabase } from '../offlineSourceUpgrade'

export function postgresqlRuntimeFor(input: {
  readonly profileRef: string
  readonly base: DatabaseConfig | null
  readonly generationId: string
  readonly env: Readonly<Record<string, string | undefined>>
}): PostgresqlDatabaseRuntime {
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(input.profileRef)
  if (!match) throw new Error('postgresql-profile-reference-invalid')
  return migrationPostgresqlRuntime(
    createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({
        ...PostgresqlDatabaseConfigSchema.safeParse(input.base).data,
        provider: 'postgresql',
        urlEnv: match[1],
      }),
      generationId: input.generationId,
      env: input.env,
    }),
  )
}

/** Each reserved migration session outlives online request/idle budgets. */
export function migrationPostgresqlRuntime(
  runtime: PostgresqlDatabaseRuntime,
): PostgresqlDatabaseRuntime {
  // Server SETs alone do not disable Bun's client-side idle eviction of a reserved connection.
  const original = runtime.providerPool('migration')
  const pool: PostgresqlPool = {
    async reserve(options) {
      const connection = await original.reserve(options)
      try {
        await connection.unsafe(
          "SELECT set_config('statement_timeout', '0', false), set_config('idle_in_transaction_session_timeout', '0', false)",
        )
        return connection
      } catch (error) {
        connection.release()
        throw error
      }
    },
    unsafe(query, values) {
      const rows = pool.reserve().then(async (connection) => {
        try {
          return await connection.unsafe(query, values)
        } finally {
          connection.release()
        }
      })
      return Object.assign(rows, { values: async () => (await rows).map(Object.values) }) as SqlRows
    },
    close: (options) => original.close(options),
  }
  return { ...runtime, providerPool: () => pool }
}

export interface ExternalTargetRequirements {
  readonly sourceFingerprint: string | null
  readonly supportedMajors: readonly number[]
  readonly profileRef: string
  readonly availableBytes?: number | null
  readonly requiredBytes?: number
}
export interface ExternalTargetFacts {
  readonly version: number
  readonly encoding: string
  readonly collation: string
  readonly has_c: boolean
  readonly can_create: boolean
}
/** Pure policy over server-observed facts; tests need no fabricated driver rows. */
export function classifyExternalTarget(
  input: ExternalTargetRequirements & {
    readonly facts: ExternalTargetFacts
    readonly fingerprint: string
    readonly occupied: number
  },
): TargetPreflight {
  const major = Math.floor(Number(input.facts.version) / 10_000)
  const blocks: ConversionBlock[] = []
  const block = (code: string) =>
    blocks.push({
      code,
      scope: 'global',
      sourceTable: null,
      sourceKey: null,
      sourcePhase: 'current',
      taskId: null,
      runId: null,
      missingFields: [],
      detail: { profileRef: input.profileRef },
    })
  if (input.occupied) block('postgresql-target-not-empty')
  if (input.fingerprint === input.sourceFingerprint) block('postgresql-target-is-source')
  if (!input.supportedMajors.includes(major)) block('postgresql-target-major-unsupported')
  if (input.facts.encoding !== 'UTF8') block('postgresql-target-encoding')
  if (input.facts.has_c !== true) block('postgresql-target-collation')
  if (input.facts.can_create !== true) block('postgresql-target-create-required')
  if (
    input.requiredBytes !== undefined &&
    (input.availableBytes == null || input.availableBytes < input.requiredBytes)
  )
    block(
      input.availableBytes == null
        ? 'postgresql-target-capacity-unproven'
        : 'postgresql-target-capacity-insufficient',
    )
  return {
    provider: 'postgresql',
    location: { kind: 'postgresql-target', profileRef: input.profileRef },
    fingerprint: input.fingerprint,
    empty: input.occupied === 0,
    postgresqlMajor: major,
    encoding: String(input.facts.encoding),
    collation: String(input.facts.collation),
    canCreate: input.facts.can_create === true,
    availableBytes: input.availableBytes ?? null,
    blocks,
  }
}

export async function preflightPostgresqlConversionTarget(
  input: ExternalTargetRequirements & {
    readonly runtime: PostgresqlDatabaseRuntime
  },
): Promise<TargetPreflight> {
  const health = await input.runtime.readiness()
  const pool = input.runtime.providerPool()
  const facts = (
    await pool.unsafe(
      "SELECT current_setting('server_version_num') AS version, pg_encoding_to_char(encoding) AS encoding, datcollate AS collation, EXISTS (SELECT 1 FROM pg_collation WHERE collname='C' AND collnamespace='pg_catalog'::regnamespace) AS has_c, has_database_privilege(current_user, current_database(), 'CREATE') AS can_create FROM pg_database WHERE datname=current_database()",
    )
  )[0]
  if (!facts) throw new Error('postgresql-target-facts-unavailable')
  const occupied = await pool.unsafe(
    "SELECT nspname AS name FROM pg_namespace WHERE nspname IN ('agent_workflow','agent_workflow_meta') UNION ALL SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')",
  )
  return classifyExternalTarget({
    ...input,
    fingerprint: health.databaseFingerprint,
    occupied: occupied.length,
    facts: {
      version: Number(facts.version),
      encoding: String(facts.encoding),
      collation: String(facts.collation),
      has_c: facts.has_c === true,
      can_create: facts.can_create === true,
    },
  })
}

/** The operator provisions the database. Closing a scratch handle never drops it. */
export async function openPostgresqlScratch(
  input: Parameters<typeof preflightPostgresqlConversionTarget>[0] & {
    readonly requireEmpty: boolean
  },
): Promise<OfflinePostgresqlDatabase> {
  try {
    if ((await input.runtime.readiness()).databaseFingerprint === input.sourceFingerprint)
      throw new Error('postgresql-scratch-is-source')
    if (input.requireEmpty) {
      const occupied = await input.runtime
        .providerPool()
        .unsafe(
          "SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_workflow','agent_workflow_meta') UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')",
        )
      if (occupied.length) throw new Error('postgresql-scratch-not-empty')
    }
    return {
      runtime: migrationPostgresqlRuntime(input.runtime),
      close: () => input.runtime.close(),
    }
  } catch (error) {
    await input.runtime.close()
    throw error
  }
}

/** Only this operation's disposable copy may be reset; source and retained backups are untouched. */
export async function preparePostgresqlScratch(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly sourceFingerprint: string | null
  readonly owner: string
  readonly bindingDigest: string
  readonly reset: boolean
}): Promise<string> {
  const fingerprint = (await input.runtime.readiness()).databaseFingerprint
  if (fingerprint === input.sourceFingerprint) throw new Error('postgresql-scratch-is-source')
  const connection = await input.runtime.providerPool().reserve()
  try {
    await withNativeTransaction(postgresqlHistoryConnection(connection), async () => {
      const tx = connection
      const exists = await tx.unsafe(
        "SELECT to_regclass('public.aw_epoch1_upgrade_scratch') AS marker",
      )
      if (exists[0]?.marker) {
        const prior = (
          await tx.unsafe(
            'SELECT owner, binding_digest FROM public.aw_epoch1_upgrade_scratch WHERE singleton=1 FOR UPDATE',
          )
        )[0]
        if (prior?.owner !== input.owner)
          throw new Error('postgresql-scratch-owned-by-another-operation')
        if (!input.reset && prior.binding_digest !== input.bindingDigest)
          throw new Error('source-changed: scratch binding differs')
      } else {
        if (!input.reset) throw new Error('postgresql-scratch-binding-required')
        const occupied = await tx.unsafe(
          "SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_workflow','agent_workflow_meta') UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')",
        )
        if (occupied.length) throw new Error('postgresql-scratch-not-empty')
        await tx.unsafe(
          'CREATE TABLE public.aw_epoch1_upgrade_scratch(singleton integer PRIMARY KEY, owner text NOT NULL, binding_digest text NOT NULL)',
        )
        await tx.unsafe('INSERT INTO public.aw_epoch1_upgrade_scratch VALUES (1,$1,$2)', [
          input.owner,
          input.bindingDigest,
        ])
      }
      if (input.reset) {
        await tx.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await tx.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        await tx.unsafe(
          'UPDATE public.aw_epoch1_upgrade_scratch SET binding_digest=$1 WHERE singleton=1',
          [input.bindingDigest],
        )
      }
    })
    return fingerprint
  } finally {
    connection.release()
  }
}
