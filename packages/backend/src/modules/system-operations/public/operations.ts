// RFC-346 — transport-neutral descriptors for the four online administration
// operations. Local CLI plan/activate remain typed application calls and do
// not masquerade as authenticated HTTP operations.

import { z } from 'zod'
import {
  databaseMigrationArtifactInputSchema,
  databaseMigrationArtifactViewSchema,
  databaseMigrationLegacyChunkInputSchema,
  databaseMigrationLegacyTableInputSchema,
  databaseMigrationLegacyTableViewSchema,
  databaseMigrationListViewSchema,
  databaseMigrationOperationInputSchema,
  databaseMigrationPreflightInputSchema,
  databaseMigrationPreflightViewSchema,
  databaseMigrationStatusViewSchema,
  databaseRuntimeOverviewSchema,
  startDatabaseMigrationInputSchema,
} from '@agent-workflow/shared'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import { operationId } from '@/platform/operations/catalog'
import { zodOperationCodec } from '@/platform/operations/codecs'
import type {
  CommandOperationDescriptor,
  IdempotentCommandOperationDescriptor,
  OperationAlias,
  OperationId,
  QueryOperationDescriptor,
  VersionedExactCodec,
} from '@/platform/operations/contracts'
import type { SystemOperationCommands } from './commands'
import type { DatabaseMigrationCommands } from './commands'
import type { DatabaseMigrationQueries, SystemOperationQueries } from './queries'
import {
  backupResultViewSchema,
  cancelStagedRestoreResultSchema,
  recoveryStatusViewSchema,
  requestBackupInputSchema,
  stageRestoreResultSchema,
  type BackupResultView,
  type CancelStagedRestoreResult,
  type DatabaseMigrationArtifactInput,
  type DatabaseMigrationArtifactView,
  type DatabaseMigrationLegacyChunkInput,
  type DatabaseMigrationLegacyTableInput,
  type DatabaseMigrationLegacyTableView,
  type DatabaseMigrationListView,
  type DatabaseMigrationOperationInput,
  type DatabaseMigrationPreflightInput,
  type DatabaseMigrationPreflightView,
  type DatabaseMigrationStatusView,
  type DatabaseRuntimeOverview,
  type RecoveryStatusView,
  type RequestBackupInput,
  type StageRestoreInput,
  type StageRestoreResult,
  type StartDatabaseMigrationInput,
} from './types'

const emptyInputSchema = z.object({}).strict()
const PUBLIC_ERRORS = Object.freeze(['validation-failed', 'internal-error'] as const)
const EFFECT_PUBLIC_ERRORS = Object.freeze([
  'validation-failed',
  'conflict',
  'internal-error',
] as const)
const BACKUP_PERMISSION = Object.freeze(['backup:run'] as const)

const SYSTEM_OPERATION_IDS: Readonly<{
  requestBackup: OperationId
  getRecoveryStatus: OperationId
  cancelStagedRestore: OperationId
  stageRestore: OperationId
}> = Object.freeze({
  requestBackup: operationId('system-operations.request-backup.v1'),
  getRecoveryStatus: operationId('system-operations.get-recovery-status.v1'),
  cancelStagedRestore: operationId('system-operations.cancel-staged-restore.v1'),
  stageRestore: operationId('system-operations.stage-restore.v1'),
})

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

export function createSystemOperationDescriptors(input: {
  readonly commands: SystemOperationCommands
  readonly queries: SystemOperationQueries
  /** Registry-owned codec: arbitrary objects and released refs must fail. */
  readonly stageRestoreInput: VersionedExactCodec<StageRestoreInput>
}): SystemOperationDescriptors {
  const requestBackup: SystemOperationDescriptors['requestBackup'] = Object.freeze({
    id: SYSTEM_OPERATION_IDS.requestBackup,
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Run a backup',
    permissions: BACKUP_PERMISSION,
    // Credential preparation deliberately refuses unsafe backup inputs with a
    // 409 DomainError.  Keeping that category public preserves the established
    // HTTP status/body instead of collapsing it into a contract violation.
    publicErrors: EFFECT_PUBLIC_ERRORS,
    input: zodOperationCodec('system-operations.request-backup.input.v1', requestBackupInputSchema),
    output: zodOperationCodec('system-operations.request-backup.output.v1', backupResultViewSchema),
    invoke: (context: CommandContext, command: RequestBackupInput) =>
      input.commands.requestBackup.execute(context, command),
  })
  const getRecoveryStatus: SystemOperationDescriptors['getRecoveryStatus'] = Object.freeze({
    id: SYSTEM_OPERATION_IDS.getRecoveryStatus,
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'Pending restore state',
    permissions: BACKUP_PERMISSION,
    publicErrors: PUBLIC_ERRORS,
    input: zodOperationCodec('system-operations.get-recovery-status.input.v1', emptyInputSchema),
    output: zodOperationCodec(
      'system-operations.get-recovery-status.output.v1',
      recoveryStatusViewSchema,
    ),
    invoke: (context: QueryContext) => input.queries.getRecoveryStatus.execute(context),
  })
  const cancelStagedRestore: SystemOperationDescriptors['cancelStagedRestore'] = Object.freeze({
    id: SYSTEM_OPERATION_IDS.cancelStagedRestore,
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Disarm a pending restore',
    permissions: BACKUP_PERMISSION,
    publicErrors: PUBLIC_ERRORS,
    input: zodOperationCodec('system-operations.cancel-staged-restore.input.v1', emptyInputSchema),
    output: zodOperationCodec(
      'system-operations.cancel-staged-restore.output.v1',
      cancelStagedRestoreResultSchema,
    ),
    invoke: (context: CommandContext) => input.commands.cancelStagedRestore.execute(context),
  })
  const stageRestore: SystemOperationDescriptors['stageRestore'] = Object.freeze({
    id: SYSTEM_OPERATION_IDS.stageRestore,
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Arm a restore',
    permissions: BACKUP_PERMISSION,
    // An already-staged restore is an established conflict.  The legacy HTTP
    // adapter still projects it to its historical 400 body, while other
    // adapters retain the typed application error unchanged.
    publicErrors: EFFECT_PUBLIC_ERRORS,
    input: input.stageRestoreInput,
    output: zodOperationCodec(
      'system-operations.stage-restore.output.v1',
      stageRestoreResultSchema,
    ),
    invoke: (context: CommandContext, command: StageRestoreInput) =>
      input.commands.stageRestore.execute(context, command),
  })
  return Object.freeze({ requestBackup, getRecoveryStatus, cancelStagedRestore, stageRestore })
}

const DATABASE_MIGRATION_PERMISSIONS = Object.freeze(['settings:write', 'backup:run'] as const)
const DATABASE_MIGRATION_ERRORS = Object.freeze([
  'validation-failed',
  'conflict',
  'internal-error',
] as const)

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

export function createDatabaseMigrationOperationDescriptors(input: {
  readonly commands: DatabaseMigrationCommands
  readonly queries: DatabaseMigrationQueries
}): DatabaseMigrationOperationDescriptors {
  const statusOutput = zodOperationCodec(
    'system-operations.database-migration-status.output.v1',
    databaseMigrationStatusViewSchema,
  )
  const operationInput = zodOperationCodec(
    'system-operations.database-migration-operation.input.v1',
    databaseMigrationOperationInputSchema,
  )
  const overview: DatabaseMigrationOperationDescriptors['overview'] = Object.freeze({
    id: operationId('system-operations.get-database-runtime.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'Read the live database provider and generation',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: zodOperationCodec('system-operations.get-database-runtime.input.v1', emptyInputSchema),
    output: zodOperationCodec(
      'system-operations.get-database-runtime.output.v1',
      databaseRuntimeOverviewSchema,
    ),
    invoke: (context: QueryContext) => input.queries.overview.execute(context),
  })
  const preflight: DatabaseMigrationOperationDescriptors['preflight'] = Object.freeze({
    id: operationId('system-operations.preflight-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Test an external PostgreSQL migration target',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: zodOperationCodec(
      'system-operations.preflight-database-migration.input.v1',
      databaseMigrationPreflightInputSchema,
    ),
    output: zodOperationCodec(
      'system-operations.preflight-database-migration.output.v1',
      databaseMigrationPreflightViewSchema,
    ),
    invoke: (context: CommandContext, command: DatabaseMigrationPreflightInput) =>
      input.commands.preflight.execute(context, command),
  })
  const start: DatabaseMigrationOperationDescriptors['start'] = Object.freeze({
    id: operationId('system-operations.start-database-migration.v1'),
    kind: 'idempotent-command',
    contextKind: 'authenticated-command',
    summary: 'Migrate SQLite to PostgreSQL',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    idempotencyKey: {
      field: 'idempotencyKey' as const,
      minLength: 8,
      maxLength: 256,
      pattern: /^[A-Za-z0-9._:-]+$/,
    },
    input: zodOperationCodec(
      'system-operations.start-database-migration.input.v1',
      startDatabaseMigrationInputSchema,
    ),
    output: statusOutput,
    invoke: (context: CommandContext, command: StartDatabaseMigrationInput) =>
      input.commands.start.execute(context, command),
  })
  const resume: DatabaseMigrationOperationDescriptors['resume'] = Object.freeze({
    id: operationId('system-operations.resume-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Resume a database migration',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.resume.execute(context, command),
  })
  const cancel: DatabaseMigrationOperationDescriptors['cancel'] = Object.freeze({
    id: operationId('system-operations.cancel-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Cancel a database migration before cutover',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.cancel.execute(context, command),
  })
  const rollback: DatabaseMigrationOperationDescriptors['rollback'] = Object.freeze({
    id: operationId('system-operations.rollback-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Roll back to SQLite before the first PostgreSQL live write',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.rollback.execute(context, command),
  })
  const finalize: DatabaseMigrationOperationDescriptors['finalize'] = Object.freeze({
    id: operationId('system-operations.finalize-database-migration.v1'),
    kind: 'command',
    contextKind: 'authenticated-command',
    summary: 'Finalize a verified database migration',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: CommandContext, command: DatabaseMigrationOperationInput) =>
      input.commands.finalize.execute(context, command),
  })
  const get: DatabaseMigrationOperationDescriptors['get'] = Object.freeze({
    id: operationId('system-operations.get-database-migration.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'Read one database migration',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: operationInput,
    output: statusOutput,
    invoke: (context: QueryContext, query: DatabaseMigrationOperationInput) =>
      input.queries.get.execute(context, query),
  })
  const list: DatabaseMigrationOperationDescriptors['list'] = Object.freeze({
    id: operationId('system-operations.list-database-migrations.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'List database migrations',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: zodOperationCodec(
      'system-operations.list-database-migrations.input.v1',
      emptyInputSchema,
    ),
    output: zodOperationCodec(
      'system-operations.list-database-migrations.output.v1',
      databaseMigrationListViewSchema,
    ),
    invoke: (context: QueryContext) => input.queries.list.execute(context),
  })
  const readArtifact: DatabaseMigrationOperationDescriptors['readArtifact'] = Object.freeze({
    id: operationId('system-operations.read-database-migration-artifact.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'Download a verified database migration artifact',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: zodOperationCodec(
      'system-operations.read-database-migration-artifact.input.v1',
      databaseMigrationArtifactInputSchema,
    ),
    output: zodOperationCodec(
      'system-operations.read-database-migration-artifact.output.v1',
      databaseMigrationArtifactViewSchema,
    ),
    invoke: (context: QueryContext, query: DatabaseMigrationArtifactInput) =>
      input.queries.readArtifact.execute(context, query),
  })
  const inspectLegacyTable: DatabaseMigrationOperationDescriptors['inspectLegacyTable'] =
    Object.freeze({
      id: operationId('system-operations.inspect-database-migration-legacy-table.v1'),
      kind: 'query',
      contextKind: 'authenticated-query',
      summary: 'Inspect one archived legacy database table',
      permissions: DATABASE_MIGRATION_PERMISSIONS,
      publicErrors: DATABASE_MIGRATION_ERRORS,
      input: zodOperationCodec(
        'system-operations.inspect-database-migration-legacy-table.input.v1',
        databaseMigrationLegacyTableInputSchema,
      ),
      output: zodOperationCodec(
        'system-operations.inspect-database-migration-legacy-table.output.v1',
        databaseMigrationLegacyTableViewSchema,
      ),
      invoke: (context: QueryContext, query: DatabaseMigrationLegacyTableInput) =>
        input.queries.inspectLegacyTable.execute(context, query),
    })
  const readLegacyChunk: DatabaseMigrationOperationDescriptors['readLegacyChunk'] = Object.freeze({
    id: operationId('system-operations.read-database-migration-legacy-chunk.v1'),
    kind: 'query',
    contextKind: 'authenticated-query',
    summary: 'Download one verified archived legacy database chunk',
    permissions: DATABASE_MIGRATION_PERMISSIONS,
    publicErrors: DATABASE_MIGRATION_ERRORS,
    input: zodOperationCodec(
      'system-operations.read-database-migration-legacy-chunk.input.v1',
      databaseMigrationLegacyChunkInputSchema,
    ),
    output: zodOperationCodec(
      'system-operations.read-database-migration-legacy-chunk.output.v1',
      databaseMigrationArtifactViewSchema,
    ),
    invoke: (context: QueryContext, query: DatabaseMigrationLegacyChunkInput) =>
      input.queries.readLegacyChunk.execute(context, query),
  })
  return Object.freeze({
    overview,
    preflight,
    start,
    resume,
    cancel,
    rollback,
    finalize,
    get,
    list,
    readArtifact,
    inspectLegacyTable,
    readLegacyChunk,
  })
}
