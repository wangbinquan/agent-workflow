// RFC-216 — the pure presentation + guidance layer for `agent-workflow sandbox`.
//
// This module is DELIBERATELY effect-free: given a probe result + config axes it
// returns a report string and an exit code, and nothing else. It never spawns,
// never reads a file, never touches the network. That purity is a load-bearing
// safety property (design §6): the read-only guard test asserts this file imports
// no `node:child_process` and calls no `Bun.spawn`/`Bun.$`/`Bun.which`/fs-write —
// so the whole "prints commands, never runs them" contract cannot regress here.
//
// Two INDEPENDENT axes drive the exit code (design §5, decision D): whether the
// OS sandbox mechanism is available, and whether the config could be read (so we
// know the effective sandboxMode). A corrupt config is never expressed by faking
// `available` — it gets its own exit 2.

import type { SandboxStatus } from './probe'

export type SandboxMode = 'enforce' | 'warn' | 'off'

/**
 * What `boundedSpawn` observed while trial-running the mechanism. `timeout` and
 * `error` are their OWN kinds (not encoded into an exit code) so a genuine
 * `exit 124` is never mistaken for a deadline kill (design §2, P1#2).
 */
export type ProbeDiagnostics =
  | { kind: 'exit'; exitCode: number; stderrSnippet: string }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string }

/** Linux package managers we know how to name an install command for. */
export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'apk' | 'zypper'

/** Fixed priority when several managers are on PATH — first hit wins (decision C). */
const PACKAGE_MANAGERS: readonly PackageManager[] = ['apt', 'dnf', 'pacman', 'apk', 'zypper']

/** The binary each manager ships (what `Bun.which` looks for). */
const PACKAGE_MANAGER_BIN: Record<PackageManager, string> = {
  apt: 'apt-get',
  dnf: 'dnf',
  pacman: 'pacman',
  apk: 'apk',
  zypper: 'zypper',
}

export interface SandboxReportInput {
  platform: NodeJS.Platform
  /** From `probeSandboxMechanism` — the mechanismAvailable axis. */
  status: SandboxStatus
  diag: ProbeDiagnostics
  /** Effective sandboxMode; assumed `warn` when config is unreadable. */
  mode: SandboxMode
  /** `--require-available` strict gate. */
  requireAvailable: boolean
  /** `Bun.which('bwrap') !== null` (Linux). Splits "not installed" vs "installed but broken". */
  bwrapOnPath: boolean
  /** First-hit PATH package manager, or null when none is found. */
  packageManager: PackageManager | null
  /** The configReadable axis (decision D). false ⇒ exit 2, mechanism shown truthfully. */
  configReadable: boolean
  /** Parse error text when `configReadable` is false. */
  configError?: string
}

export interface SandboxReport {
  text: string
  exitCode: number
}

/**
 * The single authoritative exit-code table (design §5). configReadable is
 * checked FIRST and is independent of the mechanism axis.
 */
export function computeExitCode(input: {
  configReadable: boolean
  mode: SandboxMode
  available: boolean
  requireAvailable: boolean
}): number {
  if (!input.configReadable) return 2 // decision D — can't determine effective mode
  if (input.requireAvailable) return input.mode !== 'off' && input.available ? 0 : 1
  return input.mode === 'off' || input.available ? 0 : 1
}

/** Pick the first package manager on PATH by fixed priority. `has` is injected (pure). */
export function detectPackageManager(has: (bin: string) => boolean): PackageManager | null {
  for (const pm of PACKAGE_MANAGERS) {
    if (has(PACKAGE_MANAGER_BIN[pm])) return pm
  }
  return null
}

/** The exact install command to print for a detected manager (or a generic fallback). */
export function installHint(pm: PackageManager | null): string {
  switch (pm) {
    case 'apt':
      return 'sudo apt-get update && sudo apt-get install -y bubblewrap'
    case 'dnf':
      return 'sudo dnf install -y bubblewrap'
    case 'pacman':
      return 'sudo pacman -S --noconfirm bubblewrap'
    case 'apk':
      return 'sudo apk add bubblewrap'
    case 'zypper':
      return 'sudo zypper install -y bubblewrap'
    case null:
      return '用你发行版的包管理器安装 bubblewrap（Debian/Ubuntu: apt-get; Fedora/RHEL: dnf; Arch: pacman; Alpine: apk; openSUSE: zypper）'
  }
}

/**
 * The userns sysctl block — a CONDITIONAL troubleshooting direction, never a
 * confident "userns is disabled" diagnosis (design §4, P1#3). Loosening userns
 * widens the whole host's attack surface, so it is framed as a caveated guess.
 */
export function usernsHint(): string {
  return [
    'bwrap 在 PATH 但试跑失败，最常见（但非确证）是非特权 user namespaces 被禁。',
    '若确为 userns 受限（容器常见），下列 sysctl 可能有帮助 —— ⚠️ 会扩大全机攻击面，自行权衡：',
    '  # Ubuntu 24.04+',
    '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    '  # 老 Debian',
    '  sudo sysctl -w kernel.unprivileged_userns_clone=1',
    '  # RHEL 系（若为 0）',
    '  sudo sysctl -w user.max_user_namespaces=15000',
    '受限容器（无 CAP_SYS_ADMIN / 容器策略禁 userns）可能无解 —— 维持 sandboxMode warn/off，或在容器边界隔离。',
  ].join('\n')
}

const RESTART_HINT =
  '装完 / 改完后需重启 daemon 生效（沙箱机制在开机时探测一次并缓存）：\n  agent-workflow stop && agent-workflow start'

/**
 * Render the full report + compute the exit code. Pure: input → {text, exitCode}.
 */
export function renderSandboxReport(input: SandboxReportInput): SandboxReport {
  const { platform, status, mode, configReadable } = input
  const available = status.available
  const exitCode = computeExitCode({
    configReadable,
    mode,
    available,
    requireAvailable: input.requireAvailable,
  })

  const lines: string[] = []
  const mechName =
    platform === 'darwin'
      ? 'seatbelt（macOS sandbox-exec，随系统自带）'
      : platform === 'linux'
        ? 'bwrap（Linux bubblewrap）'
        : `不支持的平台 ${platform}`
  lines.push(`沙箱机制：${mechName}`)

  if (!configReadable) {
    lines.push(
      `⚠️ config 不可读（${input.configError ?? '解析失败'}），无法确定生效 sandboxMode；以下按 warn 呈现机制状态。`,
    )
  }

  if (available) {
    lines.push('状态：✅ 可用（已真实试跑）')
    lines.push(`当前 sandboxMode：${mode}`)
    if (platform === 'darwin') lines.push('无需安装任何组件。')
  } else {
    lines.push(...renderUnavailable(input))
  }

  if (!available && mode !== 'off') {
    lines.push('')
    lines.push(RESTART_HINT)
  }

  if (mode === 'off') {
    lines.push('')
    lines.push('sandboxMode=off —— 沙箱由配置关闭，agent 进程不被 FS 沙箱包装。')
  }

  return { text: lines.join('\n') + '\n', exitCode }
}

/** The unavailable-branch body. Split by diag.kind + bwrapOnPath (design §4). */
function renderUnavailable(input: SandboxReportInput): string[] {
  const { platform, status, diag, mode, bwrapOnPath, packageManager } = input
  const out: string[] = []

  if (diag.kind === 'timeout') {
    out.push('状态：❌ 不可用 —— 沙箱机制探测超时（已 SIGKILL 整组回收）')
    out.push(`当前 sandboxMode：${mode}`)
    out.push('可能是机制在异常内核/容器环境卡住。维持 warn/off 或排查内核/容器配置。')
    return out
  }

  if (platform === 'linux' && !bwrapOnPath) {
    // Not installed (Bun.which is authoritative; a missing binary also makes
    // Bun.spawn throw → diag.kind='error', which lands here too).
    out.push('状态：❌ 不可用 —— PATH 上未找到 bwrap')
    out.push(`当前 sandboxMode：${mode}（机制不可用时任务将裸跑并逐任务告警）`)
    out.push(`检测到 PATH 上的包管理器：${packageManager ?? '（未识别）'}`)
    out.push('')
    out.push('修复：')
    out.push(`  ${installHint(packageManager)}`)
    return out
  }

  if (platform === 'linux' && bwrapOnPath) {
    // Installed but the trial run failed — evidence first, sysctl conditional.
    const detail =
      diag.kind === 'exit'
        ? `exit ${diag.exitCode}`
        : diag.kind === 'error'
          ? diag.message
          : status.detail
    out.push(`状态：❌ 不可用 —— bwrap 已安装但试跑失败（${detail}）`)
    out.push(`当前 sandboxMode：${mode}`)
    if (diag.kind === 'exit' && diag.stderrSnippet.trim() !== '') {
      out.push(`stderr：${diag.stderrSnippet.trim()}`)
    }
    out.push('')
    out.push(usernsHint())
    return out
  }

  if (platform === 'darwin') {
    const detail =
      diag.kind === 'exit'
        ? `exit ${diag.exitCode}`
        : diag.kind === 'error'
          ? diag.message
          : status.detail
    out.push(`状态：❌ 不可用 —— sandbox-exec 试跑失败（${detail}）`)
    out.push(`当前 sandboxMode：${mode}`)
    out.push('sandbox-exec 随 macOS 自带，试跑失败通常是主机被加固；维持 warn/off 或排查。')
    return out
  }

  out.push(`状态：❌ 不可用 —— ${status.detail ?? '未知'}`)
  out.push(`当前 sandboxMode：${mode}`)
  return out
}
