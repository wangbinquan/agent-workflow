// RFC-422 — the native providers the local run family openers receive from other modules (runtime-management,
// source-control, resource-catalog). Each port lists only the members the openers use; the composition passes the
// modules' implementations, which satisfy them structurally. No other module's composition or infrastructure is
// imported here.
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type {
  AgentMaterialContentReference,
  AgentMaterialIntent,
  AgentMaterialSeedFile,
  AgentMaterialWorkspace,
  RuntimeDiagnosticTarget,
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScope,
  SystemAgentWorkspaceScopes,
} from '@/modules/runtime-management/public/participants'
import type { RuntimePlugin } from '@/services/execution/agentInjection'
import type { ResolvedSkill, RuntimeDriver } from '@/services/runtime/types'
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
  skill(reference: NativeMaterialSkill): ResolvedSkill
  plugin(reference: NativeMaterialPlugin): RuntimePlugin
}

/** A runtime's native material definition (runtime-management's local material selection). */
export interface NativeMaterialDefinition {
  readonly protocol: LocalPreparationInput['binding']['protocol']
  readonly evidenceHooks: LocalPreparationInput['binding']['evidenceHooks']
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

/** The native material workspace a smoke or a task run binds (runtime-management). */
export type NativeMaterialWorkspaceRequest =
  | {
      readonly kind: 'task'
      readonly appHome: string
      readonly taskId: string
      readonly nodeRunId: string
      readonly workingDirectory: () => string
    }
  | {
      readonly kind: 'smoke'
      readonly appHome: string
    }

export interface NativeMaterialWorkspace {
  readonly workspace: AgentMaterialWorkspace
  readonly locations: { readonly workingDirectory: string; readonly runDirectory: string }
}

export type NativeMaterialWorkspaces = (
  request: NativeMaterialWorkspaceRequest,
) => NativeMaterialWorkspace

/** The diagnostic targets: a target's runtime binding and the binding's binary. */
export interface NativeDiagnosticTargets extends NativeRuntimeContents {
  runtimeBinding(target: RuntimeDiagnosticTarget): AgentMaterialContentReference
}

/** Binds a runtime driver's protocol for the local invocation adapter. */
export type NativeProtocolBinding = (driver: RuntimeDriver) => NativeMaterialDefinition['protocol']

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
