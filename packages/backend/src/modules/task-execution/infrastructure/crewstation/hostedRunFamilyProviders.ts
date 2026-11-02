// RFC-422 — what the hosted (CrewStation) run family openers receive: the hosted invocation dependencies and, from
// runtime-management, the hosted system agent contents. The port lists only the members the openers use; the
// composition passes runtime-management's implementation, which satisfies it structurally.
import type {
  AgentMaterialSeedFile,
  AgentMaterialWorkspace,
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScope,
  SystemAgentWorkspaceScopes,
} from '@/modules/runtime-management/public/participants'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { createHostedAgentInvocationPreparation } from './agentInvocationPreparation'

/** The hosted invocation dependencies both hosted run families share. */
export type HostedRunFamilyInput = Pick<
  Parameters<typeof createHostedAgentInvocationPreparation>[0],
  | 'db'
  | 'fence'
  | 'api'
  | 'executions'
  | 'profiles'
  | 'startupInventoryAvailable'
  | 'nativeConfigAvailable'
  | 'nativeModelMappingAvailable'
  | 'pluginFiles'
  | 'materialEnvironment'
> & {
  readonly helper: WorkspaceHelper
  readonly reference: (taskId: string, path: string) => string
  readonly workspaces: { ensure(taskId: string): Promise<{ readonly businessTaskId: string }> }
}

/** The hosted system agent contents (runtime-management's CrewStation system workspaces). */
export interface HostedSystemAgentContents {
  readonly workspaces: SystemAgentWorkspaceScopes
  readonly contents: SystemAgentRetainedContents
  open(request: {
    readonly scope: SystemAgentWorkspaceScope
    readonly invocationId: string
    readonly seeds?: readonly AgentMaterialSeedFile[]
  }): { readonly workspace: AgentMaterialWorkspace; readonly taskId: string; readonly cwd: string }
}

/** Opens the hosted system agent contents over a release judgment. */
export type HostedSystemAgentContentsFactory = (input: {
  readonly helper: WorkspaceHelper
  readonly reference: (taskId: string, path: string) => string
  readonly canRelease: (taskId: string, invocationId: string, path: string) => Promise<boolean>
}) => HostedSystemAgentContents
