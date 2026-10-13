// RFC-373: keep the user's preferred ratio separate from the temporarily
// clamped ratio. A narrow resource panel must not overwrite the desktop split.
export const MARKDOWN_LAYOUT_STORAGE_KEY = 'aw.markdown-editor.layout.v1'
export const MARKDOWN_PANE_MIN_WIDTH = 320
export const MARKDOWN_DIVIDER_WIDTH = 12
export const MARKDOWN_SPLIT_MIN_WIDTH = MARKDOWN_PANE_MIN_WIDTH * 2 + MARKDOWN_DIVIDER_WIDTH

export type MarkdownEditorMode = 'edit' | 'split' | 'preview'
export type MarkdownSinglePane = Exclude<MarkdownEditorMode, 'split'>

export interface MarkdownLayoutPreference {
  version: 1
  mode: MarkdownEditorMode
  ratio: number
  singlePane: MarkdownSinglePane
}

export function parseMarkdownLayout(
  raw: string | null,
  readOnly = false,
): MarkdownLayoutPreference {
  const fallback: MarkdownLayoutPreference = {
    version: 1,
    mode: 'split',
    ratio: 0.5,
    singlePane: readOnly ? 'preview' : 'edit',
  }
  if (raw === null) return fallback
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return fallback
    const candidate = value as Partial<MarkdownLayoutPreference>
    if (
      candidate.version !== 1 ||
      !['edit', 'split', 'preview'].includes(candidate.mode ?? '') ||
      !['edit', 'preview'].includes(candidate.singlePane ?? '') ||
      typeof candidate.ratio !== 'number' ||
      !Number.isFinite(candidate.ratio) ||
      candidate.ratio < 0 ||
      candidate.ratio > 1
    ) {
      return fallback
    }
    return {
      version: 1,
      mode: candidate.mode as MarkdownEditorMode,
      ratio: candidate.ratio,
      singlePane: candidate.singlePane as MarkdownSinglePane,
    }
  } catch {
    return fallback
  }
}

export function markdownSplitBounds(width: number) {
  const available = Math.max(MARKDOWN_PANE_MIN_WIDTH * 2, width - MARKDOWN_DIVIDER_WIDTH)
  const min = MARKDOWN_PANE_MIN_WIDTH / available
  return { min, max: 1 - min, available }
}

export function markdownEditorLayout(preference: MarkdownLayoutPreference, width: number) {
  // Zero means not measured / temporarily hidden, not a real narrow viewport.
  const compact = width > 0 && width < MARKDOWN_SPLIT_MIN_WIDTH
  const bounds = markdownSplitBounds(width)
  return {
    ...bounds,
    compact,
    mode: compact && preference.mode === 'split' ? preference.singlePane : preference.mode,
    ratio: Math.max(bounds.min, Math.min(bounds.max, preference.ratio)),
  }
}
