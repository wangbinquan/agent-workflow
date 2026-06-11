// RFC-040 — wrapper-loop / wrapper-git progress persistence.
//
// `runLoopWrapperNode` and `runGitWrapperNode` (services/scheduler.ts) use
// this module to encode/decode the JSON payload stored in
// `node_runs.wrapper_progress_json`. The payload is the minimum scheduler
// state needed to resume a wrapper after it bubbled awaiting_human /
// awaiting_review up from its inner scope:
//
//   - wrapper-loop: which iteration we parked on. This iteration is ALSO the
//     scan window `wrapperHasFreshInnerWork` (dispatchFrontier.ts) uses to
//     decide whether a parked wrapper row may re-dispatch: the rerun row that
//     `submitClarifyAnswers` / `submitReviewDecision` minted while we were
//     suspended lives at this inner iteration, not at the wrapper row's own
//     (outer) iteration. On resume the wrapper re-calls runScope at the same
//     iteration and deriveFrontier picks the rerun row up. (The old
//     `rescanScopeForNewPendingRows` this comment used to cite was deleted in
//     RFC-076; fixed by RFC-094, audit S-26. Note audit S-3: approve leaves
//     NO pending inner row, so an approved review inside a wrapper does not
//     re-dispatch it — locked by scheduler-audit-s03, fix queued in WP-6c.)
//
//   - wrapper-git: the baseline commit we captured before the inner scope
//     started. We MUST NOT re-capture HEAD on resume — the worktree has
//     diverged from the baseline while the inner agent was running, and the
//     final diff is meant to be against the pre-inner state, not the
//     pre-resume state.
//
//   - wrapper-fanout (RFC-098 B3, audit S-20): the persisted `reuseDisabled`
//     gate — see the field doc below. `runFanoutWrapperNode` writes it when
//     the consumed generation gate trips and reads it back on resume.
//
// `phase` is informational: it lets future debuggers tell apart "wrapper
// parked while inner scope was running" from "wrapper finished iteration N's
// scope and was about to evaluate exit_condition". The scheduler does NOT
// branch on phase today; it always re-enters at the persisted iteration and
// lets runScope drive the rest.
//
// Pure functions. Single dependency on zod; no DB / Bun / Node IO. The
// scheduler owns the persistence side (writing the encoded string into
// `node_runs.wrapper_progress_json` via drizzle).

import { z } from 'zod'

export const WrapperProgressSchema = z
  .object({
    kind: z.enum(['loop', 'git', 'fanout']),
    /**
     * wrapper-loop only: the 0-based iteration the wrapper is currently
     * working on. Must be present when `kind === 'loop'`; the scheduler's
     * resume helper treats a malformed (missing-iteration) loop payload as
     * "no progress, run init path" — i.e. it returns null from decode and
     * the wrapper starts at iter 0. This is the same observable failure
     * mode as before RFC-040 and is acceptable as the malformed-payload
     * fallback.
     */
    iteration: z.number().int().nonnegative().optional(),
    /**
     * wrapper-git only: the commit hash captured by `git rev-parse HEAD`
     * before the wrapper's inner scope started. Must be present when
     * `kind === 'git'`; an empty string is treated as "no baseline" by the
     * caller (matches the pre-RFC-040 `gitDiffSnapshot(worktree, '')`
     * fallback path).
     */
    baseline: z.string().optional(),
    /**
     * RFC-098 B3 (audit S-4) — wrapper-git only: the worktree's PRE-EXISTING
     * dirty set, sampled right after the baseline capture (same task-write-
     * lock window) at FRESH MINT only: `{ path: blobSha | 'deleted' }` for
     * every path `gitChangedFiles(worktree, baseline)` reported before the
     * inner scope started. At finalize a post path is subtracted iff it is in
     * this map AND its current state matches (hash-equal, or both 'deleted')
     * — a pre-dirty file the inner scope REWROTE stays in git_diff; one it
     * touched-then-reverted does not (consistent with git status semantics).
     * Resume reads this map from progress; absent/malformed degrades to the
     * EMPTY set (= the pre-fix cumulative behavior: over-report, never
     * drop real changes) and NEVER re-captures (the inner scope's own writes
     * are already in the worktree by then). Capped at capture time (4096
     * entries / 256KB JSON → degrade to empty set, see scheduler.ts
     * captureGitPreDirty).
     */
    preDirty: z.record(z.string(), z.string()).optional(),
    /**
     * RFC-098 B3 (audit S-20, adversarial-review revision #7) — wrapper-fanout
     * only: set to true when the wrapper-entry consumed generation gate
     * tripped (the previously recorded consumed provenance differs from the
     * freshly resolved one — an external upstream re-ran while this wrapper
     * was parked/failed). While true, dispatchFanoutShard /
     * dispatchFanoutAggregator must NOT replay any done child row (full
     * re-run), closing the path-family hash blind spot (same path string,
     * different upstream content). PERSISTED — an in-memory flag would be
     * lost on a daemon crash AFTER the consumed column was already
     * overwritten, and the resumed run would replay stale shard results
     * because its consumed comparison now passes. Cleared by
     * markWrapperTerminal once the wrapper reaches a terminal state (by then
     * every shard owns a row from the disabled generation, so reuse is safe
     * again).
     */
    reuseDisabled: z.boolean().optional(),
    /**
     * 'inner-running' = before the inner scope returned; 'awaiting' = parked
     * on awaiting_*; 'iter-done' (loop only) = iteration N's scope returned
     * ok and the wrapper was about to evaluate exit_condition. Scheduler
     * does NOT branch on phase today; it is debug-only metadata.
     */
    phase: z.enum(['inner-running', 'awaiting', 'iter-done']),
  })
  .passthrough() // forward-compat for future fields without breaking old payloads

export type WrapperProgress = z.infer<typeof WrapperProgressSchema>

export function encodeWrapperProgress(progress: WrapperProgress): string {
  return JSON.stringify(progress)
}

/**
 * Returns null on parse failure → caller treats as "no progress, run init
 * path" (a worse outcome than resume, but never a crash). `warn` is invoked
 * once with a short diagnostic so operators can see when payloads went bad.
 */
export function decodeWrapperProgress(
  raw: string | null | undefined,
  warn: (msg: string) => void,
): WrapperProgress | null {
  if (raw == null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    warn(`[rfc040] wrapper_progress_json invalid JSON: ${(e as Error).message}`)
    return null
  }
  const r = WrapperProgressSchema.safeParse(parsed)
  if (!r.success) {
    warn(`[rfc040] wrapper_progress_json shape mismatch: ${r.error.message}`)
    return null
  }
  return r.data
}
