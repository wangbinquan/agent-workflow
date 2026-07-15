// RFC-105 — pure helpers for the task-detail Markdown preview feature.
//
// Kept out of the components/route so they unit-test without a DOM or a
// router. Two consumers wire a "预览" (preview) button:
//   - TaskOutputPanel (Outputs tab): inline `markdown` ports + file ports
//     whose value is a `.md` worktree path.
//   - WorktreeFilePreview (working-dir tab): selected `.md` / `.markdown` files.
// Both navigate to the standalone preview route `/tasks/$id/preview` whose
// search params are produced by `buildPreviewTarget` and validated by
// `validatePreviewSearch` / `resolvePreviewSource`.

import { tryParseKind } from '@agent-workflow/shared'
import { isFileOutputKind, isSingleLinePath } from '@/lib/output-port'

/** Markdown file extensions we offer a preview for. */
export const MARKDOWN_EXT_RE = /\.(md|markdown)$/i

/**
 * True iff `path` is a single-line, non-empty worktree path ending in a
 * markdown extension. Shared by the worktree-files button gate and the
 * file-output-port `.md` check.
 */
export function isMarkdownPath(path: string): boolean {
  if (typeof path !== 'string') return false
  const p = path.trim()
  if (p.length === 0 || p.includes('\n')) return false
  return MARKDOWN_EXT_RE.test(p)
}

/**
 * Outputs-tab button gate: does this resolved port render as markdown?
 *   - a file-kind port (`path<...>` / `markdown_file`) whose single-line value
 *     is a `.md` path, OR
 *   - an inline `markdown` port (value IS markdown text; `parseKind('markdown')`
 *     yields `{ kind: 'base', name: 'markdown' }` — NOT `{ kind: 'markdown' }`).
 * Empty / null values and non-markdown kinds → false. `list<...>` is excluded
 * (isFileOutputKind is false for list; the inline branch only matches the base
 * `markdown` kind).
 */
export function isMarkdownPreviewable(
  kind: string | null | undefined,
  value: string | null,
): boolean {
  if (value === null) return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  // .md file-path port (download-button gate + an `.md` check).
  if (isFileOutputKind(kind) && isSingleLinePath(value) && isMarkdownPath(trimmed)) {
    return true
  }
  // Inline markdown port — value itself is the markdown body.
  const parsed = tryParseKind(typeof kind === 'string' ? kind : '')
  if (parsed !== null && parsed.kind === 'base' && parsed.name === 'markdown') {
    return true
  }
  return false
}

/** Validated search shape for the `/tasks/$id/preview` route. */
export interface TaskPreviewSearch {
  /** File source: worktree-relative path. */
  path?: string
  /** Inline-port source: source node_run id. */
  runId?: string
  /** Inline-port source: source port name. */
  port?: string
  /** Optional display label for the page header. */
  title?: string
}

/**
 * TanStack `validateSearch` for the preview route. Picks non-empty strings;
 * always returns an object (TanStack invariant). Garbage / empty values are
 * dropped, so a stray `?path=` collapses to `{}` → invalid (handled below).
 */
export function validatePreviewSearch(raw: Record<string, unknown>): TaskPreviewSearch {
  const out: TaskPreviewSearch = {}
  if (typeof raw.path === 'string' && raw.path.length > 0) out.path = raw.path
  if (typeof raw.runId === 'string' && raw.runId.length > 0) out.runId = raw.runId
  if (typeof raw.port === 'string' && raw.port.length > 0) out.port = raw.port
  if (typeof raw.title === 'string' && raw.title.length > 0) out.title = raw.title
  return out
}

/** Discriminated source the preview route resolves a markdown body from. */
export type PreviewResolution =
  | { mode: 'file'; path: string }
  | { mode: 'port'; runId: string; port: string }
  | { mode: 'artifact'; path: string; runId: string; port: string }
  | { mode: 'invalid' }

/**
 * Decide the body source from validated search.
 *
 * RFC-193: all three params present (`path` + `runId` + `port`) is the
 * ARTIFACT source — body from the emit-time archive (port-artifacts API),
 * immune to wrapper scoping / worktree GC, falling back to the file route on
 * 404 (legacy rows). `path` alone stays file mode (old links keep working —
 * the previous builder only serialized `path`, Codex design-gate P1);
 * `runId`+`port` alone is the inline-port source; anything else is invalid.
 */
export function resolvePreviewSource(search: TaskPreviewSearch): PreviewResolution {
  const hasPath = search.path !== undefined && search.path.length > 0
  const hasRun =
    search.runId !== undefined &&
    search.runId.length > 0 &&
    search.port !== undefined &&
    search.port.length > 0
  if (hasPath && hasRun) {
    return {
      mode: 'artifact',
      path: search.path as string,
      runId: search.runId as string,
      port: search.port as string,
    }
  }
  if (hasPath) {
    return { mode: 'file', path: search.path as string }
  }
  if (hasRun) {
    return { mode: 'port', runId: search.runId as string, port: search.port as string }
  }
  return { mode: 'invalid' }
}

/** A markdown body source, for `buildPreviewTarget`. */
export type PreviewSource =
  | { kind: 'file'; path: string }
  | { kind: 'port'; runId: string; port: string }
  | { kind: 'artifact'; path: string; runId: string; port: string }

/** Navigation target (spread into `<Link>` / `navigate()`) for one source. */
export interface PreviewTarget {
  to: '/tasks/$id/preview'
  params: { id: string }
  search: TaskPreviewSearch
}

/**
 * Build the `<Link>`/`navigate()` target for a preview source. Keeping this a
 * pure data builder (not a hook) lets the wiring points and their tests assert
 * the exact target without a RouterProvider.
 */
export function buildPreviewTarget(
  taskId: string,
  source: PreviewSource,
  title?: string,
): PreviewTarget {
  const search: TaskPreviewSearch =
    source.kind === 'file'
      ? { path: source.path }
      : source.kind === 'port'
        ? { runId: source.runId, port: source.port }
        : { path: source.path, runId: source.runId, port: source.port }
  if (title !== undefined && title.length > 0) search.title = title
  return { to: '/tasks/$id/preview', params: { id: taskId }, search }
}
