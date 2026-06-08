# RFC-089 — 结构页签多代码仓适配

状态：Draft

## 背景

RFC-066 引入多代码仓任务（`task.repoCount > 1`，每个仓一个子 worktree，父目录为
opencode cwd）。任务详情页的两个 diff 视图对多仓的支持并不对齐：

- **「工作目录 diff」（文本）** 已在 `c16f59a` 完成按仓分组适配：`getTaskDiff`
  逐仓拼接 `# === Repo: <name> ===` 标记，前端 `splitByRepo` 分段，文件列按仓
  分组标题渲染，跨仓同路径文件互不串扰；并补了 `isGitWorkTree` 守卫把「目录在
  但已非 git 仓库」收敛为干净 410。
- **「工作目录结构」（语义/结构 diff，RFC-083）** 只做到一半：
  - **task 作用域能跑**：`getTaskStructuralDiff` 多仓分支逐仓计算后
    `mergeStructuralDiffs` 把文件路径前缀成 `仓目录/原路径`，前端目录树
    （`fileTreeRows`）按 `/` 建树，于是 `repo-a/`、`repo-b/` 天然成为顶层目录
    → Tree / Impact / Deps 三视图可用、按仓可区分。
  - **类关系图（Graph 视图）多仓为空**：`mergeStructuralDiffs` 显式
    `classEdges: []`（`assemble.ts:140`，注释「multi-repo class edges would need
    label-prefixed keys — deferred」）。原因是 `classEdges.from/to` 是
    `${filePath}::${qn}`，而合并时只前缀了 `files[].filePath`、没前缀类边的 key，
    两边对不上，于是整批丢弃。
  - **调用链（Call-chain）多仓禁用**：`callChainAvailable` 在单仓的
    `assemble.ts:61` 计算，但 `mergeStructuralDiffs` 不透传 → 多仓恒为
    undefined（UI 视为 false），⎇ 入口不出现。
  - **node 作用域多仓直接报错**：`service.ts:164` 抛
    `structural-node-scope-multi-repo-unsupported`，注释「per-node snapshots live
    in pre_snapshot_repos_json — deferred」。但该列其实已存在
    （`schema.ts:547`）且多仓回滚已在用它（`task.ts:876`），只是结构服务没用。
  - **not-a-repo 隐患未修**：结构服务仍用 `existsSync`（`service.ts:84/105/115/
    201`）而非 `isGitWorkTree`，损坏 worktree 会 500（仅目录完全消失才有
    `readStoredDiff` 兜底）。

## 目标

让「工作目录结构」页签在多仓任务下与单仓能力**对齐**：

1. 五个视图（Tree / Graph / Impact / Deps / Call-chain）在多仓 task 作用域全部可用，
   且按仓清晰区分。
2. node 作用域支持多仓（复用 `preSnapshotReposJson`），不再整体报错。
3. 损坏 / 非 git worktree 返回干净 410，与文本 diff 页签一致。
4. 文件树有明确的「按仓」可读性（不只是恰好成了顶层目录）。

## 非目标

- **跨仓符号解析**：repo-a 的类继承 / 调用 repo-b 的符号——v1 仍各仓独立解析，
  跨仓引用按 `external`/`unresolved` 优雅降级，不做跨仓符号表合并。
- **deep 模式跨仓索引器合并**的高级语义（SCIP 跨仓）——deep 仍逐仓 baseline 兜底。
- 改变单仓任何现有行为（字节级 / 契约级保持，单仓是回归基线）。

## 用户故事

- 作为多仓任务的评审者，我打开「工作目录结构」，文件树按仓分组，能一眼看出每个
  改动属于哪个仓；
- 切到 Graph 视图，能看到（各仓内部的）类继承 / 引用关系，而不是一张空图；
- 在 scope 选择器里选某个节点运行，能看到该节点在各仓的结构改动，而不是红错；
- 对某个改动方法点「调用链」，能逐层展开它在所属仓内的直接被调用者。

## 验收标准

| 场景 | 期望 |
| --- | --- |
| 多仓 task 作用域 Tree | 文件按仓分组，跨仓同路径不串 |
| 多仓 task 作用域 Graph | 类边非空；边只连同仓卡片；跨仓不误连 |
| 多仓 task 作用域 Call-chain | ⎇ 入口出现；展开解析到所属仓的被调方；跨仓被调显示 external |
| 多仓 node 作用域 | 返回该节点各仓结构 diff（合并），不再抛 unsupported |
| 损坏 / 非 git worktree | 410 `task-worktree-missing`（含 readStoredDiff 兜底优先） |
| 单仓全场景 | 与现状字节 / 契约一致（回归基线） |
| 部分仓不可用 | `status: 'partial'`，可用仓照常出，不整体失败 |
