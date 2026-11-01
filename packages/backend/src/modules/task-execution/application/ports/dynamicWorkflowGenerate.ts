// RFC-410 — the ports of the dynamic-workflow generation engine (engine/task/dynamicWorkflowGenerate.ts).
// Only task-execution and shared types: the catalog validator arrives as a loaded function, never as the
// resource catalog's inventory type.
import type {
  TriggerDependencyIssue,
  TriggerDependencySource,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import type { GeneratedWorkflowLayerOneValidator } from '../../domain/dynamicWorkflowGeneration'
import type { DynamicWorkflowPersistence } from './dynamicWorkflowPersistence'
import type { Logger } from './executionKernel'
import type { NodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import type { WorkgroupTurnHostOperations } from './workgroupTurnsOperations'

/** Loads the generic validator over the current catalog inventory; one load per generation pass. */
export interface DynamicWorkflowLayerOneValidation {
  load(): Promise<GeneratedWorkflowLayerOneValidator>
}

export interface DynamicWorkflowGeneratePorts {
  /** The `dw` checkpoint, the frozen pool's agents and the confirm-gate holder lookup. */
  readonly persistence: DynamicWorkflowPersistence
  /** Orchestrator and confirm-gate run minting, transitions and the envelope nonce. */
  readonly nodeRuns: NodeRunLifecyclePersistence
  readonly validation: DynamicWorkflowLayerOneValidation
  readonly rules: {
    triggerPreflightIssue(args: {
      root: WorkflowDefinition
      closureJson: string | null
      source: TriggerDependencySource
    }): TriggerDependencyIssue | null
  }
  /** The workgroup host lane that runs the orchestrator agent (same hooks as the turn engine). */
  readonly host: WorkgroupTurnHostOperations
}

export interface DynamicWorkflowGenerateArgs {
  readonly taskId: string
  readonly log: Logger
  readonly signal?: AbortSignal
}
