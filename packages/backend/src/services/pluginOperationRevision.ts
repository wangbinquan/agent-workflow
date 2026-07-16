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
