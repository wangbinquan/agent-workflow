// RFC-248 D1 — 嵌套挂载点的排除规则区块。
//
// 一个仓的工作树里若嵌了别的成员，那些成员的目录在它眼里是**未跟踪目录**，
// 且 `git add -A`（RFC-075 自动提交推送用的正是它，`commitPushRunner.ts:244`）
// 会把它们**当作 gitlink 加入索引**并告警 `adding embedded git repository`
// ——推上去就是一个指向不存在子模块的坏指针。所以必须排除。
//
// 三条实测（proposal §实测依据 E1–E4）决定了为什么是「改 .gitignore 且做成
// 平台预置 commit」而不是别的：
//   - `.git/info/exclude` 是 **common-dir 级**的，写进去会污染同一个镜像的
//     **所有**任务 worktree；per-worktree gitdir 下那份**无效**。
//   - 把规则留成未提交的工作区改动，会让 `M .gitignore` 出现在**每一份**审计
//     diff 里，并被 `add -A` 提交推到远端；而 ignore 规则只作用于未跟踪文件，
//     没有办法「让 .gitignore 忽略自己的修改」。
//   - 做成 `base_commit` 之前的一笔 commit，审计 diff（`base_commit..工作树`）
//     就彻底干净，且规则对人可见可解释。
//
// 幂等是硬要求：RFC-075 的 `workingBranch` 允许复用一条真实开发分支，同一条
// 分支上跑多个任务时不能累积多个相同 commit。

/** 区块标记。`taskId` 只进开标记，闭标记保持固定，便于正则/字符串双向定位。 */
const BLOCK_OPEN_PREFIX = '# >>> agent-workflow: nested repo mounts'
const BLOCK_CLOSE = '# <<< agent-workflow: nested repo mounts <<<'

export interface GitignoreBlockPlan {
  /** 写回 `.gitignore` 的完整内容；`added` 为空时与入参 `existing` 相同。 */
  nextContent: string
  /** 本次**新加**的规则行（已存在的被过滤掉）。空数组 ⇒ 无需 commit。 */
  added: string[]
}

/**
 * 一条挂载点相对路径 → 一条 gitignore 规则。锚定到仓根并显式标成目录。
 *
 * **必须转义 gitignore 的元字符**：`*` `?` `[` `]` 在 gitignore 里是通配/字符类
 * 语法。目录名 `a[b]` 不转义会生成 `/a[b]/`，git 把它当成「a 后面跟一个 b 字符」
 * ——匹配的是 `ab/` 而不是字面的 `a[b]/`。结果就是该排的没排，`git add -A` 把
 * 嵌套仓当 gitlink 提交上去（实测 proposal E2）。
 *
 * 行首的 `!`（取反）与 `#`（注释）不需要处理：规则永远以 `/` 开头。
 * 反斜杠不需要处理：`normalizeMountPath` 已经拒绝了含 `\` 的挂载路径，所以这里
 * 加的 `\` 一定是我们自己加的转义符。
 */
export function ruleForMount(relMountPath: string): string {
  const escaped = relMountPath.replace(/[*?[\]]/g, (ch) => `\\${ch}`)
  return `/${escaped}/`
}

/**
 * 计算把 `rules` 并进 `existing` 之后的 `.gitignore` 内容。
 *
 * 幂等：已经逐字符存在于文件里的规则行不会被重复追加；全部已存在时
 * `added` 为空数组，调用方据此**跳过 commit**（不产生空 commit）。
 */
export function buildGitignoreBlock(
  existing: string,
  relMountPaths: readonly string[],
  taskId: string,
): GitignoreBlockPlan {
  // 逐行精确比对，避免 `/vendor/sdk/` 被 `/vendor/sdk-old/` 之类的行误判为已存在。
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()))
  const rules = relMountPaths.map(ruleForMount)
  const added = rules.filter((r) => !existingLines.has(r))
  if (added.length === 0) return { nextContent: existing, added: [] }

  const block = [`${BLOCK_OPEN_PREFIX} (task ${taskId}) >>>`, ...added, BLOCK_CLOSE].join('\n')

  // 追加而不是就地改写既有区块：同一条 workingBranch 上的第二个任务会看到
  // 上一个任务留下的区块（规则相同则 added 为空、根本走不到这里；规则不同则
  // 说明布局变了，两个区块并存是正确的——旧规则对新任务无害）。
  const sep = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return { nextContent: `${existing}${sep}${block}\n`, added }
}

/** 该文件里是否已经有任意一个平台写的区块（诊断 / 测试用）。 */
export function hasAgentWorkflowBlock(content: string): boolean {
  return content.includes(BLOCK_OPEN_PREFIX)
}
