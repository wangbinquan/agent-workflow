import type {
  DatabaseMigrationArtifactInput,
  DatabaseMigrationArtifactView,
  DatabaseMigrationLegacyChunkInput,
  DatabaseMigrationLegacyTableInput,
  DatabaseMigrationLegacyTableView,
  DatabaseMigrationListView,
  DatabaseMigrationOperationInput,
  DatabaseMigrationStatusView,
  DatabaseRuntimeOverview,
  LocalSystemOperationContext,
  PlanLocalRestoreInput,
  RecoveryStatusView,
  RestorePlanView,
} from './types'
import type { QueryContext } from '@/modules/identity-access/public/participants'

export interface PlanLocalRestoreQuery {
  execute(
    context: LocalSystemOperationContext,
    input: PlanLocalRestoreInput,
  ): Promise<RestorePlanView>
}

export interface GetRecoveryStatusQuery {
  execute(context: QueryContext): RecoveryStatusView
}

export interface SystemOperationQueries {
  readonly planLocalRestore: PlanLocalRestoreQuery
  readonly getRecoveryStatus: GetRecoveryStatusQuery
}

export interface DatabaseMigrationQueries {
  readonly overview: {
    execute(context: QueryContext | LocalSystemOperationContext): Promise<DatabaseRuntimeOverview>
  }
  readonly get: {
    execute(
      context: QueryContext | LocalSystemOperationContext,
      input: DatabaseMigrationOperationInput,
    ): Promise<DatabaseMigrationStatusView>
  }
  readonly list: {
    execute(context: QueryContext | LocalSystemOperationContext): Promise<DatabaseMigrationListView>
  }
  readonly readArtifact: {
    execute(
      context: QueryContext | LocalSystemOperationContext,
      input: DatabaseMigrationArtifactInput,
    ): Promise<DatabaseMigrationArtifactView>
  }
  readonly inspectLegacyTable: {
    execute(
      context: QueryContext | LocalSystemOperationContext,
      input: DatabaseMigrationLegacyTableInput,
    ): Promise<DatabaseMigrationLegacyTableView>
  }
  readonly readLegacyChunk: {
    execute(
      context: QueryContext | LocalSystemOperationContext,
      input: DatabaseMigrationLegacyChunkInput,
    ): Promise<DatabaseMigrationArtifactView>
  }
}
