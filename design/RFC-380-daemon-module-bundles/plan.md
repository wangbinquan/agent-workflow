# RFC-380 实施计划

派发 Codex 实施、本会话审核；单批次交付，先完成全部实现与用例，再集中验证一次（CLAUDE.md 文首硬规则）。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-380-T1 | `cli/daemonModules/adapters.ts`：provider 核心适配器表与单机模块适配器 | design §2、§3 |
| RFC-380-T2 | `providerCore.ts`：`composeDaemonProviderCore`；两个根改用它；删除两个 provider 专属核心函数与 `createPostgresqlAuthRuntime`；P 改用核心的存储与运输仓库 | design §1.1、§3 |
| RFC-380-T3 | `repositoryCredentials.ts`：`composeDaemonRepositoryCredentials`；S、P 各调用一次并注入 V；删除 V 的重复构造与 `composeSqliteUncredentialedDevelopmentDeliveryProvider` | design §1.2 |
| RFC-380-T4 | `resourceCatalog.ts`：`composeDaemonResourceCatalogModules`（含能力模板与开发配置 ACL 绑定）；资源目录模块的带通知 ACL 写入口；S、P 各调用一次并注入 V | design §1.3、§4.2 |
| RFC-380-T5 | `observation.ts`：`composeDaemonObservationModules`；删除 V 中无人使用的观测 / 运行族实例 | design §1.4 |
| RFC-380-T6 | `memory.ts`：`composeDaemonMemoryModules` | design §1.5 |
| RFC-380-T7 | V：HTTP 认证与令牌审计读取改用核心实例；删除令牌审计门面的列表函数；`AppDeps` 注入字段与回退改调共享函数 | design §4.1、§5 |
| RFC-380-T8 | `HOSTED_ONLY_SELECTIONS` 增加三项，SQLite 根不再读取 | design §4.3 |
| RFC-380-T9 | 架构账本：`census.ts` `BOOTSTRAP_FILES`、`commons-debt.json`、孪生账本、适配器消费者账本、导入账本；guard-manifest 登记新守卫 | design §6 |
| RFC-380-T10 | 旧锁改指（design §7） | design §7 |
| RFC-380-T11 | 测试（design §8 第 1～6 项） | design §8 |
| RFC-380-T12 | 文档：`docs/dev-gotchas.md` 一条「同构模块只在 `cli/daemonModules/` 构造一次，根与 server.ts 不再自建」；RFC-294 plan S2 注（审核方完成） | — |

依赖：T1 → T2 → T3；T4、T5、T6 依赖 T2；T7 依赖 T2～T6；T9、T10 依赖 T2～T8；T11 贯穿。

## 冲突面

- 入口根 `cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts`：本 RFC 独占，与 RFC-381～383 串行。
- `modules/resource-catalog/composition/resourceAcl.ts`（新增带通知写入口）、`services/tokenAudit.ts`（删除列表函数）。

## 验收清单

- [ ] proposal AC-1～AC-7
- [ ] design §7 旧锁逐条处置
- [ ] 推送后 exact SHA CI 全绿（含 PostgreSQL 分片）
