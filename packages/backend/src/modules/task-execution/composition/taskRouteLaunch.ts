import type { ProviderNeutralDatabase } from '@/db/query'
import { createTaskAutomationWorkStartProvider as bindTaskAutomationWorkStartProvider } from '../application/adapters/event-automation-adapter'
import { findTaskAutomationReceipt } from '../infrastructure/taskRouteLaunchOperations'

export {
  createSqliteTaskExecutionLaunchParticipant,
  createSqliteTaskRouteLaunchOperations,
  type SqliteTaskRouteLaunchDependencies,
} from '../infrastructure/sqliteTaskRouteLaunchOperations'
export {
  createRootTaskLaunchKernel,
  createTaskExecutionLaunchParticipant,
  createTaskRouteLaunchOperations,
  type RootTaskLaunchDependencies,
  type RootTaskLaunchKernel,
  type RootTaskLaunchRequest,
  type RootTaskLaunchSubject,
  type TaskRouteLaunchDependencies,
  type TaskExecutionLaunchParticipant,
  type TaskExecutionLaunchTarget,
  type TaskRoutePreparedWorkspace,
  type TaskRouteWorkspaceParticipant,
  type TaskRouteWorkspaceRepository,
  type WorkgroupRouteLaunchResources,
} from '../infrastructure/taskRouteLaunchOperations'
export {
  createTaskRouteWorkspaceParticipant,
  createTaskWorkspaceMaterializer,
  type TaskRouteWorkspaceDependencies,
  type TaskWorkspaceMaterializer,
  type TaskWorkspacePreparation,
} from '../infrastructure/taskRouteWorkspaceParticipant'
export type {
  AgentRouteTaskLaunchOperations,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'

type TaskAutomationWorkStartProviderInput = Parameters<
  typeof bindTaskAutomationWorkStartProvider
>[0]

export function createTaskAutomationWorkStartProvider(
  input: Omit<TaskAutomationWorkStartProviderInput, 'receiptFor'> & {
    readonly db: ProviderNeutralDatabase
  },
): ReturnType<typeof bindTaskAutomationWorkStartProvider> {
  return bindTaskAutomationWorkStartProvider({
    origins: input.origins,
    contexts: input.contexts,
    resources: input.resources,
    launch: input.launch,
    receiptFor: (eventDeliveryId) => findTaskAutomationReceipt(input.db, eventDeliveryId),
  })
}
