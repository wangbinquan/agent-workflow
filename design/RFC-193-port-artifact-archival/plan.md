# RFC-193 — 任务分解

单 RFC 单 PR（仓规默认）；commit 顺序即 T 序。每个 T 自带测试（Test-with-every-change）。

## 任务

### RFC-193-T1 — schema + migration
- `node_run_outputs` 加 `archive_json TEXT`（nullable，无 backfill）。
- migration `0096_rfc193_port_artifact.sql`；`upgrade-rolling.test.ts` journal 计数断言
  95→96 bump（标题+断言+注释三处）。
- 依赖：无。

### RFC-193-T2 — shared：ValidateResult.items + 路径工具 + validator 禁令
- `outputKinds/types.ts` `ValidateOk` 加可选 `items`；`list.ts` validate 收集逐项
  body/sourcePath（行序=splitListItems）；`envelope.ts resolvePortContentDetailed` 透传。
- 容器相对化 helper（`join(worktreeDirName, sourcePath)` 规范化，处理 `''` dirName）+
  portName percent-encode helper（D3）。
- validator：嵌套 list 含 path 形 kind 拒绝（D18，agent 保存 + workflow 引用两面，新校验码
  `output-kind-nested-list-path-unsupported`）。
- 单测：list items 顺序/内容；单值端口无 items；规范化边界；编码往返；design §6 case 8c。
- 依赖：无。

### RFC-193-T3 — runner：archive-at-emit（两阶段）+ content 规范化
- 新模块 `services/portArtifacts.ts`：`archivePortArtifacts`（**字节级 copy**、跟随 symlink、
  文本截断+警告行注入 / 二进制超限只记元数据、portEnc + containment 断言）+
  `readPortArtifact`（归档→worktree 回退→missing；透传 size；body/bytes 双面；archive file
  前缀 + worktree lexical/realpath containment）。
- runner.ts 校验循环改两阶段（D15）：阶段一纯校验收集，全过后阶段二统一归档+INSERT；content
  规范化为 **repo0 相对**（D6）；**RunResult.outputs 同步回写规范化值**（D17）；
  `RunResult.portFilePaths`；归档写失败 → `port-artifact-archive-failed`。
- workgroup host（persistDeclaredOutputs=false）跳过归档。
- 测试：design §6 case 1/2/3/3b/3c/3d/3e/3f/8。
- 依赖：T1、T2。

### RFC-193-T4 — 必达 merge-back（K1，三跳传播链）
- `git.ts snapshotFullState` 加 `forceIncludePaths`（add -A 后逐路径 `add -f` +
  `GIT_LITERAL_PATHSPECS=1`，失败 warn）。
- `forcedPortPathsForTask(db, taskId)` 聚合器（archive_json → per-repo 清单；symlink 相对
  目标追加，D19）；注入 `IsoHandle.forcedPaths`（createNodeIso / rebuildIsoHandle / wrapper
  复用点），nodeIsolation.ts 内部 10 处 `snapshotFullState` 统一携带（base/final/ours/
  conflict 快照全覆盖——单修 final 快照时 ignored 文件断在下游 base-snapshot 跳，见 design
  §4.5）；wrapper final 快照前重聚合；产出节点 final 并上 `RunResult.portFilePaths`。
- 测试：design §6 case 4（单节点必达，现状红）+ case 4b（跨节点传播到下游 iso，现状红）+
  case 8e（literal pathspec）+ case 8f（symlink）。
- 依赖：T3（清单来源）。

### RFC-193-T5 — scheduler：scopeRoot（止血并入）
- `SchedulerState.scopeRoot`：顶层 = `task.worktreePath`；git wrapper（scheduler.ts:5760）与
  loop wrapper（scheduler.ts:3965）的 innerState 设 `wrapperIso.containerPath`（passthrough
  沿用外层）；fanout 不换。
- `DispatchReviewArgs` 增 `scopeRoot`，`scheduler.ts:2437` 传入。
- 测试：innerState scopeRoot 纯函数断言（git/loop/passthrough 三态）。
- 依赖：无（可与 T3 并行）。

### RFC-193-T6 — review 切归档 + 主回归 + S1
- review.ts 单文档（471 一带）/ 多文档（658 一带）换 `readPortArtifact`
  （fallback=scopeRoot）；`task.worktreePath` 清零；截断文档 body 自带 D12 警告行。
- S1 修复路径（`lifecycleRepair`）scopeRoot 谱系推导（design §4.6）。
- 测试：design §6 case 5（wrapper 内 review 单/多文档，现状红→绿）、case 6（回退链）、
  case 8d（S1 回归）。
- 依赖：T3、T5。

### RFC-193-T6b — 派生输出投影透传（D16）
- 全仓核对 `insert(nodeRunOutputs)` 站点：wrapper 输出提升（`upsertWrapperOutput` 族）、
  output 虚拟节点（scheduler.ts:2408-2417，补 kind）、review 决策产物、fanout 聚合行
  （archive_json 逐 shard 合并，行序=聚合 dict 序）——kind + archive_json 随投影透传。
- 测试：design §6 case 8b。
- 依赖：T3。

### RFC-193-T7 — 归档读取 API
- `GET /api/tasks/:taskId/port-artifacts/:nodeRunId/:portName[?item=N]`：canViewTask 门 +
  nodeRun 归属校验 + 元数据（size/truncated/path）/内容（MIME 按扩展名，二进制 bytes 面）
  双形态 + 回退 404；portName 段编码往返；读取全过 `readPortArtifact`。
- contracts registry 登记（`tests/contracts/registry.ts`）。
- 测试：design §6 case 7。
- 依赖：T3、T6b。

### RFC-193-T8 — 前端切换
- preview source 新增 `{ kind: 'artifact', runId, port, item, path }`（深链路由可构造）；
  `TaskOutputPanel` 预览/下载、`tasks.preview.tsx`：优先 port-artifacts，404 回退现行
  worktree-files 路径；`WorktreeFilesPanel` path-only 浏览保留；截断横幅
  （i18n zh/en：`outputs.artifactTruncated`）。
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
- [ ] AC-2 path 端口归档 + 引用落库（T3）；派生投影行同样可读（T6b，case 8b）；两阶段无
      孤儿归档（case 3b）
- [ ] AC-3 gitignored port 文件必达 scope canonical（T4）
- [ ] AC-4 content 规范化（单值+list，T3）
- [ ] AC-5 前端优先归档、404 回退（T8）
- [ ] AC-6 截断标记 + 横幅（T3/T8）
- [ ] AC-7 review.ts 文本锁（T9）
- [ ] AC-8 typecheck/lint/test/format + journal bump + binary smoke + CI 绿（T1/T9）
