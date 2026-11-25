# RFC-592 实施计划

依赖：RFC-591。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-592-T1 查询归 platform**：两个查询逐字迁入 `platform/workspace/local/gitQueries.ts`，读者改指新位置（design §1）。
- **RFC-592-T2 回滚绑定**：`TaskExecutionParticipantBindings` 多一项回滚函数，执行器经它回滚；装配根与用例的绑定给出实现。
- **RFC-592-T3 门、用例与文档**：新增 RFC-592 用例并登记（design §2）。
- **RFC-592-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-592-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个查询只在新文件定义，`util/git.ts` 不再导出它们；新文件与原来那两段逐字相同；没有 import 再从 `util/git` 取它们
- [x] AC-2 collaboration 与 runtime-management 不 import `util/git`；执行器经绑定里的回滚函数回滚；评审回滚与沙箱放行的用例通过
- [x] AC-3 计数不升；DAG 之外的边不增加；新增 RFC-592 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 的一格红已归因为环境性（见「CI」）

## 集中验证

基于 `992ae6140`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint（15 个 TS 文件）与 promises 配置（12 个 `src` 文件）无告警；改动的 TS、RFC 文档与 JSON 账本 prettier 通过（拆 import
  时 `nodeIsolation.ts` 留下一行没排版，已补排，差异只在 import）。
- **逐字比对**（脚本）：新文件里的两段与 HEAD 的 `util/git.ts` 逐字相同。读者 6 个（runtime-management 两个、collaboration 的检查器、task-execution 的
  节点回滚、source-control 两个），只改 import。
- **候选导出**（候选已提交）：选出 595 个用例文件，594 个在候选导出里跑——5521 条里红 1 条，**本人缺陷**：`rfc377-util-git-leaf-lock` 的叶子清单没收
  新文件（RFC-591 收了运行器、这一步漏了查询文件），已补。改正之后在候选导出里复跑它、RFC-592 用例与读 guard-manifest 的全部用例（26 个文件），其中
  `rfc317-guard-corpus-floor` 又认出一处：随本提交一起修的 RFC-590 遗留缺陷（见下）把一个守卫的语料下限调低了，账本要同步记下——已在 guard-manifest 里
  改为 3 并写明理由；再复跑 26 个文件全部通过。`rfc321`（要 git 历史）在主树里 10 / 10。
- **随本提交修的 RFC-590 遗留缺陷**：`3f07d748a` 与 `992ae6140` 的主 CI 后端第 16/44 片都红在 `rfc317-runtime-spawn-capability-guard`——它把
  “`routes/` 的文件加一个显式列入的应用文件”合计要求 `> 10`，RFC-590 把 `routes/` 缩到 9 个就红了（按名字选用例选不到它）。改为单独证明 `routes/` 的枚举
  非空；本机以 SQLite 跑该文件 7 / 7。通用教训记入 `docs/dev-gotchas.md`（挪文件前的检索一节）。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：五种都被认出——`util/git.ts` 重新转出一个查询；评审门回滚执行器重新取 `util/git`；runtime-management
  重新从 `util/git` 取 `gitMetaDirsFor`；装配根的绑定换成空函数；执行器不再调绑定里的回滚。复原后导出无残留。
- **架构报告**（候选对照 `992ae6140`）：60 个计数全部不变；跨 context import 7667 → 7666（collaboration 的执行器不再取 `util/git`）；public 面不变。

## CI（AC-4）

- `12d8cfb6c`（实现）：exact SHA 主 CI run 45669279496 的 70 个 job 里 68 个成功——全部后端分片（含修 RFC-590 那条下限的第 16/44 片，828 条全过）、真实
  PostgreSQL、前端、三个平台的构建与检查、e2e；同 SHA 的 windows-platform、git-protocols-e2e、integration-opencode 与两个夜间 workflow 都通过。
- 没过的两格是同一件事：后端第 41/44 片的 `rfc398-start-auto-upgrade-takeover`（“N acquires after takeover”）在 184.8 秒时报 barrier / readiness 超时（子进程
  输出不是完整的 JSON），CI required 因它而红。归因：环境性（时序），不是本提交引入——同一文件的另一个次序（before）在同一次运行里通过，多进程接管用例
  平时 26～29 秒跑完；本提交没有改到接管与升级路径。后继证据：RFC-593 的提交 `f48df41c2`（以本提交为祖先、本提交的内容原样保留）的 run 45678070550 里第
  41/44 片 1349 条全部通过，这条用例两个次序分别 29.0 秒、26.3 秒通过。没有改测试、没有重跑。2026-11-25 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **逐字**：两个查询的代码一行未改；`util/git.ts` 的 `rollbackToSnapshot` 照旧先查快照在不在（改从新文件取 `gitCommitExists`）。
2. **回滚**：执行器逐个目标调的仍是同一个 `rollbackToSnapshot`（装配根的绑定给出它），成功 / 失败的回执、写信号量与计划校验不变；collaboration 的快照检查器
   与它的默认实现只换了 `gitCommitExists` 的来源。
3. **装配**：生产与用例的绑定都给出了实现（类型要求它，tsc 0 错）；`composeGateContinuationSupport` 的输入形状不变，调用方未改。
4. **随本提交修的 T71 下限**：只把 `routes/` 枚举的非空检查与合计拆开，棘轮扫的文件集合与 spawn 站点检查不变。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
