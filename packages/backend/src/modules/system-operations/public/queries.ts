import type { OverviewResponse } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { TaskOverviewQuery } from '@/modules/task-execution/public/queries'
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
import type { QueryContext, RequestAuthority } from '@/modules/identity-access/public/participants'

export interface SystemOverviewAuthority {
  readonly actor: Actor
  readonly authority: RequestAuthority
}

/** Compatibility export; Task Execution is the single contract owner. */
export type { TaskOverviewQuery }

/** Closed aggregate consumed by the HTTP overview route. */
export interface SystemOverviewQuery {
  execute(authority: SystemOverviewAuthority): Promise<OverviewResponse>
}

/** Database facts used by the public liveness route. Provider adapters own
 * dialect/query mechanics; the transport consumes only the closed count. */
export interface HealthDatabaseReadModel {
  countRunningTasks(): Promise<number>
}

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
