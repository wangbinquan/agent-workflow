# RFC-543 实施计划

依赖：RFC-542。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

**撤回（2026-11-23）**：集中验证查出前提不成立，见 design §9；以下任务与验收清单保留原样作记录，实现未提交。

## 任务

- **RFC-543-T1 只记在句柄上**：`sessionTables.ts` 删去 `contexts`，上下文只记在句柄与原生客户端自己的属性上，不可扩展的句柄明确报错，查找只读
  属性（design D1）。
- **RFC-543-T2 用例**：新增 RFC-543 用例并登记 guard-manifest（design D2）。
- **RFC-543-T3 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，另加全部用 `new Proxy(` 的用例与 `helpers/competingWriter` 的导入方（RFC-542 教训）；红的与 HEAD 同时 A/B（两边都撞写死
  时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-543-T4 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十一步。

## 验收清单

- [ ] AC-1 `sessionTables.ts` 没有模块级集合；上下文只记在句柄与原生客户端自己的属性上
- [ ] AC-2 各种句柄取到的上下文不变；不可扩展的句柄在构造时明确报错
- [ ] AC-3 模块级可变单例 48 → 47、计数不升；新增 RFC-543 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本 RFC 撤回（design §9），以下是撤回前的集中验证。验证在候选导出仓库里跑（HEAD `4db5b0f3a` 加本 RFC 的 3 个代码路径，核对与工作树逐字
相同），对照是同一 HEAD 的另一份导出。

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0` 与 promises 配置无告警；prettier 通过。
- **选择**：按 RFC-533 的口径从 2,988 个用例文件里选出 1,951 个；语义层 161 个（改动的 1 个用例、全部 `tests/architecture/`、语料守卫、在 import
  之外以路径点名被改文件的 5 个、点名句柄上下文 API 的 17 个），另加 RFC-542 的代理清单共 217 个；`sessionTables.ts` 的约 940 个导入方（为
  `tablesOf`）只经 import 闭包入选。
- **语义层**（60 秒；候选 5 个 worker）：217 个文件里 7 个红。`rfc395-session-table-binding` 的两条冻结句柄用例与 `rfc395-target-test-database` 的
  PostgreSQL 支 7 条都报 `persistence-handle-not-extensible`——由本 RFC 引入，即 design §9 的结论；其余 5 个是写死时限的超时（`rfc376-report`、
  `rfc395-neutral-query-boundary`、`rfc395-v1-frozen-source`、`rfc400-collaboration-task-participants`、`rfc395-v3-source-access`），本 RFC 撤回，
  未再归因。
- **变异验证**：五种变异（只读客户端、不给客户端记、登记表回来、不可扩展时静默跳过、继承时复制上下文）各自让 RFC-543 用例红。
- **架构报告**：模块级可变单例 48 → 47 只在撤回前的候选上成立；撤回后 HEAD 不变（48）。

## CI（AC-4）

- 不适用：实现撤回、未提交。
- 本 RFC 的落档提交 `b3181fc02`（只改文档；同一提交记下 RFC-542 转 Done）：主 CI run 45140254130 的 70 个 job 第 1 次全部通过。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-542 转 Done）；实现与验证后再提交
`refactor(backend): RFC-543 数据库句柄上下文只记在句柄上（RFC-294 S12 第二十四步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。

撤回后不再有实现提交：落档提交 `b3181fc02` 之后只有一个记撤回的文档提交。
