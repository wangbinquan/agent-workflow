# RFC-576 system-operations 的七个路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第一批）

- **状态**：Done（2026-11-25，落地 `23bd6b03a`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2（“`routes/` 逐步成为各模块 `inbound/` 的薄绑定”）与
  plan §4.6 W9-D；做法沿用 [RFC-439](../RFC-439-code-capability-inbound-bindings/proposal.md)（绑定原样迁入 owner 模块的 `inbound/http`，
  `composition/routes.ts` 只转出挂载函数）。

## 1. 背景

`util/` 搬完之后（RFC-571～RFC-575），legacy 横向目录里最大的是 `routes/`（50 个文件）。经过前面的 S9 / S10，这些路由已经不碰 `@/db`、不深引模块
内部、不取 `services/`，只差位置。system-operations 的七个是最整齐的一族：

| 文件                           | 内容                                    | 模块依赖（全部 `import type`）                                               |
| ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------- |
| `routes/backup.ts`             | 备份的操作路由                          | system-operations `public/operations`、identity-access `public/participants` |
| `routes/restore.ts`            | 还原的操作路由                          | 同上，另取 system-operations `public/types`                                  |
| `routes/databaseMigrations.ts` | 数据库迁移的操作路由                    | 同上                                                                         |
| `routes/overview.ts`           | 系统总览                                | system-operations `public/queries`、identity-access `public/participants`    |
| `routes/daemon.ts`             | 守护进程的运行信息（`GET /api/daemon`） | system-operations `public/queries`                                           |
| `routes/maintenance.ts`        | 维护状态                                | system-operations `public/queries`                                           |
| `routes/maintenanceDisk.ts`    | 磁盘回收报告                            | system-operations `public/operations`                                        |

它们另外只取 HTTP 传输工具（`routes/registry`、`routes/operationRoute`、`routes/operationAuthority`、`platform/http`、`hono`、`zod`、shared）与
`@/auth/actor`，和已经在模块 `inbound/http` 里的绑定一样。

## 2. 目标

- **G1**：七个文件原样迁入 `modules/system-operations/inbound/http/`（文件名统一成 `<name>Routes.ts`），`composition/routes.ts` 转出挂载函数与依赖
  类型，`server.ts` 改从那里取；旧位置不留转出。
- **G2**：三个只被这些绑定消费的 public 合同（`public/operations` 的 `SystemOperationDescriptors`、`DatabaseMigrationOperationDescriptors` 与
  `public/queries` 的 `SystemOverviewQuery`）随绑定进模块后不再有模块外的消费者，撤回 application（与造它们的工厂、实现放在一起）；绑定从那里取。随之只剩它们引用的三个 public 类型（`SystemOverviewAuthority`、
  `CancelStagedRestoreResult`、`RecoveryStatusView`）一并撤回 application。
- **G3**：`legacy-horizontal-files` 98 → 91；其余计数不升（尤其 `context-value-pairs-off-dag`、`off-dag-offered-file-context-pairs`、
  `module-layer-violations`）；行为不变（路由、鉴权、挂载顺序都不变）。

## 3. 非目标

- 路由的传输工具（`routes/registry`、`operationRoute`、`operationAuthority`、`resourceAcl` 等）归 platform，另立。
- 其他模块的路由；`routes/health.ts`（取 task-execution 与 platform 的健康数据，归属另议）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：七个旧路径不存在，全部源码、用例与脚本不再取它们；新文件与原文件只差 import 说明符。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单、鉴权门与既有路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 98 → 91；`unconsumed-public-symbols-system-operations` 保持 0（三个合同撤回 application）；架构报告的
  归属表删去七行；新增 RFC-576 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
