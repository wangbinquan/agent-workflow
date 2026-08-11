// RFC-143 PR-4 — the OPENCODE_CONFIG_CONTENT inline-config assembly, moved
// VERBATIM out of runner.ts so the opencode driver's `buildBusinessSpawn` can
// import it without a module-init cycle (driver ← runner would loop through
// runtime/index). Behavior is byte-identical — the runner-* inline-config tests
// (runner-build-inline-config-multi / runner-mcp-inject / runner-permission-
// inject / runner-plugin-inject / mcp-end-to-end) lock the move; runner.ts
// re-exports this surface so existing import sites keep resolving.
//
// RFC-280 T1: the per-entry transforms (`buildInlineAgentEntry` /
// `buildInlineMcpEntry`) and the enabled/duplicate partition now live in the
// unified injection layer (`services/execution/agentInjection.ts`) — single
// implementation for every spawn path. This module keeps the opencode
// inline-config COMPOSITION (agent map + mcp record + plugin array) and
// re-exports the old names so existing import sites keep resolving.
// NOTE: the returned object is `JSON.stringify`-ed straight into
// OPENCODE_CONFIG_CONTENT — never add platform-side fields (e.g. the declared
// manifest) to it; callers that need the manifest call
// `renderOpencodeMcpInjection` directly.
//
// Leaf module: imports shared types + the unified injection layer (itself a
// leaf) → no runtime edge back into runner/runtimeRegistry.

import type { Agent, Mcp, Plugin } from '@agent-workflow/shared'
import type { RuntimeProfile } from '@/services/runtimeRegistry'
import {
  renderOpencodeAgentEntry,
  renderOpencodeMcpInjection,
} from '@/services/execution/agentInjection'
import { buildPluginSpecArray } from './pluginSpec'
import { composeOpencodeBoundary, type BoundaryCtx } from '@/services/execution/workspaceBoundary'

export {
  EMPTY_RUNTIME_PROFILE,
  renderOpencodeAgentEntry as buildInlineAgentEntry,
  renderOpencodeMcpEntry as buildInlineMcpEntry,
} from '@/services/execution/agentInjection'

export function buildInlineConfig(
  agent: Agent,
  // RFC-113: resolved runtime profile per agent name (root + each dependent).
  // Missing → EMPTY_RUNTIME_PROFILE (omit all params).
  paramsByAgent: ReadonlyMap<string, RuntimeProfile>,
  dependents: readonly Agent[],
  mcps: readonly Mcp[] = [],
  plugins: readonly Plugin[] = [],
  // RFC-281 T1: task workspace boundary. When provided, EVERY agent entry's
  // permission is re-composed through `composeOpencodeBoundary` (deny baseline
  // + W(run) re-allow, author keys preserved, external_directory appended AFTER
  // the author's `'*'` so it cannot be dissolved — see workspaceBoundary.ts and
  // design §3.1/§5-9). A top-level `config.permission` is ALSO emitted to cover
  // opencode's NATIVE subagents (general/explore), which have no platform entry
  // and would otherwise inherit only opencode's `external_directory: ask`.
  // Omitted → byte-identical to pre-RFC-281 (no boundary); every existing caller
  // and inline-config test is unaffected.
  boundaryCtx?: BoundaryCtx,
): {
  agent: Record<string, Record<string, unknown>>
  mcp?: Record<string, Record<string, unknown>>
  /**
   * RFC-031: opencode `config.plugin` is an array of `Spec` values. Each
   * element is either a bare `file://<path>` string or a `[file://..., options]`
   * tuple when the plugin record carries non-empty options. We NEVER inject
   * the raw user-supplied spec — opencode would re-resolve it through npm,
   * defeating the eager-install + cache contract.
   */
  plugin?: Array<string | [string, Record<string, unknown>]>
  /** RFC-281 T1: top-level external_directory boundary for native subagents. */
  permission?: { external_directory: Record<string, unknown> }
} {
  // RFC-281 T1: render the entry, then (only under a boundary) overwrite its
  // permission with the boundary-composed map. The author's permission is the
  // input; the platform baseline lands AFTER the author's keys.
  const entryFor = (a: Agent): Record<string, unknown> => {
    const entry = renderOpencodeAgentEntry(a, paramsByAgent.get(a.name))
    if (boundaryCtx === undefined) return entry
    return { ...entry, permission: composeOpencodeBoundary(a.permission, boundaryCtx) }
  }
  const map: Record<string, Record<string, unknown>> = { [agent.name]: entryFor(agent) }
  for (const dep of dependents) {
    if (dep.name === agent.name) continue // root would shadow itself; defensive
    // Resource names are external registry keys. `constructor` is a valid
    // platform name, so prototype lookup on `{}` would mistake it for an
    // existing entry and silently drop the managed dependent.
    if (Object.hasOwn(map, dep.name)) continue // closure already deduped, but guard anyway
    map[dep.name] = entryFor(dep)
  }
  const out: {
    agent: Record<string, Record<string, unknown>>
    mcp?: Record<string, Record<string, unknown>>
    plugin?: Array<string | [string, Record<string, unknown>]>
    permission?: { external_directory: Record<string, unknown> }
  } = { agent: map }
  // RFC-028: emit the mcp record only when at least one ENABLED entry exists.
  // Disabled entries are skipped to keep the env-var compact AND to avoid
  // masking a same-name inherited entry from repo .opencode/config.json
  // — leaving inherited config alone is the v1 stance (docs/OPENCODE_CONFIG.md §6).
  // RFC-280 T1: the partition/render live in the unified injection layer;
  // duplicate-name-with-different-id now throws there (design-gate P1-1)
  // instead of silently keeping the first — the scheduler's exact-identity
  // fence already blocks that upstream, this is the defensive assert.
  const mcpRender = renderOpencodeMcpInjection(mcps)
  if (mcpRender.entries !== null) out.mcp = mcpRender.entries
  // RFC-031: emit the plugin array only when at least one ENABLED entry
  // resolves. RFC-251 moved the encoding rules to `pluginSpec.ts` so all
  // OpenCode assembly paths share one implementation.
  const pluginArr = buildPluginSpecArray(plugins)
  if (pluginArr.length > 0) out.plugin = pluginArr
  // RFC-281 T1: top-level boundary — same external_directory synthesis with no
  // author (undefined), so opencode's native subagents inherit the deny baseline
  // + re-allow instead of the upstream `ask` (which `--auto` would auto-approve).
  if (boundaryCtx !== undefined) {
    const top = composeOpencodeBoundary(undefined, boundaryCtx)
    out.permission = { external_directory: top['external_directory'] as Record<string, unknown> }
  }
  return out
}
