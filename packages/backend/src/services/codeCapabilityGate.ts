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

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve } from 'node:path'
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
 * A timeout, a non-zero exit and a crash all come back the same way: a non-zero
 * `exitCode` and whatever output there was. The caller's question is only
 * "green or not", and a gate that hung is not green.
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

    const shell =
      process.platform === 'win32'
        ? { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', trimmed] }
        : { file: '/bin/sh', args: ['-c', trimmed] }

    return await new Promise<GateCommandResult>((settle) => {
      let finished = false
      let collected = ''
      let truncated = false

      const child = spawn(shell.file, shell.args, {
        cwd: worktreePath,
        env: { ...process.env, ...(options.env ?? {}) },
        // The gate is not interactive; a command that waits on stdin must fail
        // rather than hang until the timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const absorb = (chunk: Buffer | string): void => {
        if (collected.length >= GATE_OUTPUT_LIMIT) {
          truncated = true
          return
        }
        collected += String(chunk)
        if (collected.length > GATE_OUTPUT_LIMIT) {
          collected = collected.slice(0, GATE_OUTPUT_LIMIT)
          truncated = true
        }
      }
      child.stdout?.on('data', absorb)
      // Merged, not separated: a failing gate usually says why on stderr, and
      // splitting them here would hand the model half the story.
      child.stderr?.on('data', absorb)

      const done = (exitCode: number, note?: string): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        const suffix = [
          truncated ? `\n[output truncated at ${String(GATE_OUTPUT_LIMIT)} characters]` : '',
          note === undefined ? '' : `\n[${note}]`,
        ].join('')
        settle({ exitCode, output: `${collected}${suffix}` })
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done(124, `the gate did not finish within ${String(Math.round(timeoutMs / 1000))}s`)
      }, timeoutMs)

      const onAbort = (): void => {
        child.kill('SIGKILL')
        done(125, 'the round was cancelled while the gate was running')
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err: Error) => {
        // Could not start at all — a command naming a tool this host does not
        // have. Reported as a failed gate with the reason, which is what an
        // operator needs to see on the merge request.
        log.warn('the gate command could not be started', {
          worktreePath,
          error: err.message,
        })
        done(127, `the gate command could not be started: ${err.message}`)
      })
      child.on('close', (code: number | null, signal: string | null) => {
        done(code ?? (signal === null ? 1 : 137))
      })
    })
  }
}
