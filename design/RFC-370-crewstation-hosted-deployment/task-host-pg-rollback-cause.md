# RFC-370 原 PostgreSQL writer 探针的 rollback cause

## 实际失败与边界

`00ce2fea044e3ed32a02cb7d13f1bcdd6affd6c8` 的主 CI `37696635364`、Ubuntu21 job `113049867005` 中，原 commit / rollback writer 两条用例期望原注入的 `rollbackError`，实际收到 ORM 的 `DrizzleQueryError`，query 为 rollback、cause 为该原错误。现有两条用例预算都是 `60_000`；约 15 秒来自原生产心跳的首次触发，不是预算不足。

前一提交 `5bf9c109ce5285a176affd47e104c055127fbed0` 已修 release / settle 两阶段断言与固定 PG schema matcher，没有修改这条 cause 断言。新精确 SHA CI 仍须实际终态验收；不能把原失败记为通过。

## 修复设计

只改 `rfc370-task-host-finalization.test.ts` 的 PG 分支，导入原 `drizzle-orm` 已有的 `DrizzleQueryError`。接收原 `heartbeatReturned.promise` 的实际值，分别确认原 ORM 错误类和 rollback query，再把原 `toBe(rollbackError)` 身份断言保留在该 wrapper 的 cause 上。生产错误传播、heartbeat、SQL 和数据库驱动不改动。

SQLite 分支完全不变。两个 outcome、原用例名、真实 15 秒心跳、原 `60_000` 预算、实际 server 持锁和终止、独立连接读旧 revision、cleanup revision 不能提前读取、review lock 仍可编辑、获准之后的完成和空 snapshot，以及原 finally 释放全部保留。没有 timer mock、延长预算或删除旧断言。

## 验收与发布

独立有限设计门和实现门分别绑定完整候选、原控制源码与实际功能日志。按完整正文逆变换和 AST 比较确认原探针保持，只增加 wrapper 的类和 query 断言，原 error 身份仍验同一对象。仅运行本片格式 / lint 和纯正文 / AST 检查，不执行本机 AW tests / typecheck / build / services，也不运行架构 generation。

精确路径发布并保留共享 STATE / plan 的所有旧正文及并行输出，推送前后验 main / origin 同步；新 SHA 的实际 hosted 功能结果另验。既有 RFC 代码回顾和两项功能 P2 修复继续；完整 H7 / A-G 与 CS M0～M4 未完成，AW 尚未部署 CS。

## 源码依据

- `packages/backend/tests/rfc370-task-host-finalization.test.ts`：原真实 writer、错误注入、cause 断言与预算。
- `packages/backend/src/platform/persistence/postgresqlDatabaseClient.ts`：原数据库驱动与 ORM 错误传播。
- `packages/backend/src/modules/task-execution/infrastructure/taskDriverFinalization.ts`、`taskDriverLifecycle.ts`：原 writer 和 heartbeat 等待。
- 已安装的 `drizzle-orm/errors.d.ts` 与错误类实际实现：原 wrapper 的 query / cause。
