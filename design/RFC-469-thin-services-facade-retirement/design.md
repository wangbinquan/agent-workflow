# RFC-469 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`RM/` = `S/modules/runtime-management/`，
`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：facade 清仓——consumer 归零后删除。三个 `services/` 转手文件删除；消费方改取 owner 的合同入口或并入唯一调用方。
- 不新增 context 边与 off-DAG 文件对：memory → runtime-management 不是目标 DAG 的边，memory 只经它已有的那个端口文件（蒸馏端口，RFC-461 起
  取 runtime-management `public/participants`）取这些类型；`services/` 文件取 public 入口不记 `R1`；函数并入 `services/task.ts` 后它用的类型
  本来就在那里；迁入用例树的旧授权不再是生产文件。

## 1. `services/taskAuthorization.ts`

- `S/services/task.ts` 删去 `import {} from '@/services/taskAuthorization'`（空导入）。
- `T/rfc311-badge-counts.test.ts` 的 `visibleTaskIdsOf` 改取 `legacySqliteVisibleTaskIdsOf`（原文件就是把它改名转出；定义处见下）。
- 文件删除。删除后 `TE/infrastructure/legacySqliteTaskAuthorization.ts` 失去唯一的生产 import 方（集中验证里架构报告实测不可达生产文件
  18 → 19）：原样迁入 `T/helpers/legacySqliteTaskAuthorization.ts`（两条同目录相对 import 改为别名），RFC-311 用例改取 helper，RFC-359 W5
  provider 命名文件债务清单去掉这一项。

## 2. `services/sessionEventSink.ts`

- `RM/public/participants.ts` 的 `agentSessionEvents` 转出补 `SessionCaptureTerminalState`（`'complete' | 'truncated' | 'incomplete'`）。
- `S/services/runtime/opencode/sessionCapture.ts`、`S/services/systemAgentRun.ts`（各 `SystemAgentEventSinkV1`）与用例
  `T/rfc234-system-agent-run.test.ts` 改取 `@/modules/runtime-management/public/participants`。
- memory 的 `memoryDistillSessionEventSink.ts`（三个类型）与 `memoryDistillWorkStore.ts` 改取 memory 自己的
  `application/ports/distillWorkStore.ts`：它已经从 runtime-management `public/participants` 取 `SystemAgentEventSinkV1`，在那里一并
  `export type` 三个类型。集中验证里第一版让这两个文件直取 runtime-management，架构报告实测 off-DAG offered 文件对 55 → 57（memory →
  runtime-management 不是目标 DAG 的边），改成经同模块的端口后回到 55。
- 文件删除；RFC-454 用例的「留下的转出」去掉这一项。`SessionEventSource` 无人经这个文件取，不转出。

## 3. `services/execution/taskExecutionCallClosure.ts`

- `freezeTaskExecutionCallClosure(root, resourceAuthority)` 原样并入 `S/services/task.ts`（同名、同参、同函数体，不导出）；`task.ts` 已从
  `services/execution/taskExecutionResources` 取 `TaskExecutionResourceAuthority`。
- `T/rfc345-resource-catalog-contracts.test.ts` 读这个文件源码的两条断言改读 `services/task.ts`。同一用例 T4a 原有「`services/task.ts` 不直接
  调 `freezeCallClosure(`」：函数并入后它的函数体就在这个文件里，集中验证里这条锁实测变红；按原意改成「除并入的那一份函数体外不直接调」
  （`replace` 掉一份函数体后再断言不含，多出第二份同样红）。
- 文件删除。

## 4. 精确清单与账本

- RFC-349 provider 切换的 `PROVIDER_SPECIFIC_BUSINESS_DEPENDENCY_DEBT` 销账 `services/taskAuthorization.ts` 的两条。
- 架构报告 legacy owner 表去掉三个文件。
- `architecture/commons-debt.json` 的 `R1` 按实测销账（预期 71 → 66）；guard-manifest 刷新改到的守卫文件行数。

## 5. 用例

- **新用例** `T/rfc469-thin-services-facade-retirement.test.ts`：三个文件不在，src / 用例 / 脚本零 import（TypeScript `preProcessFile` 取全部模块
  引用，带负对照）；runtime-management `public/participants` 转出三个会话 sink 类型，`services/` 的两个消费方取那里、memory 的两个取自己的端口；
  旧 SQLite 任务授权在 `tests/helpers/`；`services/task.ts` 有 `freezeTaskExecutionCallClosure` 且函数体就是原来那一行。第一版用 census
  `importEdges` 判零引用，集中验证里负对照实测它不给 `import {} from` 出边（按绑定逐条出边）——生产里正有过这种写法，改用 `preProcessFile`。
- 受影响用例改 import 或改读新位置（§1～§3），断言不动（只有 RFC-345 T4a 的一条否定锁按原意改写，见 §3）。

## 6. 留下的债

- `services/workflow.ts` / `services/workflow.validator.ts`：转出要传库句柄的旧函数，随消费方（`services/task.ts`、`taskLaunchGate.ts`、
  task-execution 路由操作）归位处理。

## 7. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §5；P0 变异 lane 两引擎各 17 阶段。
