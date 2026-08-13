// RFC-111 PR-B — Claude Code binary discovery + observational version probe.
// Mirrors util/opencode.ts. Agent runtimes are optional at daemon startup:
// absence/incompatibility is surfaced by explicit diagnostics and only fails
// nodes that actually select the runtime (RFC-226).

import { createLogger } from '@/util/log'
import type { ProbeOpts } from '../types'
// RFC-143 PR-5: shared best-effort semver extraction (display telemetry only).
import { extractVersion } from '@/util/semver'
import { spawnVersionProbe } from '@/util/process'

const log = createLogger('claude-code')

/**
 * Advisory version for the official Claude Code distribution. Custom
 * claude-code-compatible runtimes may report an opaque version, so availability
 * is determined only by whether `--version` runs successfully; protocol support
 * is established by the separate deep smoke test.
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

/** Spawn `<binary> --version`; parse optional semver telemetry when available. */
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
    // claude 侧策略（告警文案 + best-effort version telemetry）。
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

  // 2026-08-13 CodeAgent regression: fork version strings are not required to
  // use X.Y.Z. An exit-0 binary is available even when telemetry is opaque (or
  // reports an older, fork-specific version); the deep smoke path is the
  // authoritative protocol-conformance check.
  return { binary, version, compatible: ran, ran }
}
