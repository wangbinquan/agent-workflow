import type {
  AgentMaterialContentReference,
  AgentMaterialSeedFile,
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScope,
  SystemAgentWorkspaceScopes,
} from '@/modules/runtime-management/public/participants'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type { Logger } from '@/util/log'
import type {
  PreparedSystemAgentRunResult,
  SystemAgentCoreInvocation,
  SystemAgentRunPolicy,
} from './systemAgentRun'

/** AW's ordinary System declaration; all content/target interpretation is selected. */
export interface SystemAgentRunRequest extends SystemAgentRunPolicy {
  readonly agentName: string
  readonly systemPrompt: string
  readonly prompt: string
  readonly protocol: RuntimeKind
  readonly runtimeBinding?: AgentMaterialContentReference | null
  readonly configDirEnv?: string | null
  readonly configDirName?: string | null
  readonly model?: string | null
  readonly isSandbox?: boolean
  readonly seedFiles?: readonly AgentMaterialSeedFile[]
  readonly workspaceScope: SystemAgentWorkspaceScope
  readonly timeoutMs?: number
  readonly maxEventTextBytes?: number
  readonly log?: Logger
  readonly resumeSessionId?: string
}

/** The same selected owner handles invocation and retained-content release. */
export interface SystemAgentRunFamily {
  readonly workspaces: SystemAgentWorkspaceScopes
  run(request: SystemAgentRunRequest): Promise<PreparedSystemAgentRunResult>
  readonly retainedContents: SystemAgentRetainedContents
}

/** Preparation is opened after the original logger/default/clock read boundary. */
export interface SystemAgentInvocationFamily {
  open(request: SystemAgentRunRequest, log: Logger): SystemAgentCoreInvocation
}
