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
//   - A port whose opening tag was found but whose `</port>` close is
//     missing/corrupted is reported in `malformedPorts` (distinct from a
//     legitimately-omitted port) so the runner can fail+retry rather than
//     silently emit a blank port — see ENVELOPE_PORT_MALFORMED_PREFIX.
//
// RFC-005 layer on top: ports whose agent.outputKinds declares
// `markdown_file` carry a worktree-relative path inside the envelope
// instead of the markdown body. `resolvePortContent` does the path
// resolution + traversal hardening before the content lands in
// node_run_outputs.

import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  getHandlerForParsedKind,
  formatPortValidationErrCode,
  parseKind,
  type AgentOutputKind,
  type ValidateIO,
} from '@agent-workflow/shared'
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
    let targetAbs = isAbsolute(rawContent) ? resolve(rawContent) : resolve(rootAbs, rawContent)
    // RFC-103 T7 (05-PORT security): lexical containment FIRST, then realpath
    // containment so a symlink INSIDE the worktree pointing OUTSIDE it cannot
    // read through (`path` / `markdown_file` ports could otherwise exfiltrate
    // arbitrary files). Aligns with worktreeFiles' realpath guard. A
    // non-existent target falls back to the lexical verdict — existence is
    // checked separately by the handler.
    let insideWorktree = targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep)
    let relativePath = relative(rootAbs, targetAbs)
    if (insideWorktree) {
      try {
        const realTarget = realpathSync(targetAbs)
        const realRoot = realpathSync(rootAbs)
        insideWorktree = realTarget === realRoot || realTarget.startsWith(realRoot + sep)
      } catch {
        // target (or root) not resolvable yet → keep the lexical verdict.
      }
    } else if (isAbsolute(rawContent)) {
      // RFC-193: an ABSOLUTE path that fails lexically may still genuinely live
      // inside the worktree when the two spellings differ by a symlinked
      // prefix (macOS /var → /private/var tmpdirs: the agent's cwd is the
      // realpath form while the runner's worktreePath is the lexical form).
      // Accepting when BOTH realpaths agree is a pure same-location proof —
      // the read-through protection above is untouched (a real target outside
      // the real root is still rejected). relativePath is re-derived from the
      // real forms so the persisted content stays worktree-relative.
      try {
        const realTarget = realpathSync(targetAbs)
        const realRoot = realpathSync(rootAbs)
        if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
          insideWorktree = true
          targetAbs = realTarget
          relativePath = relative(realRoot, realTarget)
        }
      } catch {
        // unresolvable → keep the lexical (outside) verdict.
      }
    }
    return { targetAbs, relativePath, insideWorktree }
  },
  readFileUtf8(absPath) {
    return readFileSync(absPath, 'utf8')
  },
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// RFC-200 (T3): envelope matchers scoped to the run's nonce. With a nonce, ONLY
// `<workflow-output nonce="{nonce}">` matches — an echoed/forged BARE (or
// wrong-nonce) envelope in the agent's stdout is invisible to the parser, so it
// cannot be采信 as the agent's output ("echo-forge + last-wins" is closed).
// Absent nonce → the legacy bare open tag (a run dispatched before RFC-200).
// Each call returns a FRESH RegExp, so there is no shared `lastIndex` state to
// reset between callers (the old module-level consts needed that dance).
function envelopeRe(nonce?: string): RegExp {
  const open =
    nonce !== undefined && nonce.length > 0
      ? `<workflow-output\\s+nonce="${escapeRe(nonce)}"\\s*>`
      : '<workflow-output>'
  return new RegExp(`${open}([\\s\\S]*?)<\\/workflow-output>`, 'g')
}
function clarifyRe(nonce?: string): RegExp {
  const open =
    nonce !== undefined && nonce.length > 0
      ? `<workflow-clarify\\s+nonce="${escapeRe(nonce)}"\\s*>`
      : '<workflow-clarify>'
  return new RegExp(`${open}([\\s\\S]*?)<\\/workflow-clarify>`, 'g')
}
// Accept both "name" and 'name' attribute quotes. Tolerant of arbitrary
// whitespace inside the opening tag. RFC-103 T6: matches only the OPENING tag;
// each port's content is delimited by the next opening tag (container-based,
// see parseEnvelope) instead of a non-greedy `</port>` that truncated a port
// whose content legitimately contained a literal `</port>` string.
const PORT_OPEN_RE = /<port\s+name=(?:"([^"]+)"|'([^']+)')\s*>/g

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
  /**
   * Names of ports the agent clearly STARTED emitting but that could not be
   * cleanly framed — a strong corruption signal, distinct from a port the agent
   * legitimately omitted (`missingDeclared`). Two detection signals feed it:
   *   1. An opening `<port name="...">` whose `</port>` close is missing /
   *      truncated / corrupted (e.g. `</|DSML|port>`). Includes undeclared
   *      names — an unclosed port mid-envelope makes the scanner abandon every
   *      port after it (the cursor jumps to the envelope end), so even an
   *      undeclared malformed port corrupts framing.
   *   2. A DECLARED port that is missing yet whose opening tag still appears in
   *      the envelope body — it was absorbed into a preceding port whose own
   *      close was corrupted (the scanner used THIS port's clean `</port>` as
   *      the corrupted port's structural close). Legitimately-omitted ports
   *      have no opening tag, so they are never flagged.
   * The runner turns a non-empty list into a retriable `failed` (see
   * {@link ENVELOPE_PORT_MALFORMED_PREFIX}).
   */
  malformedPorts: string[]
}

/**
 * Find the last `<workflow-output>...</workflow-output>` block in `text`.
 * Returns the entire matched block (incl. open/close tags), or null if none.
 */
export function extractLastEnvelope(text: string, nonce?: string): string | null {
  const matches = [...text.matchAll(envelopeRe(nonce))]
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
 * RFC-100 — error-message prefix the runner stamps when a node is in mandatory
 * ask-back mode (a clarify channel is ACTIVE: wired AND the user has not
 * clicked "Stop clarifying") yet the agent's reply was not a pure
 * `<workflow-clarify>` envelope (it emitted `<workflow-output>`, both, or
 * neither). `decideEnvelopeFollowup` matches this prefix to drive a same-session
 * follow-up that re-demands the clarify envelope. Defined here (a leaf module
 * imported by both runner.ts and scheduler.ts) so producer and matcher share
 * one literal — no runner↔scheduler import cycle.
 */
export const CLARIFY_REQUIRED_PREFIX = 'clarify-required'

/**
 * RFC-123 follow-up: error-message prefix the runner stamps when a node is
 * EXPLICITLY stopped (canvas toggle='stop' OR latest answered 'stop' directive —
 * NOT review-rerun ask-back suppression) yet the agent disobeyed STOP CLARIFYING
 * and emitted a `<workflow-clarify>` envelope. Symmetric to CLARIFY_REQUIRED_PREFIX:
 * the framework REJECTS the clarify (no clarify session is created), and
 * `decideEnvelopeFollowup` drives a same-session follow-up that re-demands
 * `<workflow-output>` (the renderer coerces the reason to 'envelope-missing' while
 * hasClarify=false). Enforces the user's stop against a disobedient agent. Leaf
 * module so producer (runner) + matcher (scheduler) share one literal.
 */
export const CLARIFY_FORBIDDEN_PREFIX = 'clarify-forbidden'

/**
 * Error-message prefix the runner stamps when the agent DID emit a
 * `<workflow-output>` envelope but one or more `<port name="...">` tags were
 * opened without a parseable structural close (`</port>` missing, truncated, or
 * corrupted — e.g. a model leaked a special token into the tag, producing
 * `</|DSML|port>` instead of `</port>`). The tolerant scanner in
 * {@link parseEnvelope} cannot extract such a port, so it would otherwise come
 * back as an empty string and the run would silently complete `done` with a
 * blank port — downstream consumers (e.g. a doc-review node) then produce
 * nothing. Surfacing it as a `failed` with this prefix routes it through
 * `decideEnvelopeFollowup` for a same-session retry (and a hard fail after
 * retries) instead of silent data loss. Defined here (a leaf module imported by
 * both runner.ts and scheduler.ts) so producer and matcher share one literal —
 * no runner↔scheduler import cycle. Mirrors {@link CLARIFY_REQUIRED_PREFIX}.
 */
export const ENVELOPE_PORT_MALFORMED_PREFIX = 'envelope-port-malformed'

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
export function detectEnvelopeKind(stdout: string, nonce?: string): DetectedEnvelopeKind {
  // RFC-200: fresh per-call RegExps (envelopeRe/clarifyRe) — no shared
  // `lastIndex` to reset. With a nonce, a forged BARE envelope does not match,
  // so it can neither be采信 as output nor spuriously trip the 'both' reject.
  const hasOutput = envelopeRe(nonce).test(stdout)
  const hasClarify = clarifyRe(nonce).test(stdout)
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
export function extractClarifyEnvelopeBody(stdout: string, nonce?: string): string | null {
  const matches = [...stdout.matchAll(clarifyRe(nonce))]
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
  const malformed = new Set<string>()

  // RFC-103 T6 (05-PORT-02): structural port parsing. Reduce to the inner body
  // (so the last port can't absorb `</workflow-output>`), then for each
  // `<port name=...>` opening the content runs to its STRUCTURAL close — the
  // first `</port>` whose following non-whitespace is another `<port name=`
  // opening or the envelope-body end. This keeps BOTH a literal `</port>` AND a
  // literal `<port name=` inside a port's content intact (the old non-greedy
  // `</port>` truncated content containing a literal `</port>`). Residual
  // limit: content containing the exact sequence `</port>` + `<port name=`
  // (a fake port boundary) still mis-frames — the protocol forbids it.
  const inner = envelopeXml
    // RFC-200: strip the OPEN tag whether bare (`<workflow-output>`) or
    // nonce-scoped (`<workflow-output nonce="…">`) — `[^>]*` swallows any
    // attributes so parseEnvelope needs no nonce of its own.
    .replace(/^[\s\S]*?<workflow-output[^>]*>/, '')
    .replace(/<\/workflow-output>[\s\S]*$/, '')
  const CLOSE = '</port>'
  PORT_OPEN_RE.lastIndex = 0
  for (let m = PORT_OPEN_RE.exec(inner); m !== null; m = PORT_OPEN_RE.exec(inner)) {
    const name = m[1] ?? m[2] ?? ''
    const contentStart = m.index + m[0].length
    let searchFrom = contentStart
    let closeIdx = -1
    let resumeFrom = inner.length
    for (;;) {
      const c = inner.indexOf(CLOSE, searchFrom)
      if (c === -1) break
      const afterStart = c + CLOSE.length
      const after = inner.slice(afterStart).replace(/^\s+/, '')
      if (after.length === 0 || /^<port\s+name=/.test(after)) {
        closeIdx = c
        resumeFrom = afterStart
        break
      }
      searchFrom = afterStart
    }
    PORT_OPEN_RE.lastIndex = resumeFrom
    // A port with NO parseable structural close is MALFORMED (the agent dropped
    // / truncated / corrupted the trailing `</port>` — e.g. a leaked special
    // token turned it into `</|DSML|port>`, which the literal `</port>` scan
    // above never matches). Record it so the runner can fail+retry instead of
    // silently degrading it to an empty string.
    //
    // RFC-103 T6 history: this branch used to merely `continue` (so the port
    // landed in `missingDeclared` as `''`). The comment claimed that routed to a
    // "repair path", but `missingDeclared` never drove a failure — the runner
    // only `log.warn`'d it, so a port with no validating outputKind completed
    // `done` with blank content and downstream nodes (e.g. doc-review) produced
    // nothing. The `malformedPorts` signal closes that silent-data-loss gap.
    if (closeIdx < 0) {
      if (name.length > 0) malformed.add(name)
      continue
    }
    if (name.length === 0) continue
    const content = inner.slice(contentStart, closeIdx).trim()
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

  // Signal #2 — absorption detection. When a port's `</port>` close is corrupted
  // but a LATER port has a clean `</port>`, the scanner above grabs that later
  // close as the corrupted port's structural close — so the corrupted port is
  // "collected" with the later port's open tag + body absorbed into its content,
  // and the later (declared) port silently lands in `missingDeclared` with a
  // blank value. Signal #1 (closeIdx<0) can't see this (the corrupted port DID
  // find a close). Catch it here: a DECLARED port that is missing BUT whose
  // opening `<port name="...">` tag still appears in the envelope body was
  // present-but-absorbed, not legitimately omitted. (A legitimately-omitted port
  // has no opening tag anywhere — that's the false-positive-free discriminator,
  // and it leaves the RFC-103 "content contains a literal <port name=> for an
  // UNDECLARED name" cases untouched, since those names aren't in
  // `missingDeclared`.) Codex impl-gate P2 (2026-06-24).
  for (const name of missingDeclared) {
    if (malformed.has(name)) continue
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const openRe = new RegExp(`<port\\s+name=(?:"${esc}"|'${esc}')\\s*>`)
    if (openRe.test(inner)) malformed.add(name)
  }

  return { ports, missingDeclared, undeclared, malformedPorts: [...malformed] }
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
  /** RFC-193: list<T> per-item validate outputs (see ValidateResult.items). */
  items?: Array<{ body: string; sourcePath?: string }>
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
  // RFC-080: dispatch through the parametric registry (parseKind → matches),
  // so path<ext> / list<T> / signal validate correctly. `markdown_file` folds
  // to path<md> at parse time → identical containment / ext / existence /
  // non-empty checks as the legacy markdownFile handler. The errCode namespace
  // is the handler's displayName (D2: `port-validation-path-*`, never `<>`).
  const parsed = parseKind(kind)
  const handler = getHandlerForParsedKind(parsed)
  const result = handler.validate(
    rawContent,
    { port: opts.port ?? '', kind: parsed, worktreePath },
    NODE_VALIDATE_IO,
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
