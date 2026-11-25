# RFC-597 实施计划

依赖：RFC-596。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-597-T1 装配边界**：`DevelopmentAutomationProviders` 与入参继承、`ReconcilerPorts` 组装去掉条件展开（design §1）。
- **RFC-597-T2 用例与夹具**：测试替身助手、9 个用例文件的 12 个调用点、P0 变异预载的类型断言（design §1）。
- **RFC-597-T3 门与文档**：新增 RFC-597 用例并登记（design §2）。
- **RFC-597-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-597-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 11 个 provider 必填、入参继承具名接口；装配没有按 provider 分支与非空断言
- [x] AC-2 daemon 装配不变；替身给全、调用即抛；P0 变异照旧得到 `*-launcher-not-wired`
- [x] AC-3 计数都不升；新增 RFC-597 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `eead26c45`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（含 RFC-597 用例的编译期断言与各用例的替身）；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**（候选导出）：按改动路径与名字选出，再加上调装配的用例、读模块装配文件与 P0 预载的用例、两个改动的测试 helper / 夹具在 `tests/`
  内的传递闭包、遍历 development-automation 目录的扫描、架构报告、结构守卫与读 guard-manifest / 计数 / STATE / RFC 文档的全部用例，共 381 个用例
  文件。首轮红 2 个：`rfc321`（要 git 历史，导出里照例红；主树里 10 / 10）与 `rfc310-pr5-e2e-java`——正是替身要查出的那一类：第 9 轮走到用例没给的
  MR 事实采集、替身抛错，此前这一轮静默停在 `collector-not-wired:merge-request`（见 design §1）。改为给生产的 MR 事实采集后复跑通过（1 / 1，25 条
  断言），`tsc`、eslint、prettier 复查通过。其余 379 个文件里没有一个走到没给的 provider。文档定稿后（RFC-294 plan 的后继注记、本 plan 与 `STATE.md`
  的验证段）把读 guard-manifest / 计数 / `STATE.md` / RFC 文档 / RFC-294 的全部用例连同两个改动的用例在候选导出里复跑：344 个文件，只有 `rfc321`
  照例红（主树 10 / 10）；读 STATE / RFC 索引 / RFC 文档的 7 个文件在主树 46 / 46。
- **RFC-359 P0**：在候选导出里用该脚本导出的阶段表与日志判定单跑 `p0-9-launchers`（SQLite）：根执行用例通过，Agent 与脚本两条 legacy 用例照旧以
  `{"blockCode":"agent-launcher-not-wired"}` / `{"blockCode":"script-launcher-not-wired"}` 失败，判定有效。PostgreSQL 一半以 CI 的 P0 job 为准。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：五种运行期变异都被 RFC-597 用例认出——装配重新按“给没给”展开一个 provider；一个 provider 改回
  可选；物化器不再收需求源（`rfc310-pr3-journey` 也红 1 条）；冲突合并的包装重新写非空断言；替身少一个方法。三种类型检查变异一起施加后 `tsc` 报
  4 处：daemon 装配漏给 `approvalGateway`（装配调用处）、`mrEffects` 改回可选（RFC-597 用例的编译期断言，2 处）、替身少一个方法（helper 处）。首次施加时
  “改回可选”与“daemon 漏给”落在同一个成员上，前者掩盖了后者（daemon 处不报错），分到两个成员后各自报出。复原后导出无残留。
- **架构报告**（候选对照 `eead26c45`）：60 个计数都不变；只多一个模块符号（装配根导出的 `DevelopmentAutomationProviders`）；未消费 public 符号 0；
  public 面、public 类型偏差与跨 context import 不变。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **生产装配不变**：daemon 原本就给全 11 个 provider（MR 效果、仓库远端、流水线证据与 MR 事实采集由三个组装函数交出，它们的返回类型本来就是必填）；
   `ReconcilerPorts` 收到的是同样的对象，冲突合并的包装与工作区根的计算一字未改，物化器收同一个需求源。
2. **未接的状态**：装配上不再能表达“不给”；reconciler 的 `*-not-wired` 分支照旧在，只由直接构造端口的用例到达；P0 变异在运行期照旧复现事故的指纹。
3. **用例**：替身只顶替用例没给的 provider，调到就抛出带名字的错误；所选用例里只有 `rfc310-pr5-e2e-java` 走到，改为给生产的 MR 事实采集，它第 9 轮的
   选择断言照旧，其后的断言不依赖这一轮的结果。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
