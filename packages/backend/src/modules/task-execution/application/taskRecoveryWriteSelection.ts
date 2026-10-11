import type {
  TaskBootRecoveryWrites,
  TaskPeriodicRecoveryOperations,
  TaskRecoveryWritePurposes,
  TaskRecoveryWriteSelection,
  TaskResourceRecoveryGrant,
} from './ports/taskRecoveryWritePurposes'

function purposes(
  selection: TaskRecoveryWriteSelection,
  grant: TaskResourceRecoveryGrant | undefined,
): TaskRecoveryWritePurposes | undefined {
  if (selection.recoveryWriteMode === undefined && selection.recoveryWritePurposes === undefined) {
    if (grant !== undefined) throw new Error('task-recovery-write-selection-incomplete')
    return undefined
  }
  const factory = selection.recoveryWritePurposes
  if (
    selection.recoveryWriteMode !== 'host-selected' ||
    grant === undefined ||
    factory === undefined ||
    typeof factory.boot !== 'function' ||
    typeof factory.periodic !== 'function'
  ) {
    throw new Error('task-recovery-write-selection-incomplete')
  }
  return factory
}

function requireMethods(value: object | undefined, names: readonly string[]): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    names.some((name) => typeof Reflect.get(value, name) !== 'function')
  ) {
    throw new Error('task-recovery-write-selection-incomplete')
  }
}

/** Local startup interprets this choice synchronously before its first await. */
export function selectTaskBootRecoveryWrites(
  selection: TaskRecoveryWriteSelection,
  grant: TaskResourceRecoveryGrant | undefined,
): TaskBootRecoveryWrites | undefined {
  const factory = purposes(selection, grant)
  if (factory === undefined) return undefined
  const selected = factory.boot.call(factory, grant!)
  if (selected === undefined) throw new Error('task-recovery-write-selection-incomplete')
  requireMethods(selected.recovery, ['prepare', 'finalize'])
  requireMethods(selected.operations, [
    'loadBootOrphanSnapshot',
    'interruptBootOrphanTask',
    'interruptNodeRun',
    'recordEvent',
  ])
  requireMethods(selected.runtimeSessionLeases, ['repairAfterOrphanReap'])
  return selected
}

/** Active periodic work never borrows a draining issued-ACK purpose. */
export function selectTaskPeriodicRecoveryWrites(
  selection: TaskRecoveryWriteSelection,
  grant: TaskResourceRecoveryGrant | undefined,
): TaskPeriodicRecoveryOperations | undefined {
  const factory = purposes(selection, grant)
  if (factory === undefined) return undefined
  const selected = factory.periodic.call(factory, grant!)
  requireMethods(selected, [
    'listPeriodicReconcileCandidates',
    'loadPeriodicReconcileSnapshot',
    'findHeldRuntimeSessionId',
    'interruptNodeRun',
    'repairRuntimeSessionLeaseAfterOrphanReap',
    'interruptPeriodicTaskIfIdle',
    'recordEvent',
  ])
  return selected
}
