/**
 * 本次 run 的边界 mounts（runner 用）。
 *
 * 数据源是 scheduler 已填的 per-repo worktree 路径；**无论元数据说什么，进程
 * cwd 恒在其中**——否则 agent 会被挡在自己的工作树外（§0 最忌）。提成纯函数是
 * 为了让这条不变量有真正锁得住的断言面（实现门 P3-7：原先测试手抄了 runner 里
 * 的表达式，改 runner 测试照样绿）。
 *
 * RFC-487：挂载列表只处理 source-control 给出的工作区路径，由本模块的任务代理工作区内容逐个发引用，所以规则归本模块的
 * domain（原在 `services/execution/workspaceBoundary.ts`，逐字迁来）；task-execution 的本机运行入口经 `public/queries` 取。
 */
export function resolveBoundaryMounts(
  worktreePath: string,
  repoWorktreePaths: readonly string[],
): string[] {
  const fromRepos = repoWorktreePaths.filter((p) => p.length > 0)
  const withCwd = fromRepos.includes(worktreePath) ? fromRepos : [worktreePath, ...fromRepos]
  return withCwd.length > 0 ? withCwd : [worktreePath]
}
