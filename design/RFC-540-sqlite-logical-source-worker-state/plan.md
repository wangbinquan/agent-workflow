# RFC-540 实施计划

依赖：RFC-539。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-540-T1 处理器**：新增 `platform/persistence/sqliteLogicalSourceWorkerHandler.ts`，六种请求的处理与三份状态从入口逐字搬进
  `createSqliteLogicalSourceWorkerHandler(io)` 的闭包（design D1）。
- **RFC-540-T2 入口**：`sqliteLogicalSourceWorker.ts` 只建一个处理器，`onmessage` 交给它（design D2）。
- **RFC-540-T3 用例与锁**：新增 RFC-540 用例并登记 guard-manifest；`rfc349-database-migration-worker` 改钉处理器文件（design D3）。
- **RFC-540-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-540-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第八步。

## 验收清单

- [x] AC-1 Worker 入口与处理器文件没有模块级状态；入口只建一个处理器并把 `onmessage` 交给它
- [x] AC-2 六种请求的结局不变；两个处理器各自初始化、互不相通
- [x] AC-3 模块级可变单例 54 → 51、计数不升；锁随改；新增 RFC-540 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 22～30，另有会话在跑）。验证在候选导出仓库里跑（HEAD `bf1ed4716` 加本 RFC 的 6 个路径，核对与
工作树逐字相同），对照是同一 HEAD 的另一份导出；其后的 `091d0eee8` 只改文档（本 RFC 的落档与 RFC-539 转 Done）。集中验证没有查出本人缺陷：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 5 个 TS 文件无告警，改动的 2 个生产文件另过
  promises 配置；prettier：6 个路径与三件套通过。
- **选择**：按 RFC-533 的口径从 2,985 个用例文件里选出 156 个。语义层 171 个：改动的 3 个用例、全部 `tests/architecture/`（142 个）、语料守卫、
  在 import 之外以路径点名被改文件的 3 个、点名逻辑源 Worker / 迁移装配的 20 个、直接导入处理器的 1 个、经 `rfc294Gates.ts`（单二进制入口清单
  列着 Worker 入口）到达的 48 个；`tests/fixtures/` 里没有钉被改文件的摘要锁。
- **语义层**（60 秒；候选 5 个 worker）：171 个文件 168 个通过；改过的与读 Worker 的用例全过（RFC-540 用例 4 / 4、`rfc349-database-migration-worker`
  3 / 3、`rfc359-w8-logical-source-conformance` 18 / 18、经监工起真 Worker 的 `rfc349-sqlite-logical-source` 4 / 4）；红的 3 个：两个长扫描用例
  （`rfc294-architecture-preflight`、`rfc376-report`）撞写死的时限，`rfc395-provider-move-recovery` 的 PostgreSQL 一支撞测试助手 `beforeAll` 的 90 秒。
- **A/B**（候选与对照同时、各用各的库；在两边的副本里临时放大写死的时限跑到底）：`rfc294-architecture-preflight` 14 / 14、`rfc376-report` 16 / 16、
  `rfc395-provider-move-recovery`（连同测试助手的 `beforeAll`）13 / 13，两边都全过。没有只在候选上红的用例。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：三份状态挪回处理器文件的模块级（同一线程里的处理器共用一份），RFC-540 用例红两条（真实
  语料、两个处理器互不相通）；入口每条消息另建一个处理器，RFC-540 的真实语料红，经监工起真 Worker 的 `rfc349-sqlite-logical-source` 也红
  （初始化后的下一条请求落到新处理器上，读不到源）。
- **架构报告**（候选与对照各出一份）：模块级可变单例 54 → 51（删去的正是入口的 `source`、`contract`、`initializing`）；模块符号属主 32,472 → 32,471
  （入口的六个私有名字换成处理器文件的四个与入口的 `handler`）；写入入口清单 2,394 → 2,395（处理器工厂一条）；后端生产文件 3,283 → 3,284（新文件）；
  跨上下文导入、公开面与减速带计数、门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **请求处理逐字不变**：六种请求的解析（`SqliteLogicalSourceWorkerRequestSchema`）、`init` 的重复初始化拒绝、契约摘要校验、schema 历史运行时的
  登记、打开逻辑源，`metadata` / `preflight` / `assert-unchanged` / `read-chunk` 的读取与未知表报错，`close` 的关源、清空与回 `closed`，以及
  `failure` 的错误码与消息截断，都从入口逐字搬进 `createSqliteLogicalSourceWorkerHandler(io)`；`postMessage` 换成 `io.emit`，关闭 Worker 换成
  `io.close()`，顺序不变（先回 `closed`、再关）。
- **状态归处理器**：逻辑源、契约与初始化标志放在处理器的闭包里；Worker 入口只建一个处理器，`self.onmessage` 把消息体交给它，每个 Worker 线程
  仍各有一份状态。单二进制的入口清单与 Worker 的监工、协议不变。
- **用例与锁**：`rfc349-database-migration-worker` 改钉处理器文件里的三段原文与入口经处理器处理消息；`rfc359-w8-logical-source-conformance` 的
  注释随改；guard-manifest 登记 RFC-540 用例。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-539 转 Done）；实现与验证后再提交
`refactor(backend): RFC-540 SQLite 逻辑源 Worker 的状态归每个 Worker 的处理器（RFC-294 S12 第二十一步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
