// RFC-201 — Plugin Check receipts are scoped to one exact saved-resource hash.

export const PLUGIN_UPDATES_KEY = ['plugins', 'updates'] as const

export interface PluginUpdateEntry {
  configHashUsed: string
  available: boolean
  latest: string | null
  identityStatus: 'known' | 'unknown'
}

export type PluginUpdatesCache = Record<string, PluginUpdateEntry>

interface PluginFingerprint {
  id: string
  operationConfigHash: string
}

export function pluginUpdateCacheKey(id: string, operationConfigHash: string): string {
  return `${id}:${operationConfigHash}`
}

export function pluginUpdateEntry(
  cache: PluginUpdatesCache,
  plugin: PluginFingerprint,
): PluginUpdateEntry | undefined {
  return cache[pluginUpdateCacheKey(plugin.id, plugin.operationConfigHash)]
}

export function pluginUpdateMatches(
  entry: PluginUpdateEntry | undefined,
  plugin: PluginFingerprint,
): boolean {
  return entry !== undefined && entry.configHashUsed === plugin.operationConfigHash
}

export function pluginUpdateAvailable(
  entry: PluginUpdateEntry | undefined,
  plugin: PluginFingerprint,
): boolean {
  return pluginUpdateMatches(entry, plugin) && entry!.identityStatus === 'known' && entry!.available
}

export function pruneStalePluginUpdates(
  cache: PluginUpdatesCache | undefined,
  plugins: PluginFingerprint[],
): PluginUpdatesCache {
  if (cache === undefined) return {}
  const allowed = new Set(
    plugins.map((plugin) => pluginUpdateCacheKey(plugin.id, plugin.operationConfigHash)),
  )
  return Object.fromEntries(Object.entries(cache).filter(([key]) => allowed.has(key)))
}
