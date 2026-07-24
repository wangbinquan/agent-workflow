// RFC-026 — inline-session-mode fallback detection.
// (RFC-217 T9: renamed clarifyFallback.ts → sessionModeFallback.ts and moved
// out of the clarify namespace — this is a session-resume concern, pure and
// orthogonal to the clarify round lifecycle.)
//
// Inline mode is an optimization on top of RFC-023's clarify rerun path: when
// the upstream clarify node is configured `sessionMode: 'inline'`, the
// scheduler asks the runner to spawn opencode with `--session <prior-id>` so
// the agent keeps its full prior transcript. That works only when:
//   1. The prior agent run captured an opencode session id (see
//      runner.ts:`RunResult.sessionId` + scheduler persistence into
//      node_runs.opencode_session_id).
//   2. opencode still recognises that id (no upstream schema migration /
//      manual deletion / version mismatch).
//
// When either condition fails, the optimization must transparently degrade
// to the isolated path (no `--session` flag, full Q&A history dumped into the
// next prompt — RFC-023 behavior). This module centralises both decisions:
//   - `decideResumeSessionId` — pre-spawn: should we pass --session?
//   - `detectSessionNotFoundFromStderr` — post-spawn: did opencode reject the id?
//
// Pure functions. No DB / Bun / Node IO. The scheduler is responsible for
// recording warnings into node_run_events when these return a fallbackReason.

/**
 * RFC-026 fallback reasons. Recorded as the `detail` of an
 * `inline-clarify-fallback-to-isolated` warning event so operators can
 * tell apart "we never had a session id" from "opencode rejected ours" etc.
 */
export type ClarifyInlineFallbackReason =
  | 'missing-session-id'
  | 'session-not-found'
  | 'session-resume-unsupported'

export interface DecideResumeSessionIdInput {
  /** Mode resolved from the upstream clarify node (RFC-026 ClarifySessionMode). */
  sessionMode: 'isolated' | 'inline'
  /** opencode session id captured on the source agent run, if any. */
  sourceSessionId: string | null | undefined
  /**
   * When false, a behavior/capability probe has established that this runtime
   * cannot resume a prior session. This is deliberately not inferred from the
   * reported OpenCode version.
   */
  supportsSessionResume?: boolean
}

export interface DecideResumeSessionIdResult {
  /** When set, the scheduler should pass this to `runner.runNode({ resumeSessionId })`. */
  resumeSessionId?: string
  /** When set, the scheduler should record a fallback warning event. */
  fallbackReason?: ClarifyInlineFallbackReason
  /**
   * `true` when the rendered prompt should use the inline-mode short
   * reminder + current-round-only answers. `false` keeps RFC-023 isolated
   * behavior (full history, full bi-modal preamble, full clarify protocol).
   */
  inlineMode: boolean
}

/**
 * Decide whether the upcoming opencode spawn should resume a prior session.
 *
 * Pure function — the scheduler glues this into the actual DB lookup + event
 * recording. Three failure modes degrade gracefully to isolated:
 *   - `sessionMode === 'isolated'`   → never resume (no warning; user's choice).
 *   - missing source session id      → fallback `missing-session-id`.
 *   - behavior probe rejects resume  → fallback `session-resume-unsupported`.
 *
 * Note: `session-not-found` is decided AFTER the spawn (stderr inspection),
 * not here. This function runs PRE-spawn.
 */
export function decideResumeSessionId(
  input: DecideResumeSessionIdInput,
): DecideResumeSessionIdResult {
  if (input.sessionMode !== 'inline') {
    // Author chose isolated — not a fallback, no warning event.
    return { inlineMode: false }
  }
  if (input.supportsSessionResume === false) {
    return { inlineMode: false, fallbackReason: 'session-resume-unsupported' }
  }
  if (
    input.sourceSessionId === null ||
    input.sourceSessionId === undefined ||
    input.sourceSessionId.length === 0
  ) {
    return { inlineMode: false, fallbackReason: 'missing-session-id' }
  }
  return { inlineMode: true, resumeSessionId: input.sourceSessionId }
}

// -----------------------------------------------------------------------------
// stderr pattern detection — post-spawn fallback.
// -----------------------------------------------------------------------------

const SESSION_NOT_FOUND_PATTERNS: RegExp[] = [
  /\bsession not found\b/i,
  /\bsession\b[^\n]*\bdoes not exist\b/i,
  /\bunknown session\s*id?\b/i,
  /\bno such session\b/i,
]

/**
 * Returns `true` when opencode's stderr (after the run exited) indicates the
 * `--session <id>` we passed is not recognised — likely because the session
 * was deleted, schema-migrated, or never existed. The scheduler treats this
 * as a hard fail of the inline path: the current node_run is marked failed
 * and a retry (which does NOT inherit `resumeSessionId`) starts isolated.
 *
 * Multi-pattern by design: opencode wording has shifted across minor
 * versions, and this regex set is the only place we touch it — extend it
 * when a real-world stderr surface escapes detection, don't sprinkle string
 * matches at the call sites.
 */
export function detectSessionNotFoundFromStderr(stderr: string): boolean {
  if (stderr.length === 0) return false
  return SESSION_NOT_FOUND_PATTERNS.some((re) => re.test(stderr))
}
