// 2026-08-04 沙箱审计最后一条：Linux bwrap 外层下，SIGTERM 宽限期塌缩成即时 SIGKILL。
//
// 真 Linux 容器实证（Debian bookworm + bubblewrap 0.8.0，用平台自己的
// `killProcessTree` 做 A/B，不是手写脚本）：
//   旧行为（组杀含 monitor）  → 内层只留下 INNER_STARTED，连收到 TERM 都没记下来
//   修复后（TERM 放过 monitor）→ INNER_STARTED → INNER_GOT_TERM → INNER_CLEAN_EXIT
// 成因：组杀同时命中 bwrap monitor，monitor 在 TERM 上退出，`--die-with-parent` 随即对
// PID namespace 的 init 发 SIGKILL，整个 namespace 一起没了——于是平台承诺的 10s 宽限
// （abortSession / 会话库 flush / 最后一段 stdout）实际是 ~0。macOS 的 `sandbox-exec`
// 原地 exec、没有中间进程，一直是完整窗口；两个 OS 两套取消语义。
//
// 本文件锁的是原语的**信号投递形状**（跨平台可测）：优雅信号放过组长、升级信号不放过。
// 真实的 bwrap 端到端行为由上述容器验证覆盖，无法在 macOS CI 上复现。

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree, processGroupMembers } from '../src/util/process'
import { NO_POSIX_CONTAINMENT } from './fixtures/platformScope'

const spawned: Bun.Subprocess[] = []

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-(child.pid ?? 0), 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

/**
 * A real process group: a leader that IGNORES TERM (so the test can tell whether
 * it was signalled) plus a descendant that RECORDS receiving it.
 *
 * The descendant writes evidence to a file rather than being counted in `ps`:
 * a process that has taken TERM but not yet been reaped is still listed as a
 * zombie, so process-table counting cannot distinguish "signalled" from "not".
 */
function spawnGroup(evidence?: string): Bun.Subprocess {
  const childScript =
    evidence === undefined
      ? 'sleep 30'
      : `trap 'echo got-term > ${evidence}; exit 0' TERM; sleep 30`
  const child = Bun.spawn({
    cmd: ['/bin/sh', '-c', `trap "" TERM; /bin/sh -c '${childScript}' & sleep 30`],
    detached: true,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  spawned.push(child)
  return child
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(NO_POSIX_CONTAINMENT)('killProcessTree — 优雅信号放过沙箱 monitor', () => {
  test('processGroupMembers 能枚举出组长与其后代', async () => {
    const child = spawnGroup()
    await Bun.sleep(300)
    const members = processGroupMembers(child.pid!)
    expect(members).toContain(child.pid!)
    // 组里至少还有 leader fork 出来的那个 sleep。
    expect(members.length).toBeGreaterThan(1)
  })

  test('groupLeaderIsSandboxMonitor ⇒ TERM 不投给组长（它要活过宽限期）', async () => {
    const evidence = join(mkdtempSync(join(tmpdir(), 'aw-killgrace-')), 'got')
    const child = spawnGroup(evidence)
    await Bun.sleep(400)
    expect(processGroupMembers(child.pid!).length).toBeGreaterThan(1)

    expect(killProcessTree(child.pid!, 'SIGTERM', { groupLeaderIsSandboxMonitor: true })).toBe(true)
    await Bun.sleep(600)

    // 组长仍在——bwrap 情形下这正是内层能拿到完整宽限期的原因。
    expect(alive(child.pid!)).toBe(true)
    // 后代确实收到了 TERM（断行为，不是数进程表：收到 TERM 但没被回收的进程仍是僵尸）。
    expect(existsSync(evidence)).toBe(true)
  })

  test('不置位时 ⇒ 组杀，组长一并收到信号（未包装 spawn 与 macOS 的既有语义）', async () => {
    const child = spawnGroup()
    await Bun.sleep(300)
    // 组长 trap 了 TERM，所以用 KILL 证明信号确实投到了整组。
    expect(killProcessTree(child.pid!, 'SIGKILL')).toBe(true)
    await Bun.sleep(400)
    expect(alive(child.pid!)).toBe(false)
  })

  test('SIGKILL 即使置位也必须走整组（升级阶段不能放过 monitor）', async () => {
    const child = spawnGroup()
    await Bun.sleep(300)
    expect(killProcessTree(child.pid!, 'SIGKILL', { groupLeaderIsSandboxMonitor: true })).toBe(true)
    await Bun.sleep(400)
    expect(alive(child.pid!)).toBe(false)
  })
})
