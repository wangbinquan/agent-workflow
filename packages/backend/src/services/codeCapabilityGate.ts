// RFC-304 — running the TARGET repository's own gate, and reading the file that
// names it.
//
// Two capabilities depend on this and neither could reach it: `ci-fix` proves a
// fix by running the gate and comparing red to green (`validate-fix`), and
// `requirement` runs it before opening a merge request (`run-target-gate`).
// Both take the runner as a seam — `runGateCommand` / `readWorktreeFile` on the
// wiring input — and the scheduler passed neither, so the wiring installed the
// placeholder that throws `no gate runner is wired for this round`.
//
// What that meant in practice: `ci-fix` could produce a change and then had no
// way to say whether it worked, which is the one thing that capability is for.
//
// ## Why the command comes from the repository
//
// The design is explicit (registry, `run-target-gate`): the gate is read from
// the repository's own CLAUDE.md / AGENTS.md / CONTRIBUTING.md rather than
// configured on the platform, because a platform that hardcoded `npm test`
// would be wrong in most repositories and confidently so. This module executes
// what that discovery found; it deliberately does not second-guess it.
//
// Consequently this runs a command the repository chose, in a worktree the
// platform prepared — the same trust boundary the runtime children already sit
// on (an agent writes and runs code in that worktree by design). It is noted
// here so the boundary is explicit rather than incidental.

import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve } from 'node:path'
import { runManagedProcess } from '@/services/execution/managedProcess'
import { createLogger } from '@/util/log'

const log = createLogger('code-gate')

/** A gate that runs longer than this is not going to answer this round. */
export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Kept because the output is quoted back into a merge-request comment and fed
 * to the model as evidence. A gate that prints a hundred megabytes of test log
 * would otherwise blow up both.
 */
export const GATE_OUTPUT_LIMIT = 200_000

export interface GateCommandResult {
  exitCode: number
  output: string
}

/**
 * Read a file out of the worktree, or `null` if it is not there.
 *
 * `null` rather than a throw: "this repository has no CLAUDE.md" is the
 * ordinary case for the discovery loop that calls this, not an error.
 *
 * Refuses to escape the worktree. The relative path comes from a fixed list of
 * candidates today, but the seam is generic and a `..` that walked out of the
 * tree would read whatever the daemon can reach.
 */
export function makeWorktreeFileReader(
  worktreePath: string,
): (relativePath: string) => Promise<string | null> {
  const root = resolve(worktreePath)
  return async (relativePath: string): Promise<string | null> => {
    if (isAbsolute(relativePath)) return null
    const target = resolve(root, normalize(relativePath))
    const rel = relative(root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    try {
      return await readFile(target, 'utf8')
    } catch {
      return null
    }
  }
}

export interface GateRunnerOptions {
  timeoutMs?: number
  /** Cancels the run when the round is cancelled. */
  signal?: AbortSignal
  /** Extra environment for the gate; merged over the daemon's own. */
  env?: Record<string, string>
}

/**
 * Run the repository's gate command in its worktree.
 *
 * Through the platform shell rather than `argv`, because what discovery found
 * is a command line as a human wrote it in a document — `bun run gate:local`,
 * `make check && npm test` — and splitting that ourselves would get quoting and
 * operators wrong in ways that look like the gate failing.
 *
 * Through `runManagedProcess` rather than a `spawn` of its own: that is the
 * platform's single process entry point, and it already owns the things a
 * hand-rolled spawn gets subtly wrong — TERM→KILL escalation across the whole
 * process TREE (a gate is usually a script that starts compilers and test
 * runners, and killing only the shell leaks every one of them), the bounded
 * post-exit drain, and the output caps. RFC-284's spawn-site ratchet exists to
 * keep exactly this from proliferating.
 *
 * A timeout, a non-zero exit and a failure to start all come back the same way:
 * a non-zero `exitCode` and whatever output there was. The caller's question is
 * only "green or not", and a gate that hung is not green.
 */
export function makeGateRunner(
  worktreePath: string,
  options: GateRunnerOptions = {},
): (command: string) => Promise<GateCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS

  return async (command: string): Promise<GateCommandResult> => {
    const trimmed = command.trim()
    if (trimmed === '') {
      return { exitCode: 1, output: 'the gate command found in the repository was empty' }
    }

    const argv =
      process.platform === 'win32'
        ? [process.env.COMSPEC ?? 'cmd.exe', '/d', '/s', '/c', trimmed]
        : ['/bin/sh', '-c', trimmed]

    // Merged, not separated: a failing gate usually says why on stderr, and
    // splitting the two would hand the model half the story.
    const lines: string[] = []
    let size = 0
    let truncated = false
    const absorb = (line: string): void => {
      const room = GATE_OUTPUT_LIMIT - size
      if (room <= 0) {
        truncated = true
        return
      }
      // Cut the line that crosses the cap rather than letting it through whole:
      // a single line of a test log can be long, and "the limit, plus however
      // much the last line happened to be" is not a limit.
      const kept = line.length + 1 <= room ? line : line.slice(0, room)
      if (kept !== line) truncated = true
      lines.push(kept)
      size += kept.length + 1
    }

    const result = await runManagedProcess({
      argv,
      cwd: worktreePath,
      env: { ...(process.env as Record<string, string>), ...(options.env ?? {}) },
      timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      // The gate is not interactive; a command that waits on stdin must fail
      // rather than hang until the timeout.
      stdin: { mode: 'ignore' },
      onStdoutLine: absorb,
      onStderrLine: absorb,
      log,
    })

    const note =
      result.outcome === 'timeout'
        ? `the gate did not finish within ${String(Math.round(timeoutMs / 1000))}s`
        : result.outcome === 'aborted'
          ? 'the round was cancelled while the gate was running'
          : result.outcome === 'spawn-failed'
            ? 'the gate command could not be started on this host'
            : result.outcome === 'child-unkillable'
              ? 'the gate left a process behind that could not be killed'
              : null

    if (note !== null) {
      log.warn('the gate did not complete normally', {
        worktreePath,
        outcome: result.outcome,
      })
    }

    const output = [
      lines.join('\n'),
      truncated || result.truncated.stdout || result.truncated.stderr
        ? `\n[output truncated at ${String(GATE_OUTPUT_LIMIT)} characters]`
        : '',
      note === null ? '' : `\n[${note}]`,
    ].join('')

    return {
      // A null exit code means the child never reported one — timed out, was
      // aborted, or never started. None of those is green.
      exitCode: result.exitCode ?? (result.outcome === 'exited' ? 0 : 1),
      output,
    }
  }
}
