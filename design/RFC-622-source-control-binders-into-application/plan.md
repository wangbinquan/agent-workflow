# RFC-622 实施计划

依赖：RFC-612、RFC-621（同一批账本文件，先发布 RFC-621）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-622-T1 迁移**：三个绑定器迁入 application，旧提交文件删除，模块根转出改指（design §1）。
- **RFC-622-T2 改指与锁**：读者按语法树改写；`rfc527` / `rfc521` / `rfc612` / `rfc475` 与计数（design §1）。
- **RFC-622-T3 门与文档**：新增 RFC-622 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 S10 注记（design §2）。
- **RFC-622-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-622-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 旧提交文件不在，绑定器只在 application，模块根从 application 转出，application 文件不越层
- [x] AC-2 没有文件再取旧位置
- [x] AC-3 计数 4 → 0；新增 RFC-622 用例并登记
- [x] AC-4 exact SHA CI 全绿

## 集中验证

候选导出 = HEAD `72d97076b`（RFC-621）+ 只含本 RFC 的路径（33 条）；`architecture/guard-manifest.json` 按「HEAD + 本 RFC 的一条」写入（工作树里带着 RFC-616 未提交的条目）。

- **静态**：backend `tsc --noEmit` 0 错；改动的 TS 文件 eslint（`--max-warnings=0`，另跑 promises 配置）0；prettier 全过。
- **用例第一轮**（改动路径的传递闭包 + 名字 + 全部架构与文档读者，445 个文件）：`rfc511` 红——它的组合文件清单还记着 `composition/repositoryCandidate` 交出两个绑定器、
  各分支一次、取完整性核对，两个核对的调用处也还记在组合层；按迁移后的形状更新（design §1）。`rfc321` 红：导出的本地 git 没有发布历史，环境性。
- **用例第二轮**（`rfc511` + 全部读设计文档与 `STATE.md` 的用例，155 个文件）：全过。
- **架构报告**（同一 HEAD 的对照导出 vs 候选）：计数只有 `composition-control-flow-source-control` 4 → 0；生产文件 +1（两个新文件、删一个）。
- **变异**（4 / 4 被抓）：旧提交路径放回一跳转出（RFC-622 ①）；组合层重新声明绑定器（RFC-622 ①）；application 绑定文件取组合层（RFC-622 ②）；
  组合层重新出现分支（`rfc612`、`rfc376` 的计数）。每次恢复后导出干净。

## CI（AC-4）

- 实现提交 `ade7e1dc1`：CI run 45893307751 全绿（70 / 70）。

## 实现门（本会话自审，只审功能）

检视口径：只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

- 三个函数逐字迁移：候选绑定器的函数体与原文相同，提交绑定器只把 `requireRepositoryGitWorkspaceScope` 改取它的定义处（组合层原先只是转出同一函数）。
- 模块根的三条转出改指新位置，bootstrap 与用例经模块根取到的是同一个函数（`rfc475` 断言两处是同一函数）。
- 结论：功能面无遗留问题。

## PR / 提交

一个提交：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交（另带 `docs/dev-gotchas.md` 一条更正）。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
