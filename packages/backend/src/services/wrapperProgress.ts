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
    kind: z.enum(['loop', 'git']),
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
