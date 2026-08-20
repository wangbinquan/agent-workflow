// RFC-310 —— 「裸文件名的父目录」在 Windows 上是一颗雷（2026-08-20 实撞）。
//
// `mkdirSync(dirname(p), { recursive: true })` 几乎人人都这么写，但对**裸文件名**
// （`dirname('a.txt') === '.'`）它在 POSIX 上是 no-op、在 Windows 上**抛 EEXIST**。
// development stub 的 `change.implement` 分支正是这个写法，于是 RFC-310 的全旅程
// E2E 在 windows 那格红了两天，症状只有 `opencode exited with code 1`——一个未捕获
// 异常（stub 自己的失败走 exit 2），连「是不是 stub 的问题」都判断不了。真因
// `EEXIST: file already exists, mkdir '.'` 是给非零退出的回执补上 stderr 尾巴、
// 并把沿途两道截断都修掉之后才第一次看见的。
//
// 这条锁在**纯判据**上而不是「在临时目录里写个文件不抛异常」：后者在 POSIX 上
// 用旧代码也照样绿——一条在出问题的平台之外永远为真的断言，不叫回归防护。

import { describe, expect, test } from 'bun:test'

import { parentDirToCreate } from '../src/runtime/mode-development'

describe('RFC-310 —— 裸文件名不得触发 mkdir', () => {
  test('a bare file name yields no directory to create', () => {
    // 这一条就是 windows 那格的全部：旧代码在这里拿到 '.' 并去 mkdir。
    expect(parentDirToCreate('digital-employee-result.txt')).toBeNull()
    expect(parentDirToCreate('./digital-employee-result.txt')).toBeNull()
    expect(parentDirToCreate('')).toBeNull()
  })

  test('a real parent directory is still returned', () => {
    expect(parentDirToCreate('a/b.txt')).toBe('a')
    expect(parentDirToCreate('a/b/c.txt')).toBe('a/b')
  })
})
