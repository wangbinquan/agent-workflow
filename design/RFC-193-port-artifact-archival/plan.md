# RFC-193 — 任务分解

单 RFC 单 PR（仓规默认）；commit 顺序即 T 序。每个 T 自带测试（Test-with-every-change）。

## 任务

### RFC-193-T1 — schema + migration
- `node_run_outputs` 加 `archive_json TEXT`（nullable，无 backfill）。
- migration `0096_rfc193_port_artifact.sql`；`upgrade-rolling.test.ts` journal 计数断言
  95→96 bump（标题+断言+注释三处）。
- 依赖：无。

### RFC-193-T2 — shared：ValidateResult.items + 容器相对化工具
- `outputKinds/types.ts` `ValidateOk` 加可选 `items`；`list.ts` validate 收集逐项
  body/sourcePath（行序=splitListItems）；`envelope.ts resolvePortContentDetailed` 透传。
- 容器相对化 helper（`join(worktreeDirName, sourcePath)` 规范化，处理 `''` dirName）。
- 单测：list items 顺序/内容；单值端口无 items；规范化边界（`./`、绝对已被 handler 转相对）。
- 依赖：无。

### RFC-193-T3 — runner：archive-at-emit + content 规范化
- 新模块 `services/portArtifacts.ts`：`archivePortArtifacts`（写文件 + 组 archive_json +
  截断 2 MiB）+ `readPortArtifact`（归档→worktree 回退→missing）。
- runner.ts 校验循环：detailed 校验、path 形端口归档、content 重写为容器相对、INSERT 带
  archive_json、`RunResult.portFilePaths`；归档写失败 → `port-artifact-archive-failed`。
- workgroup host（persistDeclaredOutputs=false）跳过归档。
- 测试：design §6 case 1/2/3/8。
- 依赖：T1、T2。

### RFC-193-T4 — 必达 merge-back（K1）
- `git.ts snapshotFullState` 加 `forceIncludePaths`（add -A 后逐路径 `add -f`，失败 warn）。
- `snapshotNodeIsoFinal` / `mergeBackAndSettle` 透传；scheduler live 站点从
  `lastResult.portFilePaths` 传入。
- 测试：design §6 case 4（gitignored 文件必达，现状红）。
- 依赖：T3（清单来源）。

### RFC-193-T5 — scheduler：scopeRoot（止血并入）
- `SchedulerState.scopeRoot`：顶层 = `task.worktreePath`；git wrapper（scheduler.ts:5760）与
  loop wrapper（scheduler.ts:3965）的 innerState 设 `wrapperIso.containerPath`（passthrough
  沿用外层）；fanout 不换。
- `DispatchReviewArgs` 增 `scopeRoot`，`scheduler.ts:2437` 传入。
- 测试：innerState scopeRoot 纯函数断言（git/loop/passthrough 三态）。
- 依赖：无（可与 T3 并行）。

### RFC-193-T6 — review 切归档 + 主回归
- review.ts 单文档（471 一带）/ 多文档（658 一带）换 `readPortArtifact`
  （fallback=scopeRoot）；`task.worktreePath` 清零。
- 测试：design §6 case 5（wrapper 内 review 单/多文档，现状红→绿）、case 6（回退链）。
- 依赖：T3、T5。

### RFC-193-T7 — 归档读取 API
- `GET /api/tasks/:taskId/port-artifacts/:nodeRunId/:portName[?item=N]`：canViewTask 门 +
  nodeRun 归属校验 + 元数据/body 双形态 + 回退 404。
- contracts registry 登记（`tests/contracts/registry.ts`）。
- 测试：design §6 case 7。
- 依赖：T3。

### RFC-193-T8 — 前端切换
- `TaskOutputPanel` 预览/下载、`tasks.preview.tsx` file 模式：优先 port-artifacts，404 回退
  现行 worktree-files 路径；截断横幅（i18n zh/en：`outputs.artifactTruncated`）。
- vitest：design §6 case 10。
- 依赖：T7。

### RFC-193-T9 — 源码锁 + 收尾
- 文本断言测试：`review.ts` 禁 `task.worktreePath`（case 11）。
- `bun run typecheck && bun run lint && bun run test && bun run format:check` +
  `bun run build:binary` smoke + push 后查 CI（本人 sha 精确匹配）。
- 依赖：T1-T8。

### RFC-193-T10 — 登记
- `design/plan.md` RFC 索引状态 Draft→Done；`STATE.md` 移入已完成表。
- 依赖：T9。

## 验收清单（对应 proposal §5）

- [ ] AC-1 wrapper 内 review 单/多文档回归绿（T6）
- [ ] AC-2 path 端口归档 + 引用落库（T3）
- [ ] AC-3 gitignored port 文件必达 scope canonical（T4）
- [ ] AC-4 content 规范化（单值+list，T3）
- [ ] AC-5 前端优先归档、404 回退（T8）
- [ ] AC-6 截断标记 + 横幅（T3/T8）
- [ ] AC-7 review.ts 文本锁（T9）
- [ ] AC-8 typecheck/lint/test/format + journal bump + binary smoke + CI 绿（T1/T9）
