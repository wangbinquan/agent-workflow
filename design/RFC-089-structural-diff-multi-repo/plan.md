# RFC-089 — 任务分解

4 个 PR，强序 A→B→C→D（B 抽的前缀原语被 C/D 复用；D 依赖 B 的卡片 id 前缀一致）。
每个 PR 必须 `bun run typecheck && bun run test && bun run format:check` 全绿 +
推后查 CI（[feedback_post_commit_ci_check]）。单仓回归测试是每个 PR 的硬门槛。

## PR-A（P1）— isGitWorkTree 一致性 + 文件树按仓可读
- **RFC-089-T1**：`structuralDiff/service.ts` task/node/wrapper 三处 +
  多仓 `usable` filter 的 `existsSync` → `isGitWorkTree`（保 readStoredDiff 兜底在前）。
- **RFC-089-T2**：前端结构文件树 depth-0「仓」节点可读标签（复用既有 row 渲染）。
- 验收：单仓目录在但非仓库 → 410；多仓文件树按仓分组可见；单仓不变。
- 测试：后端路由 410 用例；前端多仓分组渲染断言。

## PR-B（P2）— 类关系图多仓
- **RFC-089-T3**：`assemble.ts` 抽 `prefixFilePath`/`prefixCardId`/`prefixSymbolId`
  纯函数；`files[].filePath` 改走 `prefixFilePath`（等价重构，单仓不变）。
- **RFC-089-T4**：`mergeStructuralDiffs` 前缀合并 `classEdges`（from/to/members），
  删除 `classEdges: []`；同步前缀 `impact` 的 ref。
- 验收：多仓 Graph 非空、边只连同仓卡片、同名类不串；Impact 跳转 ref 对得上卡片。
- 测试：前缀纯函数单测；`mergeStructuralDiffs` 多仓 classEdges/impact 断言；前端图
  只连同 label 卡片。

## PR-C（P3）— node 作用域多仓
- **RFC-089-T5**：`getNodeStructuralDiff` 去 `repoCount!==1` 抛错；多仓读
  `preSnapshotReposJson` 逐仓解析 from/to → 逐仓计算 → PR-B 前缀合并。
- **RFC-089-T6**：wrapper 作用域多仓同款 per-repo+merge（或显式 partial 兜底，
  不抛 unsupported）。
- 验收：多仓 node 作用域返回合并 diff、不再抛 unsupported；某仓快照缺失 → partial。
- 测试：2 仓 + 写节点 `preSnapshotReposJson` 的 node-scope 用例；快照缺失 partial。

## PR-D（P4）— 调用链多仓
- **RFC-089-T7**：`mergeStructuralDiffs` 透传 `callChainAvailable`（OR 归约）。
- **RFC-089-T8**：`getCallTargets` 加 `resolveRepoFromRef`（剥前缀→仓 worktree），
  去前缀跑 `expandMethod`，返回 `CallTarget.ref`/`ownerClass` 重新前缀；单仓回退。
- 验收：多仓 ⎇ 入口出现；跨仓方法各解析到对的仓；返回 ref 带回前缀闭环；未知 label
  清晰报错。
- 测试：`resolveRepoFromRef` 单测（剥离/匹配/单仓回退/未知 label）；多仓 call-targets
  解析到对的仓 worktree；前端多仓 callChainAvailable 入口出现。

## 收尾
- **RFC-089-T9**：更新 `STATE.md`（RFC-089 → Done + 已完成 issue 行）、`design/plan.md`
  RFC 索引状态置 Done。
- 单二进制 smoke（`bun run build:binary`）在任何 shared 导出 / `assemble` 改动后跑一遍
  （[reference_binary_build_module_cycle]）。

## 依赖图
```
T1 ─┐
T2 ─┴─ PR-A ──> T3 ─> T4 ── PR-B ──> T5 ─> T6 ── PR-C ──> T7 ─> T8 ── PR-D ──> T9
                          (前缀原语)        (复用前缀)        (复用前缀)
```

## 多人协作注意
结构页签代码（`structuralDiff/*`、`structure/*`、`structureView.ts`、
`structureGraph.ts`）正是 RFC-088 协作者活跃区。每个 PR 提交前 `git fetch` 看
origin/main 是否前移；按路径精确 `git add`，不碰协作者未追踪文件
（[feedback_dont_delete_others_code_for_ci]、[project_collaborator_stash_gate]）。
