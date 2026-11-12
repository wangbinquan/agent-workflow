import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createTaskAutomationWorkStartProvider as bindTaskAutomationWorkStartProvider } from '../application/adapters/event-automation-adapter'
import { findTaskAutomationReceipt } from '../infrastructure/taskAutomationReceipts'
import type { Actor } from '@/auth/actor'
import type { WorkspaceUploadContentFactory } from '@/modules/source-control/public/types'
import type { RootTaskLaunchDependencies } from '../application/launch/rootTaskLaunch'
import type { TaskRouteLaunchDependencies } from '../application/launch/taskRouteLaunchOperations'
import type { TaskInputFiles } from '../application/ports/taskInputFiles'
import { directTaskInitiatorFromActorSource } from '../inbound/directTaskInitiator'
import { resolveUploadLimits } from '../infrastructure/local/fileTaskLaunchConfiguration'
import { createRootTaskAdmission } from '../infrastructure/rootTaskAdmission'
import { createTaskAuthorizationQueries } from '../infrastructure/taskAuthorization'
import { createTaskLaunchUploads } from '../infrastructure/taskWorkspaceUploads'

export {
  createRootTaskLaunchKernel,
  type RootTaskLaunchDependencies,
  type RootTaskLaunchKernel,
  type RootTaskLaunchRequest,
} from '../application/launch/rootTaskLaunch'
export {
  createTaskExecutionLaunchParticipant,
  type TaskExecutionLaunchParticipant,
  type TaskExecutionLaunchTarget,
} from '../application/launch/taskExecutionLaunchParticipant'
export {
  createTaskRouteLaunchOperations,
  type TaskRouteLaunchDependencies,
} from '../application/launch/taskRouteLaunchOperations'
export { type RootTaskLaunchSubject } from '../application/ports/rootTaskAdmission'
export {
  type TaskRoutePreparedWorkspace,
  type TaskRouteWorkspaceParticipant,
  type TaskRouteWorkspaceRepository,
  type WorkgroupRouteLaunchResources,
} from '../application/ports/taskRouteLaunch'
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
    readonly db: PersistenceDb
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

/** RFC-486: the root launch kernel's ports, built from the provider database (admission, uploads, initiator). */
export type RootTaskLaunchKernelPorts = Pick<
  RootTaskLaunchDependencies,
  'admission' | 'uploads' | 'directTaskInitiator'
>

/** RFC-486: the route / participant launch ports — the kernel ports plus the file-config upload limits and replay visibility. */
export type TaskRouteLaunchPorts = RootTaskLaunchKernelPorts &
  Pick<TaskRouteLaunchDependencies, 'fileUploadLimits' | 'taskAuthorization'>

/**
 * RFC-486: what the provider assembly receives for the launch — the application dependencies minus the ports above and
 * the workspace participant, plus the raw inputs those ports are built from (the shape bootstrap already passes).
 */
export type TaskRouteLaunchAssembly = Omit<
  TaskRouteLaunchDependencies,
  keyof TaskRouteLaunchPorts | 'workspace'
> &
  Readonly<{
    configPath: string
    workspaceUploads?: WorkspaceUploadContentFactory
    inputFiles?: TaskInputFiles
  }>

export function createRootTaskLaunchKernelPorts(
  input: Readonly<{
    db: PersistenceDb
    workspaceUploads?: WorkspaceUploadContentFactory
    inputFiles?: TaskInputFiles
  }>,
): RootTaskLaunchKernelPorts {
  return Object.freeze({
    admission: createRootTaskAdmission({ db: input.db }),
    uploads: createTaskLaunchUploads({
      db: input.db,
      workspaceUploads: input.workspaceUploads,
      inputFiles: input.inputFiles,
    }),
    // RFC-301: only the inbound adapter observes the actor source.
    directTaskInitiator: (actor: Actor) => directTaskInitiatorFromActorSource(actor.source),
  })
}

export function createRootTaskLaunchPorts(
  input: Readonly<{
    db: PersistenceDb
    configPath: string
    workspaceUploads?: WorkspaceUploadContentFactory
    inputFiles?: TaskInputFiles
  }>,
): TaskRouteLaunchPorts {
  return Object.freeze({
    ...createRootTaskLaunchKernelPorts(input),
    fileUploadLimits: () => resolveUploadLimits(input.configPath),
    taskAuthorization: createTaskAuthorizationQueries(input.db),
  })
}
