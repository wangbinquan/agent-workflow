// RFC-346 — transport-neutral descriptors for the four online administration
// operations. Local CLI plan/activate remain typed application calls and do
// not masquerade as authenticated HTTP operations.
//
// RFC-550 (RFC-294 S9): the two descriptor factories and the operation id table moved into
// `application/operationDescriptors.ts` (no other module called them); the contracts stay here.

import type {
  HostedBackupCatalog,
  HostedBackupId,
  HostedBackupVerification,
} from '@agent-workflow/shared'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type {
  CommandOperationDescriptor,
  IdempotentCommandOperationDescriptor,
  OperationAlias,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import { operationId } from '@/platform/operations/catalog'
import { SYSTEM_OPERATION_IDS } from '../application/operationDescriptors'
import type {
  BackupResultView,
  CancelStagedRestoreResult,
  DatabaseMigrationArtifactInput,
  DatabaseMigrationArtifactView,
  DatabaseMigrationLegacyChunkInput,
  DatabaseMigrationLegacyTableInput,
  DatabaseMigrationLegacyTableView,
  DatabaseMigrationListView,
  DatabaseMigrationOperationInput,
  DatabaseMigrationPreflightInput,
  DatabaseMigrationPreflightView,
  DatabaseMigrationStatusView,
  DatabaseRuntimeOverview,
  MaintenanceDiskReport,
  RecoveryStatusView,
  RequestBackupInput,
  StageRestoreInput,
  StageRestoreResult,
  StartDatabaseMigrationInput,
} from './types'

export interface MaintenanceDiskOperations {
  report(): Promise<MaintenanceDiskReport>
  cleanupRetiredStores(): Promise<{ readonly removedBytes: number }>
}

// RFC-477: `ResourceLimitAudit` left public — the resource-limit policy moved into task-execution, which declares its own
// audit port; bootstrap still spreads this module's `createResourceLimitAudit` into the policy's persistence.

export const SYSTEM_OPERATION_ALIASES: ReadonlyArray<OperationAlias> = Object.freeze([
  Object.freeze({
    alias: operationId('legacy-http.post-backup.v1'),
    target: SYSTEM_OPERATION_IDS.requestBackup,
    removeAfter: 'explicit-consumer-zero-decision' as const,
  }),
  Object.freeze({
    alias: operationId('legacy-http.read-restore-pending.v1'),
    target: SYSTEM_OPERATION_IDS.getRecoveryStatus,
    removeAfter: 'explicit-consumer-zero-decision' as const,
  }),
  Object.freeze({
    alias: operationId('legacy-http.delete-restore-pending.v1'),
    target: SYSTEM_OPERATION_IDS.cancelStagedRestore,
    removeAfter: 'explicit-consumer-zero-decision' as const,
  }),
  Object.freeze({
    alias: operationId('legacy-http.post-restore.v1'),
    target: SYSTEM_OPERATION_IDS.stageRestore,
    removeAfter: 'explicit-consumer-zero-decision' as const,
  }),
])

export interface SystemOperationDescriptors {
  readonly hostedBackupCatalog?: QueryOperationDescriptor<
    Record<never, never>,
    HostedBackupCatalog,
    QueryContext
  >
  readonly verifyHostedBackup?: QueryOperationDescriptor<
    HostedBackupId,
    HostedBackupVerification,
    QueryContext
  >
  readonly requestBackup: CommandOperationDescriptor<
    RequestBackupInput,
    BackupResultView,
    CommandContext
  >
  readonly getRecoveryStatus: QueryOperationDescriptor<
    Record<never, never>,
    RecoveryStatusView,
    QueryContext
  >
  readonly cancelStagedRestore: CommandOperationDescriptor<
    Record<never, never>,
    CancelStagedRestoreResult,
    CommandContext
  >
  readonly stageRestore: CommandOperationDescriptor<
    StageRestoreInput,
    StageRestoreResult,
    CommandContext
  >
}

export interface DatabaseMigrationOperationDescriptors {
  readonly overview: QueryOperationDescriptor<
    Record<never, never>,
    DatabaseRuntimeOverview,
    QueryContext
  >
  readonly preflight: CommandOperationDescriptor<
    DatabaseMigrationPreflightInput,
    DatabaseMigrationPreflightView,
    CommandContext
  >
  readonly start: IdempotentCommandOperationDescriptor<
    StartDatabaseMigrationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly resume: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly cancel: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly rollback: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly finalize: CommandOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    CommandContext
  >
  readonly get: QueryOperationDescriptor<
    DatabaseMigrationOperationInput,
    DatabaseMigrationStatusView,
    QueryContext
  >
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    DatabaseMigrationListView,
    QueryContext
  >
  readonly readArtifact: QueryOperationDescriptor<
    DatabaseMigrationArtifactInput,
    DatabaseMigrationArtifactView,
    QueryContext
  >
  readonly inspectLegacyTable: QueryOperationDescriptor<
    DatabaseMigrationLegacyTableInput,
    DatabaseMigrationLegacyTableView,
    QueryContext
  >
  readonly readLegacyChunk: QueryOperationDescriptor<
    DatabaseMigrationLegacyChunkInput,
    DatabaseMigrationArtifactView,
    QueryContext
  >
}
