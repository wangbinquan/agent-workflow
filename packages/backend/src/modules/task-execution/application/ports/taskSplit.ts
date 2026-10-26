import type { PersistenceTables } from '@/platform/persistence/sessionTables'
import type { TaskCreationInput, TaskCreationReceipt } from './taskCreation'

/** One pure split shared by the creation participant and target fixture builders. */
export interface TaskCreationSplit {
  readonly task: PersistenceTables['tasks']['$inferInsert']
  readonly definition: PersistenceTables['taskDefinitions']['$inferInsert']
  readonly launchContext: PersistenceTables['taskLaunchContexts']['$inferInsert']
  readonly workspace: PersistenceTables['taskWorkspaces']['$inferInsert']
  readonly mounts: readonly PersistenceTables['taskRepositoryMounts']['$inferInsert'][]
  readonly generation: PersistenceTables['taskExecutionGenerations']['$inferInsert']
  readonly workgroupState: PersistenceTables['workgroupTaskState']['$inferInsert'] | null
  readonly lineage: TaskCreationReceipt
}

export type SplitTaskCreation = (input: TaskCreationInput) => TaskCreationSplit
