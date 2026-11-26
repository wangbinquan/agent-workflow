# RFC-620 实施计划

依赖：RFC-619（同一批账本文件，先发布 RFC-619）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-620-T1 拆分迁移**：合同进 `platform/contracts`，实现进 `platform/crypto`，旧文件删除（design §0）。
- **RFC-620-T2 改指与账本**：读者按语法树改指；owner 表、commons 内核清单与计数（design §1）。
- **RFC-620-T3 门与文档**：新增 RFC-620 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 W9-D 注记（design §2）。
- **RFC-620-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-620-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 旧位置不在，合同与实现在新位置，没有读者取旧位置，application 不取实现
- [x] AC-2 实现逐字迁移，既有用例照旧通过
- [x] AC-3 计数 45 → 44；新增 RFC-620 用例并登记
- [ ] AC-4 exact SHA CI 全绿

## 集中验证

候选导出 = HEAD `2b4eee088`（RFC-619）+ 只含本 RFC 的路径（171 条）；五个带着 RFC-616 未提交改动的读者文件按「HEAD + 本 RFC 的一行 import」写入（见下“并发”）。

- **改写**：按语法树改写（只认模块说明符），先在对照导出上演练一遍，改到的 156 个文件与正式改写逐个一致；没有 `mock.module`、动态 import 或 re-export 取旧位置。
- **静态**：backend `tsc --noEmit` 0 错；161 个改动的 TS 文件 eslint（`--max-warnings=0`，另跑 promises 配置）0；prettier 全过。
- **用例**（改动路径的传递闭包 + 名字 + 全部架构与文档读者，798 个文件）：除下面两条外全过。
  - `rfc167-dynamic-workflow-engine` 一条在机器负载 ~85 时红（任务在等待窗口内没走到 `failed`）；同一时刻在对照导出（不含 RFC-619 / 620）里同样红，与 RFC-619 集中验证时
    同一情形（负载回落后通过）——与本 RFC 无关，按时序敏感记录，以 CI 为准。
  - `rfc321` 红：导出的本地 git 没有发布历史，环境性。
- **架构报告**（同一 HEAD 的对照导出 vs 候选）：计数只有 `legacy-horizontal-files` 45 → 44；生产文件 +1（一拆二）。
- **变异**（4 / 4 被抓）：`auth/secretBox.ts` 放回一跳转出（RFC-620 ①、`rfc376`）；用例重新取旧位置（RFC-620 ①②）；application 改从实现取类型（RFC-620 ③）；
  实现文件重新声明接口（RFC-620 ①）。每次恢复后导出干净。
- **并发**：`bootstrap/daemonApplication.ts`、`bootstrap/daemonHttpComposition.ts`、`bootstrap/daemonModules/integration.ts`、`T/rfc381-daemon-integration-bundles.test.ts`、
  `T/rfc383-daemon-employee-automation-bundles.test.ts` 在共享工作树里带着 RFC-616 未提交的改动（不涉及 import 行）。工作树里只改了本 RFC 的那一行 import；提交时在发布锁里
  按「`origin/main` 上的该文件 + 同一行替换」重建、与导出逐字比对后提交，不带入它的在制品。

## CI（AC-4）

待推送。

## 实现门（本会话自审，只审功能）

检视口径：只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

- 实现文件与 HEAD 原文对比：只少了接口声明、多了一行取合同的 `import type`；常量、密钥文件的读写与权限、加解密逻辑逐字不变。
- 读者改动只有 import：156 个文件的语法树改写在对照导出上演练过；混合 import 拆成两条后语义不变（类型与值各取其来处）。
- commons 内核清单、owner 表与计数随之改；用例侧没有按路径读旧文件的锁（改写前后的全量搜索与 798 个用例都确认了）。
- 结论：功能面无遗留问题。

## PR / 提交

一个提交：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
