# RFC-545 实施计划

依赖：RFC-542。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-545-T1 live 绑定是常量**：删去 `schema/tables.ts` 的登记与读取，bootstrap 导出常量（design D1）。
- **RFC-545-T2 显式交入**：PostgreSQL 客户端与 provider 运行期选项必填 `liveSchema`，各入口沿 `contract` 的通路交入（design D2）。
- **RFC-545-T3 `tablesOf`**：句柄上下文记 live 绑定，`tablesOf` 据此核对（design D3）。
- **RFC-545-T4 用例**：新增 RFC-545 用例并登记 guard-manifest；随改 design D4 所列用例与测试助手。
- **RFC-545-T5 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例；红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-545-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十二步。

## 验收清单

- [x] AC-1 `schema/tables.ts` 没有模块级状态；bootstrap 只导出常量；客户端与 provider 运行期选项显式收下 live 绑定
- [x] AC-2 两种引擎的客户端与 `tablesOf` 的结局不变
- [x] AC-3 模块级可变单例 48 → 46、计数不升；新增 RFC-545 用例并登记；读旧接口的用例随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机在验证途中重启（2026-11-23 06:38），`/private/tmp` 被清空，scratchpad 里的工具、两份导出仓库与正在跑的验证一并丢失，Docker 没有随之起来
（本地没有 PostgreSQL）。工具与导出重建后重跑全部验证：候选导出仓库是 HEAD `d00cf2c72` 加本 RFC 的 113 个路径（核对与工作树逐字相同），
对照是同一 HEAD 的另一份导出。本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。集中验证查出三处本人遗漏，已修
并复验：

- **本人遗漏：三条钉着被改形状的源码锁**。`rfc370-doctor-configuration-bindings` 按语法树钉 doctor 根里
  `checkConfiguredDatabase(input.contract,input.tasks,configuration)` 的调用形状，`rfc474-entry-adapter-bootstrap-assembly` 钉 migration report 依赖的
  对象字面量，`rfc524-system-operations-development-automation-required-selections-boundary` 钉 `prepareManualDatabaseMigration` 的形参与
  `migrate.ts` 的实参；它们都随 `liveSchema` / `persistenceSchemaBinding` 多了一项。三处锁改为新形状（并注明 RFC-545），复验通过；guard-manifest
  随之同步行数。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 TS 文件无告警，改动的 22 个生产文件另过 promises 配置；
  prettier：改动的代码、guard-manifest 与三件套通过。
- **选择**：按 RFC-533 的口径（重建）从 2,989 个用例文件里选出语义层 423 个：改动的 79 个用例、全部 `tests/architecture/`（142 个）、在 import 之外
  以路径点名被改文件的 126 个、点名 live schema 与被改入口的 96 个、直接导入被改客户端 / provider 运行期 / system-operations 文件的 99 个、经读源码
  的测试助手（`daemonGraphSource`、`deploymentSelectionSource`、`census` 等）读到被改文件的 229 个；`sessionTables.ts`、`bootstrap/persistenceSchema.ts`
  与 `db/client.ts` 几乎被全部用例导入，它们的 import 闭包交给 CI 的全量分片。
- **语义层**（SQLite；60 秒；候选 5 个 worker）：423 个文件 419 个通过（RFC-545 用例全过）。红的 4 个：上面那三条锁；`rfc321-repository-publication-ratchet`
  只在导出仓库里红（要回放可达历史，导出没有 git 历史），在主树工作树里 10 / 10。改锁后那三个用例与 RFC-545 用例在候选上复验 4 / 4 个文件通过。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：`tablesOf` 不再核对 live 绑定、模块级登记回来、上下文丢掉交入的 live 绑定、bootstrap 的
  live 绑定不冻结，各自让 RFC-545 用例红。
- **架构报告**（候选与对照各出一份）：模块级可变单例 48 → 46（删去的正是 `liveBinding` 与 `registerPersistenceSchema`）；跨上下文导入多 6 条，是
  system-operations 的六个文件取 platform 的 `RuntimeSchemaBinding` 类型；模块符号属主 32,472 → 32,470；`composition-control-flow-system-operations`
  只有行号移动、计数不变；其余计数与门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **live 绑定的内容不变**：bootstrap 导出的冻结常量与原先登记的同一份（同样的表定义、两种引擎的原生表集与行规则错误码）。
- **PostgreSQL 客户端**：原生表集与行规则错误码改取 `options.liveSchema`；全部构造点交入 bootstrap 的这个常量（bootstrap 直接取，system-operations
  与 CLI 沿各自收下 `contract` 的同一条通路收下），所以客户端绑定的表集与翻译行为不变；构造也不再依赖 bootstrap 先被求值（原先未登记即抛
  “Live persistence schema has not been composed”）。
- **`tablesOf`**：原先核对“句柄绑的表集就是进程里登记的那一份”，现在核对“就是绑定时交入的 live 绑定里这个引擎的那一份”。生产里交入的都是
  同一个常量，两种引擎的客户端、事务与继承句柄结局不变，epoch-1 句柄（不交 live 绑定）照旧报 “no epoch-2 table set”。测试夹具若绑了 live 表集
  却不交 live 绑定，现在也会报错；仓内这类夹具与用例（`schemaFixture`、`nativeQueryFixture`、`rfc395-session-table-binding`、
  `rfc395-r1-target-contract`）都已交入。
- **入口与组合输入**：provider 运行期选项、托管准备输入、system-operations 的 doctor / 手动迁移 / 托管部署与恢复的输入，以及 migration report 的依赖，
  都在 `contract` 旁多一个必填的 `liveSchema`（类型检查保证没有漏交的构造点），其余参数与行为不变。
- **用例**：新增 RFC-545 用例并登记 guard-manifest；随改直接构造客户端或 provider 运行期选项的 79 个用例与 3 个测试助手，以及三条钉着被改形状的锁。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-544 转 Done 的 CI）；实现与验证后再提交
`refactor(backend): RFC-545 live 持久化 schema 由组合根显式交给 provider 构造（RFC-294 S12 第二十五步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
