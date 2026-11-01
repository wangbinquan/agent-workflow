import type { TaskMechanicsState } from './taskMechanicsState'
import { buildMergeAgent, buildMergeResolvePrompt, mergeResolveNodeId } from '@/services/mergeAgent'
import { resolveSyntheticTaskAgentInjection } from '@/services/execution/taskExecutionResources'
import { runTaskAgentWithFamily } from './taskAgentRunFamily'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import type { MergeConflictPorts } from '../application/ports/mergeConflictResolution'
import { resolveIsolatedConflict } from '../infrastructure/isolationWorkspaceView'
import { mergeAgentChildUnreapedError } from '../infrastructure/executionDiagnostics'
import { nodeRunLedger } from './executionMechanismBindings'

/** Bind capabilities only; runtime resolution, minting and agent construction stay lazy. */
export function bindMergeConflictPorts(state: TaskMechanicsState): MergeConflictPorts {
  return {
    facts: {
      get taskId() {
        return state.task.id
      },
      get baseBranch() {
        return state.task.baseBranch
      },
      get gitUserName() {
        return state.task.gitUserName
      },
      get gitUserEmail() {
        return state.task.gitUserEmail
      },
      get repositories() {
        return state.repos
      },
      get repoGroupName() {
        return state.repoGroupName
      },
    },
    get runtimeSelection() {
      return {
        runtimeName: state.opts.mergeAgentRuntime,
        deprecatedModel: state.opts.mergeAgentModel,
        defaultRuntime: state.opts.defaultRuntime,
      }
    },
    get signal() {
      return state.opts.signal
    },
    get timeoutMs() {
      return state.opts.defaultPerNodeTimeoutMs
    },
    get log() {
      return state.log
    },
    runtime: {
      internal: (input) => state.opts.taskAgentRuns.runtimeBindings.internal(input),
      resolve: (...args) => state.opts.taskAgentRuns.runtimeBindings.resolve(...args),
    },
    ledger: {
      nodeRunMintIdentityForSlot,
      mintNodeRun: (input) => nodeRunLedger(state).mintNodeRun(input),
      loadEnvelopeNonce: (id) => nodeRunLedger(state).loadEnvelopeNonce(id),
    },
    template: { buildMergeAgent, buildMergeResolvePrompt, mergeResolveNodeId },
    agent: {
      resolveSyntheticTaskAgentInjection: (agent) =>
        resolveSyntheticTaskAgentInjection(agent, state.opts.taskAgentRuns.materialReferences),
      runNode: (input, scope) =>
        runTaskAgentWithFamily(
          state.opts.taskAgentRuns,
          {
            ...input,
            observationInvocations: state.opts.observationInvocations,
            memorySnapshots: state.opts.memorySnapshots,
            memoryInjectionQueries: state.opts.memoryInjectionQueries,
            runtimeSessionLeases: state.opts.runtimeSessionLeases,
            runtimeRegistry: state.opts.runtimeRegistry,
            persistence: state.opts.persistence,
          },
          scope,
        ),
    },
    workspace: { resolveIsolatedConflict },
    diagnostics: { mergeAgentChildUnreapedError },
  }
}
