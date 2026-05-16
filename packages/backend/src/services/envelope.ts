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

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentOutputKind } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

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
  /** Per-port kind hint from agent.outputKinds (undefined → 'string'). */
  kind?: AgentOutputKind
  /**
   * Worktree root (absolute). All `markdown_file` paths must resolve inside
   * this directory; traversal attempts (`../`, absolute paths, symlinks
   * landing outside) raise ValidationError before any read happens.
   */
  worktreePath: string
}

/**
 * Detailed variant of {@link resolvePortContent} that ALSO reports the
 * worktree-relative path the body was read from, when one was used. Callers
 * that just want the body should keep using `resolvePortContent`; callers
 * that need to remember the source file path (e.g. dispatchReviewNode
 * snapshotting onto doc_versions for the iterate prompt) use this.
 *
 * `sourcePath` is set when:
 *   - kind === 'markdown_file' (always — the strict branch reads a file).
 *   - kind is anything else and the forgiveness branch silently read a `.md`
 *     file inside the worktree.
 * `sourcePath` is undefined when the body was passed through verbatim
 * (inline markdown, path-shaped strings that did not resolve, etc.).
 *
 * The path is always normalized to be worktree-relative, even when the agent
 * emitted an absolute path inside the worktree.
 */
export function resolvePortContentDetailed(opts: ResolvePortContentOptions): {
  body: string
  sourcePath?: string
} {
  const { rawContent, kind, worktreePath } = opts
  if (kind !== 'markdown_file') {
    // Forgiveness path: when an agent emits a single-line `.md` path on a
    // port whose `outputKinds` was never declared as `markdown_file`, the
    // review/audit/fix downstream still wants the file body, not the path
    // string itself. We auto-promote ONLY when the candidate resolves to a
    // real file safely contained inside the task worktree (lexical +
    // realpath checks). Any failure mode → return rawContent unchanged so
    // legitimate string ports that happen to look path-shaped don't crash.
    return tryReadInWorktreeMarkdownPath(rawContent, worktreePath)
  }

  const trimmed = rawContent.trim()
  if (trimmed.length === 0) {
    throw new ValidationError(
      'markdown-file-empty-path',
      'markdown_file port content must be a worktree-relative path, got empty string',
    )
  }

  // Both relative and absolute paths are accepted, but absolute paths must
  // still resolve inside the worktree. Agents naturally emit absolute paths
  // because the opencode process's cwd IS the task worktree (e.g. `pwd`/`find`
  // output is absolute), so requiring relative-only caused real review
  // failures in the field. The containment check below is the actual security
  // boundary; whether the path was absolute or relative on the wire is
  // incidental.
  const rootAbs = resolve(worktreePath)
  const targetAbs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootAbs, trimmed)
  // realpath-after-resolve guarantees we land inside the worktree. We do not
  // follow symlinks (readFileSync follows them, but the containment check
  // must use the lexical absolute path so a symlinked file inside the
  // worktree pointing outside doesn't bypass the check).
  if (!(targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep))) {
    throw new ValidationError(
      'markdown-file-escapes-worktree',
      `markdown_file port content '${trimmed}' resolves outside the task worktree`,
    )
  }

  try {
    const body = readFileSync(targetAbs, 'utf8')
    const sourcePath = relative(rootAbs, targetAbs)
    return { body, sourcePath }
  } catch (err) {
    throw new ValidationError(
      'markdown-file-read-failed',
      `markdown_file '${trimmed}': ${(err as Error).message}`,
    )
  }
}

/**
 * Resolve the on-the-wire content of a port to the value downstream nodes
 * actually consume.
 *
 * - `string` / undefined / `markdown` → pass `rawContent` through unchanged.
 * - `markdown_file` → treat `rawContent` as a worktree-relative path,
 *   verify it stays under `worktreePath` (defeats `../etc/passwd`,
 *   `/etc/passwd`, symlinks pointing outside), then read the file as UTF-8.
 *
 * Used by the runner post-`parseEnvelope` and by the review service when
 * snapshotting a port into doc_versions. Thin wrapper over
 * {@link resolvePortContentDetailed} that drops the source-path metadata.
 */
export function resolvePortContent(opts: ResolvePortContentOptions): string {
  return resolvePortContentDetailed(opts).body
}

/**
 * Heuristic auto-promote: when a port's `outputKinds` was NOT declared as
 * `markdown_file` but its content is a single-line `.md` path safely
 * resolving to a real file inside the task worktree, return the file body.
 * Otherwise pass the raw content through verbatim — multi-line markdown,
 * non-`.md` text, non-existent paths, and anything outside the worktree all
 * keep the legacy passthrough contract.
 *
 * This is a forgiveness path for agents that emit a markdown_file path
 * without declaring the kind in their frontmatter; the review detail page
 * was rendering the literal path string before this existed (see commit
 * referenced in tests/envelope-resolve-port-md-path.test.ts).
 */
function tryReadInWorktreeMarkdownPath(
  rawContent: string,
  worktreePath: string,
): { body: string; sourcePath?: string } {
  const trimmed = rawContent.trim()
  if (trimmed.length === 0 || trimmed.length >= 4096) return { body: rawContent }
  if (trimmed.includes('\n') || trimmed.includes('\r')) return { body: rawContent }
  if (!trimmed.toLowerCase().endsWith('.md')) return { body: rawContent }

  const rootAbs = resolve(worktreePath)
  const targetAbs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootAbs, trimmed)
  if (!(targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep))) return { body: rawContent }

  let rootReal: string
  let targetReal: string
  try {
    rootReal = realpathSync(rootAbs)
    targetReal = realpathSync(targetAbs)
  } catch {
    return { body: rawContent }
  }
  if (!(targetReal === rootReal || targetReal.startsWith(rootReal + sep))) {
    return { body: rawContent }
  }

  try {
    if (!statSync(targetReal).isFile()) return { body: rawContent }
    const body = readFileSync(targetReal, 'utf8')
    // Report the path the caller pointed us at (lexical, pre-realpath) so
    // the iterate prompt cites the exact filename the agent emitted, not the
    // symlink target. relative() handles both forms (relative-in / abs-in).
    const sourcePath = isAbsolute(trimmed) ? relative(rootAbs, targetAbs) : trimmed
    return { body, sourcePath }
  } catch {
    return { body: rawContent }
  }
}
