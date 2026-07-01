// RFC-029: pure transcoders that map opencode 1.x SDK shapes onto the
// framework's `InventoryAgent` / `InventorySkill` / `InventoryMcp` /
// `InventoryPlugin` shape. The dump plugin (`aw-inventory-dump.mjs`) carries
// a hand-written JS twin of this logic so it can run inside an opencode
// child process without bundling. The grep-lock test
// `inventory-dump-twin-parity.test.ts` keeps the two copies aligned.

import type {
  InventoryAgent,
  InventoryMcp,
  InventoryPlugin,
  InventorySkill,
} from '@agent-workflow/shared'

type Json = Record<string, unknown>

function str(v: unknown, fallback: string): string {
  if (typeof v === 'string') return v
  if (v == null) return fallback
  return String(v)
}

function nullableStr(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v == null) return null
  return String(v)
}

/**
 * opencode `Agent.Info` → framework `InventoryAgent`.
 * Source field mapping (opencode 1.15):
 *   - name: top-level `name`
 *   - mode: top-level `mode` ('primary' | 'subagent' | …)
 *   - model.providerID / model.modelID
 *   - source.type ('inline' | 'project' | 'global' | 'native' | …)
 */
export function transcodeAgent(raw: unknown): InventoryAgent {
  const r = (raw ?? {}) as Json
  const model = (r.model ?? {}) as Json
  const source = (r.source ?? {}) as Json
  return {
    name: str(r.name, '(unnamed)'),
    mode: str(r.mode, 'unknown'),
    modelProviderId: nullableStr(model.providerID ?? r.modelProviderId),
    modelId: nullableStr(model.modelID ?? r.modelId),
    source: str(source.type ?? r.source, 'unknown'),
  }
}

/**
 * opencode `Skill.Info` → framework `InventorySkill`.
 */
export function transcodeSkill(raw: unknown): InventorySkill {
  const r = (raw ?? {}) as Json
  const source = (r.source ?? {}) as Json
  return {
    name: str(r.name, '(unnamed)'),
    source: str(source.type ?? r.source, 'unknown'),
    path: nullableStr(source.path ?? r.path),
    description: nullableStr(r.description),
  }
}

/**
 * opencode `mcp.status()` returns `Record<name, MCP.Status>`. We flatten the
 * map into `InventoryMcp[]` by passing in `name` from the key explicitly.
 * `type` is taken from `config.type` when available; `hint` falls back across
 * `error` → `url` → null so the UI surfaces the most actionable string.
 */
export function transcodeMcp(name: string, raw: unknown): InventoryMcp {
  const r = (raw ?? {}) as Json
  const config = (r.config ?? {}) as Json
  return {
    name,
    type: str(config.type ?? r.type, 'unknown'),
    status: str(r.status, 'unknown'),
    hint: nullableStr(r.error ?? r.url ?? r.hint),
  }
}

/**
 * `ConfigPlugin.Origin` → `InventoryPlugin`. The dump plugin can't import
 * opencode internals (`pluginSpecifier`), so when `origin.spec` is a tuple
 * (`[specStr, options]`) we just stringify it; single-string spec passes
 * through verbatim.
 */
export function transcodePluginOrigin(raw: unknown): InventoryPlugin {
  const r = (raw ?? {}) as Json
  const spec = r.spec
  let specifier: string
  if (typeof spec === 'string') specifier = spec
  else if (Array.isArray(spec) && typeof spec[0] === 'string') specifier = spec[0]
  else if (spec != null) specifier = JSON.stringify(spec)
  else specifier = '(unknown)'
  return { specifier, source: str(r.source, 'unknown') }
}
