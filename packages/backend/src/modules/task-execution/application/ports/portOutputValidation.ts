import type { AgentOutputKind } from '@agent-workflow/shared'

// ---------------------------------------------------------------------------
// RFC-005 port-content resolution.
// ---------------------------------------------------------------------------

export interface ResolvePortContentOptions {
  /** The literal envelope content for this port (already trimmed). */
  rawContent: string
  /** Per-port kind hint from agent.outputKinds (undefined → forgiveness path). */
  kind?: AgentOutputKind
  /**
   * Worktree root (absolute). All `markdown_file` paths must resolve inside
   * this directory; traversal attempts (`../`, absolute paths, symlinks
   * landing outside) raise ValidationError before any read happens.
   */
  worktreePath: string
  /**
   * RFC-049: the port name this content belongs to. Optional for
   * backwards-compat with existing callers; threaded through to the handler
   * ctx so future per-port error context (e.g. structured failures payload
   * in PR-B) has it. Defaults to '' when omitted.
   */
  port?: string
}

export type PortOutputValidationResult = {
  body: string
  sourcePath?: string
  /** RFC-193: list<T> per-item validate outputs (see ValidateResult.items). */
  items?: Array<{ body: string; sourcePath?: string }>
}

export interface PortOutputValidationContent {
  resolve(
    workspaceRef: string,
    rawContent: string,
  ):
    | { targetRef: string; relativePath: string; insideWorkspace: boolean }
    | Promise<{ targetRef: string; relativePath: string; insideWorkspace: boolean }>
  readUtf8(targetRef: string): string | Promise<string>
}

export type PortOutputValidationRequest = Omit<ResolvePortContentOptions, 'worktreePath'> & {
  readonly workspaceRef: string
}

/** A complete selected validation purpose; only the content adapter interprets refs. */
export interface PortOutputContentValidation {
  resolve(request: PortOutputValidationRequest): Promise<PortOutputValidationResult>
}
