// RFC-072 — pure helpers for the task-detail Outputs tab. Kept out of the
// component so they can be unit-tested without a DOM.

import { tryParseKind } from '@agent-workflow/shared'

/**
 * True iff the kind string denotes a single downloadable file path
 * (`path<ext>`, including the `markdown_file` alias which folds to `path<md>`).
 * `list<path<...>>` is NOT a single file in v1 → false. Text kinds
 * (string / markdown / signal), null, undefined and '' → false.
 */
export function isFileOutputKind(kind: string | null | undefined): boolean {
  if (kind === null || kind === undefined || kind === '') return false
  const parsed = tryParseKind(kind)
  return parsed !== null && parsed.kind === 'path'
}

/**
 * True iff `value` is a single non-empty line — i.e. a usable file path.
 * Multi-line or empty values never get a download button even on a path kind
 * (a path port's value is always one worktree-relative path).
 */
export function isSingleLinePath(value: string | null): boolean {
  if (value === null) return false
  const v = value.trim()
  return v.length > 0 && !v.includes('\n')
}
