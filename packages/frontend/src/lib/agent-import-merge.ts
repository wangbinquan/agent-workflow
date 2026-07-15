// Merges an AgentImportDialog parser result into the current AgentForm draft.
// RFC-018 T2. Pure function — covered by agent-import-merge.test.tsx.
//
// Rules:
//  - any key with `partial[key] !== undefined` overwrites current[key]
//  - `frontmatterExtra` is shallow-merged (imported keys overwrite same-name
//    current keys; current-only keys are preserved)
//  - RFC-194 routes inputs / outputs / outputKinds / role /
//    outputWrapperPortNames as first-class fields; omitted fields (including
//    syncOutputsOnIterate / skills) preserve the current value as-is

import type { AgentMarkdownParseResult, CreateAgent } from '@agent-workflow/shared'
import type { OrphanSidecarRef } from './agent-ports'

const hasOwn = (record: object | undefined, key: string): boolean =>
  record !== undefined && Object.prototype.hasOwnProperty.call(record, key)

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
