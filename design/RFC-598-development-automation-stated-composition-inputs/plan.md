# RFC-598 实施计划

依赖：RFC-597。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-598-T1 装配入参**：三组效果选择必填、三个覆盖删去、`evidenceReadBinding.ts` 删去（design §1）。
- **RFC-598-T2 用例与助手**：测试助手给三组效果、证据内容覆盖改经 `evidenceArtifacts`、两个 RFC-370 锁与证据读取类型随改（design §1）。
- **RFC-598-T3 门与文档**：新增 RFC-598 用例并登记（design §2）。
- **RFC-598-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-598-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 装配入参没有可选成员；三组效果选择原样交给 `select*` 核对
- [x] AC-2 装配不读三个覆盖；`evidenceReadBinding.ts` 不在、无 import
- [x] AC-3 测试助手与此前的回落相同；计数都不升；新增 RFC-598 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `8cc1e0ff3`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（含 RFC-598 用例的编译期断言；删去的文件没有残留 import）；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**（候选导出）：按改动路径与名字选出，再加上读 guard-manifest / 计数的用例、遍历 development-automation 目录的扫描、两个改动的测试 helper
  在 `tests/` 内的传递闭包（调用装配的全部用例都经 `composeStandaloneDevelopmentAutomationSelections`），共 255 个用例文件，只有 `rfc321` 红（要 git 历史，
  导出里照例红；主树里 10 / 10）。文档定稿后（RFC 索引、`STATE.md` 与 RFC-294 plan 的条目）把读 guard-manifest / 计数 / `STATE.md` / RFC 文档 / RFC-294 的
  全部用例连同四个改动的用例在候选导出里复跑：347 个文件，只有 `rfc321` 照例红；读 STATE / RFC 索引 / RFC 文档的 7 个文件在主树 46 / 46。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：五种都被认出——自动化效果改回可选并从动作效果推出（RFC-598 用例与 `rfc370-evidence-artifact-root-bindings`
  都红）；尝试上下文的覆盖加回（RFC-598 用例与 `rfc370-attempt-context-root-wiring` 都红）；模块交出的内容读取不再取自 `evidenceArtifacts`
  （`rfc370-pipeline-evidence-content` 红）；测试助手的自动化效果不再是动作效果的 `contents`、助手忽略给出的基线效果（RFC-598 用例红）。另做一种类型检查变异
  （`repositoryBaselines` 改回可选）：`tsc` 在 RFC-598 用例的编译期断言处报 2 处。复原后导出无残留。
- **架构报告**（候选对照 `8cc1e0ff3`）：60 个计数都不变；生产文件少 1 个（`evidenceReadBinding.ts`），模块符号随之少 2 个；未消费 public 符号 0，public 面、
  public 类型偏差与跨 context import 不变。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **生产装配不变**：daemon 原本就给三组效果选择（自动化效果由 `selectDevelopmentWorkspaceEffectBinding` 推出后交入），装配照旧用 `select*` 核对，得到的
   对象与原来相同；三个覆盖生产从不给，删去后证据的读取、下载、文档与尝试上下文与原来一样取自 `evidenceArtifacts`。需求物化器不再收 `documents`，它在
   没给时本来就取 `evidence.documents`。
2. **用例**：测试助手的三组缺省与此前装配的回落逐一相同（动作效果是本机文件实现、自动化效果是它的 `contents`、基线效果是本机实现；给了的原样交出）；
   本机工厂没有树操作，事实扫描照旧走本机扫描。唯一的内容覆盖改经 `evidenceArtifacts` 给，文档与下载照旧是本机证据库。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
