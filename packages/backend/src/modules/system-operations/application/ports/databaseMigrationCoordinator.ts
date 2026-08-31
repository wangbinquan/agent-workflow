import type {
  DatabaseMigrationOperationInput,
  DatabaseMigrationPreflightInput,
  DatabaseMigrationPreflightView,
  DatabaseMigrationStatusView,
  DatabaseMigrationTargetView,
  DatabaseRuntimeOverview,
  StartDatabaseMigrationInput,
} from '../../public/databaseMigrationTypes'

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
  /** Boot-only recovery hook; not exported through the public command surface. */
  resumeInterrupted(target: DatabaseMigrationTargetView): Promise<DatabaseMigrationStatusView | null>
}
