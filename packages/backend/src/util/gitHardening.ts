// RFC-252 G1 — daemon 侧 git 执行面收口。
//
// 威胁模型：agent 对本任务 worktree 与其 git 公共目录持有**合法**写权限
// （`sealedSubprocess.ts` 的 `gitCommonDirs` 是 rw allow-back —— `git commit` 必需，
// 拿不掉），因此它可以往仓库里放一个 hook、或往 repo-local `.git/config` 写一条
// 可执行配置；随后 daemon 侧任何一次 git 调用都会**在沙箱外、以 daemon 身份、带完整
// process.env** 执行它，直达 `secret.key` / `db.sqlite`。这是当前 agent 可直接驱动的
// 唯一一条完整逃逸链。
//
// 本机 git 2.50.1 实测（RFC-252 proposal §背景，回归测试逐条复刻）：
//   - `git worktree add` 触发 `.git/hooks/post-checkout`
//   - `git status` 触发 `core.fsmonitor`
//   - 甚至不必写 `.git/hooks/`：把 repo-local `core.hooksPath` 指向 worktree 内自己的
//     目录即可，那是 agent 的正常工作区
//   - `git diff` 触发 `diff.external`
//
// 手段：命令行 `-c` 的优先级高于**所有** config 作用域（system / global / local /
// worktree / `.git/modules/**`），所以它是唯一能压过 agent 写入的机制——顺带也覆盖了
// `config.worktree` 与嵌套 submodule gitdir，无需逐个枚举。
//
// 刻意**不**用 `GIT_CONFIG_NOSYSTEM` / `GIT_CONFIG_GLOBAL=/dev/null`：威胁来自 local
// 作用域，这两个变量对它完全无效；而它们会连带禁掉 system/global 里的
// `credential.helper`（macOS 的 osxkeychain 就在 system config），打断依赖本机凭据助手
// 的私有仓 fetch。净负收益。
//
// 同样刻意**不**做「基线指纹 + 漂移即拒绝」：误报会直接让任务失败，属于「为安全把功能
// 搞坏」。本模块的每一项都经实测确认对正常 git 行为零影响。
//
// 已知残留（登记 docs/audit-backlog.md，不在本模块解决）：`filter.<n>.clean/smudge/process`
// 与 `diff.<n>.textconv` 是通配名，`-c` 压不住，需要先枚举再逐名覆盖；而无差别关闭会打断
// 用户全局 git-lfs 配置，故留作独立切片。

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { appHome } from './paths'

/**
 * 平台自有的空 hooks 目录。放在 appHome 下 —— 它在两层沙箱里都是拒绝区，agent 写不进
 * 来；放 /tmp 之类可预测且 agent 可写的位置等于把 hooksPath 又交回给它。
 */
export function gitHooksVoidDir(home: string = appHome()): string {
  return join(home, 'gitguard', 'empty-hooks')
}

/**
 * 幂等创建空 hooks 目录。best-effort：即使创建失败，git 找不到该目录时也只是「没有
 * hook 可跑」，安全性不依赖创建成功。
 */
export function ensureGitHooksVoidDir(home: string = appHome()): string {
  const dir = gitHooksVoidDir(home)
  try {
    // `mode` 会应用到 recursive 创建出的**每一级**：直接给 0o500 会让父目录
    // `gitguard/` 不可写，叶子目录随即 EACCES 建不出来（首版实测踩到）。先按默认
    // 权限建全链，再单独收紧叶子。
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o500)
  } catch {
    // 见上：找不到目录 == 没有 hook，失败不影响安全结论。
  }
  return dir
}

/**
 * 每一次 daemon 侧 git 调用都必须前置的 `-c` 覆盖集。
 *
 * `core.fsmonitor=false` 用布尔字面量而非空串：空串会让 git 认为配置了一个空命令。
 * 同理这里**不**加 `-c diff.external=` —— 实测 git 会去执行空命令并报
 * `cannot run : No such file or directory`，把 diff 直接搞坏；`diff.external` 改由
 * `--no-ext-diff` 处理（见 withExternalDiffDisabled）。
 */
export function hardenedGitLeadingArgs(home: string = appHome()): string[] {
  return ['-c', `core.hooksPath=${ensureGitHooksVoidDir(home)}`, '-c', 'core.fsmonitor=false']
}

/**
 * 定位 argv 里的 git 子命令下标：跳过前置的 `-c key=value` 与 `-C dir` 这两类
 * 「git 自身选项」。调用方本来就会传 `-c core.quotepath=false` / `-c
 * protocol.file.allow=always` 之类，所以不能假定 `args[0]` 就是子命令。
 * 返回 -1 表示 argv 里没有子命令。
 */
export function gitSubcommandIndex(args: readonly string[]): number {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '-c' || arg === '-C' || arg === '--config-env' || arg === '--namespace') {
      i += 2
      continue
    }
    if (arg !== undefined && arg.startsWith('-')) {
      i += 1
      continue
    }
    return i < args.length ? i : -1
  }
  return -1
}

/**
 * `diff` 子命令补 `--no-ext-diff`，中和 repo-local `diff.external`。
 *
 * 实测约束：`--no-ext-diff` 是 **diff 子命令的选项**，放在子命令之前会 `unknown
 * option`；因此插在子命令**紧后**。对没有配置 external diff 的仓库是 no-op，且
 * daemon 本来就要解析 unified diff —— 外部 diff 程序的输出根本不可解析，所以这条既是
 * 安全修复也是正确性修复。
 */
export function withExternalDiffDisabled(args: readonly string[]): string[] {
  const index = gitSubcommandIndex(args)
  if (index < 0 || args[index] !== 'diff') return [...args]
  if (args.includes('--no-ext-diff')) return [...args]
  return [...args.slice(0, index + 1), '--no-ext-diff', ...args.slice(index + 1)]
}

/** daemon 侧 git 的完整参数硬化：前置覆盖集 + 子命令级修正。 */
export function hardenGitArgs(args: readonly string[], home: string = appHome()): string[] {
  return [...hardenedGitLeadingArgs(home), ...withExternalDiffDisabled(args)]
}
