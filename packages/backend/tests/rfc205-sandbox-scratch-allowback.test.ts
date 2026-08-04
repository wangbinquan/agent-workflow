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
// 修法（2026-08-04 起）：buildRunSandboxCtx 不再按 `scratch/{taskId}/.git` 这个
// **字面路径**猜，而是从工作树自己的磁盘指针推导 git common dir
// （`util/git.ts:resolveGitCommonDirSync`）。字面写法只覆盖了三种「基仓在
// appHome 内」形态中的一种；另两种（技能融合引擎任务 `fusions/{id}/iter{n}/work`、
// scratch 父任务的 call-workflow 子任务——其 common dir 带的是**父**任务 id）
// 当年一律漏放行。推导版按构造覆盖全部三种。
// **仍然只放行 git common dir，不放行 canonical 工作树本身**：canonical 文件只能经
// daemon 的 writeSem merge-back 写入，把整棵 canonical 交给 iso agent 会绕过
// RFC-130 隔离边界（Codex 实现门 P1 2026-07-22）。
//
// 因此本文件的 fixture 必须落**真实的 worktree 指针**（`.git` 文件 + admin 目录下的
// `commondir`），而不是随手 mkdir 一个 `.git` 目录——后者不是任何真实布局，用它做
// 断言等于锁了一个不存在的形状。

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Materialize what `git worktree add <iso> ` leaves on disk: the linked
 * worktree's `.git` FILE pointing at an admin dir under the base repo's common
 * dir, and that admin dir's `commondir` pointing back at it.
 */
function linkWorktree(opts: { baseRepo: string; linked: string; name: string }): string {
  const commonDir = join(opts.baseRepo, '.git')
  const adminDir = join(commonDir, 'worktrees', opts.name)
  mkdirSync(adminDir, { recursive: true })
  writeFileSync(join(adminDir, 'commondir'), '../..\n')
  mkdirSync(opts.linked, { recursive: true })
  writeFileSync(join(opts.linked, '.git'), `gitdir: ${adminDir}\n`)
  return commonDir
}

describe('buildRunSandboxCtx — 基仓在 appHome 内时放行 git common dir', () => {
  test('scratch 任务的 iso run ⇒ 仅 common dir 并入（iso gitdir 可达，canonical 工作树仍隔离）', () => {
    const taskId = 'T-SCRATCH-1'
    const isoCwd = join(appHome, 'iso', taskId, 'RUN1')
    const commonDir = linkWorktree({
      baseRepo: join(appHome, 'scratch', taskId),
      linked: isoCwd,
      name: 'RUN1',
    })
    const ctx = buildRunSandboxCtx(provider, taskId, isoCwd, join(appHome, 'runs', taskId, 'RUN1'))
    expect(ctx?.taskWorktrees).toEqual([join(appHome, 'iso', taskId), commonDir])
    // Codex 实现门 P1 锁：canonical 工作树本身绝不进 allow 集——iso agent 能从
    // .git 指针推出该路径，放行整棵树 = 绕过 writeSem/merge-back 直写 canonical。
    expect(ctx?.taskWorktrees).not.toContain(join(appHome, 'scratch', taskId))
  })

  // 2026-08-04 审计新增：字面 `scratch/{taskId}` 写法漏掉的两种同型形态。
  test('技能融合引擎任务（基仓在 fusions/）的 iso run ⇒ common dir 同样并入', () => {
    const taskId = 'T-FUSION'
    const isoCwd = join(appHome, 'iso', taskId, 'RUN1')
    const commonDir = linkWorktree({
      baseRepo: join(appHome, 'fusions', 'F1', 'iter1', 'work'),
      linked: isoCwd,
      name: 'RUN1',
    })
    const ctx = buildRunSandboxCtx(provider, taskId, isoCwd, join(appHome, 'runs', taskId, 'RUN1'))
    expect(ctx?.taskWorktrees).toContain(commonDir)
    expect(ctx?.taskWorktrees).not.toContain(join(appHome, 'fusions', 'F1', 'iter1', 'work'))
  })

  test('scratch 父任务的子任务（common dir 带父任务 id）⇒ 按推导而非按自己的 taskId 命中', () => {
    const parentId = 'T-PARENT'
    const childId = 'T-CHILD'
    const isoCwd = join(appHome, 'iso', childId, 'RUN1')
    const commonDir = linkWorktree({
      baseRepo: join(appHome, 'scratch', parentId),
      linked: isoCwd,
      name: 'RUN1',
    })
    const ctx = buildRunSandboxCtx(provider, childId, isoCwd, join(appHome, 'runs', childId, 'R'))
    expect(ctx?.taskWorktrees).toContain(commonDir)
  })

  test('worktreePath 就是基仓目录（canonical run）⇒ 整树本就 allow，common dir 不重复并入', () => {
    const taskId = 'T-SCRATCH-2'
    const scratchDir = join(appHome, 'scratch', taskId)
    mkdirSync(join(scratchDir, '.git'), { recursive: true })
    const ctx = buildRunSandboxCtx(provider, taskId, scratchDir, join(appHome, 'runs', taskId, 'R'))
    // common dir 是 allow 根的后代 ⇒ 已被覆盖，不再追加一条冗余条目。
    expect(ctx?.taskWorktrees).toEqual([scratchDir])
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
