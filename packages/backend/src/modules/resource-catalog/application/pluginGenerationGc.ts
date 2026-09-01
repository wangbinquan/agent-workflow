import type {
  PluginGenerationGcCommand,
  PluginGenerationGcInput,
  PluginGenerationGcReceipt,
} from '../public/commands'
import type {
  PluginGenerationFilesystemGcPort,
  PluginGenerationReferenceReadPort,
} from './ports/pluginGenerationGc'

export function createPluginGenerationGcCommand(input: {
  readonly references: PluginGenerationReferenceReadPort
  readonly filesystem: PluginGenerationFilesystemGcPort
}): PluginGenerationGcCommand {
  return Object.freeze({
    async run(command: PluginGenerationGcInput): Promise<PluginGenerationGcReceipt> {
      if (command.executionFence === 'busy' || !(await input.filesystem.hasCandidates())) {
        return Object.freeze({ removedGenerationPaths: Object.freeze([]) })
      }
      const referencedCachedPaths = new Set(await input.references.listReferencedCachedPaths())
      const removedGenerationPaths = await input.filesystem.collect({
        referencedCachedPaths,
        ...(command.graceMs === undefined ? {} : { graceMs: command.graceMs }),
        ...(command.now === undefined ? {} : { now: command.now }),
      })
      return Object.freeze({ removedGenerationPaths: Object.freeze([...removedGenerationPaths]) })
    },
  })
}
