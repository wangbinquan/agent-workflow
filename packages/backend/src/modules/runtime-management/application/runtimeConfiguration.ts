import { ValidationError } from '@/util/errors'
import type { RuntimeProfileConfigurationCommands } from '../public/commands'

interface RuntimeProfileInspectionQueries {
  getRuntime(name: string): Promise<{ readonly enabled: boolean } | null>
}

/** Preserve config's existing validation-before-invalidation-before-file-write order. */
export function createRuntimeProfileConfigurationCommands(
  registry: RuntimeProfileInspectionQueries &
    Pick<RuntimeProfileConfigurationCommands, 'invalidateInheritedRuntimeProbeReceipts'>,
): RuntimeProfileConfigurationCommands {
  const commands: RuntimeProfileConfigurationCommands = {
    async validateDefaultChange(input) {
      if (input.next === input.previous) return
      const row = await registry.getRuntime(input.next)
      if (row !== null && !row.enabled) {
        throw new ValidationError(
          'runtime-disabled',
          "cannot make disabled runtime '" + input.next + "' the default; enable it first",
        )
      }
    },
    invalidateInheritedRuntimeProbeReceipts: (protocols) =>
      registry.invalidateInheritedRuntimeProbeReceipts(protocols),
  }
  return Object.freeze(commands)
}
