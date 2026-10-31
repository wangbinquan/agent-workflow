import type { Agent } from '@agent-workflow/shared'
import type { CanonRepo, MergeBackConflict } from '@/platform/contracts/isolationWorkspace'
import type { MergeConflictManifest } from '@/modules/source-control/public/types'
import type { TaskAgentRunPolicy, RunResult } from './taskAgentRun'
import type { TaskAgentRunFamily, TaskAgentRunScope } from './taskAgentRunFamily'
import type { NodeRunLedger, NodeRunIdentityFactory, Logger } from './executionKernel'

export type { MergeConflictManifest }
export interface MergeConflictRequest {
  readonly conflicts: MergeBackConflict[]
  readonly containerPath: string
  readonly conflictNodeRunId: string
  readonly nodeId: string
  readonly iteration: number
}
export interface MergeConflictResolver {
  resolveMergeConflicts(
    input: MergeConflictRequest,
  ): Promise<{ allResolved: boolean; detail: string }>
}
export type MergeAgentRunInput = Pick<
  TaskAgentRunPolicy,
  | 'taskId'
  | 'nodeRunId'
  | 'nodeId'
  | 'agent'
  | 'triggerContext'
  | 'expandPromptTemplate'
  | 'runtime'
  | 'runtimeParams'
  | 'runtimeConfigDir'
  | 'runtimeObservationIdentity'
  | 'observationSystemKind'
  | 'inputs'
  | 'promptTemplate'
  | 'templateMeta'
  | 'dependents'
  | 'mcps'
  | 'log'
  | 'gitUserName'
  | 'gitUserEmail'
  | 'signal'
  | 'timeoutMs'
>
export type MergeAgentScope = Omit<TaskAgentRunScope, 'taskId' | 'nodeRunId' | 'taskMountRefs'>
export interface MergeConflictPorts {
  readonly facts: {
    readonly taskId: string
    readonly baseBranch: string
    readonly gitUserName: string | null
    readonly gitUserEmail: string | null
    readonly repositories: CanonRepo[]
    readonly repoGroupName: string | null
  }
  readonly runtimeSelection: Parameters<TaskAgentRunFamily['runtimeBindings']['internal']>[0]
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly log: Logger
  readonly runtime: Pick<TaskAgentRunFamily['runtimeBindings'], 'internal' | 'resolve'>
  readonly ledger: Pick<NodeRunLedger, 'mintNodeRun' | 'loadEnvelopeNonce'> & NodeRunIdentityFactory
  readonly template: {
    buildMergeAgent(): Agent
    mergeResolveNodeId(nodeId: string, iteration: number): string
    buildMergeResolvePrompt(input: {
      manifest: MergeConflictManifest
      envelopeNonce: string
    }): string
  }
  readonly agent: {
    resolveSyntheticTaskAgentInjection(agent: Agent):
      | { readonly kind: 'failed'; readonly message: string }
      | {
          readonly kind: 'ok'
          readonly spec: {
            readonly dependents: NonNullable<TaskAgentRunPolicy['dependents']>
            readonly mcps: NonNullable<TaskAgentRunPolicy['mcps']>
            readonly material: MergeAgentScope['material']
          }
        }
    runNode(input: MergeAgentRunInput, scope: MergeAgentScope): Promise<RunResult>
  }
  readonly workspace: {
    resolveIsolatedConflict(
      conflict: MergeBackConflict,
      input: {
        containerPath: string
        runAgent(prompt: string, cwd: string, manifest: MergeConflictManifest): Promise<void>
        log: Logger
      },
    ): Promise<{
      readonly resolved: boolean
      readonly unresolved: readonly { readonly path: string }[]
    }>
  }
  readonly diagnostics: { mergeAgentChildUnreapedError(): Error }
}
