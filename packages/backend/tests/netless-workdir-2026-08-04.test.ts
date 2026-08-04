// 2026-08-04 审计 P0 回归锁：无网 wrapper 丢弃模型指定的 `workdir`。
//
// OpenCode 的 shell 工具带 `workdir` 参数，且它自己的系统提示明确要求模型**优先用
// workdir 而不是 `cd <dir> && <cmd>`**（opencode `packages/opencode/src/tool/shell/prompt.ts`），
// 随后按该参数设置 shell 子进程的 cwd（`tool/shell.ts`）——而那个 shell 就是本平台的
// wrapper。wrapper 此前把 cwd 硬钉成 `manifest.worktreePath`，于是
// `workdir: packages/x` + `command: pytest tests` 实际在仓根执行：相对路径全部错位，
// 命令「成功」或以无关原因失败，模型据此继续推理。**全链零日志零告警**，monorepo /
// 仓库组任务必中——这是最坏的一类失败：静默产出错误结论。
//
// 修法不是「放开 cwd」，而是「按构造保边界」：只有落在围栏本就可写的子树里的请求才被
// 采纳，其余（或未请求）一律退回工作树。

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  resolveNetlessCwd,
  type NetlessSubprocessManifest,
} from '../src/services/runtime/opencode/sealedSubprocess'

const WORKTREE = '/tmp/aw-nw/worktree'
const SCRATCH = '/tmp/aw-nw/scratch'

const manifest = {
  version: 1,
  worktreePath: WORKTREE,
  scratchPath: SCRATCH,
  realHome: '/home/aw',
  appHome: '/home/aw/.agent-workflow',
  gitCommonDirs: [],
  bindReadOnly: [],
  command: ['/bin/sh'],
  env: { HOME: SCRATCH, TMPDIR: join(SCRATCH, 'tmp') },
  provider: { providerId: 'none', config: {} },
} as unknown as NetlessSubprocessManifest

describe('resolveNetlessCwd — 采纳 workdir，但只在围栏内', () => {
  test('未请求 ⇒ 退回工作树（历史行为）', () => {
    expect(resolveNetlessCwd(manifest, undefined)).toBe(WORKTREE)
  })

  test('工作树的子目录 ⇒ 采纳（这正是 monorepo 的 workdir 用法）', () => {
    const sub = join(WORKTREE, 'packages', 'x')
    expect(resolveNetlessCwd(manifest, sub)).toBe(sub)
  })

  test('工作树本身 ⇒ 采纳', () => {
    expect(resolveNetlessCwd(manifest, WORKTREE)).toBe(WORKTREE)
  })

  test('围栏外的绝对路径 ⇒ 拒绝并退回工作树（边界不因此放宽）', () => {
    expect(resolveNetlessCwd(manifest, '/etc')).toBe(WORKTREE)
    expect(resolveNetlessCwd(manifest, '/home/aw')).toBe(WORKTREE)
  })

  test('前缀相似但不是后代（worktree-evil）⇒ 拒绝', () => {
    expect(resolveNetlessCwd(manifest, `${WORKTREE}-evil`)).toBe(WORKTREE)
  })

  test('相对路径 ⇒ 拒绝（wrapper 只接受绝对 cwd）', () => {
    expect(resolveNetlessCwd(manifest, 'packages/x')).toBe(WORKTREE)
  })

  test('私有 scratch（HOME/TMPDIR 所在）⇒ 采纳，它本就是可写子树', () => {
    expect(resolveNetlessCwd(manifest, SCRATCH)).toBe(SCRATCH)
  })
})
