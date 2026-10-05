import { pluginFileSpec } from '@/services/runtime'
import type { RuntimePlugin } from '@/services/execution/agentInjection'

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// RFC-154: `prepareSkills` (the opencode-blind skill-staging preamble) moved to
// ./runtime/stageSkills.ts — each driver now stages into ITS OWN config dir
// inside buildBusinessSpawn (opencode strict, claude best-effort).

/**
 * RFC-031 — substring-scan a stderr line for opencode plugin-load error
 * patterns (see opencode/packages/opencode/src/plugin/index.ts:170-209 for
 * the producer side). Returns `{ pluginName, message }` when matched and
 * `null` otherwise.
 *
 * `pluginName` is best-effort: we try to map back from the file://<cached>
 * path embedded in the spec to the plugin record's `name`. When the line
 * mentions a different path or the lookup fails, we return an empty string
 * so the UI still renders the message (truncated stderr) with a generic
 * "unknown plugin" label.
 */
export function detectPluginLoadFailure(
  line: string,
  plugins: readonly RuntimePlugin[],
): { pluginName: string; message: string } | null {
  // opencode log lines pass through a structured logger; the human-readable
  // tail of the line (after `INFO`/`ERROR`/etc.) starts with the message we
  // emitted via `publishPluginError`. Match against the publish strings.
  const PATTERNS = [
    /Failed to load plugin (\S+):\s*(.*)$/,
    /Failed to install plugin (\S+):\s*(.*)$/,
    /Plugin (\S+) skipped:\s*(.*)$/,
  ]
  let spec: string | null = null
  let message = ''
  for (const re of PATTERNS) {
    const m = re.exec(line)
    if (m !== null) {
      spec = m[1] ?? null
      message = (m[2] ?? '').trim()
      break
    }
  }
  if (spec === null) return null
  // Try to map a file:// spec back to a plugin record by suffix.
  let pluginName = ''
  if (spec.startsWith('file://')) {
    const path = spec.replace(/^file:\/\//, '')
    for (const p of plugins) {
      const cached = pluginFileSpec(p).replace(/^file:\/\//, '')
      if (path === cached || path.endsWith(cached) || cached.endsWith(path)) {
        pluginName = p.name
        break
      }
    }
  } else {
    // Non-file diagnostics are defensive only: runtime assembly always emits
    // the normalized file locator, so the closed projection need not expose
    // the persistence-side source spec.
    for (const p of plugins) {
      if (p.name === spec) {
        pluginName = p.name
        break
      }
    }
  }
  return { pluginName, message: message.length > 0 ? message : spec }
}
