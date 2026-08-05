// RFC-254 T32 — removing a test's temp directory on a platform that refuses to
// delete open files.
//
// POSIX unlinks a path regardless of who still holds it open; the inode simply
// lives until the last handle closes. Windows does not: an open handle makes
// the delete fail outright with EBUSY. A test that opens a SQLite file and then
// `rmSync`s its directory therefore passes everywhere and fails there — and the
// failure lands in teardown, so it is reported against an `(unnamed)` test with
// the real work already green, which is about as misleading as a failure gets.
//
// TWO PROBLEMS, AND THIS HELPER ONLY FIXES ONE OF THEM
// ----------------------------------------------------
// Retrying helps when the handle is ALREADY closed and the OS has simply not
// caught up — a real effect on Windows, where an indexer or scanner can hold a
// file briefly after the owner released it.
//
// Retrying does NOT help when the test never closed the handle. That is a leak,
// and the fix is to close it; no retry count rescues a handle that is still
// open by design. Reach for this helper as the second line of defence, after
// the teardown actually releases what it opened.

import { rmSync } from 'node:fs'

/**
 * Remove a test temp directory, tolerating a briefly-held Windows handle.
 *
 * THE BACKOFF IS SPELLED OUT HERE ON PURPOSE. The obvious version delegates to
 * Node's own `{ maxRetries, retryDelay }`, and that was tried first — it made
 * no difference on Windows, because this suite runs under Bun and Bun's
 * `node:fs.rmSync` accepts those options without implementing the retry. The
 * call looked like it was retrying and was doing exactly one attempt.
 *
 * So the loop is explicit and its behaviour is visible: about a second in
 * total, which is far more than a lagging release needs and short enough not to
 * park a leak behind a long pause. The final attempt is deliberately outside
 * the catch so a genuine failure still throws with its real errno rather than
 * being swallowed by the helper.
 *
 * WHAT THIS DOES NOT FIX, MEASURED
 * --------------------------------
 * `db.test.ts` and `cli.test.ts` STILL fail with EBUSY on Windows with this in
 * place, and the timing proves the retry is running (teardown went from 0.6ms
 * to ~1376ms, i.e. it burned the full budget). Their SQLite handles are closed
 * via `$client.close()` first, so something outlives that close by more than a
 * second — a lingering child process, or Bun's sqlite not releasing the file
 * when asked. That is an open question, tracked in `docs/audit-backlog.md`; do
 * not read this helper as having settled it. Waiting longer is not the answer
 * to a handle that is never released.
 */
export function removeTempDirSync(path: string, attempts = 10, delayMs = 100): void {
  for (let i = 0; i < attempts - 1; i += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch {
      Bun.sleepSync(delayMs)
    }
  }
  rmSync(path, { recursive: true, force: true })
}
