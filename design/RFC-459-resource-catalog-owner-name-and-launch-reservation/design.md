# RFC-459 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`RC/` = `S/modules/resource-catalog/`，
`IA/` = `S/modules/identity-access/`，`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位。本 RFC 收三件归属清楚的小东西：两件归 resource-catalog（它是唯一的生产
  owner），一件只剩用例在用的门面迁出生产代码。
- task-execution 取 resource-catalog 走 `public/participants`（目标 DAG 给的边）；不新增其余跨 context 边。

## 1. 去向

| 原位置                                 | 新位置                                            | 说明                                                 |
| -------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `IA/infrastructure/ownerScopedName.ts` | `RC/infrastructure/ownerScopedName.ts`            | `ownerScopedNameCondition`（Drizzle 谓词）           |
| `IA/application/ownerScopedName.ts`    | `RC/application/ownerScopedName.ts`               | `isOwnerScopedNameConflict`（两引擎一致的冲突判定）  |
| `L/ownerScopedName.ts` 的两个兼容名    | 并入 `RC/infrastructure/ownerScopedName.ts`       | `ownerScopedNameWhere`、`isOwnerNameUniqueViolation` |
| `L/agentLaunchReservation.ts`          | `RC/application/agents/agentLaunchReservation.ts` | 进程内引用计数表                                     |
| `L/userIdentities.ts`                  | `T/helpers/userIdentities.ts`                     | 用例专用的 db 形参兼容门面                           |

identity-access 同时删去 `composition/providerOperations.ts` 对 `ownerScopedNameCondition` 的再导出与 `public/operations.ts` 对
`isOwnerScopedNameConflict` 的再导出（两者在 identity-access 之外只有 `L/ownerScopedName.ts` 与用例在用）。resource-catalog
`public/participants.ts` 新增再导出 `acquireAgentLaunch`、`releaseAgentLaunch`。

## 2. 消费方改指

- resource-catalog `infrastructure/{skillMutationParticipant,legacy/skill}.ts` 取同模块 `infrastructure/ownerScopedName`；
  `infrastructure/agentPersistenceSemantics.ts` 取 `application/agents/agentLaunchReservation`。
- task-execution `infrastructure/taskRouteLaunchOperations.ts` 取 `@/modules/resource-catalog/public/participants`。
- 用例：owner 名判定的用例（`rfc359-owner-name-conflict-parity`、`rfc349-owner-identity-provider`、`rfc359-w12-provider-neutral-compatibility`、
  `rfc284-batchc-resource-dedup`）改取 resource-catalog 新位置；`rfc305-architecture-lock` 的 identity-access `public/operations` 导出清单删去
  `isOwnerScopedNameConflict`；身份门面的 7 个用例改取 `T/helpers/userIdentities`。

## 3. 用例与锁

- **新用例** `T/rfc459-resource-catalog-owner-name-and-launch-reservation.test.ts`：三个旧文件与 identity-access 两个旧文件不在、`S/` 与
  用例零引用旧路径（census AST，带负对照）；owner 名谓词与冲突判定只在 resource-catalog 定义一份；`public/participants` 导出的
  `acquireAgentLaunch` / `releaseAgentLaunch` 就是 application 那一份，且与删除守卫读的是同一张表（acquire 后 `isAgentLaunching` 为真，两次
  acquire 一次 release 仍为真，再 release 为假）；task-execution 只经 public 取保留表。
- **按路径读源码的锁**改指新位置（迁移前按 `docs/dev-gotchas.md` 的三种形态全仓搜，含仓库根 `tests/`）；架构报告 legacy 归属表删去 3 条；
  `commons-manifest.json` 的 `ownerscopedname-ts` 条目 `files` 改指；`commons-debt.json` 的 `R1` 两条按实测销账，P3 发现 ACL-10 的锚点改指迁移后的位置（TP-12 等指向 RFC-456 / RFC-457 迁走文件的锚点是带日期的审计记录，照旧不动）；guard-manifest 刷新行数。

## 4. 留下的债

- resource-catalog 三个仓储的私有 `ownerScopedNameWhere` 与 ACL 内核的手抄（ACL-10），随 ACL 继任合同去重。
- identity-access `public/operations` 的 `OidcIdentityProfileAccess`（`composeOidcIdentityOperations` 的可选入参类型）唯一的跨 context
  消费方是迁出的身份门面，「没有跨 context 消费方的 public 符号」322 → 323（该计数不设门）；随 identity-access public 面收口。
- 其余 `R1` 来源见 RFC-458 的「下一步」。

## 5. 失败模式

- 保留表出现第二份：旧文件删除后全仓只剩一条 import 路径（新用例断言同一表）。
- 漏改的消费方：tsc 兜底；按路径读源码的锁经新用例零引用断言与 `test-suite-policy` 兜底。

## 6. 测试策略

迁移所涉用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
