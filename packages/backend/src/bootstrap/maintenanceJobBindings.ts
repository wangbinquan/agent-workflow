import type { AtomicApplyConvergenceReceipt } from '@/platform/contracts/atomicApply'

import type { TokenCallAuditParticipant } from '@/auth/application/tokenCallAudit'
import type { DevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/public/commands'
import type { DigitalEmployeeMaintenanceCommands } from '@/modules/digital-employee/public/commands'
import type { IntegrationMaintenanceCommands } from '@/modules/integration/public/commands'
import type { IntentMaintenanceCommands } from '@/modules/intent/public/commands'
import type { PluginGenerationGcCommand } from '@/modules/resource-catalog/public/commands'
import type { WorkspaceMaintenanceCommand } from '@/modules/source-control/public/commands'

import type { MaintenanceSystemOperations } from '@/modules/system-operations/composition'
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import { createSourceControlMaintenanceJobHandlers } from '@/modules/source-control/composition'
import { createIntegrationMaintenanceJobHandlers } from '@/modules/integration/composition'
import { createDevelopmentAutomationMaintenanceJobHandlers } from '@/modules/development-automation/composition'
import { createDigitalEmployeeMaintenanceJobHandlers } from '@/modules/digital-employee/composition'
import { createIntentMaintenanceJobHandlers } from '@/modules/intent/composition'
import { createResourceCatalogMaintenanceJobHandlers } from '@/modules/resource-catalog/composition'
import { createTaskExecutionMaintenanceJobHandlers } from '@/modules/task-execution/composition'
import { createSystemOperationsMaintenanceJobHandlers } from '@/modules/system-operations/composition'
import { createTokenAuditMaintenanceJobHandlers } from '@/auth/application/maintenanceJobs'

import { runLifecycleInvariants } from '@/services/lifecycleInvariants'
import { runStuckTaskDetector } from '@/services/stuckTaskDetector'
import { runPluginGenerationGc } from '@/services/pluginGenerationGc'

type TaskExecutionMaintenanceCommands = Parameters<
  typeof createTaskExecutionMaintenanceJobHandlers
>[0]

export interface MaintenanceOwnerCommands {
  readonly workspace: WorkspaceMaintenanceCommand
  readonly developmentAutomation: DevelopmentAutomationMaintenanceCommands
  readonly digitalEmployee: DigitalEmployeeMaintenanceCommands
  readonly atomicApply: {
    converge(
      activeByScene: Readonly<Record<'intent' | 'resource-package', readonly string[]>>,
    ): Promise<AtomicApplyConvergenceReceipt>
  }
  readonly intent: IntentMaintenanceCommands
  readonly pluginGenerationGc: {
    readonly command: PluginGenerationGcCommand
    /** Task execution owns the live-node fence; the GC command owns catalog reads. */
    readonly executionFence: () => Promise<'clear' | 'busy'>
  }
  readonly integration: IntegrationMaintenanceCommands
  readonly taskRecovery: TaskExecutionMaintenanceCommands['taskRecovery']
  readonly taskArchive: TaskExecutionMaintenanceCommands['taskArchive']
  readonly tokenAudit: Pick<TokenCallAuditParticipant, 'pruneSlice'>
  readonly system: MaintenanceSystemOperations
}

export function composeMaintenanceJobBindings(
  commands: MaintenanceOwnerCommands,
): MaintenanceJobHandlers {
  return Object.freeze({
    ...createSourceControlMaintenanceJobHandlers(commands.workspace),
    ...createIntegrationMaintenanceJobHandlers(commands.integration),
    ...createDevelopmentAutomationMaintenanceJobHandlers(commands.developmentAutomation),
    ...createDigitalEmployeeMaintenanceJobHandlers(commands.digitalEmployee),
    ...createIntentMaintenanceJobHandlers(commands.intent, commands.atomicApply),
    ...createResourceCatalogMaintenanceJobHandlers(
      commands.pluginGenerationGc,
      runPluginGenerationGc,
    ),
    ...createTaskExecutionMaintenanceJobHandlers(
      {
        taskRecovery: commands.taskRecovery,
        taskArchive: commands.taskArchive,
      },
      { runLifecycleInvariants, runStuckTaskDetector },
    ),
    ...createSystemOperationsMaintenanceJobHandlers(commands.system),
    ...createTokenAuditMaintenanceJobHandlers(commands.tokenAudit),
  })
}
