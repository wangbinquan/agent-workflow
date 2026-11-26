# RFC-603 实施计划

依赖：RFC-597、RFC-601。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-603-T1 端口合同**：`ReconcilerPorts` 的 25 个成员必填（design §1.1）。
- **RFC-603-T2 按用例的 deps 与分支**：命令与发布链的 deps 改为必填的 `Pick`；删去端口缺席的分支（design §1.2、§1.3）；装配只改注释（§1.4）。
- **RFC-603-T3 用例**：`reconcilerPortsFor` 与两个夹具补全端口；直接构造端口的用例改走 helper；断言“端口没给”的用例删去或改成可表达的失败（design §2）。
- **RFC-603-T4 RFC-359 P0**：`p0-9-launchers` 退役，同步阶段表、预载与判定用例（design §3）。
- **RFC-603-T5 门与文档**：新增 RFC-603 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 W4-E8 注记、RFC-359 plan 的 P0-9 注记（design §4）。
- **RFC-603-T6 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-603-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 `ReconcilerPorts` 无可选成员；命令与发布链的 deps 只声明自己读的端口且必填；生产装配不变
- [x] AC-2 application 里不再把端口当作可能缺席；删去的 code 不再因端口缺席产生
- [x] AC-3 P0 `p0-9-launchers` 退役，`p0-9-terminal-observer` 保留
- [x] AC-4 用例给全端口、行为与生产一致；计数不升；新增 RFC-603 用例并登记
- [x] AC-5 受影响用例全部通过；exact SHA CI 全绿（后继证据，见下）
- [x] AC-6 流水线发布链按版本化引用得出适配器绑定；用例以 schema 合法的员工内容走通

## 集中验证

基于 `c37b675ff`（另一会话的 RFC-602 在本 RFC 开发期间落地）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：
  - 先把 25 个成员改为必填，按 `tsc` 列出的调用点逐个补上：20 个用例文件与 1 个夹具的 75 处，生产代码 0 处。
  - 删去分支、收窄 deps 之后，backend `tsc` 0 错。
  - eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：
  - 范围：在候选导出里，按改动路径与名字选出，再加上读 guard-manifest / 计数 / `STATE.md` / RFC 文档的用例、遍历 development-automation 目录的扫描，
    以及改动的测试 helper 在 `tests/` 内的传递闭包，共 578 个用例文件，13 个红。
  - 另一会话的 6 个：它们在干净的 `c37b675ff` 控制导出里同样红，与本 RFC 无关，证据留给 RFC-602。
    - RFC-602 新挂的 `GET /api/tasks/:id/children` 缺契约 / MCP / 错误码条目：`api-contract-coverage`、`rfc317-route-contract-oracle`、
      `rfc329-mcp-surface-guard`、`route-error-code-coverage`。
    - `backup`：新增表使 `activeTableCount` 234 → 244。
    - `rfc395-fixture-direct-writes`：新用例 `rfc602-task-children-page` 不在账里。
  - `rfc321`：要 git 历史，导出里照例红，主树 10 / 10。
  - 本 RFC 的 6 个：都是替身与真实 playbook 台账让“端口缺席”的静默依赖现形（design §2.1），其中一处是既有缺陷。修复后复跑这 6 个与所有触及流水线发布链的
    用例，共 18 个文件全绿。`rfc310-pr2-recovery` 多走一轮：驱动走到了动作启动，给出动作端口后 6 / 6。
  - 文档定稿后，读 guard-manifest / 计数 / `STATE.md` / RFC 文档的 148 个用例文件在候选导出里复跑，全绿。
- **RFC-359 P0**（SQLite，用脚本导出的阶段表与日志判定）：`p0-9-terminal-observer` 判定有效（按钉住的失败退出 1），前后两个控制阶段有效。PostgreSQL
  一半以 CI 为准。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：
  - 运行期 8 种，7 种被认出：
    - 发布链重新按端口缺席 block、playbook 经取自端口的局部变量静默跳过、对端口重新用 `?.`、端口成员改回可选、替身少一个方法：RFC-603 用例红。
    - helper 不再给数据库支撑的 playbook 台账：RFC-603 用例与 `rfc310-pr2-reconciler` 红。
    - 启动器拒绝的 block code 丢掉 runner 的 code：`rfc310-pr2-reconciler` 红。
  - 未被认出的一种：reconcile 不再记 saga 摘要，`rfc310-playbook-coordinator` 照旧绿。这是既有缺口：此前摘要也只在给了台账时记，没有用例钉它的存在；
    记下，不在本 RFC 扩范围。
  - 类型检查 3 种一起施加，都在预期处报错：在途动作失效的 `ports` 改回可选（`actionInvalidation.ts`，加上 RFC-603 用例的编译期断言）、装配漏给一个
    端口（`composition.ts`）、发布链端口集少一个成员（`conflictRepairDelivery.ts`）。
- **架构报告**（候选对照干净的 `c37b675ff`）：
  - 除来源与时间外，只差三处：多了一个导出类型 `DeliveryChainPorts`，少了私有函数 `requiredPortsMissing`；报告里只记不门禁的 mutation entrypoint
    清单在同文件的 `DeliveryChainDeps` 旁多列了 `DeliveryChainPorts`。
  - 有门禁的计数都不变。

## CI（AC-5）

- `0f2ded0db`（实现）：exact SHA 主 CI run 45760585469 红在 shard 1、2、17、23、41、42。
  - 全部是另一会话 RFC-602（`c37b675ff` / `c1f722673`）的用例与门：新路由缺契约 / MCP / 错误码条目、`backup` 表数、PostgreSQL 聚合映射、守护进程装配、
    epoch-2 桥、账外的新用例。与 RFC-602 自己的 run 是同一批，由它的 `5ebf425f5` 修复。
  - 本 RFC 的用例（含 PostgreSQL 一半与 P0 变异）都过，未重跑。
- 后继证据：包含本提交与该修复的 `170f3e2cc`（RFC-605）run 45772006810 70 / 70 全绿。2026-11-26 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **生产装配不变**：`composeDevelopmentAutomation` 本来就构造全部 25 个端口，命令收到的是同一份 `ports`；`tsc` 确认所有生产调用方都给全。
2. **删去的分支在生产上走不到**：每处删去的判断，在端口都在时取的正是保留下来的那一支。saga 摘要、playbook 编排、上传计划、需求标题、上传发布回执与
   在途执行的取消，在生产上照旧发生。
3. **既有缺陷的修复**：流水线绑定改按 schema 的版本化引用得出 `id@revision`，与集成侧解析绑定的写法一致。没有 provider 或内容不合法时仍为
   `pipeline-adapter-unbound`。
4. **用例**：删去或改写的只是断言“端口没给”的用例；改写后的失败都是生产上真实存在的：启动器拒绝、基线不可解析、observe 失败。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。开发期间另一会话的 RFC-602 已以 `c37b675ff` 提交，`STATE.md` 与 `design/plan.md` 相对 HEAD 只含本 RFC 的段落（发布前再核一次）。
推送后按 exact SHA 跟 CI。
