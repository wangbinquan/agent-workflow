// RFC-108 T9 (AR-14) — fail-safe stale-process reaping via persisted spawn identity.
//
// 为什么这条测试存在：killStaleRunProcessTree 旧版用 `/opencode|bun/` 模糊正则 +
// 48h 窗口判一个活 pid 是否「我们的子进程」。误判（被 shim 包裹 / >48h 的活 agent /
// pid 被回收到另一个 bun 进程）会让 reaper 不杀它却照样翻行 → resume 在活进程下
// git-reset（双写损坏）。T9 持久化 spawn 的二进制绝对路径（node_runs.spawn_binary_path），
// reaper 改按该路径精确匹配：
//   - 活 + 路径匹配 → 确是我们的子进程 → 杀（不再受 48h 窗口保护）；杀不掉 → 'kill-failed'
//     即高置信「活且杀不死」危险信号 → resume/retry 拒绝（escalateLiveChildSurvived 409）。
//   - 活 + 路径不匹配 → 确信 pid 被回收 → 'command-mismatch'（安全，不杀、照常翻行）。
//
// 确定性：spawn 真实可杀进程（process.execPath，同 rfc098-process-governance 范式），
// 'kill-failed'（杀不死）路径无法确定性构造，由源码层断言锁 refuse 接线。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  isProcessAlive,
  killStaleRunProcessTree,
  pidCommandContainsBinary,
  STALE_RUN_PID_MAX_AGE_MS,
} from '../src/util/process'

const spawned: Bun.Subprocess[] = []

function spawnLongLived(): Bun.Subprocess {
  // Absolute, known binary path (the test runtime) so `ps command=` contains it.
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
      c.kill(9)
    } catch {
      /* already dead */
    }
  }
  spawned.length = 0
})

describe('RFC-108 T9 (AR-14) — spawn-binary identity gate', () => {
  test('pidCommandContainsBinary matches the spawned binary path, not a foreign one', async () => {
    const child = spawnLongLived()
    await Bun.sleep(120)
    const pid = child.pid as number
    expect(pidCommandContainsBinary(pid, process.execPath)).toBe(true)
    expect(pidCommandContainsBinary(pid, '/no/such/opencode-binary')).toBe(false)
  })

  test('alive + matching binary → killed, even with a >48h startedAt (identity beats the window)', async () => {
    const child = spawnLongLived()
    await Bun.sleep(120)
    const pid = child.pid as number
    const outcome = await killStaleRunProcessTree({
      pid,
      startedAt: Date.now() - STALE_RUN_PID_MAX_AGE_MS - 60_000, // "old"
      spawnBinaryPath: process.execPath,
    })
    expect(outcome).toBe('killed')
    expect(isProcessAlive(pid)).toBe(false)
  })

  test('alive but binary MISMATCH → command-mismatch (recycled pid, left alone)', async () => {
    const child = spawnLongLived()
    await Bun.sleep(120)
    const pid = child.pid as number
    const outcome = await killStaleRunProcessTree({
      pid,
      startedAt: Date.now(),
      spawnBinaryPath: '/usr/local/bin/some-other-opencode',
    })
    expect(outcome).toBe('command-mismatch')
    expect(isProcessAlive(pid)).toBe(true) // NOT killed — we don't touch a foreign pid
  })

  test('legacy (no spawnBinaryPath): the old 48h window gate still applies', async () => {
    const child = spawnLongLived()
    await Bun.sleep(120)
    const pid = child.pid as number
    const outcome = await killStaleRunProcessTree({
      pid,
      startedAt: Date.now() - STALE_RUN_PID_MAX_AGE_MS - 60_000,
      spawnBinaryPath: null,
    })
    expect(outcome).toBe('window-expired')
    expect(isProcessAlive(pid)).toBe(true)
  })
})

describe('RFC-108 T9 — refuse-on-survivor wiring (source-text)', () => {
  const taskSrc = readFileSync(join(import.meta.dir, '../src/services/task.ts'), 'utf8')
  const runnerSrc = readFileSync(join(import.meta.dir, '../src/services/runner.ts'), 'utf8')

  test('resumeKick + retryNode escalate (409 refuse) on kill-failed', () => {
    const calls = (taskSrc.match(/escalateLiveChildSurvived\(/g) ?? []).length
    // definition + resumeKick + retryNode = 3
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(taskSrc).toContain("errorSummary: 'live-child-survived'")
  })

  test('runner persists the spawn binary path at spawn', () => {
    expect(runnerSrc).toContain('spawnBinaryPath: cmd[0]')
  })
})
