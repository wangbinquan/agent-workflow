// RFC-111 PR-B — Claude Code binary discovery + version probe + min-version gate.
// Mirrors util/opencode.ts. Unlike opencode (hard-fail at daemon startup), the
// claude probe is SOFT (D10): a missing/old claude only fails a node whose agent
// selected the claude runtime; opencode-only installs are unaffected.

import { createLogger } from '@/util/log'
import { killProcessTree } from '@/util/platform'
import type { ProbeOpts } from '@/util/opencode'
// RFC-143 PR-5: single semver helper pair (was a byte-for-byte local copy).
import { compareSemver, extractVersion } from '@/util/semver'

const log = createLogger('claude-code')

/**
 * Minimum supported Claude Code version. Verified hands-on at 2.1.193 (all
 * headless flags present, design §6.1). Conservative floor; bump as the contract
 * is re-validated against newer releases.
 */
export const MIN_CLAUDE_CODE_VERSION = '2.0.0'

export interface ClaudeProbe {
  binary: string
  version: string | null
  compatible: boolean
  incompatibleReason?: string
  /**
   * Auth source as Claude Code reports it (`apiKeySource` from the init event /
   * env). Surfaced to the settings card; `none` does NOT mean "unauthed" — a
   * subscription login still reports `none` (design §4.1). Optional: only the
   * runtime route fills this via a real probe run; the version probe leaves it
   * undefined.
   */
  apiKeySource?: string
  /**
   * RFC-135: true iff the `--version` process exited 0 — availability without
   * version parsing/gating (mirrors util/opencode.ts `OpencodeProbe.ran`).
   */
  ran?: boolean
}

/** Spawn `<binary> --version`, parse the semver. Output form: `2.1.193 (Claude Code)`. */
export async function probeClaudeCode(
  claudePath?: string,
  opts: ProbeOpts = {},
): Promise<ClaudeProbe> {
  const binary = claudePath ?? 'claude'
  const warn: typeof log.warn = opts.quiet === true ? () => {} : (msg, ctx) => log.warn(msg, ctx)
  let version: string | null = null
  let ran = false
  try {
    // Detached process group on the timeout path so SIGKILL reaps the whole
    // tree, not just a hung wrapper (see util/opencode.ts, same shape).
    const proc = Bun.spawn({
      cmd: [binary, '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
      ...(opts.timeoutMs !== undefined ? { detached: true } : {}),
    })
    let timedOut = false
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            // RFC-windows PR-1: delegate to platform.killProcessTree (POSIX group-kill
            // byte-for-byte; Windows taskkill /T /F).
            if (typeof proc.pid === 'number') killProcessTree(proc.pid, 'SIGKILL')
          }, opts.timeoutMs)
        : undefined
    try {
      // Exit wait decoupled from the stdout read, and the read itself bounded —
      // a grandchild holding the pipe write end must not hang the probe after
      // SIGKILL reaps the direct child (see util/opencode.ts, same shape).
      const outPromise = new Response(proc.stdout).text().catch(() => '')
      const exitCode = await proc.exited
      if (timedOut) {
        warn('claude --version timed out', { binary, timeoutMs: opts.timeoutMs })
      } else if (exitCode === 0) {
        ran = true
        const out =
          opts.timeoutMs !== undefined
            ? await Promise.race([
                outPromise,
                new Promise<string>((res) => setTimeout(() => res(''), opts.timeoutMs)),
              ])
            : await outPromise
        version = extractVersion(out)
      } else {
        warn('claude --version non-zero exit', { binary, exitCode })
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
        // Unconditional group reap once the probe is over — a wrapper that
        // forked then exited before the timer would otherwise leak its
        // descendants (see util/opencode.ts, same shape).
        // RFC-windows PR-1: delegated to platform.killProcessTree (cross-platform).
        if (typeof proc.pid === 'number') killProcessTree(proc.pid, 'SIGKILL')
      }
    }
  } catch (err) {
    warn('claude binary not executable', { binary, error: (err as Error).message })
  }

  if (version === null) {
    return { binary, version, compatible: false, ran }
  }
  if (compareSemver(version, MIN_CLAUDE_CODE_VERSION) < 0) {
    return {
      binary,
      version,
      compatible: false,
      incompatibleReason: `Claude Code ${version} is older than required minimum ${MIN_CLAUDE_CODE_VERSION}`,
      ran,
    }
  }
  return { binary, version, compatible: true, ran }
}
