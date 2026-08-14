// RFC-287 G7 / AC-10 —— 「任务还没有工作树」不得被当成「工作树 = daemon 的 cwd」。
//
// G7 把仓库准备移到任务行落库**之后**，于是空 `worktreePath` 从「物化失败」这一罕见
// 终态，变成了**每个**延后准备任务在准备窗口内的正常状态。同一段路径包含性代码，
// 暴露面因此完全不同了——这正是 AC-10 要求「全部消费点逐处复核」的原因。
//
// 具体的坑：`resolve('')` 返回的是**当前进程的 cwd**。于是
// `existsInsideRoot('', 'package.json')` 会返回 true——一个准备中的任务就成了「读
// daemon 工作目录下任意文件」的入口。判据下沉到 `checkLexicalThenRealpath` 这个共用
// 底座上，因为它同时喂着 exists（探在不在）与 read（真读内容）两个消费方，只堵一个
// 必漏另一个。

import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkLexicalThenRealpath } from '@/util/safePath'
import { existsInsideRoot, readInsideRoot } from '@/services/portArtifacts'

describe('RFC-287 G7 — 空根一律判否（共用底座）', () => {
  test('checkLexicalThenRealpath 对空根不解析、不判 inside', () => {
    const v = checkLexicalThenRealpath('', 'package.json')
    expect(v.lexicalInside).toBe(false)
    expect(v.realpath.resolved).toBe(false)
    // 且不得把 cwd 泄漏成根。
    expect(v.rootAbs).toBe('')
  })

  // 这两条是**真行为**：`package.json` 在 daemon 的 cwd（仓库根）下确实存在，
  // 修复前 exists 会返回 true、read 会真的把它读出来。
  test('existsInsideRoot 空根不再命中 cwd 下的真实文件', () => {
    expect(existsInsideRoot('', 'package.json')).toBe(false)
    expect(existsInsideRoot('', 'CLAUDE.md')).toBe(false)
  })

  test('readInsideRoot 空根不再读出 cwd 下的真实文件', () => {
    expect(readInsideRoot('', 'package.json')).toBeNull()
  })

  test('非空根的正常行为逐字不变（别把守卫写成一刀切）', () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-t14-root-'))
    try {
      writeFileSync(join(root, 'a.txt'), 'hello\n')
      expect(existsInsideRoot(root, 'a.txt')).toBe(true)
      expect(readInsideRoot(root, 'a.txt')?.toString()).toBe('hello\n')
      // 逃逸仍然被挡。
      expect(existsInsideRoot(root, '../a.txt')).toBe(false)
      const v = checkLexicalThenRealpath(root, 'a.txt')
      expect(v.lexicalInside).toBe(true)
      expect(v.rootAbs).toBe(resolve(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('RFC-287 G7 — worktree-files 路由挡住「还没有工作树」', () => {
  // 该路由此前直接 `resolve(task.worktreePath)` 当根用，空串同样锚到 cwd。
  // 它有自己的一道 404，语义比「路径逃逸」准确：任务不是被拒绝，是还没准备好。
  test('路由在取根之前先判空 worktreePath', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'worktree-files.ts'),
      'utf8',
    )
    const guard = src.indexOf("task.worktreePath === ''")
    const useRoot = src.indexOf('resolve(task.worktreePath)')
    expect(guard, 'worktree-files 应有空 worktreePath 守卫').toBeGreaterThan(-1)
    expect(useRoot).toBeGreaterThan(-1)
    expect(guard, '守卫必须在取根之前').toBeLessThan(useRoot)
    expect(src).toContain('worktree-not-ready')
  })
})
