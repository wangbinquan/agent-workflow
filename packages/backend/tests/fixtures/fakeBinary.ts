// RFC-254 T32 — a fake "binary" a test can hand to production code that spawns
// a single executable path.
//
// THE PROBLEM
// -----------
// Several suites configure a runtime by PATH (`listOpencodeModels(binary)`, the
// agent runtime's `opencodePath`) and then let production code spawn it. The
// established way to fake that was a `#!/bin/sh` script — which Windows cannot
// execute at all, so those suites failed there with
//   spawn ... EFTYPE: inappropriate file type or format, uv_spawn
// and the failure often surfaced somewhere else entirely: `fusion-engine`
// reported "cancel produced `failed` instead of `canceled`" because the runtime
// spawn died first and the task terminalized on that.
//
// WHAT ACTUALLY WORKS ON WINDOWS, MEASURED
// ----------------------------------------
// `Bun.spawn` DOES execute a `.cmd` directly (verified on Windows 11) — which
// is worth stating precisely, because `node:child_process.spawn` does NOT: it
// refuses batch files with EFTYPE, and that difference is the whole reason the
// plugin installer is broken on Windows while this fixture can work.
//
// AND THE CATCH, ALSO MEASURED
// ----------------------------
// Windows runs a batch file THROUGH cmd.exe, so its arguments are re-tokenized
// even without `shell: true`. Measured on the same host:
//   ['a&whoami']  → argument becomes `a`, and `whoami` EXECUTES
//   ['x|y']       → the pipe is interpreted
//   ['%PATH%']    → the variable expands and splits on spaces
// That is fine HERE and only here: every argument these fakes receive is
// written by the test itself (`models --verbose`). It is NOT a pattern for
// production, where arguments carry user, DB or repository content — see
// `docs/audit-backlog.md` for the evidence and the rule.
//
// WHY THE PAYLOAD LIVES IN A FILE
// -------------------------------
// The old sh version interpolated the expected stdout into a `printf` and
// escaped quotes by hand. Reproducing that in batch means fighting `%`, `&`,
// `<`, `>` and `^` as well, for output that then has to match byte for byte.
// Reading the bytes from a file sidesteps escaping entirely and makes both
// platforms emit the SAME bytes, which is what the assertions actually want.

import { chmodSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface FakeBinarySpec {
  /** Exact bytes on stdout. No trailing newline is added. */
  stdout?: string
  /** Exact bytes on stderr. No trailing newline is added. */
  stderr?: string
  exitCode?: number
  /** Append the received arguments to `args.log` beside the binary. */
  recordArgs?: boolean
  /** Block this long before exiting — for timeout/kill tests. */
  sleepSeconds?: number
}

/**
 * The path a fake binary should live at: `<dir>/<base>` on POSIX, and
 * `<dir>/<base>.cmd` on Windows, because there an extension is what makes a
 * file executable at all.
 */
export function fakeBinaryPath(dir: string, base: string): string {
  return join(dir, process.platform === 'win32' ? `${base}.cmd` : base)
}

/** Write (and on POSIX, chmod) a fake binary that behaves per `spec`. */
export function writeFakeBinary(path: string, spec: FakeBinarySpec = {}): void {
  const { stdout = '', stderr = '', exitCode = 0, recordArgs = false, sleepSeconds } = spec
  const stdoutFile = `${path}.stdout`
  const stderrFile = `${path}.stderr`
  // Always written, even when empty: `type`/`cat` on a MISSING file writes an
  // error to stderr, which would contaminate the very stream under assertion.
  writeFileSync(stdoutFile, stdout)
  writeFileSync(stderrFile, stderr)
  const argsLog = join(dirname(path), 'args.log')

  if (process.platform === 'win32') {
    const lines = ['@echo off']
    if (recordArgs) lines.push(`echo %* >> "${argsLog}"`)
    // `ping` rather than `timeout`: `timeout` needs a console and fails outright
    // when stdin is redirected, which is exactly how a spawned child runs.
    if (sleepSeconds !== undefined) lines.push(`ping -n ${sleepSeconds + 1} 127.0.0.1 >nul`)
    lines.push(`type "${stdoutFile}"`, `type "${stderrFile}" 1>&2`, `exit /b ${exitCode}`)
    writeFileSync(path, `${lines.join('\r\n')}\r\n`)
    return
  }

  const lines = ['#!/bin/sh']
  if (recordArgs) lines.push(`echo "$@" >> "${argsLog}"`)
  if (sleepSeconds !== undefined) lines.push(`sleep ${sleepSeconds}`)
  lines.push(`cat "${stdoutFile}"`, `cat "${stderrFile}" >&2`, `exit ${exitCode}`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  chmodSync(path, 0o755)
}
