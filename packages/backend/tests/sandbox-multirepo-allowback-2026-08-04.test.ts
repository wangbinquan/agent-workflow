// 2026-08-04 审计 P0 回归锁：多仓 / 仓库组任务在沙箱下只放行 repos[0]。
//
// 成因：`buildRunSandboxCtx` 判定「这是多仓运行」的依据曾经是**父目录名 == taskId**，
// 那是写给 RFC-130 之前的 canonical 布局 `worktrees/multi/{taskId}/{repo}` 的。
// 生产实际跑的是 iso 布局 `iso/{taskId}/{nodeRunId}/{挂载路径}`——父目录名是
// **nodeRunId**，永不等于 taskId ⇒ 只有第一个成员仓进 allow 集，而 prompt 的
// `{{__repos__}}` / 脚本的 `AW_REPOS_JSON` 照旧把每个成员的路径交给执行体。
//
// 后果不对称，Linux 那边更糟：
//   macOS  — sibling 仓 EPERM，响亮失败；
//   Linux  — appHome 被 `--tmpfs` 遮蔽，sibling 路径在 namespace 里不存在，
//            但 tmpfs 本身可写 ⇒ `mkdir -p` + 写入全部「成功」，进程退出即蒸发，
//            daemon 侧快照读到空 delta、merge-back 静默 no-op。
//            = 「agent 报告已改完、推上去空空如也」。
//
// 当年没被发现，是因为唯一的多仓用例锁的是 canonical 形状（父目录名恰好等于
// taskId，所以永远绿）——iso × 多仓这一格零覆盖。本文件补的就是那一格。

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRunSandboxCtx, wrapSandbox, type SandboxProvider } from '../src/services/sandbox'

const appHome = mkdtempSync(join(tmpdir(), 'aw-sbx-multi-'))
afterAll(() => rmSync(appHome, { recursive: true, force: true }))

const TASK = 'T-MULTI'
const RUN = 'NR-1'
const isoRoot = join(appHome, 'iso', TASK, RUN)
const members = [join(isoRoot, 'api'), join(isoRoot, 'web'), join(isoRoot, 'vendor', 'sdk')]
const runDir = join(appHome, 'runs', TASK, RUN)

function provider(mechanism: 'seatbelt' | 'bwrap'): SandboxProvider {
  return { mode: 'warn', status: { mechanism, available: true, detail: null }, appHome }
}

describe('多仓 iso 运行：每个成员仓都必须进 allow 集', () => {
  test('传入全部成员 ⇒ 三个仓都在 taskWorktrees 里', () => {
    const ctx = buildRunSandboxCtx(provider('bwrap'), TASK, members[0]!, runDir, members)
    for (const member of members) expect(ctx?.taskWorktrees).toContain(member)
  })

  test('嵌套挂载路径（vendor/sdk）不会因为父目录名不是 taskId 而掉队', () => {
    // 这是启发式最容易漏的一格：`dirname` 是 `<iso>/vendor`。
    const ctx = buildRunSandboxCtx(provider('bwrap'), TASK, members[2]!, runDir, members)
    expect(ctx?.taskWorktrees).toContain(members[2])
    expect(ctx?.taskWorktrees).toContain(members[0])
  })

  test('bwrap argv 为每个成员各发一条 --bind（否则 Linux 上写入落进 tmpfs 蒸发）', () => {
    const ctx = buildRunSandboxCtx(provider('bwrap'), TASK, members[0]!, runDir, members)
    const argv = wrapSandbox(['/bin/true'], ctx).join(' ')
    for (const member of members) expect(argv).toContain(`--bind ${member} ${member}`)
  })

  test('Seatbelt profile 为每个成员各发一条 allow', () => {
    const ctx = buildRunSandboxCtx(provider('seatbelt'), TASK, members[0]!, runDir, members)
    const profile = wrapSandbox(['/bin/true'], ctx)[2] ?? ''
    for (const member of members) {
      expect(profile).toContain(`(allow file-read* file-write* (subpath "${member}"))`)
    }
  })

  test('不传成员清单 ⇒ 退回单工作树启发式（单仓调用方与既有测试形状不变）', () => {
    const single = join(appHome, 'worktrees', 'slug', TASK)
    const ctx = buildRunSandboxCtx(provider('bwrap'), TASK, single, runDir)
    expect(ctx?.taskWorktrees).toEqual([single])
  })
})
