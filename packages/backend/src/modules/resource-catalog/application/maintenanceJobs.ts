// RFC-399 B1: owner-owned maintenance bodies; slicing and result projection are unchanged.
import type { PluginGenerationGcCommand } from '../public/commands'
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'

export type PluginGenerationGcRunner = (input: {
  readonly command: PluginGenerationGcCommand
  readonly executionFence: 'clear' | 'busy'
}) => Promise<readonly string[]>

const NONE: MaintenanceWorkerDelta = { kind: 'none' }

export function createResourceCatalogMaintenanceJobHandlers(
  pluginGenerationGc: {
    readonly command: PluginGenerationGcCommand
    readonly executionFence: () => Promise<'clear' | 'busy'>
  },
  runPluginGenerationGc: PluginGenerationGcRunner,
): Pick<MaintenanceJobHandlers, 'pluginGenerationGc'> {
  return {
    async pluginGenerationGc(input) {
      parseMaintenanceJobPayload('pluginGenerationGc', input.payload)
      const removed = await runPluginGenerationGc({
        command: pluginGenerationGc.command,
        executionFence: await pluginGenerationGc.executionFence(),
      })
      return { counters: { removed: removed.length }, delta: NONE }
    },
  }
}
