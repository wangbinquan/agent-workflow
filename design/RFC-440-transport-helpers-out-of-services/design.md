# RFC-440 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-439 落地后的源码（`ce164ed44`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：
  - platform 的 `S/platform/http`：删除确认、删除快照；
  - identity-access 的 `S/auth/`（现址，尚未并入 `modules/identity-access`）：token 读视图。
- **承担的演进**：W4 B / D 第六步。
  - import `services/` 的路由 23 → 18：skills、memories、workgroups、workflows、plugins 不再 import `services/`；
  - platform 与模块对 legacy `services/` 的依赖各少一处来源：bound operation invoker、integration 的定时任务绑定、resource-catalog 的技能操作；
  - 以后 resource-catalog 的路由迁入模块时，不会再把这三个 legacy 助手带进去。
- **不新增** DAG 之外的边、R1 边与 R2 边：
  - 两个 platform 文件只 import `hono`、`@/auth/actor`（类型）与 `@/util/errors`；
  - `S/auth/` 不是模块路径，也不在 legacy 目标前缀（`@/services/`、`@/routes/`、`@/ws/`、`@/mcp/`）里。
- **留下的债**：
  - `S/auth/` 整体并入 `modules/identity-access`；token 读视图随之进入模块，或改为不带 `Actor` 与 `unknown` 的 public 合同；
  - `services/mcpSurface`、`services/apiDocs` 与其余 18 个路由的 `services/` 依赖。
- **偏离项**：无。

## 1. 文件去向

| 原文件                                            | 新位置                              | 说明                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S/services/deleteConfirm.ts`                     | `S/platform/http/deleteConfirm.ts`  | 原样搬迁；注释里指向 `services/tokenRedaction.ts` 的一处改指新位置（行数不变，e2e 注释里的行号仍有效）                                                            |
| `S/services/tokenAudit.ts`                        | `S/platform/http/deleteSnapshot.ts` | 只搬 `captureDeleteSnapshot` / `takeDeleteSnapshot` 与它们共用的 `WeakMap`，其余删除（见下行）                                                                    |
| 同上：审计转出                                    | 删除                                | `recordTokenCall` / `pruneTokenAudit` / `pruneTokenAuditSlice` 与类型转出；生产零调用，用例改用 `createTokenCallAudit(db)` 与 `@/auth/application/tokenCallAudit` |
| `S/auth/composition.ts` 的 `legacyTokenCallAudit` | 删除                                | 只服务于上一行的转出                                                                                                                                              |
| `S/services/tokenRedaction.ts`                    | `S/auth/tokenRedaction.ts`          | 原样搬迁；`tokenSnapshotRedaction` 改为同 context 的相对路径                                                                                                      |

## 2. 连接（只改 import，调用不变）

- `platform/http/deleteConfirm`：
  - 路由：cached-repos、mcps、memories、repoGroups、tasks、plugins；
  - integration 的 `inbound/http/scheduledTaskRoutes.ts`，resource-catalog 的 `composition/skillOperations.ts`。
- `platform/http/deleteSnapshot`：
  - 抓取：agents、cached-repos、skills、mcps、memories、workgroups、workflows、tasks、plugins 九个路由与 integration 的定时任务绑定；
  - 取走：`server.ts` 的响应后审计钩子、`platform/operations/boundOperationInvoker.ts`。
  - 写入与读出必须是同一个模块实例里的同一个 `WeakMap`。搬迁后两侧都指向这一份文件，不变。
- `auth/tokenRedaction`：workflows、mcps、tasks、plugins 四个路由，`mcp/server.ts`，`bootstrap/daemonApplication.ts`。

## 3. 守卫与用例

- **改 import 的用例与辅助**：
  - `rfc222-delete-confirm`、`rfc247-token-delete-confirm`：改从 `platform/http/deleteConfirm` 取；
  - `rfc247-token-redaction`、`rfc270-privileged-node-read-lens`、`rfc270-privileged-node-rehydrate`、`rfc305-script-grant-http`、
    `helpers/realtimeRuntime`：改从 `auth/tokenRedaction` 取，`rfc247-token-redaction` 读源码的两处改读新位置；
  - `rfc247-token-audit`、`rfc338-maintenance-slices`、`fixtures/rfc338-maintenance-contention-worker`：改用
    `createTokenCallAudit(db).record / prune / pruneSlice` 与 `@/auth/application/tokenCallAudit` 的类型和 `redactSnapshot`；
  - `rfc349-auth-token-audit-provider`：第一条原本断言「legacy service 只是 facade」，改为「facade 与兼容桥都已删除，
    application 合同不带 provider 句柄」；
  - `rfc438-scheduled-tasks-into-integration`：定时任务绑定不再需要 `services/` 例外，删去该例外，绑定与 application 同一规则。
- **架构报告**：legacy 归属表删去三个 `services/` 文件，登记 `S/auth/tokenRedaction.ts` 归 identity-access；
  `platform/` 下的新文件由前缀自动归 platform。
- **新用例** `T/rfc440-transport-helpers-out-of-services.test.ts`：
  - 原文件不存在，新文件就位；`legacyTokenCallAudit` 不再出现在 `auth/composition.ts`；
  - 源码（`S/**`）里没有对三个旧路径的 import，判据走 census 的 AST 提取；
  - 两个 platform 文件只依赖 `hono`、`@/auth/actor`、`@/util/errors`，`auth/tokenRedaction.ts` 不 import `services/`、`routes/` 与模块；
  - 五个路由（skills、memories、workgroups、workflows、plugins）不 import `services/`；
  - 同一实例：`captureDeleteSnapshot` 写入的快照只能被 `takeDeleteSnapshot` 取走一次；非 PAT 调用方不留快照。
- **行为由既有用例覆盖**：RFC-222 删除确认矩阵、RFC-247 token 删除确认 / token 审计（含删除快照）/ token 读视图、RFC-270 两份、
  bound operation（MCP）删除路径。

## 4. 账本与计数（实测为准）

- `architecture/commons-debt.json`：不变（三处依赖都在非 fenced 层或 legacy 文件里，不在 R1 / R2 账本中）。
- `architecture/counts.json`：`legacy-horizontal-files`、`legacy-service-implementations`、`legacy-thin-facades` 只降不升，不改。
- `architecture/guard-manifest.json`：本 RFC 不改登记守卫。
- `.github/workflows/maintenance-soak-nightly.yml` 的 push 与 pull_request 路径过滤（两处同改）：
  - `services/tokenAudit.ts` 改为 `auth/application/tokenCallAudit.ts`、`auth/infrastructure/tokenCallAudit.ts`、`auth/application/maintenanceJobs.ts`；
  - `services/webhook/**` 改为 `modules/integration/infrastructure/webhookDeliveryPersistence.ts`（夜跑实际执行的投递 GC，见 `scripts/rfc338-maintenance-soak.ts`）。
- 注释里的旧路径（e2e 五处、前端两处、shared 一处、integration 绑定一处）改指新位置，行号不变。`docs/audit-backlog.md` 是历史记录，不改。

## 5. 失败模式

- **快照写读分家**：两侧必须用同一个 `WeakMap`。新用例直接断言写入后取走一次、再取为空；REST 与 MCP 删除的审计用例覆盖端到端。
- **用例改写漂移**：`createTokenCallAudit(db)` 正是原兼容桥每次调用时做的事，参数一一对应，语义不变。
- **注释行号漂移**：搬迁的两个文件保持行数，e2e 注释里的 `file:line` 引用只改路径。

## 6. 测试策略

全部实现与用例写完后集中验证一次：

- 静态检查（`tsc`、eslint 两套配置、prettier）；
- 全量 SQLite；
- 导出仓库（含 PostgreSQL 真库）跑全部架构测试、受影响用例、路由错误码棘轮与 API 合同覆盖、测试套件策略（workflow 字面路径）；
- P0 变异 lane。
