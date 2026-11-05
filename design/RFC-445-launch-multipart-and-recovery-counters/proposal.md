# RFC-445 启动 multipart 信封与恢复计数归 platform，上传兼容层退役（RFC-294 W4 B / D 第十一步）

- **状态**：Done（2026-11-04；`16465e382`，exact SHA 主 CI run 41958285754：attempt 1 backend 分片 43/44 一条 `scheduler-clarify-dispatch` PostgreSQL 用例 5491ms 越过 bun 默认 5s（前一提交同一分片 1498ms，本 RFC 不经过该路径，RFC-446 给它 20s 显式预算），只重跑失败作业，attempt 2 全绿；windows-platform、integration-opencode、visual-regression-nightly 首轮全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-444](../RFC-444-builtin-resources-into-resource-catalog/proposal.md)（内建资源清单归 resource-catalog）
- **落位**：
  - platform：`http/multipartLaunch.ts`（启动请求的 multipart 信封解析）、`health/recoveryCounters.ts`（自启动以来的恢复计数）；
  - task-execution：`domain/uploads.ts`（上传声明提取）、`application/launchUploads.ts`（按声明缓冲字节、回收失败时的错误合成）、
    `infrastructure/local/fileTaskLaunchConfiguration.ts`（按配置文件取上传上限）。

## 1. 背景

RFC-444 之后 9 个路由仍 import `services/`。其中两个只差 platform 层的小件：

- `routes/agents.ts` 的单 agent 启动（`POST /api/agents/:id/tasks`）经 `services/launchMultipart.ts` 解析 multipart 启动请求，
  并经 `services/upload.ts` 取 `UploadLimits` 类型：
  - `services/launchMultipart.ts`（230 行，RFC-218 T7）里有五样东西：
    - `payload` + `files[<key>][]` 信封的解析，`POST /api/tasks` 与单 agent 启动共用；
    - 上传声明提取；按声明缓冲字节；
    - 按配置文件取上传上限；
    - 工作区回收失败时仍以上传错误为主错误。
  - 除路由外，它的消费者是 task-execution 的两个 infrastructure 文件；它对 task-execution `composition/launchConfiguration` 的 import
    是一条 `R1-inbound-module-internals` 账本边。
  - `services/upload.ts`（19 行）是 RFC-370 留下的兼容转出：把 task-execution `public` 的上限与校验、platform 的路径判定，以及
    task-execution **infrastructure** 的落盘函数（两条 R1 边）再导出一次。
    生产消费者只剩一个 task-execution infrastructure 文件、`services/launchMultipart.ts` 与 `services/execution/types.ts` 的类型，其余都是用例。
- `routes/health.ts`（归属表登记为 platform）只经 `services/recovery.ts` 取自启动以来的恢复计数快照。这组计数有四处累加点：
  - platform 的 SQLite 恢复（`restore`）；
  - system-operations 的资源上限取消（`limit-cancel`）；
  - task-execution 的空闲收割（`idle-timeout-reap`）；
  - legacy 恢复审计 `recordRecoveryEvent`（其余各类）。

  platform 不能 import 模块，所以计数放不进任何一个模块。

## 2. 目标

- **G1 multipart 信封归 `platform/http`**：`parseMultipartLaunch` 及其两个类型原样迁入 `platform/http/multipartLaunch.ts`；
  单 agent 启动路由与 task-execution 的 multipart 启动编排共用它。
- **G2 其余上传助手归 task-execution**：
  - 上传声明提取与校验 `collectUploadInputDefs`（纯函数）→ `domain/uploads.ts`，与上传上限、校验同处；
  - `bufferUploadParts`（先核对声明再复制字节）与 `attachWorkspaceCleanupToMultipartError`（回收失败时保留上传错误）→ `application/launchUploads.ts`；
  - `resolveUploadLimits(configPath)` → `infrastructure/local/fileTaskLaunchConfiguration.ts`，与它读取的配置文件适配器同处。
- **G3 删除 `services/upload.ts` 兼容转出**：生产代码改取 task-execution 的 domain / public 与 platform，用例直接取模块文件。
- **G4 恢复计数归 `platform/health`**：
  - `bumpRecoveryCounter`、`recoveryCountersSnapshot`、`__resetRecoveryCountersForTest` 原样迁入 `platform/health/recoveryCounters.ts`；
  - 四处累加点与 `/health` 改取新位置；
  - `services/recovery.ts` 只留恢复审计的写入与查询（task-execution 恢复家族，随该子波迁移）。
- **G5**：`routes/tasks.ts` 删除对 `attachWorkspaceCleanupToMultipartError` 的转出（唯一消费者是一个用例）。
- **G6 行为不变**：以下全部不变：
  - multipart 字段语法与错误码；
  - 上传声明校验、字节缓冲顺序与上传上限；
  - 清理报告的错误合成；
  - `/health` 的 `recovery` 字段。
- **G7 不留 facade**：`services/launchMultipart.ts`、`services/upload.ts` 删除。

## 3. 非目标

- task-execution 恢复家族：`services/recovery.ts` 余下的审计写入与查询、`autoResume`、`autoKill`、`autoRepair`、`recoveryBreaker`、
  `orphans`、`orphanReconcile`、`taskAlerts`、`lifecycleInvariants`。
- `routes/tasks.ts` 的其余 `services/` 依赖；其余 7 个路由。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：
  - 两个 `services/` 文件不再存在，源码里没有对它们的 import；
  - `routes/agents.ts`、`routes/health.ts` 不 import `services/`；
  - 四处计数累加点与 `/health` 只经 `platform/health/recoveryCounters` 取计数。
- **AC-2**：计数按实测更新，其余结构门不回退：
  - import `services/` 的路由 9 → 7（`agents`、`health`）；
  - `R1-inbound-module-internals` 169 → 166；
  - `services/` 文件 220 → 218；
  - 模块里 import `services/` 的文件 145 → 143。
- **AC-3**：以下用例全部通过：
  - multipart 启动（任务与单 agent）；
  - 上传落盘与覆盖策略、启动配置；
  - 恢复审计与计数、资源上限与空闲收割、`/health`。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **信封解析进 `platform/http`，不进 task-execution `inbound`**：
   - 单 agent 启动在 legacy 路由里，路由不能深引模块内部（R1 里来自 `routes/` 的边已归零）；
   - 解析函数收原始 `Request`，返回未经校验的 `payloadJson: unknown`，过不了 public 面的类型规则；
   - 它只依赖 `@/util/errors`，与 RFC-440 迁入 `platform/http` 的删除确认同类：入站适配器共用的 HTTP 传输助手。
2. **计数进 platform，不进 task-execution**：
   - platform 自己的 SQLite 恢复也累加它，而 platform 不能 import 模块；
   - `/health` 路由在归属表里登记为 platform，计数正是它的进程内仪表；
   - 放 `platform/health/`，因为 `platform/operations/` 是 API 操作目录，不合适。
3. **上传助手按层拆分**：
   - 声明提取是纯规则，进 domain，与上传上限、校验同处；
   - 缓冲与错误合成是启动用例的步骤，进 application；
   - 按配置文件取上限要读文件，进 infrastructure 的配置文件适配器。
4. **`services/recovery.ts` 留下审计写入与查询**：
   - 它们的调用方是七个 legacy 文件（六个恢复服务与关停），迁进模块会新增七条 R1 边；
   - `recordRecoveryEvent` 的参数含 `Record<string, unknown>`，也过不了 public 面类型规则；
   - 所以随恢复家族整体迁移。
