// RFC-346 — transport-neutral descriptors for the four online administration
// operations. Local CLI plan/activate remain typed application calls and do
// not masquerade as authenticated HTTP operations.
//
// RFC-550 (RFC-294 S9): the two descriptor factories and the operation id table moved into
// `application/operationDescriptors.ts` (no other module called them). RFC-576: the two descriptor contracts followed
// them once the HTTP bindings that consumed them moved into this module's inbound layer; the aliases stay here.

import type { OperationAlias } from '@/platform/operations/contracts'
import { operationId } from '@/platform/operations/catalog'
import { SYSTEM_OPERATION_IDS } from '../application/operationDescriptors'
import type { MaintenanceDiskReport } from './types'

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
