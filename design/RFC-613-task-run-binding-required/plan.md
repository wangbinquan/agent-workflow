# RFC-613 实施计划

依赖：RFC-526、RFC-527。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-613-T1 合同**：绑定必填，选择分支删去，桥接导出（design §1）。
- **RFC-613-T2 测试助手**：旧直绑迁入 `tests/helpers/legacyTaskRunDriveBinding.ts`，助手与用例改从它取；接收者用例改写（design §0 裁定三）。
- **RFC-613-T3 门与文档**：两条源码锁随之改；计数 10 → 9；新增 RFC-613 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 S12 注记（design §2）。
- **RFC-613-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-613-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 绑定必填，文件无控制流，`src/` 无旧直绑
- [x] AC-2 用例经测试助手照旧通过
- [x] AC-3 计数 10 → 9；新增 RFC-613 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（后继证据，见下）

## 集中验证

基于 `1d4faeac5`（RFC-612）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（含编译期断言）；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径的传递闭包与名字选出，再加上 `tests/architecture/` 全部、读 guard-manifest / 计数 / `STATE.md` / RFC 文档
  的用例与遍历 task-execution 目录的扫描，共 715 个用例文件。
  - **查出一处本人缺陷**：`rfc510` 红——它逐字钉着装配处那次 `requireTaskRunDriveBinding` 调用的实参（原来是 `selected`，现在直接取
    `input.taskRunBinding`）。按新实参改了钉值，复验通过。
  - 另一个红是 `rfc321`（要 git 历史，导出里照例红）。
  - 集中验证时把 RFC-613 用例的合同断言加强为同时核对 `taskRunBinding` 不带问号（初版只核对是接口，可选成员只能靠 `tsc` 看出）；
    改后与 `rfc510`、`rfc317` 账本、`rfc376` 结构锁一起复验通过。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：4 种都被认出。
  - 绑定改回可选、`src/` 里放回旧直绑、不再核对给定的绑定：RFC-613 用例红。
  - 加回选择分支：RFC-613 用例与 `rfc376-structural-guards` 同时红（计数超过 max 9）。
- **架构报告**（候选对照干净的 `1d4faeac5`）：`composition-control-flow-task-execution` 10 → 9；这个文件的导出随之变化；只报告、无门禁的
  `mutationEntrypoints` 多一条（导出的桥接，它的配置引用登记请求）。其余有门禁的计数不变。

## CI（AC-4）

- `0339842ab`（实现）：exact SHA 主 CI run 45803731041 结论 failure，后端各格全绿，红在两格 e2e，都是等任务到达某个状态超时：
  - Windows shard 2/4：`e2e/clarify.spec.ts:274` RFC-023 澄清主路径（同一格另有两条标记为 flaky）；
  - macOS shard 1/4：`e2e/rfc294-webhook-runtime-failures.spec.ts:619` opencode 运行时超时一族（重试一次仍超时）。
  - 本 RFC 不改生产行为（两种部署的 bootstrap 一直给驱动绑定，那一支逐字不变），e2e 跑的正是生产装配；上一个提交 `1d4faeac5` 的 run 里同几格 e2e 全绿。
    原因未查实，未重跑。Windows 平台 run 45803731038 与快速反馈 run 45803731064 全绿。后继证据：包含本提交的 `6c92e2be2`（RFC-615）run 45846353277 第 2 次尝试 70 / 70 全绿（第 1 次尝试只有 macOS e2e 3/4 一格在 36 分钟后被取消、日志已不可取，没有失败的用例作业）。2026-11-26 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **生产路径不变**：两种部署的 bootstrap 都给绑定；原来给绑定时的那一支（核对后原样使用）就是现在的全部行为。
2. **单机选择不变**：`composeLocalTaskRunSelection` 用的还是同一段桥接，只是改为导出、换了名字。
3. **用例**：旧直绑在助手里逐行照旧（每次驱动现绑 prompt → archive → Agent → script）；只有工厂的接收者从 provider 运行期的入参变为助手的入参，
   全仓只有一条用例断言过它，已改写为核对每次驱动的调用顺序与内容归属。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
