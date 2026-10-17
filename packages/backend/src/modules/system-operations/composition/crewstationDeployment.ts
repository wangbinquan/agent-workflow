import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createHostedDatabaseWriteBarrier,
  type HostedDatabaseWriteBarrier,
} from '../infrastructure/crewstation/databaseWriteBarrier'
import { restoreCrewStationDatabaseFromEnvironment } from './crewstationDatabaseRestore'
import type { BusinessExecutionFence } from '@/platform/crewstation/businessExecution'
// RFC-370 M0 — system-operations selections of a CrewStation-hosted instance.
// The platform injects every input through environment variables; a missing
// input refuses to start and names all of them at once. Bootstrap passes the
// returned selections to the one shared start sequence.
import { PostgresqlDatabaseConfigSchema, type DatabaseConfig } from '@agent-workflow/shared'
import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  prepareHostedPostgresqlProviderRuntime,
  type PreparedPostgresqlProviderSchema,
} from '@/platform/persistence/databaseProviderRuntime'
import { hostedDatabaseGeneration } from '@/platform/persistence/generationValidation'
import { seedHostedInstallation } from '@/platform/persistence/hostedInstallationSeed'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import type { DatabaseInstallationPort } from '../application/ports/databaseInstallation'
import { createDatabaseApplicationConfiguration } from '../infrastructure/databaseApplicationConfiguration'
import { createHostedDatabaseInstallation } from '../infrastructure/crewstation/hostedDatabaseInstallation'
import {
  createCrewStationExecutionAuthority,
  type CrewStationExecutionAuthorityPort,
} from '../infrastructure/crewstation/crewStationExecutionAuthority'
import {
  createDatabaseHostedExecutionControl,
  hostedLeaseOf,
  HostedExecutionLeaseLostError,
} from '../infrastructure/hostedExecutionControl'
import {
  CREWSTATION_PLATFORM_API_URL_ENV,
  createCrewStationPlatformApi,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'
import { createLogger } from '@/util/log'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from './applicationConfiguration'

export const CREWSTATION_DATABASE_URL_ENV = 'CS_DATABASE_URL'

/** A worker's write window: it starts after its owner serves, so it enforces from the start. */
export function composeCrewStationDatabaseWriteBarrier(): HostedDatabaseWriteBarrier {
  return createHostedDatabaseWriteBarrier()
}

/** A worker borrows its launching owner's exact fence. It never acquires or
 * follows a newer lease merely because the control row has changed. */
export function composeCrewStationWorkerFence(
  db: ProviderNeutralDatabase,
  lease: BusinessExecutionFence,
): CrewStationMutationFence {
  const frozen = Object.freeze({
    epoch: lease.epoch,
    leaseId: lease.leaseId,
    instanceId: lease.instanceId,
  })
  const control = createDatabaseHostedExecutionControl({ db })
  return { current: () => frozen, assertHeld: (tx, expected) => control.assertHeld(tx, expected) }
}

/** aw's task execution contract (Manifest `tasks.acceptedTaskContractVersions`).
 * Bump when a release can no longer take over another release's running tasks. */
export const HOSTED_TASK_CONTRACT_VERSION = 'aw-task-v1'

export interface CrewStationDeploymentEnvironment {
  readonly project: string
  readonly service: string
  readonly port: number
  readonly jwksUrl: string
  /** The service-domain platform API (`CS_PLATFORM_API_URL`). */
  readonly platformApiUrl: string
  /** Present once the Manifest declares `spec.data.objects` (not needed by M0). */
  readonly objectsUrl: string | null
  readonly objectSpaceId: string | null
  readonly secretKey: Buffer
  /** CrewStation user subjects (`user:<uuid>`) that become administrators on first access. */
  readonly adminSubjects: readonly string[]
}

export class CrewStationEnvironmentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`CrewStation deployment environment is incomplete:\n  - ${problems.join('\n  - ')}`)
    this.name = 'CrewStationEnvironmentError'
  }
}

const SUBJECT_PREFIX = 'user:'

/** Accept `user:<id>` or a bare id; whitespace and empty entries are ignored. */
function parseAdminSubjects(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => (entry.startsWith(SUBJECT_PREFIX) ? entry : `${SUBJECT_PREFIX}${entry}`)),
    ),
  ]
}

function requiredReader(env: Readonly<Record<string, string | undefined>>) {
  const problems: string[] = []
  const required = (name: string): string => {
    const value = env[name]?.trim() ?? ''
    if (value.length === 0) problems.push(`${name} is required`)
    return value
  }
  return { problems, required }
}

/** The release migration Job only needs the service identity and its database. */
export function readCrewStationDatabaseEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Pick<CrewStationDeploymentEnvironment, 'project' | 'service'> {
  const { problems, required } = requiredReader(env)
  const project = required('CS_PROJECT')
  const service = required('CS_SERVICE')
  required(CREWSTATION_DATABASE_URL_ENV)
  if (problems.length > 0) throw new CrewStationEnvironmentError(problems)
  return Object.freeze({ project, service })
}

export function readCrewStationEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): CrewStationDeploymentEnvironment {
  const { problems, required } = requiredReader(env)
  const project = required('CS_PROJECT')
  const service = required('CS_SERVICE')
  required(CREWSTATION_DATABASE_URL_ENV)
  const jwksUrl = required('CS_JWKS_URL')
  const platformApiUrl = required(CREWSTATION_PLATFORM_API_URL_ENV)
  const objectsUrl = env.CS_OBJECTS_URL?.trim() ?? ''
  const portText = required('PORT')
  const port = Number(portText)
  if (portText.length > 0 && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    problems.push(`PORT must be a TCP port number, got ${JSON.stringify(portText)}`)
  }
  for (const [name, value] of [
    ['CS_JWKS_URL', jwksUrl],
    [CREWSTATION_PLATFORM_API_URL_ENV, platformApiUrl],
    ['CS_OBJECTS_URL', objectsUrl],
  ] as const) {
    if (value.length > 0 && !URL.canParse(value)) problems.push(`${name} must be an absolute URL`)
  }
  const keyText = required('AW_SECRET_KEY')
  const secretKey = Buffer.from(keyText, 'base64')
  if (keyText.length > 0 && secretKey.length !== 32) {
    problems.push(
      'AW_SECRET_KEY must be 32 random bytes encoded as base64 (for example `openssl rand -base64 32`)',
    )
  }
  if (problems.length > 0) throw new CrewStationEnvironmentError(problems)
  const objectSpaceId = env.CS_OBJECT_SPACE_ID?.trim() ?? ''
  return Object.freeze({
    project,
    service,
    port,
    jwksUrl,
    platformApiUrl,
    objectsUrl: objectsUrl.length > 0 ? objectsUrl : null,
    objectSpaceId: objectSpaceId.length > 0 ? objectSpaceId : null,
    secretKey,
    adminSubjects: Object.freeze(parseAdminSubjects(env.AW_ADMIN_SUBJECTS)),
  })
}

/**
 * A hosted instance shares the platform's PostgreSQL with every other service,
 * and both release slots are connected during a handoff, so the pool stays small
 * unless the plan allows more (`AW_DATABASE_POOL_MAX`). With the standalone
 * default of 16, two slots exhausted the local platform's shared server
 * (RFC-370 acceptance, 2026-10-17).
 */
export const HOSTED_DATABASE_POOL_MAX = 8

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
 * only verifies it (`verify`). Both name the same derived generation.
 */
export async function prepareCrewStationDatabase(input: {
  readonly environment: Pick<CrewStationDeploymentEnvironment, 'project' | 'service'>
  readonly schema: 'apply' | 'verify'
  readonly env?: Readonly<Record<string, string | undefined>>
}): Promise<PreparedPostgresqlProviderSchema> {
  const contract = buildLogicalSchemaContract()
  return await prepareHostedPostgresqlProviderRuntime({
    config: crewStationDatabaseConfig(input.env ?? process.env),
    contract,
    generation: hostedDatabaseGeneration({
      project: input.environment.project,
      service: input.environment.service,
      schemaDigest: contract.digest,
      env: input.env ?? process.env,
    }),
    history: await loadPostgresqlMigrationHistory(),
    schema: input.schema,
    ...(input.env === undefined ? {} : { env: input.env }),
  })
}

/**
 * The migration Job's installation: apply the schema history, give a fresh
 * database its initial rows once, and report both.
 */
export function composeCrewStationMigrationInstallation(
  environment: Pick<CrewStationDeploymentEnvironment, 'project' | 'service'>,
  env?: Readonly<Record<string, string | undefined>>,
  /** Restore normalization participants of the owning modules (bootstrap). */
  normalization?: Parameters<typeof restoreCrewStationDatabaseFromEnvironment>[0]['normalization'],
): DatabaseInstallationPort<PreparedPostgresqlProviderSchema> {
  return createHostedDatabaseInstallation({
    project: environment.project,
    service: environment.service,
    env: env ?? process.env,
    async prepare() {
      await restoreCrewStationDatabaseFromEnvironment({
        environment,
        env: env ?? process.env,
        ...(normalization === undefined ? {} : { normalization }),
      })
      const prepared = await prepareCrewStationDatabase({
        environment,
        schema: 'apply',
        ...(env === undefined ? {} : { env }),
      })
      try {
        const seed = await seedHostedInstallation({
          target: prepared.openBootstrapClient(),
          migrationsFolder: await resolveMigrationsFolder(),
          now: Date.now(),
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
    },
  })
}

export interface CrewStationSystemSelections {
  readonly database: ProviderNeutralDatabase
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly databaseInstallation: DatabaseInstallationPort<PreparedPostgresqlProviderSchema>
  readonly executionAuthority: CrewStationExecutionAuthorityPort
  /** The application side of the execution fence, checked by hosted effect writes. */
  readonly mutationFence: CrewStationMutationFence
  readonly platform: CrewStationPlatformApi
  readonly secretBox: SecretBox
}

/**
 * A serving instance verifies the database before anything else so Settings
 * can be read from it at the start of the shared boot sequence; the
 * installation then hands that same verified runtime to the boot.
 *
 * Nothing here waits for the platform: during a migration or restore freeze
 * the instance boots into read-only standby (its boot convergence precedes the
 * write window, see the barrier) and its execution authority reports the
 * freeze ready from the first tick.
 */
export async function composeCrewStationSystemSelections(input: {
  readonly environment: CrewStationDeploymentEnvironment
  readonly prepared: PreparedPostgresqlProviderSchema
}): Promise<CrewStationSystemSelections> {
  const barrier = createHostedDatabaseWriteBarrier({ enforcing: false })
  const raw = input.prepared.openBootstrapClient()
  const db = createPostgresqlDatabaseClient(input.prepared.runtime.runtime, {
    beforeWrite: barrier.beforeWrite,
  })
  const prepared: PreparedPostgresqlProviderSchema = {
    ...input.prepared,
    runtime: { ...input.prepared.runtime, openClient: () => db },
    openBootstrapClient: () => db,
  }
  const platform = createCrewStationPlatformApi({ baseUrl: input.environment.platformApiUrl })
  // The control row is written outside the window it governs.
  const control = createDatabaseHostedExecutionControl({ db: raw })
  const authority = createCrewStationExecutionAuthority({
    platform,
    control,
    acceptedTaskContractVersions: [HOSTED_TASK_CONTRACT_VERSION],
    log: createLogger('crewstation-execution-authority'),
  })
  const executionAuthority: CrewStationExecutionAuthorityPort = {
    ...authority,
    // Competing for execution is where this instance starts serving: from here
    // on the write window governs every write transaction.
    start() {
      barrier.enforce()
      authority.start()
    },
  }
  return Object.freeze<CrewStationSystemSelections>({
    database: db,
    applicationConfiguration: composeApplicationConfigurationBinding({
      kind: 'selected',
      persistence: createDatabaseApplicationConfiguration({
        db,
        managed: { database: input.prepared.databaseConfig },
      }),
      notificationKey: `crewstation:${input.environment.project}/${input.environment.service}`,
    }),
    databaseInstallation: createHostedDatabaseInstallation({
      project: input.environment.project,
      service: input.environment.service,
      prepare: async () => prepared,
    }),
    executionAuthority,
    mutationFence: {
      current() {
        const state = executionAuthority.current()
        if (state.kind !== 'active') throw new HostedExecutionLeaseLostError(`${state.kind}`)
        return hostedLeaseOf(state.fence)
      },
      assertHeld: (tx, lease) => control.assertHeld(tx, lease),
    },
    platform,
    secretBox: createSecretBoxFromKey(input.environment.secretKey),
  })
}
