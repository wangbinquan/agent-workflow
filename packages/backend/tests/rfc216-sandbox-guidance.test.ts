// RFC-216 — the pure guidance layer (services/sandbox/guidance.ts). These are
// the primary assertable surface for the sandbox preflight: the exit-code truth
// table (design §5, incl. decision D's configReadable axis), the report's
// install-vs-sysctl mutual exclusion, and the package-manager detection.
//
// Locks (design §10): a regression that (a) makes --require-available pass on an
// `off` host, (b) treats a corrupt config as exit 0/1 instead of exit 2, (c)
// prints an install command in the "installed but broken" branch, or (d) drops
// the "restart daemon" hint — turns one of these red.

import { describe, expect, it } from 'bun:test'
import {
  computeExitCode,
  detectPackageManager,
  installHint,
  renderSandboxReport,
  usernsHint,
  type PackageManager,
  type ProbeDiagnostics,
  type SandboxMode,
  type SandboxReportInput,
} from '@/services/sandbox/guidance'
import type { SandboxStatus } from '@/services/sandbox/probe'

const exitDiag = (exitCode: number, stderr = ''): ProbeDiagnostics => ({
  kind: 'exit',
  exitCode,
  stderrSnippet: stderr,
})
const timeoutDiag: ProbeDiagnostics = { kind: 'timeout' }
const errorDiag = (message: string): ProbeDiagnostics => ({ kind: 'error', message })

const status = (
  available: boolean,
  mechanism: SandboxStatus['mechanism'],
  detail: string | null = null,
): SandboxStatus => ({
  available,
  mechanism,
  detail,
})

function baseInput(over: Partial<SandboxReportInput>): SandboxReportInput {
  return {
    platform: 'linux',
    status: status(false, 'bwrap', 'bwrap not found on PATH (install bubblewrap)'),
    diag: errorDiag('ENOENT'),
    mode: 'warn',
    requireAvailable: false,
    bwrapOnPath: false,
    packageManager: 'apt',
    configReadable: true,
    ...over,
  }
}

describe('computeExitCode — the single authoritative truth table (design §5)', () => {
  const modes: SandboxMode[] = ['off', 'warn', 'enforce']

  it('configReadable=false ⇒ exit 2 in EVERY cell (decision D, independent axis)', () => {
    for (const mode of modes) {
      for (const available of [true, false]) {
        for (const requireAvailable of [true, false]) {
          expect(
            computeExitCode({ configReadable: false, mode, available, requireAvailable }),
          ).toBe(2)
        }
      }
    }
  })

  it('default gate: exit 0 ⟺ (off || available)', () => {
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'off',
        available: false,
        requireAvailable: false,
      }),
    ).toBe(0)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'off',
        available: true,
        requireAvailable: false,
      }),
    ).toBe(0)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'warn',
        available: true,
        requireAvailable: false,
      }),
    ).toBe(0)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'warn',
        available: false,
        requireAvailable: false,
      }),
    ).toBe(1)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'enforce',
        available: false,
        requireAvailable: false,
      }),
    ).toBe(1)
  })

  it('strict gate: exit 0 ⟺ (mode≠off && available) — off is non-zero even when available', () => {
    // The footgun this closes: an off host with a working mechanism must NOT
    // read as "sandbox in effect" in CI.
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'off',
        available: true,
        requireAvailable: true,
      }),
    ).toBe(1)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'off',
        available: false,
        requireAvailable: true,
      }),
    ).toBe(1)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'warn',
        available: true,
        requireAvailable: true,
      }),
    ).toBe(0)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'enforce',
        available: true,
        requireAvailable: true,
      }),
    ).toBe(0)
    expect(
      computeExitCode({
        configReadable: true,
        mode: 'warn',
        available: false,
        requireAvailable: true,
      }),
    ).toBe(1)
  })
})

describe('renderSandboxReport — exitCode wiring + cross cells', () => {
  it('off + available → default 0, strict 1 (the off cross cell)', () => {
    const avail = status(true, 'bwrap')
    expect(
      renderSandboxReport(
        baseInput({ mode: 'off', status: avail, diag: exitDiag(0), bwrapOnPath: true }),
      ).exitCode,
    ).toBe(0)
    expect(
      renderSandboxReport(
        baseInput({
          mode: 'off',
          status: avail,
          diag: exitDiag(0),
          bwrapOnPath: true,
          requireAvailable: true,
        }),
      ).exitCode,
    ).toBe(1)
  })

  it('off + timeout / off + error → default 0 (off never cares about the mechanism)', () => {
    expect(renderSandboxReport(baseInput({ mode: 'off', diag: timeoutDiag })).exitCode).toBe(0)
    expect(renderSandboxReport(baseInput({ mode: 'off', diag: errorDiag('boom') })).exitCode).toBe(
      0,
    )
  })

  it('configReadable=false → exit 2 even when the mechanism is available (available not faked)', () => {
    const r = renderSandboxReport(
      baseInput({
        configReadable: false,
        configError: 'bad json',
        status: status(true, 'bwrap'),
        diag: exitDiag(0),
        bwrapOnPath: true,
      }),
    )
    expect(r.exitCode).toBe(2)
    expect(r.text).toContain('config 不可读')
    expect(r.text).toContain('✅') // mechanism shown truthfully
  })
})

describe('renderSandboxReport — install vs sysctl are mutually exclusive (P1#3)', () => {
  it('not installed (bwrapOnPath=false) → install command, NO sysctl', () => {
    const r = renderSandboxReport(
      baseInput({ bwrapOnPath: false, packageManager: 'apt', diag: errorDiag('ENOENT') }),
    )
    expect(r.text).toContain('apt-get install -y bubblewrap')
    expect(r.text).toContain('检测到 PATH 上的包管理器：apt')
    expect(r.text).not.toContain('sysctl')
    expect(r.exitCode).toBe(1)
  })

  it('installed but broken (bwrapOnPath=true, exit non-zero) → sysctl + stderr, NO install command', () => {
    const r = renderSandboxReport(
      baseInput({
        bwrapOnPath: true,
        diag: exitDiag(1, 'bwrap: setting up uid map: Permission denied'),
      }),
    )
    expect(r.text).toContain('已安装但试跑失败')
    expect(r.text).toContain('exit 1')
    expect(r.text).toContain('setting up uid map') // stderr evidence
    expect(r.text).toContain('sysctl')
    expect(r.text).not.toContain('install -y bubblewrap')
    // Conditional, not a confident diagnosis:
    expect(r.text).toContain('非确证')
  })

  it('unknown package manager → generic guidance, still no crash', () => {
    const r = renderSandboxReport(baseInput({ bwrapOnPath: false, packageManager: null }))
    expect(r.text).toContain('bubblewrap')
    expect(r.text).not.toContain('sysctl')
  })
})

describe('renderSandboxReport — restart hint oracle (AC-4)', () => {
  const unavailableStates: Array<[string, Partial<SandboxReportInput>]> = [
    ['not installed', { bwrapOnPath: false, diag: errorDiag('ENOENT') }],
    ['installed but broken', { bwrapOnPath: true, diag: exitDiag(1, 'x') }],
    ['timeout', { diag: timeoutDiag, bwrapOnPath: true }],
    ['probe error', { diag: errorDiag('exited reject'), bwrapOnPath: true }],
  ]

  it('shows "重启 daemon" for every unavailable state under warn/enforce', () => {
    for (const mode of ['warn', 'enforce'] as SandboxMode[]) {
      for (const [, over] of unavailableStates) {
        const r = renderSandboxReport(baseInput({ mode, ...over }))
        expect(r.text).toContain('重启 daemon')
      }
    }
  })

  it('does NOT show restart hint when available or off', () => {
    expect(
      renderSandboxReport(
        baseInput({ status: status(true, 'bwrap'), diag: exitDiag(0), bwrapOnPath: true }),
      ).text,
    ).not.toContain('重启 daemon')
    expect(renderSandboxReport(baseInput({ mode: 'off' })).text).not.toContain('重启 daemon')
  })
})

describe('renderSandboxReport — timeout is its own kind (not exit 124)', () => {
  it('kind=timeout → 探测超时', () => {
    expect(renderSandboxReport(baseInput({ diag: timeoutDiag, bwrapOnPath: true })).text).toContain(
      '探测超时',
    )
  })
  it('kind=exit exitCode=124 → treated as a normal non-zero exit, NOT timeout', () => {
    const r = renderSandboxReport(baseInput({ diag: exitDiag(124, 'real 124'), bwrapOnPath: true }))
    expect(r.text).not.toContain('探测超时')
    expect(r.text).toContain('exit 124')
  })
})

describe('detectPackageManager — fixed first-hit priority (decision C)', () => {
  const only = (bin: string) => (b: string) => b === bin
  it('single hit each', () => {
    expect(detectPackageManager(only('apt-get'))).toBe<PackageManager>('apt')
    expect(detectPackageManager(only('dnf'))).toBe<PackageManager>('dnf')
    expect(detectPackageManager(only('pacman'))).toBe<PackageManager>('pacman')
    expect(detectPackageManager(only('apk'))).toBe<PackageManager>('apk')
    expect(detectPackageManager(only('zypper'))).toBe<PackageManager>('zypper')
  })
  it('multiple hits → apt > dnf > pacman > apk > zypper', () => {
    expect(detectPackageManager((b) => ['dnf', 'zypper'].includes(b))).toBe<PackageManager>('dnf')
    expect(detectPackageManager(() => true)).toBe<PackageManager>('apt')
  })
  it('no hit → null', () => {
    expect(detectPackageManager(() => false)).toBeNull()
  })
})

describe('installHint / usernsHint token contracts', () => {
  it('every manager names bubblewrap', () => {
    for (const pm of [
      'apt',
      'dnf',
      'pacman',
      'apk',
      'zypper',
      null,
    ] as Array<PackageManager | null>) {
      expect(installHint(pm)).toContain('bubblewrap')
    }
  })
  it('usernsHint carries the sysctl + the security caveat', () => {
    const h = usernsHint()
    expect(h).toContain('sysctl')
    expect(h).toContain('攻击面')
    expect(h).toContain('非确证')
  })
})
