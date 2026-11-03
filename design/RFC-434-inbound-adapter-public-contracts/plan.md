# RFC-434 实施计划

**前置**：RFC-433 与 RFC-294 S2 收尾（`43fcce84c`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                         | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| RFC-434-T1 | 3 个非精确 public 文件按内容并入精确入口，生产与用例导入方改走新入口，原文件删除                             | design §1 |
| RFC-434-T2 | public 导出 application 层合同：TE 归档维护命令、DA 上传操作                                                 | design §2 |
| RFC-434-T3 | composition 里的 Webhook 入口持久化接口搬到 `application/ports`，由 public 导出                              | design §2 |
| RFC-434-T4 | 第一批 8 条模块外深引改走精确 public 入口                                                                    | design §2 |
| RFC-434-T5 | 账本与计数按实测更新（R1、public surface、跨 context 边、offered 边、RFC-305 / 328 / 331、counts、manifest） | design §4 |
| RFC-434-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                        | design §6 |
| RFC-434-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W4 B / D 第一步）                                   | —         |

## 验收清单

- [x] AC-1 public 入口全部精确
- [x] AC-2 第一批路由不再深引
- [x] AC-3 账本与计数按实测更新（DAG 外 offered 边 +1 是两条既有依赖的重新归类，其余只减）
- [x] AC-4 回归用例全部通过
- [ ] AC-5 exact SHA CI 全绿

## PR / 提交

单个提交：`refactor(backend): RFC-434 精确 public 入口与入站路由第一批去深引（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。

## 集中验证（T6）

全部实现写完后一次进行（`880d23d3e` 之上的工作树）。

- **静态**：后端 typecheck（含 tests，6 GiB heap）0 错误；改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **验证中发现、已修的设计问题**（都由既有结构规则报出，按规则调整去向，不登记新例外）：
  - `rfc400` 遗留 `Actor` 规则：能力模板 / 上游操作、任务目录查询、Webhook 投递运行时的签名带遗留 `Actor`，不能从 public 导出。
    这几条退出本 RFC，另立（E8 / E10）。
  - 能力归属规则：`MemoryScopeAuthority` 含 `RequestAuthority`，不进 `public/types`，改放在使用它的 `queries` 旁。
  - public surface 规则：`TaskRouteOperations` 若放在 `types` 会直接 import `platform/` 实现类型，改放 `commands` 并经 `./types` 引用；
    `WebhookIngressPersistence.endpoints` 从 `Pick` 整个管理端口收窄为两个读方法，不再带出 `Partial`。
  - 账本：R1、非精确入口、跨 context 内部边、public surface、RFC-305 / 328 / 331 的路径与条目按实测更新。
    DAG 外 offered 边 +2 是两条既有依赖的重新归类（proposal §6 第 6 条）。
- **架构测试**：`tests/architecture/` 全部、`rfc294-architecture-preflight`、`rfc305-architecture-lock` 1374/1374 通过；`rfc328-architecture-guards`、
  `rfc331-task-execution-topology` 通过。
- **全量 SQLite（4 分片，单分片上限 5400 s）**：4 个分片都跑完：2883 个文件、23392 条用例，23246 通过、127 跳过、19 失败。
  - 2 条是本 RFC 的账本（RFC-328 任务执行账本里 `TaskRouteOperations` 的文件路径、RFC-331 的既有深引登记），已改；
  - 17 条是 5 s / 30 s 负载超时（RFC-396 MR 桥 11、RFC-396 验证 1、RFC-167 3、RFC-075 1、RFC-363 工作区内容 1）。
  - 修复与超时文件 60 s 复跑：7 个文件 114/114 通过。
- **PostgreSQL 专注 lane**：受影响的 130 个文件，4 路各用独立库，60 s 预算：1237 条中 1236 通过。唯一失败是 `rfc311-perf-guards`
  只开 PostgreSQL 时必然报的跨引擎对比缺失（AC-11 需两个 provider）；该文件以 SQLite + PostgreSQL 同跑 25/25 通过。
- **导出仓库（`880d23d3e` + 本候选）**：141 个按已提交源码出报告的用例全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 实现门（本会话自审，只审功能）

- **运行时不变**：并入、搬家与导出的全是类型，受影响的导入全部是 `import type`，编译后擦除，生成的 JavaScript 不变；值导出
  （`isMemoryHiddenCandidate`、`narrowCandidateRows` 等）的位置没有动。
- **符号原样**：搬入精确入口的接口逐字搬移，没有改字段与方法签名；`MemoryScopeAuthority`、`TaskRouteOperations` 只换文件。
- **Webhook 端点读取收窄**：
  - 组合根照旧把完整的端点管理端口交给入口持久化，结构上满足 `WebhookIngressEndpointReads`；
  - `routes/webhooks.ts` 只调 `getByUrlToken`，投递路由经扩展它的投递运行时调 `get`，两个方法都在收窄后的接口里。
- **结论**：PASS。
