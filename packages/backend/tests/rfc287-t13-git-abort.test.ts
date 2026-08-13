// RFC-287 T13（G7 子项）—— 取消要**真杀** git 子进程。
//
// 用户可见的问题：点了取消，界面立刻回到 canceled，但一个正在克隆几百 MB 的
// `git clone` 还在后台跑几分钟——占着带宽与磁盘，任务的工作树甚至会在「已取消」
// 之后才被创建出来。修法是给 `runGit` 接 `AbortSignal`，杀法与既有的 `timeoutMs`
// 完全一致（进程组 + SIGKILL）：git 会自由派生（credential helper、ssh、`!` 别名
// 走 shell），只杀直接子进程会留下孙进程握着管道。
//
// 这条**不是**源码断言——它真起一个慢 git 并在中途中断，看它是不是真的停了。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runGit, GIT_ABORTED_EXIT_CODE } from '@/util/git'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('RFC-287 T13 — 取消真杀 git', () => {
  test('abort 后 git 立即返回，且退出码不会被误判成成功', async () => {
    const dir = tmp('aw-t13-abort-')
    try {
      await runGit(dir, ['init', '-q', '-b', 'main', dir])
      // `git ls-remote` 指向一个不可路由的地址：它会长时间卡在连接上，正好当
      // 「慢 git」用。不用真 clone 是为了不依赖网络与体积。
      const ac = new AbortController()
      const started = Date.now()
      const p = runGit(
        dir,
        ['-c', 'core.askpass=true', 'ls-remote', 'http://10.255.255.1:9/x.git'],
        {
          signal: ac.signal,
        },
      )
      setTimeout(() => ac.abort(), 300)
      const r = await p
      const elapsed = Date.now() - started
      // 被杀掉才可能这么快回来——不杀的话这个连接要挂到系统 TCP 超时（数十秒）。
      expect(elapsed).toBeLessThan(10_000)
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toContain('git aborted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('已经 aborted 的 signal 传进来也立刻收场（不留活进程）', async () => {
    const dir = tmp('aw-t13-pre-abort-')
    try {
      await runGit(dir, ['init', '-q', '-b', 'main', dir])
      const ac = new AbortController()
      ac.abort()
      const r = await runGit(dir, ['ls-remote', 'http://10.255.255.1:9/x.git'], {
        signal: ac.signal,
      })
      expect(r.exitCode).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('不传 signal 时行为逐字不变（正常 git 照常成功）', async () => {
    const dir = tmp('aw-t13-nosignal-')
    try {
      await runGit(dir, ['init', '-q', '-b', 'main', dir])
      writeFileSync(join(dir, 'a.txt'), 'x\n')
      await runGit(dir, ['add', '.'])
      const r = await runGit(dir, [
        '-c',
        'user.email=t@e',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'i',
      ])
      expect(r.exitCode).toBe(0)
      const log = await runGit(dir, ['log', '--oneline'])
      expect(log.exitCode).toBe(0)
      expect(log.stdout.trim().length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('取消码与超时码可区分（上层要给不同文案）', () => {
    expect(GIT_ABORTED_EXIT_CODE).not.toBe(124)
  })
})

// RFC-287 T13（G7 子项）—— `gitCloneTimeoutMs` 必须真的到达任务启动路径。
//
// 修复前：这个配置只被两条**仓库路由**（cached-repos / repoGroups）传给
// `resolveCachedRepo`，任务启动那条路径压根没接——管理员把它调小，手动导入仓库
// 时生效，而真正会卡住启动接口的那次克隆仍按 30 分钟默认值跑。与 RFC-284 T30
// 挖出的「字段因类型缺席被 spread 静默丢弃」是同一类断链，故按同样口径上锁：
// 既锁漏斗产出，也锁调用点确实透传。
describe('RFC-287 T13 — gitCloneTimeoutMs 接线到启动路径', () => {
  test('漏斗把 config.gitCloneTimeoutMs 映射成下游入参名 cloneTimeoutMs', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'launchRuntimeConfig.ts'),
      'utf8',
    )
    expect(src).toMatch(/cfg\.gitCloneTimeoutMs[\s\S]{0,80}out\.cloneTimeoutMs/)
    // 类型面必须同时声明——RFC-284 T30 那批字段正是「只赋值、类型没声明」被丢的。
    expect(src).toMatch(/cloneTimeoutMs\?: number/)
  })

  test('startTask 把它透传给 resolveCachedRepo（不透传等于配置形同虚设）', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    expect(src).toMatch(/cloneTimeoutMs\?: number/)
    expect(src).toMatch(
      /resolveCachedRepo\(\s*\{[\s\S]{0,400}deps\.cloneTimeoutMs !== undefined \? \{ cloneTimeoutMs: deps\.cloneTimeoutMs \}/,
    )
  })
})
