// RFC-455：自 `services/pluginOperationRevision.ts` 迁入；intent 的清单经 resource-catalog `public/queries` 取。
import { createHash } from 'node:crypto'
import {
  pluginOperationConfigHashWith,
  type Plugin,
  type PluginOperationResource,
} from '@agent-workflow/shared'

export function pluginOperationConfigHashOf(plugin: Plugin): string {
  return pluginOperationConfigHashWith(plugin, (canonical) =>
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
  )
}

export function withPluginOperationConfigHash(plugin: Plugin): PluginOperationResource {
  return { ...plugin, operationConfigHash: pluginOperationConfigHashOf(plugin) }
}
