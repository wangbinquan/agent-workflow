import type { Plugin } from '@agent-workflow/shared'

/**
 * RFC-487: the native skill and plugin content records Resource Catalog produces for a task agent's local material
 * compiler (managed skill files under this module's storage layout, the skill revision, the plugin locator). Declared
 * here because Resource Catalog is their producer; the runtime drivers and Task Execution's local run options consume
 * them through this module's `public/types`. Moved from `services/runtime/types.ts` and
 * `services/execution/agentInjection.ts`: `SkillSource` and `RuntimePlugin` verbatim (the family re-exports them);
 * the skill record without the driver-side `readContentVersion` re-read, which runtime-management's local compiler
 * adds (`ResolvedSkill extends NativeSkillContent` in the family) — a public contract carries data, not behaviour.
 */

/** Where an injected skill comes from (RFC-004; moved here from runner.ts so
 *  drivers can type their skill inputs without a runner import — RFC-143 PR-4;
 *  runner re-exports both for existing import sites). RFC-178: skills are
 *  managed-only; `project` = a repo-local skill the CLI self-discovers. */
export type SkillSource = 'managed' | 'project'

export interface NativeSkillContent {
  name: string
  sourceKind: SkillSource
  /** Absolute path for managed. Unused for project (self-discovered). */
  sourcePath?: string
  /** Managed resource identity and revision used for dispatch fencing. */
  skillId?: string
  contentVersion?: number
}

/**
 * Runtime-only plugin projection. Persistence may provide the historical
 * cached path while Resource Catalog provides an already-normalized file
 * specifier; spawn assembly consumes exactly one locator and never a row.
 */
export type RuntimePlugin = Pick<Plugin, 'id' | 'name' | 'options' | 'enabled'> &
  (
    | { readonly cachedPath: string; readonly runtimeSpecifier?: never }
    | { readonly runtimeSpecifier: string; readonly cachedPath?: never }
  )
