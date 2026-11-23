import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createHostedDatabaseWriteBarrier,
  type HostedDatabaseWriteBarrier,
} from '../infrastructure/crewstation/databaseWriteBarrier'
import type { restoreCrewStationDatabaseFromEnvironment } from '../infrastructure/crewstation/crewstationDatabaseRestore'
import type { BusinessExecutionFence } from '@/platform/crewstation/businessExecution'
// RFC-370 M0 — system-operations selections of a CrewStation-hosted instance.
// The platform injects every input through environment variables; a missing
// input refuses to start and names all of them at once. Bootstrap passes the
// returned selections to the one shared start sequence.
import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { type PreparedPostgresqlProviderSchema } from '@/platform/persistence/databaseProviderRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { RuntimeSchemaBinding } from '@/platform/persistence/schema/tables'
import type { DatabaseInstallationPort } from '../application/ports/databaseInstallation'
import { createDatabaseApplicationConfiguration } from '../infrastructure/databaseApplicationConfiguration'
import { createHostedDatabaseInstallation } from '../infrastructure/crewstation/hostedDatabaseInstallation'
import {
  createCrewStationExecutionAuthority,
  type CrewStationExecutionAuthorityPort,
} from '../infrastructure/crewstation/crewStationExecutionAuthority'
import { createDatabaseHostedExecutionControl } from '../infrastructure/hostedExecutionControl'
import {
  createCrewStationPlatformApi,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'
import { createLogger } from '@/util/log'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from './applicationConfiguration'
import {
  CREWSTATION_DATABASE_URL_ENV,
  CrewStationEnvironmentError,
  HOSTED_TASK_CONTRACT_VERSION,
  readCrewStationDatabaseEnvironment,
  readCrewStationEnvironment,
  type CrewStationDeploymentEnvironment,
} from '../infrastructure/crewstation/deploymentEnvironment'
import {
  createHostedMutationFence,
  crewStationControlClient,
  crewStationDatabaseConfig,
  prepareCrewStationDatabase,
  prepareCrewStationMigrationInstallation,
} from '../infrastructure/crewstation/deploymentDatabase'
// RFC-519: the deployment environment and the hosted database live in infrastructure/crewstation; this file assembles them.
export {
  CREWSTATION_DATABASE_URL_ENV,
  CrewStationEnvironmentError,
  HOSTED_TASK_CONTRACT_VERSION,
  crewStationControlClient,
  crewStationDatabaseConfig,
  prepareCrewStationDatabase,
  readCrewStationDatabaseEnvironment,
  readCrewStationEnvironment,
  type CrewStationDeploymentEnvironment,
}

/** A worker's write window: it starts after its owner serves, so it enforces from the start. */
export function composeCrewStationDatabaseWriteBarrier(): HostedDatabaseWriteBarrier {
  return createHostedDatabaseWriteBarrier()
}

/** A worker borrows its launching owner's exact fence. It never acquires or
 * follows a newer lease merely because the control row has changed. */
export function composeCrewStationWorkerFence(
  db: PersistenceDb,
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

/**
 * The migration Job's installation: apply the schema history, give a fresh
 * database its initial rows once, and report both.
 */
export function composeCrewStationMigrationInstallation(
  contract: LogicalSchemaContract,
  liveSchema: RuntimeSchemaBinding,
  environment: Pick<CrewStationDeploymentEnvironment, 'project' | 'service'>,
  env?: Readonly<Record<string, string | undefined>>,
  /** Restore normalization participants of the owning modules (bootstrap). */
  normalization?: Parameters<typeof restoreCrewStationDatabaseFromEnvironment>[0]['normalization'],
): DatabaseInstallationPort<PreparedPostgresqlProviderSchema> {
  return createHostedDatabaseInstallation({
    project: environment.project,
    service: environment.service,
    env: env ?? process.env,
    prepare: () =>
      prepareCrewStationMigrationInstallation({
        contract,
        liveSchema,
        environment,
        env,
        normalization,
      }),
  })
}

export interface CrewStationSystemSelections {
  readonly database: PersistenceDb
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
  readonly liveSchema: RuntimeSchemaBinding
}): Promise<CrewStationSystemSelections> {
  const barrier = createHostedDatabaseWriteBarrier({ enforcing: false })
  const raw = crewStationControlClient(input.prepared.runtime.runtime, input.liveSchema)
  const db = createPostgresqlDatabaseClient(input.prepared.runtime.runtime, {
    liveSchema: input.liveSchema,
    beforeWrite: barrier.beforeWrite,
    countsAsLiveWrite: barrier.isEnforcing,
  })
  const prepared: PreparedPostgresqlProviderSchema = {
    ...input.prepared,
    runtime: { ...input.prepared.runtime, openClient: () => db },
    openBootstrapClient: () => db,
  }
  const platform = createCrewStationPlatformApi({ baseUrl: input.environment.platformApiUrl })
  const control = createDatabaseHostedExecutionControl({ db: raw })
  const authority = createCrewStationExecutionAuthority({
    platform,
    control,
    acceptedTaskContractVersions: [HOSTED_TASK_CONTRACT_VERSION],
    log: createLogger('crewstation-execution-authority'),
  })
  // Crash-only (§3.2): once this instance loses its lease it writes nothing more.
  barrier.follow(authority)
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
    mutationFence: createHostedMutationFence(executionAuthority, control),
    platform,
    secretBox: createSecretBoxFromKey(input.environment.secretKey),
  })
}
