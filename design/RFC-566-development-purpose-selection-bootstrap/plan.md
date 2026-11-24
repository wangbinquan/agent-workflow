# RFC-566 实施计划

依赖：RFC-565。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-566-T1**：四个研发用途选择接口声明到 bootstrap 的 `developmentPurposeRoot.ts`；development-automation 的装配根、两个装配文件与交付 provider
  不再取 integration 的 public，流水线执行面改用本模块的 `SelectedPipelineEvidenceRunnerPort`；integration 的 public 撤出
  `SelectedPipelineEvidenceExecution`（design §1）。
- **RFC-566-T2 门与用例**：两份精确清单与 `counts.json` 降低；钉着旧位置的用例随改；新增 RFC-566 用例并登记 guard-manifest。
- **RFC-566-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-566-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 development-automation 的全部源码不取 integration 的 public；四个用途选择接口只声明在 bootstrap
- [x] AC-2 行为不变；integration 的流水线执行面仍交得进 development-automation 的端口，由编译器检查
- [x] AC-3 DAG 外 offered 边 4 → 2；清单与减速带随之更新；新增 RFC-566 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本 RFC 的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `ff3442970` 加本 RFC 的路径，用本地提交固化，核对与工作树逐字相同），对照是同一 HEAD
的另一份导出。

- **本人缺陷三处（已修复并复验）**：① 漏查一个钉着旧位置的用例——`rfc471-development-delivery-code-host-bridge` 钉着“交付 provider 只取 integration 的
  public”，选集运行里红；改成断言它与另两个文件都不取 integration，并留一条正对照（同一读法认得出它取的本模块端口）。② RFC-566 用例里给
  development-automation 装配根的导出名数写了一个没有量过的下限（40，实际 35），选集运行里红；改成 30。③ 变异 m6 没被认出：用例对交付 provider 的
  `pipeline` 字段只做子串匹配，类型被放宽成“端口或 undefined”仍然通过；改成整行匹配、三处 `readonly pipeline` 逐行钉住，另加两条方向相反的编译期
  断言（provider 的入参与产物上的 `pipeline` 就是这个端口），复跑六种变异全部认出。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 14 个 TS 文件（9 个生产文件、5 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 363 个（没有经夹具与测试助手补的；本 RFC 的生产改动全在
  类型位置——接口声明、类型 import 与入参标注——只换声明处的装配根、public 与 bootstrap 文件不按“被谁 import”扩选）。首轮 361 个通过，2 个红就是
  上面 ① ② 两处；修正后这两个用例连同读 guard-manifest 的用例共 27 个文件全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221；RFC-566 用例 8 / 8、
  `rfc294-review-offered-edge-dag` 8 / 8、`rfc294-architecture-preflight` 15 / 15、`rfc317-guard-corpus-floor` 24 / 24、
  `rfc317-guard-negative-fixture` 17 / 17、`rfc471-development-delivery-code-host-bridge` 17 / 17、RFC-565 用例 9 / 9。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：六种变异都被认出——交付 provider 重新点名 integration 的 public 类型、装配文件用类型位置的
  `import('…')` 取 integration 的类型（两种都与 `rfc376-structural-guards`、`rfc294-review-offered-edge-dag` 同红）；development-automation 的装配根
  重新声明一个用途选择接口；integration 的 public 重新交出流水线执行类型；部署档案重新从 development-automation 的装配根取用途选择；交付 provider 的
  `pipeline` 不再只是这个端口。另做一组类型层变异（development-automation 的端口多要一个字段、bootstrap 的流水线用途选择不再继承适配绑定）：候选导出
  里 `tsc` 报 18 处，落在 bootstrap 的四个文件（`crewstation.ts`、`daemonApplication.ts`、`daemonModules/repositoryCredentials.ts`、
  `developmentPurposeRoot.ts`）、六个既有用例与助手、RFC-566 用例的四条编译期断言。
- **架构报告**（候选与对照各出一份）：`off-dag-offered-file-context-pairs` 4 → 2；public 面 993 → 992（integration 撤一个类型）；跨 context import
  7540 → 7531；未消费的 public 符号（0）、public 类型偏差（45，条目相同）、目标边（111）、生产文件数、变更入口普查（2394）与其余门、计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **只换类型的声明处**：九个生产文件里没有一行可执行代码变化。四个用途选择接口原文搬到 bootstrap（成员、继承关系与注释不变），读它们的三个 bootstrap
  文件只换 import 的来处；development-automation 的三个文件只把入参与字段的类型标注从 integration 的执行类型换成本模块的端口。
- **绑定仍然成立**：bootstrap 交给 development-automation 的还是 integration 的 `composeSelectedPipelineEvidenceRunnerFor(...)` 的结果，它能赋给本模块的
  端口（`createSelectedPipelineEvidence` 原先收的就是这个端口，装配文件只是转交）；类型层变异验证过形状对不上时会报错。
- **integration 的 public 少一个类型不影响读者**：模块外原先的读者只有 development-automation 的两个文件与一个用例；前者改用本模块的端口，后者改从
  定义处取。integration 自己的装配与实现照旧从定义处取。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。RFC-565 的 CI 仍在跑，它的转 Done 随后续提交。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
