# RFC-591 实施计划

依赖：RFC-590。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-591-T1 搬迁**：运行器逐字迁入 `platform/execution/local/gitProcess.ts`，`util/git.ts` 改从那里取（design §1）。
- **RFC-591-T2 读者**：全部从 `util/git` 取这五个名字的 import 改指新位置。
- **RFC-591-T3 门、用例与文档**：读源码的用例改读新文件；新增 RFC-591 用例并登记（design §2）。
- **RFC-591-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-591-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 五个名字只在新文件定义，`util/git.ts` 不再导出它们；新文件与原来那几段逐字相同
- [x] AC-2 没有 import 再从 `util/git` 取这五个名字；git 相关用例通过
- [x] AC-3 计数不升；DAG 之外的边不增加；新增 RFC-591 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `3f07d748a`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint（241 个 TS 文件）与 promises 配置（33 个 `src` 文件）无告警；改动的 TS、RFC 文档与 JSON 账本 prettier 通过。开发期的
  静态自查：`util/git.ts` 里只给运行器用的三条 import（`hardenGitArgs`、`platformSpawnOptionsForHost`、`raceWithFallback`）随之删掉。
- **逐字比对**（脚本）：新文件里的两段（`GitRunResult` 到 `nonInteractiveGitEnv`、`runGit` 到两个退出码）与 HEAD 的 `util/git.ts` 逐字相同。
- **读者**：236 个文件的 import 拆开、五个名字改取新位置（`@/` 别名与相对路径各按原样）；剩下两处“从 `util/git` 取 `runGit`”都在字符串夹具里
  （RFC-575 用例的同前缀负对照、RFC-515 用例的解析夹具），按原样保留。凭据相邻的 `repositoryMirrorCache.ts` 只改了 import 行。
- **候选导出**（候选已提交）：选出 542 个用例文件，541 个在候选导出里跑——4921 条里红 1 条，**本人缺陷**：`rfc287-t13-deferred-prep` 读 `util/git.ts`
  断言 git 输出被强制 C locale，那段随 `nonInteractiveGitEnv` 迁走了；改读新文件后在候选导出里复跑它与读 guard-manifest 的 23 个用例文件，全部通过。
  `rfc321`（要 git 历史）在主树里 10 / 10。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：五种都被认出——`util/git.ts` 重新转出运行器；测试 helper 从 `util/git` 取 `runGit`；运行器取模块；
  运行器丢掉加固参数；`util/git.ts` 重新 spawn git（RFC-591 用例与 `rfc284-spawn-site-ratchet` 都红）。复原后导出无残留。
- **架构报告**（候选对照 `3f07d748a`）：60 个计数全部不变；跨 context import 总数不变（7667），32 条模块 → legacy 的边由 `@/util/git` 一一换成
  `@/platform/execution/local/gitProcess`；任务自有效应清单里一条（延后准备的 `runGit` 来源）随之换名。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **逐字**：运行器与环境的代码一行未改——同一套加固参数、同一个非交互环境（含 C locale）、同样的超时 / 取消杀进程组与管道读取上限、同样的退出码。
2. **读者**：只换 import 的来源，调用一处未改；`util/git.ts` 自己的仓库操作照旧调 `runGit`（从新位置取）。
3. **依赖方向**：新文件只取 platform 与 `util/gitHardening`，platform 仍不依赖任何模块。
4. **留下的**：`repositoryMirrorCache.ts` 里一条注释还写着“见 util/git.ts 的 runGit”（凭据相邻文件，本 RFC 只改 import 行）；`util/git.ts` 余下的仓库语义
   下一步归 source-control（design §4）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
