# RFC-249 — 仓库组目录树 · 实施计划

> 状态：**Approved / Core Implementation Complete / Release Validation In Progress（用户于 2026-08-03 明确批准）**

## 交付策略

仓库要求 main-only，且共享 `main` 上每个落点必须能独立通过门禁。本 RFC 按四批
推进，但管理 wire 的 v1→v2 切换放在同一批原子完成，不能留下前后端不同步的
中间态。

| 批次 | 范围                                                                       | 依赖 | 关键验收               |
| ---- | -------------------------------------------------------------------------- | ---- | ---------------------- |
| PR-1 | shared 树模型/纯函数 + DB migration + service nodes 内核；边界暂留 v1 翻译 | 批准 | AC-1…AC-4              |
| PR-2 | task 节点快照、物化与重放                                                  | PR-1 | AC-7…AC-12             |
| PR-3 | 原子切 v2 wire + 紧凑树编辑器、批量操作、只读布局树、API/MCP 文档          | PR-2 | AC-5…AC-6、AC-13…AC-20 |
| PR-4 | 全链 E2E、响应式/视觉、清扫旧模型、实现门修复                              | PR-3 | AC-21…AC-22            |

## PR-1 — 数据模型与服务契约

- **T1** shared 新增 `RepoNodeAttachment*`、`RepoGroupNode*`、
  `PlannedDirectoryNode`、v2 Group/Layout schemas；导出节点/展开预算常量。
- **T2** 抽取 `normalizeRepoNodePath` 与父/子/排序原语；保留现有 path 安全语义。
- **T3** 实现定义闭包校验，以及 attach/detach/rename/move/delete/bulk allocate 纯函数。
- **T4** 实现 `flattenRepoGroupTree`：目录合并、挂载冲突、group chain、readonly、
  edge/node/repo 三预算。
- **T5** 补 shared 正反向矩阵与 property-style 不变量测试。
- **T6** 实现期现取下一个 migration 号：建 `repo_group_nodes`，回填 v1 members，
  SQL 等价行/根/闭包断言后删除旧表，组 schemaVersion→2。
- **T7** `schema.ts` 切表；迁移测试运行升级前后两套展开算法逐字段比对，并锁住
  CHECK、索引、FK、计数、根/闭包及嵌套组。
- **T8** `repoGroup.ts` 内核全面切 nodes：load/materialize/layout/ancestor validation；
  边界暂将 v1 members 无损翻译成 attachment nodes + 祖先闭包，并从 nodes 投影 v1 DTO。
- **T9** repo/group force delete 与 cached repo 引用守卫改为 detach attachment、保留 node。
- **T10** layout 内部结果增加 nodes 并保留 repos；公开 definition/preview 写契约在本批
  仍是 v1，禁止纯叶目录进入旧 UI 无法 round-trip 的窗口。
- **T11** backend service/route contract tests；迁移前后展开等价、URL preview 零写入、
  OCC race 与 v1 边界翻译完整性。

**过渡边界要求**：T6–T11 同批合入；DB 只有 nodes 一份事实源，但 public API 仍与
当前前端完全兼容。v1 输入只能合成 attachment 节点及其祖先，不能接受纯叶目录；
因此 current UI 不会丢它无法显示的数据。翻译层必须在 PR-3 wire/UI 原子切换时删除。

## PR-2 — 任务冻结与运行时

- **T12** migration 建 `task_space_nodes`；Drizzle schema + migration tests。
- **T13** `ResolvedRepoGroupLayout` 贯通 `materializeSpace`，`MaterializedSpace` 增
  `nodePaths`。
- **T14** `loadFrozenSpaceLayout` 同读 task repos/nodes；旧任务构造最小祖先闭包。
- **T15** 单仓退化条件加 `nodes === [root]`，边界测试锁住 byte baseline。
- **T16** `materializeGroupSpace` 接收 nodes：仓物化后安全创建纯目录；逐段 lstat、
  symlink/文件拒绝、containment 复核。
- **T17** task/task_repos/task_space_nodes 同事务快照；详情 DTO 加冻结 nodes。
- **T18** 组定义漂移/删除后的 sourceTask 重放；现有四入口可见性守卫回归。
- **T19** neutral/root-repo/nested-repo 目录归属、失败回收、readonly/sparse/upload/
  wrapper-git/diff/commit-push 全链回归。

## PR-3 — 紧凑目录树编辑器

- **T20** Create/Update/Preview/DTO 与新 `RepoTreeEditor` 同批切到 v2 nodes：routes 增
  `members` retired preflight，旧写入明确 422，删除 PR-1 的 v1 边界翻译；编辑器以
  flat draft nodes + shared tree helpers 为唯一状态。
- **T21** `RepoGroupEditor` 删除成员卡片/右预览，落紧凑元数据、工具条、单树、
  inline settings 与保存阻断。
- **T22** `RepoBulkAddDialog`：缓存仓搜索多选、URL 多行解析、自动目录名与冲突摘要。
- **T23** root/add directory/attach repo/attach group/detach/delete subtree/rename/move 全交互。
- **T24** 多选与 batch readonly/move/detach/delete；候选树一次计算、原子应用。
- **T25** 桌面 native drag 复用 move primitive；键盘/触屏 `移动到…` 完整替代。
- **T26** 子组 ghost tree、preview debounce、path 锚定错误与 pending import 提示。
- **T27** `RepoLayoutTree` 改收 nodes+repos；组列表、任务详情展示纯目录并继续共用；
  组列表复用任务列表的 `OperationsExpandButton`。
- **T28** zh-CN/en-US 全量 i18n；移除所有组 UI 的 main/primary member 文案。
- **T29** API docs、MCP catalog/example 切 v2 nodes；退役 members 文档与源码锁。
- **T30** frontend unit/integration tests：20/32 仓、批量操作、焦点/ARIA、OCC 与错误态。

## PR-4 — 浏览器、视觉与收口

- **T31** Playwright Chromium/WebKit 跑新建平铺组→整理层级→保存重开→启动→详情→
  sourceTask 重跑全流程；锁定启动初始态只显示统一选择器，手工 URL 与分支按需展开。
- **T32** 390/736/1440 三宽验证，无横向 overflow；移动端 44px、长 URL/组名可读。
- **T33** 本地 macOS 与 hosted Ubuntu visual baseline；覆盖 20 仓平铺、三层嵌套、
  inline edit、批量态。
- **T34** 全仓搜索并删除 `repo_group_members`、`RepoGroupMember*`、成员卡片 CSS、
  从 repos 猜目录的 `buildLayoutTree(repos)` 及 `memberIndex` 用户文案。
- **T35** 全量门禁：`typecheck`、`lint --max-warnings 0`、`test`、`format:check`；
  migration、binary/E2E build 按仓库既有命令执行。
- **T36** 实现门审查；逐条核实 P0/P1/P2，修复并记档，刷新 STATE/plan 交付记录。

## 测试文件预期

文件名以实现时现状为准，至少覆盖：

- shared：`rfc249-repo-group-node-tree.test.ts`、
  `rfc249-repo-group-tree-flatten.test.ts`；
- backend：`rfc249-repo-group-node-migration.test.ts`、
  `rfc249-repo-group-service.test.ts`、`rfc249-task-space-nodes.test.ts`、
  `rfc249-repo-group-directory-materialize.test.ts`、
  `rfc249-repo-group-replay.test.ts`；
- frontend：`rfc249-repo-tree-editor.test.tsx`、
  `rfc249-repo-bulk-add.test.tsx`、`rfc249-repo-layout-tree.test.tsx`、
  `rfc249-repo-group-responsive.test.tsx`；
- e2e/visual：沿现有 repos 页面与 task detail harness 扩展，不另造第二套浏览器夹具。

## 每批门禁

1. 先跑受影响包的 targeted tests；
2. 再跑受影响包完整 test/typecheck/lint/format；
3. PR-2 起跑 backend runtime integration；
4. PR-3 起跑 frontend 全量与 Chromium/WebKit；
5. PR-4 跑全仓与 hosted visual；
6. 任何提交只精确 stage 本 RFC 文件，保留共享树中他人 WIP；若用户授权 push，按
   exact SHA 核验远端祖先与终态 CI。

## 当前进度

- [x] 实读 RFC-248 shared/backend/frontend/task snapshot 与物化链路
- [x] 确认纯目录若不进入任务快照，会在 sourceTask 重跑时丢失
- [x] UX 方向确认：目录树、无主仓、平铺批量优先、紧凑单面板
- [x] RFC-249 proposal/design/plan 落档
- [x] 用户明确批准 RFC-249（2026-08-03）
- [x] T1–T30 核心生产链：shared / migration / CRUD / task snapshot / materialize / compact UI
- [x] 桌面与 390px 本地真实浏览器：20 仓平铺、批量态、三层目录、改名与无 overflow
- [x] targeted tests、全仓 typecheck / lint / format、migration `db:check`
- [x] 更新后二进制 Chromium + WebKit 持久化启动 E2E（各 2/2）
- [ ] T31–T36 发布门余项：完整编辑链 E2E、hosted Ubuntu visual、旧兼容投影清扫与独立实现门
