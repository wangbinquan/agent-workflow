import type { SkillOperationContext, WorkgroupOperationContext } from './participants'
import type {
  DeleteSkillFileCatalogInput,
  DeleteSkillFileCatalogReceipt,
  RestoreSkillVersionCatalogInput,
  RestoreSkillVersionCatalogReceipt,
  WriteSkillFileCatalogInput,
  WriteSkillFileCatalogReceipt,
  WorkgroupTaskAssignmentRef,
  WorkgroupTaskAssignmentSubmission,
  WorkgroupTaskConfigReceipt,
  WorkgroupTaskDecisionReceipt,
  WorkgroupTaskDeliveryReceipt,
  WorkgroupTaskMessageReceipt,
  WorkgroupTaskSubmission,
  WorkgroupTaskWorkflowReceipt,
} from './types'

export interface SkillFileCommands {
  write(
    authority: SkillOperationContext,
    input: WriteSkillFileCatalogInput,
  ): Promise<WriteSkillFileCatalogReceipt>
  delete(
    authority: SkillOperationContext,
    input: DeleteSkillFileCatalogInput,
  ): Promise<DeleteSkillFileCatalogReceipt>
}

export interface SkillVersionCommands {
  restore(
    authority: SkillOperationContext,
    input: RestoreSkillVersionCatalogInput,
  ): Promise<RestoreSkillVersionCatalogReceipt>
}

export interface PluginGenerationGcInput {
  /** The platform runtime owns this coarse active-execution fence. */
  readonly executionFence: 'clear' | 'busy'
  readonly graceMs?: number
  readonly now?: number
}

export interface PluginGenerationGcReceipt {
  readonly removedGenerationPaths: readonly string[]
}

/** Provider-neutral maintenance command; persistence and filesystem stay private. */
export interface PluginGenerationGcCommand {
  run(input: PluginGenerationGcInput): Promise<PluginGenerationGcReceipt>
}

export interface ResourcePackageApplyConvergenceInput {
  /** Process-local apply ids that the recovery sweep must not reap. */
  readonly activeApplyIds: readonly string[]
}

export interface ResourcePackageApplyConvergenceReceipt {
  readonly failed: number
  readonly rolledForward: number
}

/** Provider-neutral recovery command for the durable resource-package journal. */
export interface ResourcePackageApplyMaintenanceCommand {
  converge(
    input: ResourcePackageApplyConvergenceInput,
  ): Promise<ResourcePackageApplyConvergenceReceipt>
}

/** Task-scoped Workgroup mutations; transport parsing and provider clients stay private. */
export interface WorkgroupTaskRoomCommands {
  postMessage(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskMessageReceipt>
  deliverAssignment(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskAssignmentSubmission,
  ): Promise<WorkgroupTaskDeliveryReceipt>
  confirmGate(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskDecisionReceipt>
  confirmDynamicWorkflow(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskDecisionReceipt>
  saveDynamicWorkflow(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskWorkflowReceipt>
  updateConfig(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskConfigReceipt>
  cancelAssignment(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskAssignmentRef,
  ): Promise<void>
}
