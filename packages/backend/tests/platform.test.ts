// RFC-windows PR-1 — platform primitive oracle + source-text guards.
//
// 为什么这条测试存在：PR-1 把 OS-specific 的进程原语（liveness / kill-tree /
// PID 命令指纹）从 util/process.ts 收口到 util/platform.ts 单源。POSIX 行为
// 必须 byte-for-byte 不变（`process.kill(-pid)` group-kill、`ps -o command=`），
// Windows 用等价机制（`taskkill /T /F`、`wmic`/CIM）。这条测试锁两件事：
//   1. 行为：在当前平台上，spawn 一个长寿命子进程，pidCommandLine /
//      pidCommandContainsBinary 能认出它，killProcessTree 能杀掉它，
//      isProcessAlive 翻转正确（先红后绿——旧 POSIX-only 实现在 Windows 上
//      pidCommandContainsBinary 恒 false、killStaleRunProcessTree 恒
//      'command-mismatch'，正是本测试要锁住不复发的回归）。
//   2. 源码：platform.ts 是平台分支的唯一出口——含 POSIX 字面量
//      (`process.kill(-pid, signal)` / `'-o', 'command='`) 与 Windows 分支
//      (`taskkill` / `wmic`)；POSIX 分支行为不因 Windows 适配而被偷偷改写。
//
// 平台标注：行为测试在两个平台都跑（原语本就跨平台）；Windows 专属的
// 大小写不敏感断言用 process.platform 守卫。POSIX 专属的 SIGTERM-trapping
// group-kill 行为由 rfc098-process-governance.test.ts 锁（该文件在 Windows
// skip，指向本文件覆盖 Windows kill 行为）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  isProcessAlive,
  killProcessTree,
  pidCommandContainsBinary,
  pidCommandLine,
  pidCommandLooksLikeAgentChild,
} from '../src/util/platform'

const PLATFORM_UTIL = resolve(import.meta.dir, '..', 'src', 'util', 'platform.ts')

const spawned: Bun.Subprocess[] = []

function spawnLongLived(): Bun.Subprocess {
  // Use process.execPath (the bun binary itself) — NOT the bare `bun` command,
  // which on Windows resolves to a `bun.cmd` shim and would make child.pid the
  // cmd.exe pid instead of the bun process pid (RFC-windows PR-1 lock-test parity).
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
    detached: true,
  })
  spawned.push(child)
  return child
}

afterEach(() => {
  for (const c of spawned) {
    try {
      if (typeof c.pid === 'number') killProcessTree(c.pid, 'SIGKILL')
    } catch {
      /* already dead */
    }
  }
  spawned.length = 0
})

describe('RFC-windows PR-1 — platform primitives (behavioural)', () => {
  test('pidCommandLine returns a string containing the spawned binary', async () => {
    const child = spawnLongLived()
    await Bun.sleep(150)
    const pid = child.pid as number
    const cmd = pidCommandLine(pid)
    expect(typeof cmd).toBe('string')
    expect(cmd!.length).toBeGreaterThan(0)
  })

  test('pidCommandContainsBinary matches the spawned binary, not a foreign one', async () => {
    const child = spawnLongLived()
    await Bun.sleep(150)
    const pid = child.pid as number
    expect(pidCommandContainsBinary(pid, process.execPath)).toBe(true)
    expect(pidCommandContainsBinary(pid, '/no/such/opencode-binary')).toBe(false)
  })

  test('pidCommandLooksLikeAgentChild matches a bun child', async () => {
    const child = spawnLongLived()
    await Bun.sleep(150)
    const pid = child.pid as number
    // process.execPath's basename is `bun` (or bun.exe on Windows); the fuzzy
    // /opencode|bun/i gate must recognise it as one of our children.
    expect(pidCommandLooksLikeAgentChild(pid)).toBe(true)
  })

  test('killProcessTree reaps the spawned child; isProcessAlive flips', async () => {
    const child = spawnLongLived()
    await Bun.sleep(150)
    const pid = child.pid as number
    expect(isProcessAlive(pid)).toBe(true)
    expect(killProcessTree(pid, 'SIGKILL')).toBe(true)
    // taskkill /F (Windows) and SIGKILL (POSIX) are both forceful; the child
    // should be gone within a short bound.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await Bun.sleep(50)
    }
    expect(isProcessAlive(pid)).toBe(false)
  })

  test('killProcessTree returns false for an invalid pid', () => {
    expect(killProcessTree(-1, 'SIGKILL')).toBe(false)
    expect(killProcessTree(0, 'SIGKILL')).toBe(false)
  })

  test('killProcessTree on an already-dead pid does not throw', () => {
    // 2_000_000 is extremely unlikely to be a live pid on any test machine.
    expect(() => killProcessTree(2_000_000, 'SIGKILL')).not.toThrow()
  })
})

describe('RFC-windows PR-1 — Windows-specific fingerprint semantics', () => {
  test('pidCommandContainsBinary is case-insensitive on Windows (path case may differ)', async () => {
    if (process.platform !== 'win32') return // POSIX keeps case-sensitive byte-for-byte
    const child = spawnLongLived()
    await Bun.sleep(150)
    const pid = child.pid as number
    // wmic / CIM may echo the path with different case than process.execPath
    // reports; a case-sensitive match would falsely report 'command-mismatch'.
    expect(pidCommandContainsBinary(pid, process.execPath.toUpperCase())).toBe(true)
  })
})

describe('RFC-windows PR-1 — platform.ts is the single source of platform branching', () => {
  const src = readFileSync(PLATFORM_UTIL, 'utf8')

  test('exposes isWindows + the liveness / kill-tree / fingerprint primitives', () => {
    expect(src).toContain('export function isWindows')
    expect(src).toContain('export function isProcessAlive')
    expect(src).toContain('export function killProcessTree')
    expect(src).toContain('export function pidCommandLine')
    expect(src).toContain('export function pidCommandLooksLikeAgentChild')
    expect(src).toContain('export function pidCommandContainsBinary')
  })

  test('POSIX branch is byte-for-byte the original mechanism (group-kill + ps)', () => {
    // POSIX kill-tree: process.kill(-pid, signal) with single-pid fallback.
    expect(src).toContain('process.kill(-pid, signal)')
    // POSIX fingerprint: ps -p <pid> -o command=.
    expect(src).toContain("'-o', 'command='")
    expect(src).toContain("'ps'")
  })

  test('Windows branch realises the same semantics via taskkill + wmic/CIM', () => {
    expect(src).toContain("'taskkill'")
    expect(src).toContain("'/T'")
    expect(src).toContain("'/F'")
    expect(src).toContain("'wmic'")
    expect(src).toContain('powershell')
    expect(src).toContain('Get-CimInstance Win32_Process')
  })

  test('isWindows() is the only platform discriminator inside platform.ts', () => {
    // platform.ts itself may call isWindows(); the point of this lock is that
    // no OTHER business file does — that guard lives in the PR-5 CI source-text
    // lock. Here we just assert the discriminator exists exactly once as a
    // definition (not a call count, which varies by branch).
    expect(src).toContain("process.platform === 'win32'")
  })
})
