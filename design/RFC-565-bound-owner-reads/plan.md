# RFC-565 实施计划

依赖：RFC-564。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-565-T1 owner 一侧**：七个符号撤出 task-execution 与 source-control 的 public，装配根交出；`listNodeEventContents` 并入
  `TaskKnowledgeQueries.distillationEvents`；任务知识读收下仓库存在性片段（design §1）。
- **RFC-565-T2 消费方与 bootstrap**：memory、integration 与 task-execution 的托管恢复选择从构造入参拿到建好的读；bootstrap 在根句柄上建好并
  交入（design §2、§3）。
- **RFC-565-T3 门与用例**：`PUBLIC_SURFACE_DEBT` 与 `counts.json` 降低；钉着旧位置的用例随改；构造消费方的用例随入参更新；新增 RFC-565 用例并登记
  guard-manifest；补行为断言。
- **RFC-565-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-565-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 七个符号不再从任何 `public/*` 导出；两个装配根交出；全部模块的源码不再从别的 context 取它们
- [x] AC-2 行为不变；消费方的入参与 owner 的实现对得上，由编译器检查
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 删去 11 条，`public-surface-deviations` 56 → 45；新增 RFC-565 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 两格环境性红（macOS e2e 没有分到 runner），已归因、未重跑（见下）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `4f1dcae66` 加本 RFC 的路径，用本地提交固化，核对与工作树逐字相同），对照是同一 HEAD
的另一份导出。

- **本人缺陷一处（实现门通读时发现，已修复并复验）**：触发读 `createTaskTriggerQueries` 在构造时就按句柄取表。原先消费方每次调用现造一份，取表
  发生在调用时；改成 bootstrap 装配期建一次后，取表提前到了装配期——句柄没有绑定会话时，装配会比原来更早失败。首轮选集没有用例走到这种情形（全部
  通过），是读自己的改动时看出来的。改成各方法运行时取表；RFC-565 用例补 ⑤（四个读在没有绑定会话的句柄上也能构造、调用时才报错），变异 m12 验证
  它认得出。
- **覆盖补强**：蒸馏工作存储读事件正文这一跳原先只有“查不到返回空”的断言；`rfc359-w4-b4c-adapters` 补上带内容、带次序的断言（两种数据库），变异 m5
  验证它认得出。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 79 个 TS 文件（27 个生产文件、47 个用例文件、5 个测试助手）
  无告警，生产文件另过 promises 配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 1005 个（语义层 527、经夹具与测试助手补 478；只加导出行
  的两个装配根与只撤名字的三个 public 文件不按“被谁 import”扩选，撤掉的名字没有残留读者由 `tsc` 保证）。1005 个全部通过，用时 15.5 分钟（机器同时有
  一台虚拟机占着约 5 个核，负载 20～35）。上面那处修复之后，重跑取触发读、Webhook 装配、两个补了断言的用例与读 guard-manifest 的用例共 46 个文件，
  全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221；RFC-565 用例 9 / 9、
  `rfc294-architecture-preflight` 15 / 15、`rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24、
  `rfc317-guard-negative-fixture` 17 / 17、`rfc483-human-gate-badge-read-model-boundary` 7 / 7、`rfc551-public-unconsumed-sweep-lock` 11 / 11、
  `rfc395-o3-cross-context-closure` 4 / 4、`rfc317-table-ownership` 19 / 19。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：十二种变异都被认出——task-execution 的 public 重新交出触发读工厂、source-control 的 public
  重新交出仓库身份函数（两种都与 `rfc294-architecture-preflight` 同红）；memory 的注入读存储重新从装配根取工厂、integration 的保留清理重新 import
  片段（RFC-565 用例 ②）；蒸馏工作存储不再经任务知识读取事件正文（与 `rfc359-w4-b4c-adapters` 同红）；任务知识读的端口少了事件正文方法；事件正文
  换了次序、绑定后的仓库身份读不看入参（`rfc395-a7-owner-queries` 红）；绑定后的托管归属读查不到归属（`rfc423-port-bindings` 红）；bootstrap 不从
  装配根取片段；派发持久化不再问触发读（与 `rfc359-w4-b4b-adapters` 同红）；触发读在构造时取表（RFC-565 用例 ⑤）。另做一组类型层变异（仓库身份读
  的方法改名、保留清理片段多一个必填入参、托管归属读的行少了 `taskId`）：候选导出里 `tsc` 报 20 处，落在 bootstrap 的三处交接
  （`daemonModules/memory.ts`、`retentionSweepPhases.ts`、`crewstation.ts`）、测试助手与用例的构造处、RFC-565 用例的六条编译期断言。
- **架构报告**（候选与对照各出一份）：`public-surface-deviations` 56 → 45（删去的正是清单里那 11 条，没有换名的）；public 面 1000 → 993（撤 8 个、
  新增类型 `TaskDistillationEvent`）；未消费的 public 符号仍是 0；跨 context import 7536 → 7540；变更入口普查 2392 → 2394（两个新的 `create…` 函数）；
  目标边（111）、生产文件数与其余门、计数不变（integration 装配根那一处既有的分支只是行号后移）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `ff3442970`（实现，父提交是 `4f1dcae66`）：exact SHA 主 CI run 45423073198 的 70 个 job 里 67 个成功——全部后端分片、前端、构建与检查、另两个
  macOS e2e 分片（1/4、3/4）通过；`Playwright e2e (macos-latest shard 2/4)`（job 138549864917）与 `shard 4/4`（job 138549864736）被取消，汇总格
  `CI required` 随之不通过。同一提交触发的 windows-platform（run 45423073251）与 maintenance-soak-nightly（run 45423072759）通过。
- **归因**：不在本 RFC。两个被取消的 job 都没有分到 runner、没有任何步骤，注记是
  `The job was not acquired by Runner of type hosted even after multiple attempts`（附 macOS arm64 容量提示）；同一 run 里 macOS 的
  构建与另两个 e2e 分片通过。与 `docs/audit-backlog.md` 第九条下记的 macOS runner 容量形态相同。未重跑；后继提交的 CI 结果见 RFC-566 的 plan。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS（含上面那处已修复的缺陷）：

- **同一个句柄、同样的语句**：七处读原先由消费方拿自己的句柄去造，那个句柄就是它所在装配函数收到的 `db`；现在 bootstrap 用同一个 `db` 建好交入
  （`daemonModules/memory.ts`、`daemonModules/integration.ts`、`daemonApplication.ts`、`crewstation.ts` 各自就在把 `db` 交给消费方装配函数的那个调用
  旁边）。生产代码里没有一处消费方是在事务句柄上构造的。读的实现一行没改，只多了 `distillationEvents`（转给原函数）与两个绑定句柄的薄包装。
- **两个片段仍拼在同一条语句里**：保留清理的候选集与蒸馏范围的任务行读取，SQL 文本与参数次序不变（片段函数与调用它的表达式都是原来的）；`rfc311`
  的保留清理用例与 `rfc395-a3-oracle-query-cost` 的条数预算在选集里通过。
- **构造不碰句柄**：四个读在装配期构造时不取表、不发查询；触发读改成调用时取表后，同一句柄上每次取到的是同一份表（按句柄取）。
- **终态工作区清理策略**：入参从 `db` 换成触发读，归属查询读的还是 `workspaceAttribution(taskId)`；策略每次调用照旧重新读配置开关。
- **用例一侧**：注入读存储统一经测试助手构造（助手里的入参与 bootstrap 相同）；其余构造处补上的入参都建在该用例原先用的句柄上。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-563 的转 Done（CI 已全绿）、RFC-564 的转 Done 与它那格
环境性红的归因（含 `docs/audit-backlog.md` 的补记）同批。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
