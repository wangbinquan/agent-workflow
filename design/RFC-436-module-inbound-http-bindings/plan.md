# RFC-436 实施计划

**前置**：RFC-435 收尾（`8e2f39721`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                  | 依据            |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| RFC-436-T1 | 事件中心：句柄合同移到 `application/ports`，路由移到 `inbound/http`，composition 转出，`server.ts` 改导入             | design §1       |
| RFC-436-T2 | 数字员工句柄合同与迁移状态类型移到 `application/ports`，composition 转出                                              | design §2.1     |
| RFC-436-T3 | 案例访问判据移到 `application/caseAccess`（自有查看者类型），平台工具只读判据 `application/toolAccess`，删除服务文件  | design §2.2–2.3 |
| RFC-436-T4 | 数字员工路由移到 `inbound/http`，挂载签名收窄，去掉 development-automation 托管的两组路由                             | design §2.4     |
| RFC-436-T5 | development-automation：活动操作入 `inbound/http`，`mountDevelopmentCaseRoutes`；`server.ts` 新路由组，bootstrap 连接 | design §3       |
| RFC-436-T6 | 用例：新增 RFC-436 用例，改指旧路径的源码锁与判据导入；账本与计数按实测更新                                           | design §4、§6   |
| RFC-436-T7 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                 | design §6       |
| RFC-436-T8 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（E9 路由部分、B / D 第二步）                                  | —               |

## 验收清单

- [x] AC-1 两个绑定入模块，旧文件删除，数字员工绑定不依赖 development-automation / identity-access / `services/`
- [x] AC-2 development-automation 自己挂载案例范围路由，每条路由只注册一次，DAG 无反向边
- [x] AC-3 账本与计数按实测更新（R1 201 → 198，深引路由 6 → 4，import `services/` 的路由 29 → 28）
- [x] AC-4 受影响用例全部通过
- [ ] AC-5 exact SHA CI 全绿

## 集中验证（2026-11-03，候选基于 `8e2f39721`）

全部实现与用例写完后一次进行。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警；改动的 TS 文件已按 prettier 格式化。
- **第一轮定向**（SQLite，`--isolate`）：`tests/architecture/` 与 preflight、RFC-305 / 317 / 331 / 436、routes-no-cast、API 合同覆盖，
  146 个文件 1412 pass / 0 fail。
- **全量 SQLite**（`bun run test:backend`，四分片）：23247 pass / 23 fail，另有文件级错误。逐条归因：
  - **本 RFC 的遗漏，已修**：
    - RFC-317 员工定义 ACL 与 RFC-330 工具 / 模版 ACL 的接线断言仍读旧路由路径，测试套件策略「模块级读取的源码路径必须存在」随之报出；
    - RFC-310 OS 清单、development-automation 架构锁与 RFC-349 provider 边界扫描没有跟上新位置，处理见 design §4。
  - **只在未提交的工作树出现**：路由错误码棘轮按 git 索引取文件，索引里仍有已删的旧路由文件。导出仓库里候选已提交，该用例通过。
  - **负载超时，与本 RFC 无关**：
    - 涉及 RFC-396 MR 候选桥 10 条、RFC-167 dw-confirm 3 条、RFC-370 V16 1 条、RFC-075 自动提交 1 条，均超出 5 s 默认时限；
    - 同一时限下逐个文件单独复跑全部通过（37 / 29 / 8 / 3 pass）。
- **第二轮复验**（SQLite，`--isolate`）：修正后的文件连同第一轮全部用例，152 个文件 1472 pass / 0 fail / 4 skip。
- **导出仓库**（`8e2f39721` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 169 个文件：按已提交源码出报告的 141 个用例、路由错误码棘轮等 7 个、受影响用例的 PostgreSQL lane 26 个，去重后合并；
  - 结果 2329 pass / 1 fail / 4 skip。唯一失败是 RFC-359 W5 组合根路由面：PostgreSQL 应用在四路并行下启动超时。
    单独复跑两个引擎都通过，两条 lane 的路由面逐字一致。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异各自变红、
  当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：深引模块内部的路由 4 个（`code.ts`、`capabilityTemplates.ts`、`scheduledTasks.ts`、`webhookDeliveries.ts`）；
  import `services/` 的路由 28 个；三个模块 `inbound/http` 下的绑定都不 import `services/`。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 路由、方法、权限点、令牌访问、请求解析与错误码和原注册逐条相同；
- 活动操作仍需 `development-missions:retry`、`tokenAccess: never`、执行组 `digital-employee`，不是 MCP 工具；
- 案例范围路由与数字员工路由没有同方法同形路径，全局中间件先于路由注册，API 文档按路径排序，挂载先后不可见；
- 生产装配的数字员工模块恒带运行时，原先「运行时存在才挂载」的条件与现在无条件挂载等价；
- 案例与工具判据整段搬迁，404 同形、403 分档与文案不变。

## PR / 提交

单个提交：`refactor(backend): RFC-436 事件中心与数字员工的 HTTP 绑定归入各自模块（RFC-294 W4 E9）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
