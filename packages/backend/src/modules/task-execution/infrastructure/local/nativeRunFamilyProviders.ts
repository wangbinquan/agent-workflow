// RFC-422 — the native providers the local run family openers receive from other modules (runtime-management,
// source-control, resource-catalog). Each port lists only the members the openers use; the composition passes the
// modules' implementations, which satisfy them structurally. No other module's composition or infrastructure is
// imported here.
// RFC-491: the native system-agent run and the local MCP diagnostic read the runtime's driver through
// `NativeRuntimeDriver`; the local task agent family reads plugin-load failures through `NativePluginLoadFailures`. No
// runtime driver family module is imported here.
import type { InventorySnapshot, Mcp, RuntimeConfigDirProfile } from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import type { RuntimeKind, RuntimeProfile } from '@/modules/runtime-management/public/types'
import type {
  AgentMaterialContentReference,
  AgentMaterialIntent,
  AgentMaterialSeedFile,
  AgentMaterialWorkspace,
  RuntimeDiagnosticTarget,
  RuntimeDriverCapabilities,
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScope,
  SystemAgentWorkspaceScopes,
} from '@/modules/runtime-management/public/participants'
import type { NativeSkillContent, RuntimePlugin } from '@/modules/resource-catalog/public/types'
import type { NativeAgentCompiledPlan } from './agentInvocation'
import type { createLocalAgentInvocationPreparation } from './agentInvocationPreparation'
import type { TaskAgentRunFamily } from '../../application/ports/taskAgentRunFamily'
import type { TaskAgentRunPurpose } from '../../application/ports/taskAgentMaterial'

type LocalPreparationInput = Parameters<typeof createLocalAgentInvocationPreparation>[0]

export type NativeMaterialSkill = NonNullable<AgentMaterialIntent['injection']['skills']>[number]
export type NativeMaterialPlugin = NonNullable<AgentMaterialIntent['injection']['plugins']>[number]

/** What a native material compiler reads for one owner-bound content scope. */
export interface NativeMaterialContents {
  workspace(reference: AgentMaterialContentReference): string
  runContent(reference: AgentMaterialContentReference): string
  runtimeBinary(reference: AgentMaterialContentReference): string
  skill(reference: NativeMaterialSkill): NativeSkillContent
  plugin(reference: NativeMaterialPlugin): RuntimePlugin
}

/** A runtime's native material definition (runtime-management's local material selection). */
export interface NativeMaterialDefinition {
  readonly protocol: LocalPreparationInput['binding']['protocol']
  /** RFC-489: a run's evidence over the runtime's own hooks (the run gives its scope). */
  readonly evidence: LocalPreparationInput['binding']['evidence']
  /** RFC-489: a native plan's material reference. RFC-491: a wrapped plan given its source plan takes the source's. */
  readonly materialReference: (plan: object, sourcePlan?: object) => string
  createCompiler(
    contents: NativeMaterialContents,
    fixture?: { readonly binaryOverride?: readonly string[] },
  ): LocalPreparationInput['material']
}

/** Selects the native material definition of one runtime kind. */
export type NativeMaterialDefinitions = (kind: RuntimeKind) => NativeMaterialDefinition

/** The runtime bindings' content reader (a runtime binding reference resolves to its binary). */
export interface NativeRuntimeContents {
  readonly contents: { runtimeBinary(reference: AgentMaterialContentReference): string }
}

/** The system agent retained contents (runtime-management's native scratch workspaces). */
export interface NativeSystemAgentContents {
  readonly workspaces: SystemAgentWorkspaceScopes
  readonly contents: SystemAgentRetainedContents
  open(request: {
    readonly scope: SystemAgentWorkspaceScope
    readonly feature: () => string
    readonly seedFiles: () => readonly AgentMaterialSeedFile[] | undefined
  }): {
    readonly workspace: AgentMaterialWorkspace
    readonly locations: { readonly workingDirectory: string; readonly runDirectory: string }
  }
  parent(scope: SystemAgentWorkspaceScope): string
  bindFixtureRetainedResult(reference: string, root: string): void
}

/** The native material workspace a smoke, a task run or (RFC-491) a native system agent run binds (runtime-management). */
export type NativeMaterialWorkspaceRequest =
  | {
      readonly kind: 'task'
      readonly appHome: string
      readonly taskId: string
      readonly nodeRunId: string
      readonly workingDirectory: () => string
    }
  | {
      readonly kind: 'system'
      readonly parent: () => string
      readonly feature: () => string
      readonly scratchName: () => string | undefined
      readonly seedFiles?: () => readonly AgentMaterialSeedFile[] | undefined
    }
  | {
      readonly kind: 'smoke'
      readonly appHome: string
    }

export interface NativeMaterialWorkspace {
  readonly workspace: AgentMaterialWorkspace
  readonly locations: {
    /** RFC-491: the workspace root (a native system agent run's scratch directory). */
    readonly root: string
    readonly workingDirectory: string
    readonly runDirectory: string
  }
}

export type NativeMaterialWorkspaces = (
  request: NativeMaterialWorkspaceRequest,
) => NativeMaterialWorkspace

/** The diagnostic targets: a target's runtime binding and the binding's binary. */
export interface NativeDiagnosticTargets extends NativeRuntimeContents {
  runtimeBinding(target: RuntimeDiagnosticTarget): AgentMaterialContentReference
}

/** The task agent runtime bindings (runtime-management): the bindings the family exposes and the binary reader. */
export interface NativeTaskAgentRuntimes extends NativeRuntimeContents {
  readonly bindings: TaskAgentRunFamily['runtimeBindings']
}

/** The task agent material references (resource-catalog): the references the family exposes and the native contents. */
export interface NativeTaskAgentMaterialReferences {
  readonly references: TaskAgentRunFamily['materialReferences']
  readonly contents: Pick<NativeMaterialContents, 'skill' | 'plugin'>
}

/** One task agent run's workspace contents (source-control). */
export interface NativeTaskAgentWorkspaceContents {
  bindWorking(reference: AgentMaterialContentReference): void
  workingDirectory(reference: string): string
  workspace(reference: AgentMaterialContentReference): string
  prepareMounts(): readonly AgentMaterialContentReference[]
}

export type NativeTaskAgentWorkspaceContentsFactory = (input: {
  workspaceRef(): string
  taskMountRefs(): readonly string[]
}) => NativeTaskAgentWorkspaceContents

/** Observes a task workspace's git control plane (source-control). */
export type NativeGitControlObservation = (input: {
  readonly workingDirectory: () => string
}) => TaskAgentRunPurpose['gitControlObservation']

/** RFC-491: one native assembly request as the native system-agent run and the local MCP diagnostic write it (the
 * runtime driver's spawn context accepts it). */
export interface NativeSpawnRequest {
  readonly injection: { readonly mcps: readonly Mcp[] }
  readonly prompt: string
  readonly agentName: string
  readonly systemPrompt: string
  readonly resolvedParamsByAgent: ReadonlyMap<string, RuntimeProfile>
  readonly cwd: string
  readonly runRoot: string
  readonly configDir?: RuntimeConfigDirProfile
  readonly freshAgentRun: boolean
  readonly nativeSessionId?: string | null
  readonly resumeSessionId?: string | null
  readonly runtimeBinary?: string | null
  readonly binaryOverride?: readonly string[]
  readonly nodeRunId: string
  readonly log: Logger
}

/** RFC-491: the members of a runtime's native driver the native system-agent run and the local MCP diagnostic read
 * (runtime-management's registered driver, selected by bootstrap's binding). */
export interface NativeRuntimeDriver {
  readonly capabilities: RuntimeDriverCapabilities
  buildSpawn(request: NativeSpawnRequest): Promise<NativeAgentCompiledPlan>
  defaultBinary(config: {
    readonly opencodePath?: string | null
    readonly claudeCodePath?: string | null
  }): string[]
  readInventory?(input: { runRoot: string; nodeKind: string }): Promise<InventorySnapshot | null>
  createMcpTestNativeSessionId?(): string | null
  mcpTestSessionReference?(input: { turnSeq: number; nativeSessionId: string | null }): {
    nativeSessionId?: string
    resumeSessionId?: string
  }
}

/** RFC-491: selects one runtime kind's native driver. */
export type NativeRuntimeDrivers = (kind: RuntimeKind) => NativeRuntimeDriver

/** RFC-491: one stderr line's plugin-load failure, mapped back to a plugin of the run (runtime-management's knowledge). */
export type NativePluginLoadFailures = (
  line: string,
  plugins: readonly RuntimePlugin[],
) => { pluginName: string; message: string } | null
