// RFC-254 — a ref'd replacement for `AbortSignal.timeout()`.
//
// WHY NOT AbortSignal.timeout
// ---------------------------
// Its internal timer carries unref semantics, and on Windows Bun an unref'd
// timer never fires once nothing ref'd remains on the event loop. Measured
// under `bun test` (Windows 11 ARM64, Bun 1.3.14): a test that awaits nothing
// but an `AbortSignal.timeout(50)` abort wedges forever, while macOS passes it
// in 94ms. In production the same shape means "a fetch against a black-holed
// host never times out if the daemon happens to be otherwise idle" — the exact
// pinning the timeout was added to prevent. `renderPlantuml`'s never-settling
// endpoint test froze the whole Windows suite through this.
//
// This helper is the same contract with a REF'D timer, plus an explicit
// `cancel` so settled callers do not leave the daemon's loop held for the
// remainder of the window: `AbortSignal.timeout` cleans itself up when the
// fetch settles; a manual controller cannot know, so the caller says so.
// Callers that cannot be bothered may skip cancel — the cost is only that the
// process stays referenced for up to `ms`.
//
// Guarded by rfc254-no-unref-deadline-guard.test.ts, which bans new
// `AbortSignal.timeout` call sites in src.

export interface TimeoutSignal {
  signal: AbortSignal
  /** Clear the timer once the guarded operation has settled. Idempotent. */
  cancel: () => void
}

export function timeoutSignal(ms: number): TimeoutSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`operation timed out after ${ms}ms`, 'TimeoutError'))
  }, ms)
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  }
}
