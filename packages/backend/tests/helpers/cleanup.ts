// RFC-W001: Windows-tolerant recursive cleanup for tests.
//
// `rimrafDir(target)` in afterEach/afterAll is
// the universal teardown idiom across this suite. On Windows it intermittently
// throws EBUSY / EPERM / ENOTEMPTY because the sqlite WAL files, the OS, an
// antivirus scan, or the search indexer still hold a handle the instant the
// test releases it - failing an otherwise-green test for a reason unrelated to
// what's under test. This helper retries with a short backoff and, as a last
// resort on Windows, swallows the error (each test uses a unique mkdtemp dir,
// so leftover temp files never cross-contaminate). On POSIX it is a thin pass-
// through so behaviour is byte-identical to before.
//
// This module is imported (for rimrafDir) by nearly every test file, so it is
// also the natural place to normalize the test-process git environment once:
// the dev/CI Windows box ships `core.autocrlf=true` (Git for Windows default),
// which converts LF -> CRLF on worktree checkout and breaks byte-exact file
// assertions. The GIT_CONFIG_COUNT env vars override the global/system config
// for every git subprocess this process spawns (runGit spreads process.env;
// execSync inherits it), forcing `core.autocrlf=false` for byte-deterministic
// checkouts. `.gitattributes` still wins. POSIX is a no-op (autocrlf already
// false there). Test-only - never touches the daemon's production git env.

// Force core.autocrlf=false for all git invocations in this test process
// (RFC-W001). Done at module load so it is set before any test runs git.
if (process.env.GIT_CONFIG_COUNT === undefined) {
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.autocrlf'
  process.env.GIT_CONFIG_VALUE_0 = 'false'
}

import { rmSync, chmodSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const isWindows = process.platform === 'win32'

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

/** Clear the read-only bit recursively (git writes its objects read-only; on
 *  Windows rmSync refuses read-only files). Best-effort, never throws. */
function clearReadOnlyRecursive(target: string): void {
  try {
    const st = statSync(target)
    if (st.isDirectory()) {
      for (const entry of walkEntries(target)) {
        try {
          chmodSync(entry, 0o777)
        } catch {
          /* ignore */
        }
      }
    }
    try {
      chmodSync(target, 0o777)
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

function* walkEntries(dir: string): Generator<string, void, undefined> {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    yield p
    try {
      if (statSync(p).isDirectory()) yield* walkEntries(p)
    } catch {
      /* ignore */
    }
  }
}

/** Recursively remove `target`, retrying on transient Windows locks. Missing
 *  paths are silently ignored (matches `force: true`). Never throws on Windows;
 *  on POSIX it throws exactly like `rmSync` would. */
export function rimrafDir(target: string): void {
  if (!existsSync(target)) return
  const opts = { recursive: true, force: true } as const
  if (!isWindows) {
    rmSync(target, opts)
    return
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(target, opts)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !RETRY_CODES.has(code)) throw err
      if (attempt >= 4) {
        // Final attempt: clear read-only attrs, retry once, then give up
        // silently (leftover temp dir in a unique mkdtemp path is harmless).
        clearReadOnlyRecursive(target)
        try {
          rmSync(target, opts)
        } catch {
          /* swallow - Windows lock that won't release; not a test-correctness issue */
        }
        return
      }
      // Synchronous backoff so the OS / AV can release the handle.
      try {
        ;(Bun as unknown as { sleepSync?: (ms: number) => void }).sleepSync?.(20 * (attempt + 1))
      } catch {
        /* Bun.sleepSync unavailable; fall through to retry */
      }
    }
  }
}
