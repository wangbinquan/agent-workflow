// RFC-287 G7 / AC-10 第二轮 —— 准备窗口把四类既有代码的输入分布改掉了。
//
// 这批的共同点：**代码一行没改，变的是喂给它的值**。G7 把仓库准备移到任务行落库
// 之后，于是空 `worktreePath`、空 `task_repos`、指向未克隆镜像的 `cached_repo_id`、
// 「pending 但无驱动」这四个值，从罕见终态变成了**每次 JSON-body 启动都会经历**的
// 正常中间态，时长等于整个克隆。
//
// 第一轮双路实现门都在看 diff，所以**都没看见**——这些消费点不在 diff 里。本文件
// 是「按放宽了的取值范围反查所有消费方」这条方法的产物。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { MIGRATIONS } from './migration-freeze'
import { openContainedFile } from '@/services/worktreeFileContent'
import { resolveRepoTarget } from '@/services/codeIntel/fileSymbols'

describe('AC-10 读洞①②：空根不得锚到 daemon 的 cwd（openContainedFile）', () => {
  // `resolve('')` 返回**当前进程的 cwd**。修复前 `GET /api/tasks/:id/file-content`
  // 与 `/file-symbols` 在准备窗口内会把 daemon 自己的源码读出来——两条路由只要
  // `tasks:read`，而攻击者自己起一个任务就是 owner，`side` 默认还就是 `worktree`。
  //
  // 用**真实存在于 cwd 下**的文件当探针：修复前它们 `exists=true` 并能读到内容。
  test('空根 + cwd 下真实存在的文件 → 不得命中', () => {
    for (const rel of ['package.json', 'tsconfig.json', 'src/services/task.ts']) {
      const r = openContainedFile('', rel)
      expect(r.kind, `root='' rel='${rel}'`).not.toBe('ok')
    }
  })

  // 标题只声称**结果**：不依赖 `..` 预筛也照样判否。原标题写的是「发生在任何路径
  // 推导之前」——那是位置断言，本条验不了：把守卫挪到 `..` 预筛下面，它仍绿
  //（三轮门测试有效性自查实证）。
  test('空根判否不依赖 .. 预筛（干净 rel 也照样拒）', () => {
    // 这些 rel 都不含 `..`、都不是绝对路径，所以旧实现的两道预筛全都放行。
    expect(openContainedFile('', 'package.json').kind).toBe('not-found')
  })

  test('非空根行为逐字不变（别把守卫写成一刀切）', () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-t14b-root-'))
    try {
      writeFileSync(join(root, 'a.txt'), 'hello\n')
      const ok = openContainedFile(root, 'a.txt')
      expect(ok.kind).toBe('ok')
      // 逃逸仍被挡。
      expect(openContainedFile(root, '../a.txt').kind).toBe('outside')
      expect(openContainedFile(root, '/etc/hosts').kind).toBe('outside')
      expect(openContainedFile(root, 'nope.txt').kind).toBe('not-found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('AC-10 读洞③④：code-intel 取根时必须拒「还没有工作树」', () => {
  // deep 模式会把这个根当 `cwd` 交给 SCIP indexer 子进程，而 `Bun.spawn({cwd:''})`
  // 回落进程 cwd ⇒ 在 daemon 工作目录上跑一次完整索引、进缓存、对外应答。
  // baseline 模式则经 getTaskFileSymbols 落回上面那个 openContainedFile。
  const taskLike = (over: Record<string, unknown>): never =>
    ({
      id: 'T1',
      repoCount: 1,
      worktreePath: '',
      baseCommit: null,
      repos: [],
      ...over,
    }) as never

  test('单仓（准备窗口内 repoCount 恒为 1）：空 worktreePath → 抛，不返回空根', () => {
    expect(() => resolveRepoTarget(taskLike({}), undefined)).toThrow(/worktree/i)
  })

  // 多仓任务在准备窗口内 `repoCount` 也是 1（回填后才变 N），所以走的是单仓分支
  // ——攻击者连 `repo` 参数都不用给。上一条已覆盖那支。
  //
  // ⚠️ 这一条原来写的是 `taskLike({ repoCount: 1, repos: [] })`——与上一条的
  // `taskLike({})` **逐字等价**（两个字段本就是默认值），于是它零增量，而它标题
  // 声称覆盖的**多仓分支**（fileSymbols.ts 的 `repo.worktreePath === ''`）实际
  // 无人覆盖：把那段守卫整段删掉，全套仍绿（三轮门测试有效性自查实证）。
  // 改成真正的多仓形态：repoCount=2 + 指名的那个仓工作树还没建出来。
  test('多仓回填后：指名的仓工作树未就绪 → 同样拒绝，不返回空根', () => {
    const multi = taskLike({
      repoCount: 2,
      worktreePath: '/tmp/wt-root',
      baseCommit: 'abc',
      repos: [
        { mountPath: '', worktreePath: '/tmp/wt-root', baseCommit: 'abc' },
        { mountPath: 'sub', worktreePath: '', baseCommit: null },
      ],
    })
    expect(() => resolveRepoTarget(multi, 'sub')).toThrow(/worktree/i)
    // 反向：同一任务里已就绪的那个仓照常返回（守卫不一刀切）。
    expect(resolveRepoTarget(multi, '.')).toEqual({
      worktreePath: '/tmp/wt-root',
      baseCommit: 'abc',
    })
  })

  test('已准备好的任务照常返回根（守卫不误伤正常路径）', () => {
    const t = taskLike({ worktreePath: '/tmp/wt', baseCommit: 'abc' })
    expect(resolveRepoTarget(t, undefined)).toEqual({
      worktreePath: '/tmp/wt',
      baseCommit: 'abc',
    })
  })
})

describe('G7 —— 身份登记不得堵在克隆锁后面', () => {
  // 二轮门后由门禁抓到的真回归（本地绿、门禁红）：`ensureCachedRepoIdentity` 一度与
  // 克隆共用 `withUrlLock`。那把锁的临界区里跑 `git clone`，一次可能几分钟；于是
  // **同一 URL** 上只要有人正在克隆，后来者的请求路径就一直堵到克隆结束——G7 承诺的
  // 「启动接口立刻返回」对第二个用户直接失效。门禁里表现为「立刻返回」那条断言从
  // <1.5s 变成 3005ms，正好等于前一次克隆的 timeout。
  //
  // 直接按**行为**验，不靠时序碰巧：先起一个注定要耗满 timeout 的 resolveCachedRepo
  // 占住克隆锁，再对**同一个 URL** 登记身份，看它是不是立刻回来。
  test('克隆锁被占住时，同一 URL 的身份登记仍立刻返回', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-idlock-'))
    // 不可路由地址：克隆会一直卡到 cloneTimeoutMs。
    const url = 'http://10.255.255.1:9/identity-lock-probe.git'
    try {
      const { resolveCachedRepo, ensureCachedRepoIdentity } =
        await import('@/services/gitRepoCache')
      // 占锁：故意不 await，让它在后台把克隆锁握满 3 秒。
      let cloneSettled = false
      const blocking = resolveCachedRepo({ db, appHome, cloneTimeoutMs: 3_000 }, { url })
        .catch(() => null)
        .finally(() => {
          cloneSettled = true
        })
      // 给它一点时间真正进入临界区。
      await new Promise((r) => setTimeout(r, 200))
      // ⚠️ 前提复核，缺了它这条用例会**静默失去全部预言力**（三轮门测试有效性自查
      // 实证）：本条的力量全靠 10.255.255.1:9 一直挂到 3s 超时、锁还握在手里。若 CI
      // 的网络是 ICMP 立刻拒绝 / 走代理 / 被沙箱掐断，克隆会在 ~205ms 就结束——早于
      // 这个 200ms sleep。那时**即便缺陷还在**（身份共用克隆锁），下面的耗时也只有
      // 1~3ms，断言照样绿。所以先断言「锁此刻确实还被握着」，前提不成立就红。
      expect(cloneSettled, '前置不成立：克隆已经结束、锁没被握住，本用例此刻零预言力').toBe(false)

      const t0 = Date.now()
      const id = await ensureCachedRepoIdentity({ db, appHome }, { url })
      const elapsed = Date.now() - t0
      expect(id.cachedRepoId).not.toBe('')
      // 关键：不得被克隆锁堵住。共用一把锁时这里会是 ~2800ms（剩余的 timeout）。
      expect(elapsed, '身份登记堵在了克隆锁后面 —— G7 的立刻返回失效').toBeLessThan(1_000)
      await blocking
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  }, 30_000)
})
