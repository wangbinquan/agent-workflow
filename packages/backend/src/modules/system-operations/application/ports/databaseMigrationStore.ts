import type { DatabaseMigrationManifest } from '../../domain/databaseMigration'

export interface DatabaseMigrationStorePort {
  create(manifest: DatabaseMigrationManifest): DatabaseMigrationManifest
  read(operationId: string): DatabaseMigrationManifest | null
  list(): readonly DatabaseMigrationManifest[]
  compareAndSwap(
    expected: Readonly<{ operationId: string; revision: number; digest: string }>,
    next: DatabaseMigrationManifest,
  ): DatabaseMigrationManifest
}
