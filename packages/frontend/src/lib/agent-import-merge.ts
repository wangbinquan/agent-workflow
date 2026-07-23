// Merges an AgentImportDialog parser result into the current AgentForm draft.
// RFC-018 T2. Pure function — covered by agent-import-merge.test.tsx.
//
// Rules:
//  - any key with `partial[key] !== undefined` overwrites current[key]
//  - `frontmatterExtra` is shallow-merged (imported keys overwrite same-name
//    current keys; current-only keys are preserved)
//  - RFC-194 routes inputs / outputs / outputKinds / role /
//    outputWrapperPortNames as first-class fields; omitted fields (e.g.
//    syncOutputsOnIterate) preserve the current value as-is
//  - RFC-223 (PR-1, Codex impl-gate P1-1): `skills` is parsed as PORTABLE
//    name-based selectors (`result.skillSelectors`), NOT persisted refs. The
//    merge converts them to `AgentSkillRef`s here: a `project` selector → a
//    `project` ref; a `managed` selector → a `managed` ref carrying the raw NAME
//    in `skillId` (never demoted to `project`), which the server then resolves to
//    a canonical id against the actor's ACL-visible set (or keeps as an unresolved
//    managed ref — a missing managed skill is never silently turned into a
//    repo-local skill). The picker's own refs already carry ids, unaffected.

import type {
  AgentMarkdownParseResult,
  AgentSkillRef,
  CreateAgent,
  ResolveAgentImportRefsResult,
} from '@agent-workflow/shared'
import { skillSelectorToRef } from '@agent-workflow/shared'
import type { OrphanSidecarRef } from './agent-ports'

const hasOwn = (record: object | undefined, key: string): boolean =>
  record !== undefined && Object.prototype.hasOwnProperty.call(record, key)

/**
 * RFC-223 (PR-1): the skill refs an import would apply, or undefined when the
 * source declared no `skills:`. Managed selectors keep their NAME in `skillId`
 * (server resolves + ACL-checks); the offline merge has no DB to mint an id.
 */
function importedSkillRefs(result: AgentMarkdownParseResult): AgentSkillRef[] | undefined {
  if (result.skillSelectors === undefined) return undefined
  return result.skillSelectors.map((sel) => skillSelectorToRef(sel, () => undefined))
}

/**
 * Importing only `outputs` must not turn a previously orphaned, omitted
 * sidecar into a live mapping. The dialog uses this to require an explicit
 * cleanup (or an import that explicitly replaces that sidecar map) first.
 */
export function importOrphanSidecarConflicts(
  current: CreateAgent,
  result: AgentMarkdownParseResult,
): OrphanSidecarRef[] {
  const importedOutputs = result.partial.outputs
  if (importedOutputs === undefined) return []

  const currentOutputs = new Set(current.outputs ?? [])
  const conflicts: OrphanSidecarRef[] = []
  for (const key of new Set(importedOutputs)) {
    if (currentOutputs.has(key)) continue
    if (result.partial.outputKinds === undefined && hasOwn(current.outputKinds, key)) {
      conflicts.push({ source: 'outputKinds', key })
    }
    if (
      result.partial.outputWrapperPortNames === undefined &&
      hasOwn(current.outputWrapperPortNames, key)
    ) {
      conflicts.push({ source: 'outputWrapperPortNames', key })
    }
  }
  return conflicts
}

export function mergeAgentImport(
  current: CreateAgent,
  result: AgentMarkdownParseResult,
  resolved: ResolveAgentImportRefsResult,
): CreateAgent {
  const next: CreateAgent = { ...current }
  for (const [key, value] of Object.entries(result.partial)) {
    if (value === undefined) continue
    if (key === 'frontmatterExtra') {
      next.frontmatterExtra = {
        ...(current.frontmatterExtra ?? {}),
        ...(value as Record<string, unknown>),
      }
      continue
    }
    ;(next as unknown as Record<string, unknown>)[key] = value
  }
  // RFC-223 (PR-1): skills come from the selector list, not partial — convert +
  // apply like the other list fields (overwrite when the source declared them).
  const skills = importedSkillRefs(result)
  if (skills !== undefined) {
    if (resolved.skills === undefined) throw new Error('agent import skill refs were not resolved')
    next.skills = resolved.skills
  }
  if (result.partial.dependsOn !== undefined) {
    if (resolved.dependsOn === undefined)
      throw new Error('agent import dependencies were not resolved')
    next.dependsOn = resolved.dependsOn
  }
  if (result.partial.mcp !== undefined) {
    if (resolved.mcp === undefined) throw new Error('agent import MCP refs were not resolved')
    next.mcp = resolved.mcp
  }
  if (result.partial.plugins !== undefined) {
    if (resolved.plugins === undefined)
      throw new Error('agent import plugin refs were not resolved')
    next.plugins = resolved.plugins
  }
  return next
}

/** Returns the form field names whose user-edited value would be replaced if
 *  the given parser result were applied. `frontmatterExtra` is excluded because
 *  it shallow-merges rather than overwrites. */
export function fieldsOverwrittenByImport(
  current: CreateAgent,
  result: AgentMarkdownParseResult,
  emptyDraft: CreateAgent,
): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(result.partial)) {
    if (value === undefined) continue
    if (key === 'frontmatterExtra') continue
    const currentVal = (current as unknown as Record<string, unknown>)[key]
    const emptyVal = (emptyDraft as unknown as Record<string, unknown>)[key]
    if (!isSameValue(currentVal, emptyVal)) out.push(key)
  }
  // RFC-223 (PR-1): skills live on the selector list, not partial — check it too
  // so an import that only replaces skills still flags the overwrite.
  const skills = importedSkillRefs(result)
  if (skills !== undefined && !isSameValue(current.skills ?? [], emptyDraft.skills ?? [])) {
    out.push('skills')
  }
  return out
}

function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (typeof a !== typeof b) return false
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}
