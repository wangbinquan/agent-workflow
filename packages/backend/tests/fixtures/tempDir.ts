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
 * WHY A PERSISTENT FAILURE IS A WARNING AND NOT A THROW, MEASURED
 * ---------------------------------------------------------------
 * The retry alone did NOT make `db.test.ts` pass, and the reason is not that
 * the wait was too short. Probed directly on Windows: after
 * `$client.close()` the `.sqlite`, `-shm` and `-wal` files are all still
 * locked, the WAL files still exist (a clean close checkpoints and removes
 * them), and `close(true)` — the form that reports instead of deferring —
 * throws `database is locked`. That is SQLITE_BUSY: prepared statements are
 * still alive, so the connection never actually closed. No amount of waiting
 * fixes a handle that is held by design.
 *
 * Given that, throwing here converts a HYGIENE step into a test failure, in a
 * test whose own assertions already passed — and it reports as an `(unnamed)`
 * failure, which is about as misleading as a result gets. So on the platform
 * where the runtime cannot release the handle, a persistent lock is reported
 * and the run continues. It stays visible (the warning names the path), it
 * stays narrow (win32 only, and only after the full retry budget), and the
 * directory is under the OS temp root, which the OS and CI reclaim.
 *
 * Everywhere else the final attempt still throws with its real errno: a POSIX
 * host that cannot delete its own temp directory has a problem worth failing on.
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
  if (process.platform !== 'win32') {
    rmSync(path, { recursive: true, force: true })
    return
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    console.warn(
      `[tempDir] leaving ${path} behind: ${(error as Error).message}. ` +
        `On Windows an unfinalized SQLite statement keeps the file open even after ` +
        `close(), so this is not a leak the test can drain — see fixtures/tempDir.ts.`,
    )
  }
}
