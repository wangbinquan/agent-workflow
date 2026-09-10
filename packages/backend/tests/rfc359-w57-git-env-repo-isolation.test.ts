// RFC-359 W57 —— `runGit` 必须**打到调用方指定的仓库**，不受环境里 git 变量的劫持。
//
// 为什么这条测试存在（2026-09-10 实撞，损失是真实的）
// -----------------------------------------------
// `nonInteractiveGitEnv()` 原样 `...process.env` 透传，于是 `GIT_DIR` 一路传进每次
// `git -C <cwd> …` 的 spawn。而 **`GIT_DIR` 的优先级高于 `-C`**：`-C` 只改工作目录，
// 仓库位置仍以 `GIT_DIR` 为准。后果是「调用方明明指定了工作区，git 却写进了别的仓库」。
//
// 实撞经过：我为了做失败归因，按 docs/dev-gotchas.md 的普查配方把
// `GIT_DIR=<真仓库>/.git` 导出给了**一整轮 `bun test`**（配方本意只覆盖普查脚本与架构守卫，
// 那些是纯文件读，无害）。`rfc359-w5-t21b-execution-chain` 这个夹具会在临时目录里
// `git init` 再 `git add README.md && git commit -m fixture`——`init` 建的是临时仓库，
// 而 `add` / `commit` 继承了 `GIT_DIR`，**打进了开发者的真仓库**：main 上凭空多出一笔
// 作者为 `Execution Chain Fixture <execution-chain@example.test>` 的提交，把 README.md
// 从 330 行删到 1 行，并留下一个 0 字节的 `.git/index.lock` 死锁。
//
// 这不只是测试卫生问题——**daemon 侧同样中招**：平台给每个任务 spawn 的是
// `git -C <任务工作树>`，只要 daemon 进程的环境里带着 `GIT_DIR`（从 git hook 起的进程、
// 或某人在 shell 里 export 过），所有任务的 git 操作都会打到那一个仓库上去。
//
// 判据：环境里存在指向 decoy 仓库的 `GIT_DIR` 时，`runGit(target, …)` 解析出的仓库
// 必须仍是 target。第二条钉住 `opts.env` 的注入面没被误伤——`snapshotFullState` 靠它
// 传 `GIT_INDEX_FILE` 做临时索引（RFC-130 D25），那是**调用方显式指定**、必须继续生效。
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nonInteractiveGitEnv, runGit } from '@/util/git'

const HIJACK_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
] as const

let root: string
let decoy: string
let target: string
const saved = new Map<string, string | undefined>()

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-git-env-')))
  decoy = join(root, 'decoy')
  target = join(root, 'target')
  for (const dir of [decoy, target]) {
    await runGit(root, ['init', '-q', '-b', 'main', dir])
  }
  for (const name of HIJACK_VARS) saved.set(name, process.env[name])
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  rmSync(root, { recursive: true, force: true })
})

test('环境里的 GIT_DIR 劫持不了 runGit：仓库仍是调用方指定的那个', async () => {
  process.env['GIT_DIR'] = join(decoy, '.git')
  const resolved = await runGit(target, ['rev-parse', '--absolute-git-dir'])
  expect(resolved.exitCode, resolved.stderr).toBe(0)
  expect(
    realpathSync(resolved.stdout.trim()),
    '环境里的 GIT_DIR 优先级高于 `-C`：不清掉它，调用方指定的工作区会被完全绕过，' +
      'git 会写进环境指向的那个仓库（2026-09-10 实撞：测试夹具据此在真仓库上提交并改坏 README）',
  ).toBe(realpathSync(join(target, '.git')))
})

test('GIT_WORK_TREE / GIT_INDEX_FILE 等同族变量一并清掉', async () => {
  for (const name of HIJACK_VARS) process.env[name] = join(decoy, '.git')
  const env = nonInteractiveGitEnv()
  for (const name of HIJACK_VARS) {
    expect(env[name], `${name} 会改写 git 认定的仓库 / 工作区 / 索引，必须从继承的环境里清掉`).toBe(
      undefined,
    )
  }
})

test('opts.env 的显式注入仍然生效（snapshotFullState 的临时索引靠它）', async () => {
  const indexPath = join(root, 'scratch.index')
  const resolved = await runGit(target, ['rev-parse', '--git-path', 'index'], {
    env: { GIT_INDEX_FILE: indexPath },
  })
  expect(resolved.exitCode, resolved.stderr).toBe(0)
  expect(
    resolved.stdout.trim(),
    'RFC-130 D25：opts.env 是调用方显式指定的注入面，清理继承环境不得把它一起废掉',
  ).toBe(indexPath)
})
