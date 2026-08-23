// OpenCode binary discovery + observational version probe.
//
// Reported versions are telemetry only; runtime execution uses the configured
// command directly and does not make semver an admission boundary.

import { createLogger } from '@/util/log'
import { extractVersion } from '@/util/semver'
import { recordOpencodeBinaryVersion } from './versionRegistry'
import { DEFAULT_VERSION_PROBE_TIMEOUT_MS, spawnVersionProbe } from '@/util/process'
// RFC-282 C0 (设计门 P2-7) — the probe-options shape lives on the runtime
// contract surface; this module re-exports it so existing `util/opencode`
// import sites keep resolving until C3 relocates the whole module.
import type { ProbeOpts } from '@/services/runtime/types'
export type { ProbeOpts } from '@/services/runtime/types'

// RFC-143 PR-5: extractVersion/compareSemver live in ./semver (single copy,
// shared with the claude probe); re-exported so existing import sites
// (opencode-version.test.ts) keep resolving from this module.
export { compareSemver, extractVersion } from '@/util/semver'

const log = createLogger('opencode')
/**
 * RFC-135: optional knobs for the `--version` probes (opencode + claude-code).
 * Omitting both fields is byte-identical to the historical behavior for
 * explicit diagnostics and legacy callers. RFC-226 removed the boot caller.
 */

export interface OpencodeProbe {
  /** Resolved binary path (absolute when overridden, "opencode" when on PATH). */
  binary: string
  /** Parsed "X.Y.Z" telemetry, or null when the runtime uses another scheme. */
  version: string | null
  /**
   * Transport availability only: true iff `--version` exited zero. RFC-227
   * deliberately does not infer protocol compatibility from this value.
   */
  compatible: boolean
  /**
   * Reserved for transport-level diagnostic detail. Version text never
   * populates this field.
   */
  incompatibleReason?: string
  /**
   * True iff the `--version` process exited 0. RFC-226 runtime status combines
   * this transport result with `compatible`; daemon startup does not probe.
   */
  ran?: boolean
}

/**
 * Spawn `<binary> --version` and collect optional semver telemetry. An exit-0
 * binary remains available even when its version output is non-semver.
 */
export async function probeOpencode(
  opencodePath?: string | readonly string[],
  opts: ProbeOpts = {},
): Promise<OpencodeProbe> {
  // RFC-282 C1（Windows P2）: an array is a full command head ([bun, run, mock]).
  const head: readonly string[] =
    typeof opencodePath === 'string' ? [opencodePath] : (opencodePath ?? ['opencode'])
  const binary = head[0]!
  const warn: typeof log.warn = opts.quiet === true ? () => {} : (msg, ctx) => log.warn(msg, ctx)
  let version: string | null = null
  let ran = false
  try {
    // RFC-284 T8：spawn 骨架收敛 util/process.spawnVersionProbe（detached 仅在
    // 有 timeout 时开——无-timeout 保持历史 flat spawn 的承诺由骨架参数化兑现；
    // exit 先行防孙进程持管道；finally 组 reap 防提前退出的 wrapper 漏杀）。
    // 本函数只留 opencode 侧策略：告警文案 + flag-spelling registry 记录。
    const r = await spawnVersionProbe([...head, '--version'], {
      // RFC-317 T36（EK-02 / C4）—— 省略 timeoutMs 曾意味着「无进程组、无树杀、
      // 无超时、stdout 无上限」。现在没有这个模式了：调用方不给就用具名默认。
      timeoutMs: opts.timeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS,
    })
    if (r.timedOut) {
      warn('opencode --version timed out', { binary, timeoutMs: opts.timeoutMs })
    } else if (r.exitCode === 0) {
      ran = true
      version = extractVersion(r.stdout)
      // 2026-07-21: seed the spawn-time flag-spelling registry. Every probe
      // path funnels through here (doctor / runtime validation / status
      // poll), so a successful probe is exactly when we know which spelling
      // of the auto-approve flag this binary takes — see
      // opencode-version-registry.ts + spawn.ts resolveAutoApproveFlag.
      // Only on ran=true: a transient probe failure must not clobber a good
      // record with null.
      recordOpencodeBinaryVersion(binary, version)
    } else {
      warn('opencode --version non-zero exit', { binary, exitCode: r.exitCode })
    }
  } catch (err) {
    warn('opencode binary not executable', { binary, error: (err as Error).message })
  }

  return { binary, version, compatible: ran, ran }
}

// （RFC-143 PR-5 的 resolveOpencodeCmd 单份已于 RFC-284 T19 删除：RFC-282 C1 后
// config.opencodePath 的头解析只活在 mint 冻结链 scheduler.freezeBinaryConfig，
// 生产消费方为零。）

// RFC-284 T15（自 services/sessionModeFallback.ts 迁入）—— opencode 拒绝
// `--session <id>` 的 stderr 措辞集。Multi-pattern by design: opencode wording
// has shifted across minor versions; 逃逸检测时在此扩列，勿在调用点散落字符串。
const SESSION_NOT_FOUND_PATTERNS: RegExp[] = [
  /\bsession not found\b/i,
  /\bsession\b[^\n]*\bdoes not exist\b/i,
  /\bunknown session\s*id?\b/i,
  /\bno such session\b/i,
]

export function detectOpencodeSessionNotFound(stderrTail: string): boolean {
  if (stderrTail.length === 0) return false
  return SESSION_NOT_FOUND_PATTERNS.some((re) => re.test(stderrTail))
}
