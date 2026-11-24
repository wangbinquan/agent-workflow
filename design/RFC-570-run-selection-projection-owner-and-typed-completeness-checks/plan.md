# RFC-570 实施计划

依赖：RFC-569。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-570-T1 投影归位**：task-execution 的 domain 新增类型文件，三个读者改取；resource-catalog 声明自己的形状；删平台文件（design §1）。
- **RFC-570-T2 完整性检查**：两个函数的签名（design §2）。
- **RFC-570-T3 门与用例**：`PUBLIC_SURFACE_DEBT` 与 `counts.json` 降低；`rfc511` 随改；新增 RFC-570 用例并登记 guard-manifest。
- **RFC-570-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-570-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 平台文件不存在、全部源码不取它；投影在 task-execution 的 domain，resource-catalog 用自己的形状
- [x] AC-2 两个完整性检查收具名类型，拒绝行为不变
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 删去 3 条，`public-surface-deviations` 35 → 32；新增 RFC-570 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `412767ff0` 加本 RFC 的 16 个路径，含一个删除，用本地提交固化，树哈希与“HEAD 加这些
路径”的树哈希相同），对照是同一 HEAD 的另一份导出。

- **集中验证没有查出产品缺陷**。写用例时的一处自查：RFC-570 用例起初断言 `workspacePorts.ts` 整份文件里没有 `unknown` 与 `asserts`，而同一文件里
  还有一个不在清单上的 `requireRepositoryGitWorkspaceScope`（只在 source-control 内部用）保持原样；断言改为只看本 RFC 改的两个函数。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 10 个 TS 文件（6 个生产文件、4 个用例文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 359 个用例文件（语义层 189、经夹具与测试助手补 170；
  只改类型或 import 路径的五个生产文件与被删的平台文件不按“被谁 import”扩选），一次全部通过（3238 条）。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部 142 个用例文件、`rfc317-*` / `rfc294-*` 与钉着本次改动位置的边界
  用例，共 165 个文件、1575 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-570 用例 8 / 8、
  `rfc294-architecture-preflight` 15 / 15、`rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24、
  `rfc317-guard-negative-fixture` 17 / 17、`rfc511-source-control-port-completeness-checks-out-of-composition-boundary` 13 / 13、
  `rfc370-isolation-workspace-scope` 5 / 5、`rfc374-node-run-order-guard` 6 / 6、`rfc411-workgroup-turns-engine` 3 / 3、
  `rfc217-architecture-locks` 18 / 18。
- **变异验证**（候选导出仓库里，每种变异复原后导出仓库无改动、树哈希不变）：十一种变异都被认出。
  - 归属：把投影重新声明在 platform 并让 public 合同取它、房间投影改取 owner 的类型（都是 RFC-570 用例与 `rfc294-architecture-preflight` 同红）；
    房间自己的形状多声明一个没读的字段、task-execution 里出现第二份投影声明（RFC-570 用例 ②）。
  - 完整性检查：两个函数各自退回 `unknown` 加断言（用例 ③ 与 `rfc294-architecture-preflight` 同红）；隔离作用域的检查漏掉一个方法、上传内容的
    检查放过残缺的接收者、拒绝时换了消息（用例 ④ 与 `rfc511` 同红，最后一种 `rfc370-isolation-workspace-scope` 也红）。
  - 房间投影的行为：宿主运行按选择序号倒序排（`rfc179-member-current-run` 与 `rfc374-node-run-pickers` 红）、预算投影不再剔除被取代的账本行
    （`rfc209-round-ledger` 与 `rfc395-a3-sites-b` 红）。
  - 类型层：把 owner 投影的 `sequence` 改成字符串、给隔离作用域的检查加一个必填入参，候选导出里 `tsc` 报 25 处、11 个文件——resource-catalog 的
    两个房间适配文件（task-execution 的行交进房间投影的交接处，4 处）、task-execution 算投影的那一处、检查的两个调用点，以及 6 个用例文件（含
    RFC-570 用例的 7 处）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `public-surface-deviations` 变了，35 → 32（删去的正是清单里那 3 条，隔离工作区合同里的
  日志器与函数类型条目的归属没有移动）；public 面的符号数（989）、变更入口普查（2393，逐条相同）与生产文件数不变（删一个平台文件、加一个 domain
  文件）；跨 context import 7532 → 7528（少的是 task-execution 的三处与 resource-catalog 的一处对那个平台文件的类型引用）；其余各节不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **投影的内容没变**：四个字段与注释原样搬到 task-execution 的 domain；算它的 `projectWorkgroupRunSelections` 与两处使用它的合同只改了 import。
- **房间投影读到的值没变**：这个文件只读 `selection.sequence`（宿主运行的先后、候选与现任的比较）与 `selection.legacyGroupCurrent`（预算投影剔除
  被取代的行），自己的形状声明的就是这两个字段；task-execution 交来的行带完整投影，结构上可赋值，交接处没有改动。
- **完整性检查的判定没变**：方法清单、`null` / 非对象的判断与抛出的 `TypeError` 都原样；只是入参有了类型，函数体里两处多余的类型断言随之去掉。三个
  调用点传的值本来就是端口类型，不需要 `asserts` 带来的收窄。
- **用例一侧**：故意传残缺对象的五处调用标注 `as never`（同文件里对 `…Factory` 检查早就这样写）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-569 的主 CI 在本提交时仍在跑，它的转 Done 随后一个提交。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
