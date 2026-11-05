# RFC-445 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`TE` = `S/modules/task-execution`。以 RFC-444 落地后的源码
（`60a8b2c7c`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：
  - platform 的 `http`（入站适配器共用的 HTTP 传输助手）与新目录 `health`（`/health` 的进程内仪表）；
  - task-execution 的 `domain`、`application`、`infrastructure/local`。
- **承担的演进**：
  - W4 B / D 第十一步：import `services/` 的路由 9 → 7；
  - `R1-inbound-module-internals` 169 → 166（`services/launchMultipart` → TE composition，`services/upload` → TE infrastructure 两条）；
  - platform、system-operations、task-execution 的计数累加点不再 import legacy。
- **不新增** DAG 之外的边：
  - 新的 platform 文件只 import `@/util/errors`（或什么都不 import）；
  - 模块与路由对 platform 的依赖是允许方向；
  - TE 内部只走同模块相对路径。
- **留下的债**：task-execution 恢复家族（含 `services/recovery.ts` 余下的审计写入与查询）；`routes/tasks.ts` 的其余 legacy 依赖；
  其余 7 个路由。
- **偏离项**：无。

## 1. 文件去向

| 原位置                                                                                                          | 新位置                                                   | 说明                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `S/services/launchMultipart.ts`：`parseMultipartLaunch`、`MultipartFilePart`、`ParsedMultipartLaunch`、字段语法 | `S/platform/http/multipartLaunch.ts`                     | 原样                                                                                          |
| 同上：`collectUploadInputDefs`                                                                                  | `TE/domain/uploads.ts` 末尾                              | 原样                                                                                          |
| 同上：`bufferUploadParts`、`attachWorkspaceCleanupToMultipartError`                                             | `TE/application/launchUploads.ts`（新）                  | 原样；`bufferUploadParts` 的参数改用模块自己的 `TaskRouteMultipartFilePart`（字段相同、只读） |
| 同上：`resolveUploadLimits`                                                                                     | `TE/infrastructure/local/fileTaskLaunchConfiguration.ts` | 原样，直接调同文件的 `createFileTaskLaunchConfigurationQueries`                               |
| `S/services/upload.ts`                                                                                          | 删除                                                     | 消费者改取 TE domain / public 与 platform                                                     |
| `S/services/recovery.ts`：`bumpRecoveryCounter`、`recoveryCountersSnapshot`、`__resetRecoveryCountersForTest`   | `S/platform/health/recoveryCounters.ts`（新）            | 原样；`services/recovery.ts` 的 `recordRecoveryEvent` 改从这里取 `bumpRecoveryCounter`        |

## 2. 连接

- **multipart 信封**：`routes/agents.ts` 与 `TE/infrastructure/taskRouteOperations.ts`（`launchMultipartTask`）改取 `@/platform/http/multipartLaunch`。
  - `routes/agents.ts` 的上传变量改用 TE `public/commands` 已有的 `TaskRouteMultipartFilePart`、`TaskRouteUploadLimits`，
    也就是 `AgentRouteTaskLaunchOperations.launch` 收的类型；
  - `services/execution/types.ts` 的 `MultipartFilePart` 改取 platform，`UploadLimits` 改取 TE `public/types`。
- **上传助手**：`TE/infrastructure/taskRouteLaunchOperations.ts` 改取同模块文件：
  - `DEFAULT_UPLOAD_LIMITS`、`collectUploadInputDefs` 取 `../domain/uploads`；
  - `bufferUploadParts`、`attachWorkspaceCleanupToMultipartError` 取 `../application/launchUploads`；
  - `resolveUploadLimits` 取 `./local/fileTaskLaunchConfiguration`。
- **`routes/tasks.ts`**：删去 `attachWorkspaceCleanupToMultipartError` 的转出与说明注释。
- **恢复计数**：四处改取 `@/platform/health/recoveryCounters`：
  - `routes/health.ts`；
  - `platform/persistence/sqlite/systemProviderRestore.ts`；
  - `modules/system-operations/infrastructure/resourceLimitAudit.ts`；
  - `TE/infrastructure/taskIdleTimeoutPersistence.ts`。

  `services/recovery.ts` 保留 `recordRecoveryEvent`（仍先累加计数再写审计）与 `listRecoveryEventsForTask`。

- **CI 路径过滤**：`windows-platform.yml` 的 push 与 pull_request 两份清单：
  - `services/upload.ts` 换成它转出的落盘实现 `TE/infrastructure/local/nativeWorkspaceUploads.ts`；
  - `services/recovery.ts` 之后加 `platform/health/recoveryCounters.ts`。

  覆盖面与原先相同：原文件里的计数改动仍会触发该工作流，测试套件策略也要求清单里的路径真实存在。

## 3. 守卫与用例

- **账本**（`architecture/commons-debt.json`）：
  - 删去 `services/launchMultipart.ts` → `TE/composition/launchConfiguration` 一条；
  - 删去 `services/upload.ts` → `TE/infrastructure/local/nativeWorkspaceUploads` 两条（值与类型导出），`inboundEdges` 169 → 166；
  - `services/recovery.ts` → `TE/application/ports/taskRecoveryOperations` 一条保留（审计写入仍用该端口类型）。
- **架构报告**：legacy 归属表删去 `services/launchMultipart.ts`、`services/upload.ts` 两行；新文件在 platform / 模块内按位置归属。
- **改 import 的用例与辅助**：
  - 上传：`upload-apply-to-worktree`、`rfc262-upload-overwrite`、`rfc370-workspace-upload-content`、`rfc370-workspace-upload-bindings`、
    `rfc359-w7-task-route-conformance`、`rfc370-task-launch-configuration`、`rfc107-url-upload-multipart`，以及夹具
    `fixtures/rfc363-task-workspace-crash-worker`；
  - 计数：`rfc108-*` 五个、`rfc187-clarify-continuation-revival`、`rfc186-workgroup-e2e`、`rfc243-call-workgroup`、
    `rfc359-w7-resource-limit-conformance`。
- **注释**：`routes-no-cast` 用例与 `routes/agents.ts` 里指向旧路径的说明改指新位置。
- **新用例** `T/rfc445-launch-multipart-and-recovery-counters.test.ts`：
  - **位置**：两个原文件不存在、新文件就位，源码里没有文件 import 旧路径（带负对照）；`routes/agents.ts`、`routes/health.ts`
    不 import `services/`；四处计数累加点与 `/health` 都取 `platform/health/recoveryCounters`，`services/recovery.ts` 不再自带计数；
  - **信封行为**：`payload` 加两个 `files[<key>][]` 部件解析为原样的 `payloadJson` 与部件（未命名文件记为 `upload.bin`）；
    缺 `payload`、`payload` 非 JSON、未知字段、字段是字符串而非文件分别抛原错误码；
  - **助手行为**：
    - `bufferUploadParts` 遇未声明的输入键时在复制任何字节前抛 `task-multipart-unknown-input`；
    - `attachWorkspaceCleanupToMultipartError` 在清理完整时原样返回主错误，不完整时把报告并入 `details`；
  - **计数行为**：累加、快照与重置。
- **行为由既有用例覆盖**：
  - RFC-020 / RFC-107 / RFC-218 的 multipart 启动；
  - RFC-262 覆盖策略、RFC-370 启动配置与上传绑定；
  - RFC-108 恢复审计与计数、RFC-359 W7 资源上限一致性、RFC-350 空闲收割、RFC-213 恢复。

## 4. 账本与计数（实测为准）

- `commons-debt.json` 如上；`commons-manifest.json`、`guard-manifest.json`、`counts.json` 不变（三个文件都不在公共内核清单里，计数只降）。

## 5. 失败模式

- **漏改消费者**：迁出的符号由 `tsc` 全量检查兜底；新用例对旧路径的零引用断言带负对照。
- **结构等价被破坏**：`routes/agents.ts` 的上传变量改用 public 合同类型后，platform 的 `MultipartFilePart[]` 必须仍可赋给
  `readonly TaskRouteMultipartFilePart[]`（字段同名同类型），由 `tsc` 核对。
- **计数分叉成两份**：计数状态只存在 `platform/health/recoveryCounters.ts` 一处；新用例断言 `services/recovery.ts` 不再声明计数表、
  四处累加点只经新文件。

## 6. 测试策略

全部实现与用例写完后集中验证一次：

- 静态检查；
- 全量 SQLite；
- 导出仓库（含 PostgreSQL 真库）跑全部架构测试与受影响用例；
- P0 变异 lane。
