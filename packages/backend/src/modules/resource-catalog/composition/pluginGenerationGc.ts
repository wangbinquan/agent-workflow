import type { ProviderNeutralDatabase } from '@/db/query'
import { createPluginGenerationGcCommand } from '../application/pluginGenerationGc'
import type { PluginGenerationFilesystemGcPort } from '../application/ports/pluginGenerationGc'
import type { PluginGenerationGcCommand } from '../public/commands'
import { createPluginGenerationReferenceReadPort } from '../infrastructure/pluginGenerationGc'

/** RFC-359 W4-D17 —— 插件代际清扫命令一份装配（此前 SQLite / PG 各一份只做绑定的具名装配）。 */
export function composePluginGenerationGcCommand(
  db: ProviderNeutralDatabase,
  filesystem: PluginGenerationFilesystemGcPort,
): PluginGenerationGcCommand {
  return createPluginGenerationGcCommand({
    references: createPluginGenerationReferenceReadPort(db),
    filesystem,
  })
}
