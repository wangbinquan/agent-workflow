# RFC-604 实施计划

依赖：RFC-569（函数类型成员改写为方法签名的先例）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的
静态自查。

## 任务

- **RFC-604-T1 检测规则**：规则一（平台日志器是合同接口）与规则二（方法参数里的回调算闭合）（design §1）。
- **RFC-604-T2 类型改写**：7 处输入成员改为方法签名（design §2）。
- **RFC-604-T3 账本与计数**：`PUBLIC_SURFACE_DEBT` 去掉 8 条，`public-surface-deviations` 27 → 19（design §3）。
- **RFC-604-T4 门与文档**：新增 RFC-604 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 S9 注记（design §4）。
- **RFC-604-T5 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-604-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两条规则各有正反用例，其他平台类型与属性 / 返回值位置的函数类型照旧记债
- [x] AC-2 7 处成员改为方法签名，调用方不改
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 去掉 8 条且逐条相等；计数降到 19
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `0f2ded0db`（RFC-603）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（7 处改写的调用方不改）；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：
  - 范围：在候选导出里，按改动路径与名字选出，再加上读 guard-manifest / 计数 / `STATE.md` / RFC 文档的用例与遍历 source-control、
    runtime-management 目录的扫描，共 872 个用例文件，4 个红。
  - `rfc321`：要 git 历史，导出里照例红。
  - `rfc167-dynamic-workflow-engine`：6 个并发进程下的时序红，单跑在候选与干净的 `0f2ded0db` 控制导出里都通过；本 RFC 不改运行期代码。
  - 本 RFC 的 2 个是负对照钉住了新规则放行的写法：
    - `rfc475-commit-push-owner-split` 用 `Logger` 证明检测器认得出平台类型，改为 `PersistenceTx`。
    - `rfc552-public-operations-exemption-lock` 的非描述工厂负对照预期回调参数记债，改为只预期它的 `unknown` 输入。这照旧说明那个声明被检查、没有被跳过。
  - 改后复跑这 2 个与 RFC-604 用例、preflight、`rfc376-report`、`rfc479-governance-gap-fill`，共 6 个文件全绿。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：
  - 被认出的 5 种：规则一放宽到持久化句柄、规则二放宽到属性、去掉规则二、去掉规则一、`runAgent` 改回函数类型属性。RFC-604 用例都红，前两种以外
    preflight 也红。
  - 未被认出的 1 种是设计如此：`counts.json` 的 max 留在 27，`rfc479-governance-gap-fill` 照旧绿。RFC-294 design §13.4 允许计数低于 max，只报告；
    降 max 是后继收口时的约定（C13），本 RFC 照做。
- **架构报告**（候选对照干净的 `0f2ded0db`）：
  - `public-surface-deviations` 27 → 19，`publicSurfaceDeviations` 正好少这 8 条。
  - 四个 public 面的报告预算里方法数各加 1～2：属性改成了方法签名。这只记在报告里，不是门。
  - 其余相同。

## CI（AC-4）

待推送。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **生产行为不变**：只改检测规则（测试代码）与七个成员的写法，运行期代码没有变化。调用方传的对象字面量、被调方的调用写法与回调时机都不变。
2. **规则不放过它不该放过的**：规则一只认一个具名接口；规则二只认参数位置，回调自己的参数与返回类型照旧逐个检查。正反用例与五种变异都对得上。
3. **账本**：`PUBLIC_SURFACE_DEBT` 与检测结果逐条相等，计数随之降到 19。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
