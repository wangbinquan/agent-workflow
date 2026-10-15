// RFC-370 A-T2: installation preparation owns the decisions, while the host
// supplies metadata, locking, copy recovery and provider preparation effects.
import type { DatabaseConfig } from '@agent-workflow/shared'
import type {
  DatabaseGenerationBootstrapCandidate,
  DatabaseGenerationPayload,
} from '@/platform/persistence/generationValidation'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { DatabaseMigrationManifest } from '../../domain/databaseMigration'
import type { DatabaseMigrationStatusView } from '../databaseMigrationControlPlane'
import type { DatabaseMigrationCoordinatorPort } from './databaseMigrationCoordinator'

export interface DatabaseInstallationPort<TPrepared> {
  readGeneration(input: {
    readonly contract: LogicalSchemaContract
    readonly pendingOperationId?: string
  }): DatabaseGenerationBootstrapCandidate | Promise<DatabaseGenerationBootstrapCandidate>
  resolveRecoverySource(input: {
    readonly fromContractDigest: string
    readonly toContractDigest: string
  }): LogicalSchemaContract | Promise<LogicalSchemaContract>
  listMigrations():
    | readonly DatabaseMigrationStatusView[]
    | Promise<readonly DatabaseMigrationStatusView[]>
  /**
   * The local record of a SQLite→PostgreSQL migration operation. `null` when the
   * installation keeps none for it: a CrewStation-hosted generation's operation is
   * the release Job's installation copy, recorded in PostgreSQL itself (RFC-370 M0).
   */
  readMigration(
    operationId: string,
  ): DatabaseMigrationManifest | null | Promise<DatabaseMigrationManifest | null>
  writeGeneration(payload: DatabaseGenerationPayload): void | Promise<void>
  /** Idempotent within one preparation. Reuse a caller-owned lock when present. */
  requireUpgradeLock(): void | Promise<void>
  /** Release only the lock owned by this preparation, including on failure. */
  releaseUpgradeLock(): void | Promise<void>
  resumeMigration(input: {
    readonly contract: LogicalSchemaContract
    readonly operationId: string
    readonly target: DatabaseMigrationManifest['payload']['target']
  }): ReturnType<DatabaseMigrationCoordinatorPort['resumeInterrupted']>
  prepareProvider(input: {
    readonly config: DatabaseConfig
    readonly contract: LogicalSchemaContract
    readonly candidate: DatabaseGenerationBootstrapCandidate
    readonly requireUpgradeLock: () => Promise<void>
    readonly advancePointer: () => Promise<void>
  }): Promise<TPrepared>
}
