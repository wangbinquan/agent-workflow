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
  const specs: PluginSpec[] = []
  const seen = new Set<string>()
  for (const p of plugins) {
    if (p.enabled === false) continue
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const pathSpec = p.cachedPath.startsWith('file://') ? p.cachedPath : `file://${p.cachedPath}`
    const opts = p.options && Object.keys(p.options).length > 0 ? p.options : undefined
    specs.push(opts === undefined ? pathSpec : [pathSpec, opts])
  }
  return specs
}
