// RFC-111 PR-B — Claude Code binary discovery + version probe + min-version gate.
// Mirrors util/opencode.ts. Agent runtimes are optional at daemon startup:
// absence/incompatibility is surfaced by explicit diagnostics and only fails
// nodes that actually select the runtime (RFC-226).

import { createLogger } from '@/util/log'
import type { ProbeOpts } from '../types'
// RFC-143 PR-5: single semver helper pair (was a byte-for-byte local copy).
import { compareSemver, extractVersion } from '@/util/semver'
import { spawnVersionProbe } from '@/util/process'

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
  claudePath?: string | readonly string[],
  opts: ProbeOpts = {},
): Promise<ClaudeProbe> {
  // RFC-282 C1（Windows P2）: an array is a full command head ([bun, run, mock]).
  const head: readonly string[] =
    typeof claudePath === 'string' ? [claudePath] : (claudePath ?? ['claude'])
  const binary = head[0]!
  const warn: typeof log.warn = opts.quiet === true ? () => {} : (msg, ctx) => log.warn(msg, ctx)
  let version: string | null = null
  let ran = false
  try {
    // RFC-284 T8：spawn 骨架（detached-iff-timeout / exit 先行 / 有界读 /
    // finally 组 reap）收敛到 util/process.spawnVersionProbe，本函数只留
    // claude 侧策略（告警文案 + semver 门）。
    const r = await spawnVersionProbe([...head, '--version'], {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    if (r.timedOut) {
      warn('claude --version timed out', { binary, timeoutMs: opts.timeoutMs })
    } else if (r.exitCode === 0) {
      ran = true
      version = extractVersion(r.stdout)
    } else {
      warn('claude --version non-zero exit', { binary, exitCode: r.exitCode })
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
