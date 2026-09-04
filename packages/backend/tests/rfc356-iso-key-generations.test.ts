// RFC-356 PR-3 —— iso 键代际自愈 + 双身份 handle + 诊断。
//
// locks in the actual self-heal for GitHub issue #13：残留目录清不掉时，建树换一代
// （`{原键}-2`）继续跑，而不是逐次撞 `fatal: '<path>' already exists` 把任务钉死。
//
// 以及设计门 P0-1 —— 这一层最危险的洞：`discardNodeIso` 自己起的 effect observer
// 用的是 `handle.nodeRunId`，而 `beforeAct()` 在 `try` **之外**、调用点
// （`schedulerAssembly.ts` 的 `await spec.discardIso(handle)`）又是**裸 await**。
// 换代之后喂给它一个合成键 ⇒ `readLineage` 返 null ⇒ 抛 `task-continuation-stale`
// ⇒ 异常穿出 `runAssembly` ⇒ 节点 `scheduler-node-threw`。那会是一个**比 issue #13
// 更早触发**的新 wedge。下面「双身份」那组用例锁住它。

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  chooseIsoWorkspaceKey,
  createNodeIso,
  isoWorktreePathFor,
  IsoWorkspaceBlockedError,
  MAX_ISO_KEY_GENERATIONS,
  rebuildIsoHandle,
} from '../src/services/nodeIsolation'
import { isoKeyOf } from '../src/modules/task-execution/composition/nodeMechanics'
import { runGit } from '../src/util/git'
import { removeTempDirSync } from './fixtures/tempDir'

const isWindows = process.platform === 'win32'

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc356g-repo-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

function canonRepoOf(worktreePath: string) {
  return { repoPath: worktreePath, worktreePath, worktreeDirName: '', baseBranch: 'main' }
}

describe('RFC-356 · 选键：常态零成本，有残留才回收', () => {
  test('容器不存在 ⇒ 第 0 代直接选中，reclaimed=0', async () => {
    const repo = await initRepo()
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc356g-home-'))
    const chosen = await chooseIsoWorkspaceKey({
      appHome,
      taskId: 'T1',
      baseKey: 'K1',
      canonRepos: [canonRepoOf(repo)],
    })
    expect(chosen).toEqual({ key: 'K1', generation: 0, reclaimed: 0 })
    removeTempDirSync(appHome)
    removeTempDirSync(repo)
  }, 30_000)

  test('有可回收的残留 ⇒ 仍留在第 0 代（不无谓换代）', async () => {
    const repo = await initRepo()
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc356g-home2-'))
    const container = isoWorktreePathFor(appHome, 'T2', 'K2', '')
    mkdirSync(container, { recursive: true })
    writeFileSync(join(container, 'residual.bin'), 'x')

    const chosen = await chooseIsoWorkspaceKey({
      appHome,
      taskId: 'T2',
      baseKey: 'K2',
      canonRepos: [canonRepoOf(repo)],
    })
    expect(chosen.key).toBe('K2')
    expect(chosen.generation).toBe(0)
    expect(chosen.reclaimed).toBeGreaterThan(0)
    // 回收之后同一路径必须能真的建起树来——这才是自愈的判据。
    expect((await runGit(repo, ['worktree', 'add', '--detach', container, 'HEAD'])).exitCode).toBe(
      0,
    )
    removeTempDirSync(appHome)
    removeTempDirSync(repo)
  }, 30_000)

  test.skipIf(isWindows)(
    'AC-6：残留清不掉 ⇒ 换代到 `-2` 并成功建树',
    async () => {
      // 屏障必须放在**基键树内部**（子目录去写权限），不是放在 appHome/iso/{task} 上
      // ——放父目录会把新旧两代一起挡住，就证不出「换代」这件事本身。
      const repo = await initRepo()
      const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc356g-home3-'))
      const container = isoWorktreePathFor(appHome, 'T3', 'K3', '')
      const stubborn = join(container, 'stubborn')
      mkdirSync(stubborn, { recursive: true })
      writeFileSync(join(stubborn, 'held.bin'), 'x')
      chmodSync(stubborn, 0o500)
      try {
        const chosen = await chooseIsoWorkspaceKey({
          appHome,
          taskId: 'T3',
          baseKey: 'K3',
          canonRepos: [canonRepoOf(repo)],
        })
        expect(chosen.key).toBe('K3-2')
        expect(chosen.generation).toBe(1)
        // 换代路径必须是空的、可建树的。
        const next = isoWorktreePathFor(appHome, 'T3', chosen.key, '')
        expect(existsSync(next)).toBe(false)
        expect((await runGit(repo, ['worktree', 'add', '--detach', next, 'HEAD'])).exitCode).toBe(0)
        // 旧的残留仍在盘上——这是自愈的代价，由终态 GC 收。
        expect(existsSync(stubborn)).toBe(true)
      } finally {
        chmodSync(stubborn, 0o700)
        removeTempDirSync(appHome)
        removeTempDirSync(repo)
      }
    },
    30_000,
  )

  test.skipIf(isWindows)(
    'AC-9：代际耗尽 ⇒ 抛 IsoWorkspaceBlockedError 且带够现场',
    async () => {
      const repo = await initRepo()
      const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc356g-home4-'))
      const blocked: string[] = []
      for (let g = 0; g <= MAX_ISO_KEY_GENERATIONS; g += 1) {
        const key = g === 0 ? 'K4' : `K4-${g + 1}`
        const dir = join(isoWorktreePathFor(appHome, 'T4', key, ''), 'stubborn')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'held.bin'), 'x')
        chmodSync(dir, 0o500)
        blocked.push(dir)
      }
      try {
        await chooseIsoWorkspaceKey({
          appHome,
          taskId: 'T4',
          baseKey: 'K4',
          canonRepos: [canonRepoOf(repo)],
        })
        throw new Error('应当抛 IsoWorkspaceBlockedError')
      } catch (error) {
        expect(error).toBeInstanceOf(IsoWorkspaceBlockedError)
        const detail = (error as IsoWorkspaceBlockedError).detail
        expect(detail.baseKey).toBe('K4')
        expect(detail.generationsTried).toBe(MAX_ISO_KEY_GENERATIONS + 1)
        expect(detail.residualPath).not.toBe('(unknown)')
        expect(detail.lastError).not.toBe('')
      } finally {
        for (const d of blocked) chmodSync(d, 0o700)
        removeTempDirSync(appHome)
        removeTempDirSync(repo)
      }
    },
    30_000,
  )

  test('AC-7：换代后的路径能被 isoKeyOf 回读', () => {
    const path = isoWorktreePathFor('/home', 'T', 'K-2', '')
    expect(isoKeyOf(path, 'row-id')).toBe('K-2')
    // 多仓：叶子是仓目录名，键在它的父段——这条路径上回读的是仓名，所以
    // resume 侧必须用容器路径（persistIsoBase 存的就是容器）。
    expect(isoKeyOf(isoWorktreePathFor('/home', 'T', 'K-2', 'sub'), 'row-id')).toBe('sub')
  })

  test('代际后缀必须是合法 git ref（`-N` 收、`~N` 拒）', async () => {
    const repo = await initRepo()
    const ok = await runGit(repo, ['check-ref-format', 'refs/agent-workflow/iso/T/K-2/base'])
    expect(ok.exitCode).toBe(0)
    const bad = await runGit(repo, ['check-ref-format', 'refs/agent-workflow/iso/T/K~2/base'])
    expect(bad.exitCode).not.toBe(0)
    removeTempDirSync(repo)
  }, 30_000)
})

describe('RFC-356 · 双身份 handle（设计门 P0-1）', () => {
  test('rebuildIsoHandle 缺省时两个身份同值', () => {
    const h = rebuildIsoHandle({
      appHome: '/home',
      taskId: 'T',
      nodeRunId: 'R',
      canonRepos: [canonRepoOf('/canon')],
      baseSnapshots: {},
      taskBaseHeads: {},
    })
    expect(h.nodeRunId).toBe('R')
    expect(h.dbNodeRunId).toBe('R')
  })

  test('rebuildIsoHandle 换代时物理键与 DB 身份分离', () => {
    const h = rebuildIsoHandle({
      appHome: '/home',
      taskId: 'T',
      nodeRunId: 'R-2',
      dbNodeRunId: 'R',
      canonRepos: [canonRepoOf('/canon')],
      baseSnapshots: {},
      taskBaseHeads: {},
    })
    expect(h.nodeRunId).toBe('R-2')
    expect(h.dbNodeRunId).toBe('R')
    // 路径按物理键派生，不是按行 id。
    expect(h.containerPath).toBe(isoWorktreePathFor('/home', 'T', 'R-2', ''))
  })

  test('合成键但没带 DB 身份 ⇒ createNodeIso 响亮拒绝（结构性防线）', async () => {
    const repo = await initRepo()
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc356g-home5-'))
    await expect(
      createNodeIso({
        appHome,
        taskId: 'T5',
        nodeRunId: 'K5-2', // 看起来像代际键
        canonRepos: [canonRepoOf(repo)],
      }),
    ).rejects.toThrow(/dbNodeRunId/)
    removeTempDirSync(appHome)
    removeTempDirSync(repo)
  }, 30_000)

  test('discardNodeIso 的 effect observer 吃的是 DB 身份，不是物理键', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'nodeIsolation.ts'),
      'utf8',
    )
    const at = src.indexOf('export async function discardNodeIso')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('\n}', at))
    // observer 的 nodeRunId 必须是 dbNodeRunId：喂物理键会让 readLineage 返 null、
    // beforeAct 抛 task-continuation-stale，而那一句在 try 外、调用点是裸 await。
    expect(body).toMatch(/nodeRunId: handle\.dbNodeRunId/)
    expect(body, 'observer 不得吃物理键').not.toMatch(/nodeRunId: handle\.nodeRunId,\s*\n\s*kind:/)
    // 反过来：路径 / ref / resourceKeys 必须继续用物理键。
    expect(body).toMatch(/isolation:\$\{handle\.taskId\}:\$\{handle\.nodeRunId\}/)
    expect(body).toMatch(/deleteIsoRefs\(r\.canonWorktreePath, handle\.taskId, handle\.nodeRunId/)
  })
})

describe('RFC-356 · handleTaskIdOf 分隔符（AC-14）', () => {
  test('POSIX 与 Windows 两种路径形状都能回读 taskId', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'nodeIsolation.ts'),
      'utf8',
    )
    const at = src.indexOf('function handleTaskIdOf')
    const body = src.slice(at, src.indexOf('\n}', at))
    // 改动前是 `split('/')`：Windows 上路径由 join() 生成、是反斜杠，于是
    // lastIndexOf('iso') 恒为 -1、函数恒返回 'unknown'，RFC-210 的池锚点全部串台。
    // 用 toContain 而不是正则：这段要匹配的正是「一个含反斜杠的正则字面量」，
    // 再套一层正则转义只会把可读性烧光（第一版就是在这上面写错了转义层数）。
    expect(body, '必须两种分隔符都认').toContain('split(/[\\\\/]/)')
    expect(body, '不得退回只认正斜杠').not.toContain("split('/')")
  })
})
