// Merges an AgentImportDialog parser result into the current AgentForm draft.
// RFC-018 T2. Pure function — covered by agent-import-merge.test.tsx.
//
// Rules:
//  - any key with `partial[key] !== undefined` overwrites current[key]
//  - `frontmatterExtra` is shallow-merged (imported keys overwrite same-name
//    current keys; current-only keys are preserved)
//  - `outputs / outputKinds / syncOutputsOnIterate / skills` are
//    never touched by the parser, so the current value is preserved as-is

import type { AgentMarkdownParseResult, CreateAgent } from '@agent-workflow/shared'

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
