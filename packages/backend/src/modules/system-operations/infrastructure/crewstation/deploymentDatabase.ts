// RFC-519 — the hosted database (RFC-294 S10): its configuration and verified preparation, the migration Job's installation (the
// seed closes the runtime when it fails), the execution-control client and the write fence that needs the active lease.
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  createPostgresqlDatabaseClient,
  type PostgresqlDatabaseClient,
} from '@/platform/persistence/postgresqlDatabaseClient'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { restoreCrewStationDatabaseFromEnvironment } from './crewstationDatabaseRestore'
// RFC-370 M0 — system-operations selections of a CrewStation-hosted instance.
// The platform injects every input through environment variables; a missing
// input refuses to start and names all of them at once. Bootstrap passes the
// returned selections to the one shared start sequence.
import { PostgresqlDatabaseConfigSchema, type DatabaseConfig } from '@agent-workflow/shared'
import {
  prepareHostedPostgresqlProviderRuntime,
  type PreparedPostgresqlProviderSchema,
} from '@/platform/persistence/databaseProviderRuntime'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import { seedHostedInstallation } from '@/platform/persistence/hostedInstallationSeed'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { RuntimeSchemaBinding } from '@/platform/persistence/schema/tables'
import { type CrewStationExecutionAuthorityPort } from './crewStationExecutionAuthority'
import type { createDatabaseHostedExecutionControl } from '../hostedExecutionControl'
import { hostedLeaseOf, HostedExecutionLeaseLostError } from '../hostedExecutionControl'
import {
  CREWSTATION_DATABASE_URL_ENV,
  type CrewStationDeploymentEnvironment,
} from './deploymentEnvironment'

/**
 * A hosted instance shares the platform's PostgreSQL with every other service,
 * and both release slots are connected during a handoff, so the pool stays small
 * unless the plan allows more (`AW_DATABASE_POOL_MAX`). With the standalone
 * default of 16, two slots exhausted the local platform's shared server
 * (RFC-370 acceptance, 2026-10-17).
 */
const HOSTED_DATABASE_POOL_MAX = 8

export function crewStationDatabaseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const raw = env.AW_DATABASE_POOL_MAX?.trim()
  const poolMax = raw === undefined || raw === '' ? HOSTED_DATABASE_POOL_MAX : Number(raw)
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 256)
    throw new Error(
      `AW_DATABASE_POOL_MAX must be an integer from 1 to 256, got ${JSON.stringify(raw)}`,
    )
  return PostgresqlDatabaseConfigSchema.parse({
    provider: 'postgresql',
    urlEnv: CREWSTATION_DATABASE_URL_ENV,
    poolMax,
  })
}

/**
 * The migration Job applies the schema history (`apply`); a serving instance
 * only verifies it (`verify`). The target's active row supplies its generation.
 */
export async function prepareCrewStationDatabase(input: {
  readonly contract: LogicalSchemaContract
  readonly liveSchema: RuntimeSchemaBinding
  readonly environment: Pick<CrewStationDeploymentEnvironment, 'project' | 'service'>
  readonly schema: 'apply' | 'verify'
  readonly env?: Readonly<Record<string, string | undefined>>
}): Promise<PreparedPostgresqlProviderSchema> {
  const contract = input.contract
  return await prepareHostedPostgresqlProviderRuntime({
    config: crewStationDatabaseConfig(input.env ?? process.env),
    contract,
    liveSchema: input.liveSchema,
    generation: hostedDatabaseGeneration({
      project: input.environment.project,
      service: input.environment.service,
      schemaDigest: contract.digest,
      env: input.env ?? process.env,
    }),
    schema: input.schema,
    ...(input.env === undefined ? {} : { env: input.env }),
  })
}

/** The migration Job's preparation: restore when asked, apply the schema history, give a fresh database its initial rows
 * once, and close the runtime when the seed fails (RFC-519: the body of the installation's `prepare`). */
export async function prepareCrewStationMigrationInstallation(input: {
  readonly contract: LogicalSchemaContract
  readonly liveSchema: RuntimeSchemaBinding
  readonly environment: Pick<CrewStationDeploymentEnvironment, 'project' | 'service'>
  readonly env: Readonly<Record<string, string | undefined>> | undefined
  readonly normalization:
    | Parameters<typeof restoreCrewStationDatabaseFromEnvironment>[0]['normalization']
    | undefined
}) {
  const { contract, liveSchema, environment, env, normalization } = input
  await restoreCrewStationDatabaseFromEnvironment({
    contract,
    liveSchema,
    environment,
    env: env ?? process.env,
    ...(normalization === undefined ? {} : { normalization }),
  })
  const prepared = await prepareCrewStationDatabase({
    contract,
    liveSchema,
    environment,
    schema: 'apply',
    ...(env === undefined ? {} : { env }),
  })
  try {
    const seed = await seedHostedInstallation({
      contract,
      target: prepared.openBootstrapClient(),
      migrationsFolder: '',
      now: Date.now(),
      installed: prepared.receipt.installedSeeds,
    })
    const schemaOutcome = prepared.describeSchemaOutcome()
    return {
      ...prepared,
      describeSchemaOutcome: () =>
        schemaOutcome +
        (seed.seeded
          ? `initial rows installed (${seed.rows} rows in ${seed.tables} tables)\n`
          : 'initial rows already installed\n'),
    }
  } catch (error) {
    await prepared.runtime.close()
    throw error
  }
}

/**
 * The client that writes the execution-control row. That row is written outside the window it
 * governs and is coordination state, not a live write: an epoch-2 candidate reporting the freeze
 * must not close the switch's rollback window (CrewStation RFC-044 T9).
 */
export function crewStationControlClient(
  runtime: PostgresqlDatabaseRuntime,
  liveSchema: RuntimeSchemaBinding,
): PostgresqlDatabaseClient {
  return createPostgresqlDatabaseClient(runtime, { liveSchema, countsAsLiveWrite: () => false })
}

/** The application side of the execution fence: a write needs the active lease (crash-only, RFC-370 §3.2). */
export function createHostedMutationFence(
  executionAuthority: CrewStationExecutionAuthorityPort,
  control: Pick<ReturnType<typeof createDatabaseHostedExecutionControl>, 'assertHeld'>,
): CrewStationMutationFence {
  return {
    current() {
      const state = executionAuthority.current()
      if (state.kind !== 'active') throw new HostedExecutionLeaseLostError(`${state.kind}`)
      return hostedLeaseOf(state.fence)
    },
    assertHeld: (tx, lease) => control.assertHeld(tx, lease),
  }
}
