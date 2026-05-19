// Workflow-output envelope parser.
//
// agent stdout must end with:
//   <workflow-output>
//     <port name="audit_findings">...</port>
//     <port name="summary">...</port>
//   </workflow-output>
//
// Rules per design/proposal.md §7:
//   - The LAST matching <workflow-output>...</workflow-output> wins
//     (anything before is treated as drafts the agent emitted while thinking).
//   - Port name must be a declared agent output; extras are kept but flagged
//     as `undeclared` for the caller to warn on.
//   - Declared ports missing from the envelope come back as empty strings
//     so downstream nodes get an explicit "" rather than undefined.
//
// RFC-005 layer on top: ports whose agent.outputKinds declares
// `markdown_file` carry a worktree-relative path inside the envelope
// instead of the markdown body. `resolvePortContent` does the path
// resolution + traversal hardening before the content lands in
// node_run_outputs.

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { getOutputKindHandler, type AgentOutputKind, type ValidateIO } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

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
 * Convenience for callers that want to write a batch of port failures to the
 * new column. Today we throw on the first failure (fail-fast — see RFC-049
 * design.md §7), so the array is always length 1; the helper is shaped this
 * way to anchor the JSON-payload schema for a future reduce-style validator.
 */
export function serializePortValidationFailures(
  failures: ReadonlyArray<PortValidationFailure>,
): string {
  return JSON.stringify(failures)
}

/**
 * Parse the raw JSON the runner persisted into
 * `node_runs.port_validation_failures_json`. Defensive parsing — malformed
 * payloads degrade to null rather than throw, so a corrupted column never
 * 5xx's the task detail API. Same shape as RFC-046's parseInjectedSnapshotJson.
 */
export function parsePortValidationFailuresJson(
  raw: string | null,
): PortValidationFailure[] | null {
  if (raw == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: PortValidationFailure[] = []
  for (const item of parsed) {
    if (item == null || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (
      typeof m.port !== 'string' ||
      typeof m.kind !== 'string' ||
      typeof m.subReason !== 'string'
    ) {
      continue
    }
    const entry: PortValidationFailure = {
      port: m.port,
      kind: m.kind as AgentOutputKind,
      subReason: m.subReason,
    }
    if (typeof m.detail === 'string') entry.detail = m.detail
    out.push(entry)
  }
  return out
}

/**
 * Node-backed ValidateIO supplied to RFC-049 OutputKindHandler.validate.
 * Centralized here so the same fs / path semantics back every handler call;
 * the handlers themselves stay pure JS and can be exercised in tests with a
 * stub IO that doesn't touch disk.
 */
const NODE_VALIDATE_IO: ValidateIO = {
  resolveWorktreePath(worktreeAbsPath, rawContent) {
    const rootAbs = resolve(worktreeAbsPath)
    const targetAbs = isAbsolute(rawContent) ? resolve(rawContent) : resolve(rootAbs, rawContent)
    // Lexical containment — same rule the pre-RFC-049 code used. realpath()
    // is intentionally NOT done here; the documented limit (a symlink inside
    // the worktree pointing outside still reads through) is locked by
    // envelope-parse-md-edge-cases.test.ts.
    const insideWorktree = targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep)
    const relativePath = relative(rootAbs, targetAbs)
    return { targetAbs, relativePath, insideWorktree }
  },
  readFileUtf8(absPath) {
    return readFileSync(absPath, 'utf8')
  },
}

const ENVELOPE_RE = /<workflow-output>([\s\S]*?)<\/workflow-output>/g
const CLARIFY_ENVELOPE_RE = /<workflow-clarify>([\s\S]*?)<\/workflow-clarify>/g
// Accept both "name" and 'name' attribute quotes. Tolerant of arbitrary
// whitespace inside the opening tag.
const PORT_RE = /<port\s+name=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/port>/g

export interface EnvelopeParseResult {
  /**
   * Resolved port content for every entry in `declaredOutputs`, in declaration
   * order. Ports omitted by the agent are present with an empty string.
   */
  ports: Map<string, string>
  /** Names listed in `declaredOutputs` but absent from the envelope. */
  missingDeclared: string[]
  /** Ports emitted by the agent that aren't declared in agent.outputs. */
  undeclared: Array<{ name: string; content: string }>
}

/**
 * Find the last `<workflow-output>...</workflow-output>` block in `text`.
 * Returns the entire matched block (incl. open/close tags), or null if none.
 */
export function extractLastEnvelope(text: string): string | null {
  const matches = [...text.matchAll(ENVELOPE_RE)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  return last ? last[0] : null
}

// ---------------------------------------------------------------------------
// RFC-023: clarify envelope detection.
// ---------------------------------------------------------------------------

/**
 * The four possible envelope shapes an agent reply can take after RFC-023.
 *
 *  - 'output'  → exactly one (or more) <workflow-output> block, no clarify.
 *                Normal happy path — runner parses output and writes ports.
 *  - 'clarify' → exactly one (or more) <workflow-clarify> block, no output.
 *                Runner hands off to ClarifyService.createClarifySession and
 *                marks the clarify node_run awaiting_human.
 *  - 'both'    → both kinds present. **Hard reject** — the protocol block in
 *                the user prompt explicitly forbids this (a reply MUST be
 *                exactly one OR the other, never both / neither). Runner
 *                fails the node with `clarify-and-output-both-present` so the
 *                normal retry path applies.
 *  - 'none'    → neither kind present. Same failure mode as today.
 */
export type DetectedEnvelopeKind = 'output' | 'clarify' | 'both' | 'none'

/**
 * Cheap pre-scan over agent stdout to decide which envelope path the runner
 * should take. We do not parse the body here — just count global regex hits
 * for either form.
 *
 * Both/Neither detection does not depend on ordering — any stdout that
 * contains BOTH tag pairs (even nested or separated by megabytes) is `both`.
 * This is intentional: agents that try to "hedge" by emitting one form first
 * and another later are still rejected so we never have to decide which one
 * was the intent.
 */
export function detectEnvelopeKind(stdout: string): DetectedEnvelopeKind {
  const hasOutput = ENVELOPE_RE.test(stdout)
  // RegExp objects with the global flag carry mutable lastIndex state across
  // .test()/.exec() calls. Reset so the next caller doesn't get a false
  // negative on a string that begins before our last cursor position.
  ENVELOPE_RE.lastIndex = 0
  const hasClarify = CLARIFY_ENVELOPE_RE.test(stdout)
  CLARIFY_ENVELOPE_RE.lastIndex = 0
  if (hasOutput && hasClarify) return 'both'
  if (hasOutput) return 'output'
  if (hasClarify) return 'clarify'
  return 'none'
}

/**
 * Extract the JSON body inside the LAST `<workflow-clarify>...</workflow-clarify>`
 * block, mirroring extractLastEnvelope semantics. Returns null when no
 * clarify block is present. The returned string is trimmed but otherwise
 * verbatim — callers (shared/clarify.parseClarifyEnvelopeBody) handle JSON
 * parsing + zod validation + permissive truncation.
 */
export function extractClarifyEnvelopeBody(stdout: string): string | null {
  const matches = [...stdout.matchAll(CLARIFY_ENVELOPE_RE)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  if (!last) return null
  // last[1] is the captured body between the open / close tags.
  const body = (last[1] ?? '').trim()
  return body
}

/**
 * Parse <port> elements inside an envelope block. Returns a structured result
 * suitable for upserting into node_run_outputs + WS broadcast.
 *
 * Trims whitespace around each port's content (agents often pad with leading
 * newlines from XML pretty-printing).
 */
export function parseEnvelope(envelopeXml: string, declaredOutputs: string[]): EnvelopeParseResult {
  const collected = new Map<string, string>()
  const undeclared: Array<{ name: string; content: string }> = []

  for (const m of envelopeXml.matchAll(PORT_RE)) {
    const name = m[1] ?? m[2] ?? ''
    const content = (m[3] ?? '').trim()
    if (name.length === 0) continue
    if (declaredOutputs.includes(name)) {
      // If an agent emits the same port name twice, keep the LAST one — most
      // intuitive for a buggy / iterating agent.
      collected.set(name, content)
    } else {
      undeclared.push({ name, content })
    }
  }

  const ports = new Map<string, string>()
  for (const name of declaredOutputs) {
    ports.set(name, collected.get(name) ?? '')
  }
  const missingDeclared = declaredOutputs.filter((p) => !collected.has(p))

  return { ports, missingDeclared, undeclared }
}

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
} {
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
  const handler = getOutputKindHandler(kind)
  const result = handler.validate(
    rawContent,
    { port: opts.port ?? '', kind, worktreePath },
    NODE_VALIDATE_IO,
  )
  if (result.ok) {
    const out: { body: string; sourcePath?: string } = { body: result.body }
    if (result.sourcePath !== undefined) out.sourcePath = result.sourcePath
    return out
  }
  throw new PortValidationError(
    `port-validation-${kind}-${result.subReason}`,
    `port-validation-${kind}-${result.subReason}: ${result.detail}`,
    {
      port: opts.port ?? '',
      kind,
      subReason: result.subReason,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    },
  )
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
