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
import { isAbsolute, resolve, sep } from 'node:path'
import type { AgentOutputKind } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

const ENVELOPE_RE = /<workflow-output>([\s\S]*?)<\/workflow-output>/g
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
 * Resolve the on-the-wire content of a port to the value downstream nodes
 * actually consume.
 *
 * - `string` / undefined / `markdown` → pass `rawContent` through unchanged.
 * - `markdown_file` → treat `rawContent` as a worktree-relative path,
 *   verify it stays under `worktreePath` (defeats `../etc/passwd`,
 *   `/etc/passwd`, symlinks pointing outside), then read the file as UTF-8.
 *
 * Used by the runner post-`parseEnvelope` and by the review service when
 * snapshotting a port into doc_versions.
 */
export function resolvePortContent(opts: ResolvePortContentOptions): string {
  const { rawContent, kind, worktreePath } = opts
  if (kind !== 'markdown_file') return rawContent

  const trimmed = rawContent.trim()
  if (trimmed.length === 0) {
    throw new ValidationError(
      'markdown-file-empty-path',
      'markdown_file port content must be a worktree-relative path, got empty string',
    )
  }
  // Reject absolute paths up-front — the only legal form is relative to the
  // worktree root.
  if (isAbsolute(trimmed)) {
    throw new ValidationError(
      'markdown-file-absolute-path',
      `markdown_file port content '${trimmed}' must be a relative path, not absolute`,
    )
  }

  const rootAbs = resolve(worktreePath)
  const targetAbs = resolve(rootAbs, trimmed)
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
    return readFileSync(targetAbs, 'utf8')
  } catch (err) {
    throw new ValidationError(
      'markdown-file-read-failed',
      `markdown_file '${trimmed}': ${(err as Error).message}`,
    )
  }
}
