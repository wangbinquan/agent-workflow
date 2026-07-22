// 2026-07-22 —— scratch 任务 sandbox allow-back 回归锁（实测任务
// 01KY4VWED21MH6VAE5MSQGENNV「explorer sources 目录自组织重构」）。
//
// RFC-205 把整个 appHome 全量 deny、只 allow back 本任务 worktree + run dir +
// repos 镜像。scratch 任务是唯一「任务基仓在 appHome 里」的形态：RFC-130 iso
// 工作树的 .git 指针指向 scratch/{taskId}/.git/worktrees/{runId}，基仓 git
// 元数据不进 allow 集时 agent cwd 里所有 git 命令 EPERM（文件写反而成功——
// iso/{taskId} 本身是 allow 的）。实测后果：成员宣布工作区不可用（"git 无法
// 运行 / 仅 .git 指针"），转而去改 appHome 边界外不设防的用户真仓。
//
// 修法：buildRunSandboxCtx 在 scratch/{taskId}/.git 存在时把它并进
// taskWorktrees——**只放行 git common dir，不放行 canonical 工作树本身**：
// canonical 文件只能经 daemon 的 writeSem merge-back 写入，把整棵 canonical
// 交给 iso agent 会绕过 RFC-130 隔离边界（Codex 实现门 P1 2026-07-22）。

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRunSandboxCtx, type SandboxProvider } from '../src/services/sandbox'

const appHome = mkdtempSync(join(tmpdir(), 'aw-sbx-scratch-'))
afterAll(() => rmSync(appHome, { recursive: true, force: true }))

const provider: SandboxProvider = {
  mode: 'warn',
  status: { mechanism: 'seatbelt', available: true, detail: null },
  appHome,
}

describe('buildRunSandboxCtx — scratch 基仓 git 元数据 allow-back', () => {
  test('scratch/{taskId}/.git 存在 ⇒ 仅 .git 并入（iso gitdir 可达，canonical 工作树仍隔离）', () => {
    const taskId = 'T-SCRATCH-1'
    mkdirSync(join(appHome, 'scratch', taskId, '.git'), { recursive: true })
    // iso run：cwd = iso/{taskId}/{runId}，父目录名 = taskId ⇒ 整任务 iso 树 allow
    const isoCwd = join(appHome, 'iso', taskId, 'RUN1')
    const ctx = buildRunSandboxCtx(provider, taskId, isoCwd, join(appHome, 'runs', taskId, 'RUN1'))
    expect(ctx?.taskWorktrees).toEqual([
      join(appHome, 'iso', taskId),
      join(appHome, 'scratch', taskId, '.git'),
    ])
    // Codex 实现门 P1 锁：canonical 工作树本身绝不进 allow 集——iso agent 能从
    // .git 指针推出该路径，放行整棵树 = 绕过 writeSem/merge-back 直写 canonical。
    expect(ctx?.taskWorktrees).not.toContain(join(appHome, 'scratch', taskId))
  })

  test('worktreePath 就是 scratch 目录（canonical run）⇒ 整树本就 allow，.git 附带并入无害', () => {
    const taskId = 'T-SCRATCH-2'
    const scratchDir = join(appHome, 'scratch', taskId)
    mkdirSync(join(scratchDir, '.git'), { recursive: true })
    const ctx = buildRunSandboxCtx(provider, taskId, scratchDir, join(appHome, 'runs', taskId, 'R'))
    expect(ctx?.taskWorktrees).toEqual([scratchDir, join(scratchDir, '.git')])
  })

  test('无 scratch 目录（普通 repo 任务）⇒ 形状逐字不变', () => {
    const taskId = 'T-PLAIN'
    const wt = join(appHome, 'worktrees', 'slug', taskId)
    const ctx = buildRunSandboxCtx(provider, taskId, wt, join(appHome, 'runs', taskId, 'R'))
    expect(ctx?.taskWorktrees).toEqual([wt])
    // multi-repo 形态（父目录名 = taskId ⇒ allow 整任务目录）同样不受影响
    const multiCwd = join(appHome, 'worktrees', 'multi', taskId, 'repoA')
    const ctx2 = buildRunSandboxCtx(provider, taskId, multiCwd, join(appHome, 'runs', taskId, 'R2'))
    expect(ctx2?.taskWorktrees).toEqual([join(appHome, 'worktrees', 'multi', taskId)])
  })

  test('provider 缺席 ⇒ undefined（测试/off 路径不受影响）', () => {
    expect(buildRunSandboxCtx(null, 'T', '/x', '/y')).toBeUndefined()
  })
})
