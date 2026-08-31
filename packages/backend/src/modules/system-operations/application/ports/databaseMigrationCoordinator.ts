import type {
  DatabaseMigrationArtifactInput,
  DatabaseMigrationArtifactView,
  DatabaseMigrationLegacyChunkInput,
  DatabaseMigrationLegacyTableInput,
  DatabaseMigrationLegacyTableView,
  DatabaseMigrationOperationInput,
  DatabaseMigrationPreflightInput,
  DatabaseMigrationPreflightView,
  DatabaseMigrationStatusView,
  DatabaseMigrationTargetView,
  DatabaseRuntimeOverview,
  StartDatabaseMigrationInput,
} from '../../public/types'

export interface DatabaseMigrationCoordinatorPort {
  start(input: StartDatabaseMigrationInput): Promise<DatabaseMigrationStatusView>
  preflight(input: DatabaseMigrationPreflightInput): Promise<DatabaseMigrationPreflightView>
  resume(input: DatabaseMigrationOperationInput): Promise<DatabaseMigrationStatusView>
  cancel(input: DatabaseMigrationOperationInput): Promise<DatabaseMigrationStatusView>
  rollback(input: DatabaseMigrationOperationInput): Promise<DatabaseMigrationStatusView>
  finalize(input: DatabaseMigrationOperationInput): Promise<DatabaseMigrationStatusView>
  get(input: DatabaseMigrationOperationInput): Promise<DatabaseMigrationStatusView>
  list(): Promise<readonly DatabaseMigrationStatusView[]>
  overview(): Promise<DatabaseRuntimeOverview>
  readArtifact(input: DatabaseMigrationArtifactInput): Promise<DatabaseMigrationArtifactView>
  inspectLegacyTable(
    input: DatabaseMigrationLegacyTableInput,
  ): Promise<DatabaseMigrationLegacyTableView>
  readLegacyChunk(input: DatabaseMigrationLegacyChunkInput): Promise<DatabaseMigrationArtifactView>
  /** Boot-only recovery hook; not exported through the public command surface. */
  resumeInterrupted(
    target: DatabaseMigrationTargetView,
  ): Promise<DatabaseMigrationStatusView | null>
}
