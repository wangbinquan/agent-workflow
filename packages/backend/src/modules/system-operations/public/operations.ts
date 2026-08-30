// RFC-346 — transport-neutral descriptors for the four online administration
// operations. Local CLI plan/activate remain typed application calls and do
// not masquerade as authenticated HTTP operations.

import { z } from 'zod'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import { operationId } from '@/platform/operations/catalog'
import { zodOperationCodec } from '@/platform/operations/codecs'
import type {
  CommandOperationDescriptor,
  OperationAlias,
  OperationId,
  QueryOperationDescriptor,
  VersionedExactCodec,
} from '@/platform/operations/contracts'
import type { SystemOperationCommands } from './commands'
import type { SystemOperationQueries } from './queries'
import {
  backupResultViewSchema,
  cancelStagedRestoreResultSchema,
  recoveryStatusViewSchema,
  requestBackupInputSchema,
  stageRestoreResultSchema,
  type BackupResultView,
  type CancelStagedRestoreResult,
  type RecoveryStatusView,
  type RequestBackupInput,
  type StageRestoreInput,
  type StageRestoreResult,
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
