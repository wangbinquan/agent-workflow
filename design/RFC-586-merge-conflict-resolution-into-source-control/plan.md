# RFC-586 实施计划

依赖：RFC-585。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-586-T1 搬迁与连接**：`services/mergeAgent.ts` 迁入 `SC/domain/mergeConflictResolution.ts` 并并入 `residualConflictMarkers`；`public/participants`
  交出三个模板函数；task-execution 的 composition 与 source-control 的隔离实现改取（design §1）。
- **RFC-586-T2 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例；新增 RFC-586 用例并登记 guard-manifest（design §2）。
- **RFC-586-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-586-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 旧路径不存在、没有说明符再解析到它；迁走的文件只改 import（另并入 `residualConflictMarkers`）；`util/git.ts` 不再有这个函数
- [x] AC-2 两个使用方拿到同一份函数；合并代理、冲突解析与判定的用例通过
- [x] AC-3 两个上限按实测收紧；未消费 public 符号保持 0；public 类型偏差不升；DAG 之外的边与跨 context 内部文件对不增加；新增 RFC-586 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `c17e1e7fe` 加本 RFC 的路径，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希相同），对照是同一
HEAD 的另一份导出。导出之后只改了收口文档（本文件与 `STATE.md`）；代码、用例、工作流与账本逐个文件比对，与候选相同。

- **钉点检索**（RFC-583 / RFC-584 的教训）：`pins.py` 覆盖 `src` / `tests` / `scripts` / `architecture` / `.github`，另查 `design/`、`docs/` 的 Markdown 链接，
  都没有指向旧路径的链接。搬迁脚本把三个用例里作为判据输入的字符串也改写了（`rfc487`、`rfc488` 与 RFC-585 用例的负对照），已还原——它们是判据的
  输入样例，不是真的 import。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 11 个 TS 文件无告警，生产文件（5 个）另过 promises 配置；
  prettier：改动的代码、JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 421 个用例文件，3480 条全部通过；其中 `rfc130-merge-agent` 12 / 12、`rfc130-merge-resolve` 6 / 6、
  `rfc130-iso-worktree-primitives` 11 / 11（含移入 domain 的冲突标记判定）、`rfc282-b2-resolve-injection` 6 / 6。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576～RFC-585 的清单），共 364 个文件、3614 条全部通过；其中 `rfc376-structural-guards` 221 / 221、RFC-586 用例 7 / 7、
  RFC-585 用例 9 / 9、`rfc487` 11 / 11、`rfc488` 13 / 13、`route-error-code-coverage` 4 / 4。`rfc321-repository-publication-ratchet` 在主树里跑（导出仓库
  没有原历史），10 / 10。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：五种都被认出——旧路径上重新出现一跳转出（RFC-586 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用 import 类型取旧路径（用例 ①）；domain 文件又取 git 模块（用例 ②）；冲突标记判定在别处
  又声明一次（用例 ③）；task-execution 改取 source-control 的 domain（用例 ④ 与 `rfc376-structural-guards` 的跨 context 内部文件对同红）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 63 → 62 与 `legacy-service-implementations` 3 → 2 变了；未消费 public
  符号保持 0；public 面 857 → 860（三个模板函数，由 task-execution 消费）；public 类型偏差 28、不可达生产文件 8、跨 context 内部文件对 6、模块分层
  违规 0、DAG 之外的已提供文件对 2 都不变。跨 context import 7643 → 7631：task-execution → source-control 的 offered-consumption 值边 17 → 20；
  task-execution → legacy 值边 714 → 711、source-control → legacy 的类型 / 值边各少 3、legacy → source-control 的类型边 44 → 38——原来经 `services/`
  这一跳的取用变成模块内或经 public。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **逻辑逐字不变**：迁走的文件只改了两处 import；`residualConflictMarkers` 逐字移入（正则不变）。冲突解析、二进制告警解析、清单、判定与提示词的
  用例全部通过。
- **两个使用方拿到同一份函数**：source-control 的隔离实现从本模块 domain 取；task-execution 的合并冲突端口从 source-control 的 public 取，RFC-586
  用例在运行时比对了三个模板函数的身份。
- **钉着旧路径的地方都随改**：归属表一行、`counts.json` 两个上限、取冲突标记判定的用例与一处说明注释；作为判据输入的字面量路径保持原样。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
