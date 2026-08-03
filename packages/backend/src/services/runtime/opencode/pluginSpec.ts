// RFC-251 — single source of truth for turning a platform `plugins` selection
// into opencode's `config.plugin` array.
//
// Why this module exists: RFC-031 built these rules inline for the legacy spawn
// path (inlineConfig.ts). RFC-251 restores plugin support on the *verified*
// path, whose controlled config is assembled independently (hermetic.ts). Two
// copies would drift, and drift here fails SILENTLY — opencode would just load
// a different plugin set than the operator selected, with no error anywhere.
//
// Leaf module: a shared type import only, so both assemblers can depend on it
// without creating a runtime edge between them.

import type { Plugin } from '@agent-workflow/shared'

/**
 * One element of opencode's `config.plugin`: either a bare `file://<path>`
 * string, or a `[file://<path>, options]` tuple when the record carries
 * non-empty options.
 */
export type PluginSpec = string | [string, Record<string, unknown>]

/**
 * RFC-031 encoding rules, unchanged:
 *
 *  - `enabled === false` rows are skipped entirely — a disabled plugin must not
 *    reach opencode at all.
 *  - dedupe by canonical plugin **id** (RFC-223 PR-6): a `dependsOn` closure can
 *    reach the same row through several agents, while two distinct rows sharing
 *    a display name must both survive.
 *  - always emit `file://<cachedPath>`, NEVER the user-supplied spec — opencode
 *    would otherwise re-resolve it through npm, defeating the eager-install +
 *    cache contract and breaking the zero-network spawn guarantee.
 *
 * Returns [] when nothing resolves; callers omit the `plugin` key entirely in
 * that case rather than emitting an empty array.
 */
export function buildPluginSpecArray(plugins: readonly Plugin[]): PluginSpec[] {
  return selectShippedPlugins(plugins).map((p) => {
    const pathSpec = pluginFileSpec(p)
    const opts = p.options && Object.keys(p.options).length > 0 ? p.options : undefined
    return opts === undefined ? pathSpec : [pathSpec, opts]
  })
}

/**
 * The plugin records that actually reach OpenCode, in emission order — the
 * single source of the enabled-filter and id-dedupe rules.
 *
 * RFC-251: inventory/diagnostics must describe exactly this set. Deriving them
 * from the raw selection instead would drift the moment a row is disabled or
 * reached twice through the closure.
 */
export function selectShippedPlugins(plugins: readonly Plugin[]): Plugin[] {
  const shipped: Plugin[] = []
  const seen = new Set<string>()
  for (const p of plugins) {
    if (p.enabled === false) continue
    if (seen.has(p.id)) continue
    seen.add(p.id)
    shipped.push(p)
  }
  return shipped
}

/** The sealed `file://` specifier — never the user-supplied npm/git spec. */
export function pluginFileSpec(plugin: Plugin): string {
  return plugin.cachedPath.startsWith('file://') ? plugin.cachedPath : `file://${plugin.cachedPath}`
}
