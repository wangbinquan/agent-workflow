# RFC-384 实施计划

**前置**：RFC-383 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-384-T1 | intent 补 composition 入口：资源目录绑定（含 WeakMap）、排队续跑包装、路由依赖类型与挂载再导出；`composeIntentDumpAuxiliaryQueries` 改收实时配置读取口 | design §2.3、§2.5 |
| RFC-384-T2 | 新增 `cli/daemonModules/intent.ts`（一套图、两个运行族、显式制品生命周期、维护活动、排队续跑） | design §2.1、§2.4、§3 |
| RFC-384-T3 | S 与 P 改用模块组：两个会话都在 `createMaintenanceService` 之前构造意图组；删除收件箱、迟绑定、两处转储包装与 P 的构造时快照；P 以 `runtime.intentModules` 取代 `intentMaintenance` / `resumeIntentSessions`；统一排队准入失败日志 | design §2.2～§2.4、§3 |
| RFC-384-T4 | V 注入与回退：`AppDeps.intentModules`，V 只在 `composeSqliteApplicationDeps` 的 `??` 回退中调用；删除 V 自建的应用引擎与路由图、`SqliteAppComposition.intentApplyActivity`；注入与 `intentTestDependencies` 同时出现时抛错 | design §4 |
| RFC-384-T5 | 架构账本与旧锁：`BOOTSTRAP_FILES`、R1、guard-manifest、结构守卫 | design §5.2～§5.4 |
| RFC-384-T6 | 测试（design §5.1 第 1～6 项） | design §5.1 |
| RFC-384-T7 | 文档：`docs/dev-gotchas.md` 一条：意图只在模块组构造，两个运行族保持分离，维护直接读模块组的应用活动 | — |

**依赖**：T1 → T2 → T3 → T4；T5、T6 贯穿。

## 冲突面

入口根（`cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts`）与 `cli/daemonModules/`：与 RFC-385、RFC-386 串行。

## 验收清单

- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片）
