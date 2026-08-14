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

  test('空根的判否发生在任何路径推导之前（不依赖 .. 预筛）', () => {
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
  // ——攻击者连 `repo` 参数都不用给。这条锁住那个「不需要额外参数」的事实。
  test('多仓任务在窗口内同样落单仓分支并被拒（无需 repo 参数）', () => {
    expect(() => resolveRepoTarget(taskLike({ repoCount: 1, repos: [] }), undefined)).toThrow(
      /worktree/i,
    )
  })

  test('已准备好的任务照常返回根（守卫不误伤正常路径）', () => {
    const t = taskLike({ worktreePath: '/tmp/wt', baseCommit: 'abc' })
    expect(resolveRepoTarget(t, undefined)).toEqual({
      worktreePath: '/tmp/wt',
      baseCommit: 'abc',
    })
  })
})
