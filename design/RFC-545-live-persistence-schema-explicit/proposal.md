# RFC-545 live 持久化 schema 由组合根显式交给 provider 构造（RFC-294 S12 第二十五步）

- **状态**：Done（2026-11-23，落地 `d204218c2`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 4 项（模块级可变单例）的第十二步；
  design §3 常驻规则 5、§14“模块级可变单例（生产态，bootstrap 外）0”。
- **前序**：[RFC-542](../RFC-542-persistence-handle-side-tables/proposal.md)（第 4 项第十步）；第十一步 RFC-543 撤回。

## 1. 背景

live 持久化 schema（各模块的表定义、两种引擎的原生表集与行规则错误码）由 bootstrap 组合（`bootstrap/persistenceSchema.ts`），platform 不能
import bootstrap，于是 bootstrap 在模块求值时调 `registerPersistenceSchema(...)` 把它写进 platform 的模块级变量
（`platform/persistence/schema/tables.ts` 的 `liveBinding`），platform 再经 `persistenceSchemaBinding()` 读：PostgreSQL 客户端构造时取原生表集与
行规则错误码，`tablesOf(handle)` 用它核对句柄绑的是不是 epoch-2 的表集。一旦哪条路径在 bootstrap 求值之前构造客户端或取表，就只能靠
import 顺序碰运气。架构报告的模块级可变单例清单里这个文件 2 条（全仓 48 条）。

## 2. 目标

- **G1 显式交给 provider**：删去 `liveBinding` 与登记 / 读取函数；bootstrap 导出冻结的 live 绑定常量；PostgreSQL 客户端构造与 provider 运行期的
  选项像已有的 `contract` 一样显式收下它，`tablesOf` 的 epoch-2 核对改看句柄绑定时交入的 live 绑定。
- **G2 结局不变**：两种引擎的客户端用的表集与行规则错误码不变；`tablesOf` 对 epoch-2 句柄返回原生表集、对 epoch-1 与没有 live 绑定的句柄
  照旧报“no epoch-2 table set”。
- **G3 门与用例**：新增 RFC-545 用例（文件没有模块级状态、删去的名字不在；客户端与 `tablesOf` 按交入的绑定工作；带负对照）；模块级可变单例
  48 → 46。

## 3. 非目标

- schema 历史运行时的登记（`schema/history/runtime.ts`，另立）与其余模块级可变单例。
- 表定义、行规则与 provider 选择逻辑不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`schema/tables.ts` 没有模块级状态；bootstrap 不再登记、只导出常量；客户端构造与 provider 运行期选项显式收下 live 绑定。
- **AC-2**：两种引擎的客户端与 `tablesOf` 的结局不变。
- **AC-3**：模块级可变单例 48 → 46、计数不升；新增 RFC-545 用例并登记 guard-manifest；读旧接口的用例随改。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
