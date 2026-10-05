import {
  getHandlerForParsedKind,
  formatPortValidationErrCode,
  parseKind,
  type AgentOutputKind,
  type OutputValidationEffects,
  type OutputValidationPolicy,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import type {
  PortOutputValidationContent,
  PortOutputValidationResult,
  ResolvePortContentOptions,
} from './ports/portOutputValidation'

/**
 * RFC-049 — structured failure payload attached to PortValidationError when
 * port content fails an OutputKindHandler.validate call. The runner catches
 * PortValidationError specifically, serializes `failure` into the
 * `port_validation_failures_json` column, and the scheduler reads it back to
 * drive same-session followup.
 */
export interface PortValidationFailure {
  port: string
  kind: AgentOutputKind
  subReason: string
  detail?: string
}

/**
 * ValidationError subclass carrying a structured `failure` payload so the
 * runner can persist it to `node_runs.port_validation_failures_json` without
 * re-parsing the human-readable errorMessage. Test code catching this class
 * gets a precise narrowed type instead of a stringly-typed `code` match.
 */
export class PortValidationError extends ValidationError {
  constructor(
    code: string,
    message: string,
    public readonly failure: PortValidationFailure,
  ) {
    super(code, message, { ...failure })
    this.name = 'PortValidationError'
  }
}

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
export function* portOutputValidationPolicy(
  opts: ResolvePortContentOptions,
  io: OutputValidationEffects,
): OutputValidationPolicy<PortOutputValidationResult> {
  const { rawContent, kind, worktreePath } = opts
  if (kind === undefined) {
    // Undeclared kind → raw passthrough. Forgiveness path was removed in
    // RFC-049 PR-B; emit the content verbatim so legitimate string ports
    // that happen to look path-shaped don't get accidentally read as files.
    return { body: rawContent }
  }

  // RFC-049 PR-B: route through the registered handler. Handler's `validate`
  // returns either `{ ok: true, body, sourcePath? }` or `{ ok: false,
  // subReason, detail }`; failures translate into a
  // `port-validation-<kind>-<sub>` errCode at the wire (kind namespace so a
  // future kind's subReasons can't collide with markdown_file's codes).
  // RFC-080: dispatch through the parametric registry (parseKind → matches),
  // so path<ext> / list<T> / signal validate correctly. `markdown_file` folds
  // to path<md> at parse time → identical containment / ext / existence /
  // non-empty checks as the legacy markdownFile handler. The errCode namespace
  // is the handler's displayName (D2: `port-validation-path-*`, never `<>`).
  const parsed = parseKind(kind)
  const handler = getHandlerForParsedKind(parsed)
  const result = yield* handler.validationPolicy(
    rawContent,
    { port: opts.port ?? '', kind: parsed, worktreePath },
    io,
  )
  if (result.ok) {
    const out: {
      body: string
      sourcePath?: string
      items?: Array<{ body: string; sourcePath?: string }>
    } = { body: result.body }
    if (result.sourcePath !== undefined) out.sourcePath = result.sourcePath
    if (result.items !== undefined) out.items = result.items
    return out
  }
  const errCode = formatPortValidationErrCode(handler.displayName, result.subReason)
  throw new PortValidationError(errCode, `${errCode}: ${result.detail}`, {
    port: opts.port ?? '',
    kind,
    subReason: result.subReason,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  })
}

/** Preserve the original shared field aliases without interpreting selected references. */
export function bindPortOutputValidationEffects(
  content: PortOutputValidationContent,
): OutputValidationEffects {
  return {
    async resolveWorktreePath(workspaceRef, rawContent) {
      const resolved = await content.resolve(workspaceRef, rawContent)
      return {
        targetAbs: resolved.targetRef,
        relativePath: resolved.relativePath,
        insideWorktree: resolved.insideWorkspace,
      }
    },
    readFileUtf8(targetRef) {
      return content.readUtf8(targetRef)
    },
  }
}
