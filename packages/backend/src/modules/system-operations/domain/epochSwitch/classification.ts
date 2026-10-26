import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { DatabaseGenerationFile } from '@/platform/persistence/generationValidation'
import type { GenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { EpochSwitchError, type EpochSwitchJournal } from './model'
import { phaseIndex } from './transitions'

export interface InstallationFacts {
  readonly pointer: GenerationPointerV2 | DatabaseGenerationFile | null
  readonly provider: DatabaseProvider
  readonly sourceExists: boolean
  readonly operation: EpochSwitchJournal | null
  readonly rfc349Operation: string | null
  readonly activationReceiptDigest: string | null
  readonly targetState: 'prepared' | 'active' | 'retired' | null
  readonly rollbackIncomplete: boolean
}
export type EpochInstallationState =
  | { kind: 'fresh' }
  | { kind: 'epoch2'; pointer: GenerationPointerV2; operation: EpochSwitchJournal | null }
  | {
      kind: 'epoch1'
      pointer: DatabaseGenerationFile | null
      provider: DatabaseProvider
      operation: EpochSwitchJournal | null
      rfc349Operation: string | null
    }
  | {
      kind: 'switch-recovery-required'
      operation: EpochSwitchJournal
      reason:
        | 'pointer-receipt-mismatch'
        | 'rollback-incomplete'
        | 'activation-unreconciled'
        | 'target-retired'
    }

export function classifyEpochInstallation(f: InstallationFacts): EpochInstallationState {
  const operation = f.operation
  if (operation && f.rollbackIncomplete)
    return { kind: 'switch-recovery-required', operation, reason: 'rollback-incomplete' }
  if (f.pointer?.payload.version === 2) {
    const pointer = f.pointer as GenerationPointerV2
    if (pointer.payload.role !== 'installed' && !operation)
      throw new EpochSwitchError('v3-pointer-operation-missing', {
        category: 'pointer-receipt-mismatch',
      })
    if (
      operation &&
      pointer.payload.operationId !== operation.payload.operationId &&
      !['rolled-back', 'abandoned', 'completed'].includes(operation.payload.status) &&
      phaseIndex(operation.payload.phase) >= phaseIndex('quiescing')
    )
      return { kind: 'switch-recovery-required', operation, reason: 'activation-unreconciled' }
    if (
      operation &&
      f.targetState === 'retired' &&
      pointer.payload.operationId === operation.payload.operationId
    )
      return { kind: 'switch-recovery-required', operation, reason: 'target-retired' }
    if (operation && pointer.payload.operationId === operation.payload.operationId) {
      if (
        pointer.payload.manifestDigest !== f.activationReceiptDigest ||
        pointer.payload.generationId !== operation.payload.target.generationId
      )
        return { kind: 'switch-recovery-required', operation, reason: 'pointer-receipt-mismatch' }
      if (phaseIndex(operation.payload.phase) < phaseIndex('activated'))
        return { kind: 'switch-recovery-required', operation, reason: 'activation-unreconciled' }
    }
    return { kind: 'epoch2', pointer, operation }
  }
  if (
    operation &&
    !['rolled-back', 'abandoned'].includes(operation.payload.status) &&
    phaseIndex(operation.payload.phase) >= phaseIndex('activated')
  )
    return { kind: 'switch-recovery-required', operation, reason: 'activation-unreconciled' }
  if (!f.sourceExists && !f.pointer && !operation && !f.rfc349Operation) return { kind: 'fresh' }
  return {
    kind: 'epoch1',
    pointer: f.pointer as DatabaseGenerationFile | null,
    provider: f.provider,
    operation,
    rfc349Operation: f.rfc349Operation,
  }
}

export function epochInstallationGuidance(state: EpochInstallationState): string | null {
  switch (state.kind) {
    case 'fresh':
      return null
    case 'epoch2':
      return null
    case 'epoch1':
      return state.rfc349Operation
        ? `Finish or roll back RFC-349 operation ${state.rfc349Operation} before planning the epoch switch.`
        : state.operation &&
            !['completed', 'rolled-back', 'abandoned'].includes(state.operation.payload.status)
          ? `This is an epoch-1 installation with operation ${state.operation.payload.operationId}. Run db migration status ${state.operation.payload.operationId}, then resume that operation with its approval digest.`
          : 'This is an epoch-1 installation. Run db migration plan, review its plan, then run with --approve <approvalDigest> while offline.'
    case 'switch-recovery-required':
      return `Keep the daemon stopped. Recover db migration ${state.operation.payload.operationId}: ${state.reason}; use status, run or rollback before starting writers.`
  }
}
