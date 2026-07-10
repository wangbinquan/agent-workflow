import { rimrafDir } from './helpers/cleanup'
// RFC-103 T7 (调研报告 05-PORT MISSED, Codex) — 端口文件 realpath 越界防护。
//
// 为什么这条测试存在：path / markdown_file 端口原本只做词法包含、不做 realpath，
// worktree 内的 symlink 指向 worktree 外即可读出任意文件（凭据/密钥）。修复加
// realpath 包含校验（与 worktreeFiles 一致）。本测试锁定：越界 symlink 抛错、
// 界内 symlink 仍放行（不误伤合法用例）。
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortContent } from '../src/services/envelope'
import { ValidationError } from '../src/util/errors'
import { isWindows } from './helpers/stub-runtime'

const canSymlink = isWindows
  ? // On Windows, file symlinks need developer mode; check at runtime
    (() => {
      try {
        const d = mkdirSync(join(tmpdir(), 'aw-symlink-probe-'), { recursive: true }) as string
        symlinkSync(join(d, 'x'), join(d, 'y'), 'file')
        rimrafDir(d)
        return true
      } catch {
        return false
      }
    })()
  : true

describe('RFC-103 T7 端口 symlink realpath 包含', () => {
  let worktree: string
  let outside: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'aw-rfc103-wt-'))
    outside = mkdtempSync(join(tmpdir(), 'aw-rfc103-outside-'))
    writeFileSync(join(outside, 'secrets.txt'), 'TOP SECRET')
    writeFileSync(join(worktree, 'real.md'), 'INSIDE OK')
  })
  afterEach(() => {
    rimrafDir(worktree)
    rimrafDir(outside)
  })

  test('worktree 内 symlink → 仓外文件：抛 ValidationError（不读穿）', () => {
    if (!canSymlink) return // needs developer mode on Windows
    symlinkSync(join(outside, 'secrets.txt'), join(worktree, 'evil.md'))
    expect(() =>
      resolvePortContent({ rawContent: 'evil.md', kind: 'markdown_file', worktreePath: worktree }),
    ).toThrow(ValidationError)
  })

  test('worktree 内 symlink → 仓内文件：放行（realpath 仍在界内）', () => {
    if (!canSymlink) return // needs developer mode on Windows
    symlinkSync(join(worktree, 'real.md'), join(worktree, 'inside-link.md'))
    expect(
      resolvePortContent({
        rawContent: 'inside-link.md',
        kind: 'markdown_file',
        worktreePath: worktree,
      }),
    ).toBe('INSIDE OK')
  })

  test('普通界内文件不受影响', () => {
    expect(
      resolvePortContent({ rawContent: 'real.md', kind: 'markdown_file', worktreePath: worktree }),
    ).toBe('INSIDE OK')
  })
})
