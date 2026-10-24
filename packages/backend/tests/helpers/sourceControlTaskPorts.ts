// RFC-395 II-b package O1: provider tests use the same Task-owned ports as bootstrap.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'

export function withSourceControlTaskPorts<T extends { readonly db: PersistenceDb }>(
  input: T,
): NoInfer<T> & { taskPorts: ReturnType<typeof composeSourceControlTaskPorts> } {
  return { ...input, taskPorts: composeSourceControlTaskPorts(input.db) }
}

export function withWorkspaceMaintenancePorts<T extends { readonly db: PersistenceDb }>(input: T) {
  const { db, ...rest } = input
  return { ...rest, ...composeSourceControlTaskPorts(db) }
}

export function withRepositorySnapshotPorts<T extends { readonly transaction: PersistenceDb }>(
  input: T,
) {
  return { ...input, taskPorts: composeSourceControlTaskPorts(input.transaction) }
}
