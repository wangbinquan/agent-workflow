import { runOutputValidationPolicy } from '@agent-workflow/shared'
import {
  bindPortOutputValidationEffects,
  portOutputValidationPolicy,
} from '../application/portOutputValidation'
import type {
  PortOutputContentValidation,
  PortOutputValidationContent,
  PortOutputValidationRequest,
  ResolvePortContentOptions,
} from '../application/ports/portOutputValidation'
import { resolveNativePortContentDetailed } from '../infrastructure/local/filePortOutputValidation'

export { NODE_VALIDATE_IO } from '../infrastructure/local/filePortOutputValidation'
export { createFilePortOutputValidationContent as createNativePortOutputValidationContent } from '../infrastructure/local/filePortOutputValidation'
// RFC-414: the native validation entry binds infrastructure IO, so it lives there; this export keeps its callers.
export { resolveNativePortContentDetailed } from '../infrastructure/local/filePortOutputValidation'

/** Select one complete content receiver, never filling missing methods from native IO. */
export function composePortOutputContentValidation(
  content: PortOutputValidationContent,
): PortOutputContentValidation {
  if (
    content === null ||
    typeof content !== 'object' ||
    typeof content.resolve !== 'function' ||
    typeof content.readUtf8 !== 'function'
  ) {
    throw new TypeError('Port output validation requires a complete content receiver')
  }
  const io = bindPortOutputValidationEffects(content)
  return Object.freeze({
    async resolve(request: PortOutputValidationRequest) {
      const { workspaceRef, ...opts } = request
      return await runOutputValidationPolicy(
        portOutputValidationPolicy({ ...opts, worktreePath: workspaceRef }, io),
      )
    },
  })
}

// RFC-458 (RFC-294 W9-D): moved here from `services/envelope.ts`. RFC-005 layer: ports whose agent.outputKinds
// declares `markdown_file` carry a worktree-relative path inside the envelope instead of the markdown body.
/**
 * Detailed variant of {@link resolvePortContent} that ALSO reports the
 * worktree-relative path the body was read from, when one was used. Callers
 * that just want the body should keep using `resolvePortContent`; callers
 * that need to remember the source file path (e.g. dispatchReviewNode
 * snapshotting onto doc_versions for the iterate prompt) use this.
 *
 * `sourcePath` is set when the OutputKindHandler.validate that ran reports
 * one (today: `markdown_file` always; pure-text kinds never).
 *
 * The path is always normalized to be worktree-relative, even when the agent
 * emitted an absolute path inside the worktree.
 *
 * RFC-049 PR-B: kind === undefined → raw passthrough (no file read attempt,
 * no probing). The old "forgiveness path" that auto-promoted single-line
 * .md paths is gone — agents that want the file body delivered to downstream
 * nodes MUST declare `outputKinds: { port: markdown_file }`. This is a
 * breaking change, locked in {@link envelope-undeclared-kind-raw-passthrough}
 * test + the prefix-swap source grep guard.
 */
export function resolvePortContentDetailed(opts: ResolvePortContentOptions): {
  body: string
  sourcePath?: string
  /** RFC-193: list<T> per-item validate outputs (see ValidateResult.items). */
  items?: Array<{ body: string; sourcePath?: string }>
} {
  return resolveNativePortContentDetailed(opts)
}

/**
 * Resolve the on-the-wire content of a port to the value downstream nodes
 * actually consume.
 *
 * - `string` / `markdown` → handler passthrough (rawContent unchanged).
 * - `markdown_file` → handler treats rawContent as a worktree-relative path,
 *   verifies containment + .md/.markdown extension + non-empty file, then
 *   reads the file as UTF-8.
 * - `undefined` → raw passthrough (no file read attempt). RFC-049 PR-B
 *   removed the auto-promote forgiveness path.
 *
 * Used by the runner post-`parseEnvelope` and by the review service when
 * snapshotting a port into doc_versions. Thin wrapper over
 * {@link resolvePortContentDetailed} that drops the source-path metadata.
 */
export function resolvePortContent(opts: ResolvePortContentOptions): string {
  return resolvePortContentDetailed(opts).body
}
