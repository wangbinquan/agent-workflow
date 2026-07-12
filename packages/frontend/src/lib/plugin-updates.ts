// RFC-169 (T17) — plugin update-check results lifted from the list page's local
// useState into a shared query cache so the detail "Updates" tab can write a
// check result and the list card can read it.
//
// The cache is a dictionary keyed by plugin id. Each entry carries an INPUT
// FINGERPRINT (spec + resolvedVersion): a plugin's spec can be edited and
// re-installed, moving resolvedVersion, so a stale entry must not light up the
// "update available" chip for a plugin that has since changed. Consumers verify
// the fingerprint before trusting an entry.

export const PLUGIN_UPDATES_KEY = ['plugins', 'updates'] as const

export interface PluginUpdateEntry {
  /** Input fingerprint — the spec the check ran against. */
  spec: string
  /** Input fingerprint — the resolvedVersion at check time. */
  resolvedVersion: string | null
  /** The latest available version the check reported (null = up to date / unknown). */
  latest: string | null
}

export type PluginUpdatesCache = Record<string, PluginUpdateEntry>

interface PluginFingerprint {
  spec: string
  resolvedVersion: string | null
}

/** Does a cached entry still describe THIS plugin row (spec + resolvedVersion)? */
export function pluginUpdateMatches(
  entry: PluginUpdateEntry | undefined,
  plugin: PluginFingerprint,
): boolean {
  return (
    entry !== undefined &&
    entry.spec === plugin.spec &&
    entry.resolvedVersion === plugin.resolvedVersion
  )
}

/** A fingerprint-matching entry whose latest differs from the installed version. */
export function pluginUpdateAvailable(
  entry: PluginUpdateEntry | undefined,
  plugin: PluginFingerprint,
): boolean {
  return (
    pluginUpdateMatches(entry, plugin) &&
    entry!.latest !== null &&
    entry!.latest !== plugin.resolvedVersion
  )
}

/** Drop entries whose fingerprint no longer matches the current rows (called
 *  after save / upgrade / delete so a changed plugin doesn't keep a stale chip). */
export function pruneStalePluginUpdates(
  cache: PluginUpdatesCache | undefined,
  plugins: Array<{ id: string } & PluginFingerprint>,
): PluginUpdatesCache {
  if (cache === undefined) return {}
  const byId = new Map(plugins.map((p) => [p.id, p]))
  const next: PluginUpdatesCache = {}
  for (const [id, entry] of Object.entries(cache)) {
    const p = byId.get(id)
    if (p !== undefined && pluginUpdateMatches(entry, p)) next[id] = entry
  }
  return next
}
