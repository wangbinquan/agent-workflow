# RFC-605 不透明身份引用改为带品牌的句柄，任务房间结果不再带事件引用（RFC-294 S9 余项）

- **状态**：Done（2026-11-26，落地 `170f3e2cc`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  收法由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S9；接
  [RFC-604](../RFC-604-public-contract-behaviour-types/proposal.md) 留下的“不透明身份引用 `object`”与 `CommittedEventRef`。

## 1. 背景

RFC-604 之后 `PUBLIC_SURFACE_DEBT` 余 19 条，其中 3 条：

- **不透明身份引用（2 条）**：
  - development-automation 的证据暂存命名空间与暂存引用。
  - integration 的适配器配置引用与程序引用。
  - 它们都带一个 `reference: object`：实现在铸造时给一个空对象，之后用它的身份做 `WeakMap` 的键、比对两个引用是不是同一个命名空间。消费方只携带、
    从不读它。检测器把 `object` 记为开放类型。design §3.3 对这类值的形态是“带品牌的 id”。
- **事件引用（1 条）**：task-execution 给 resource-catalog 的任务房间参与方，在恢复与判失败两个结果里带回 `CommittedEventRef`。
  - 平台的提交事件引用本该由事务属主在提交后用来催发投递。但 resource-catalog 从不读它，催发因此从未发生，事件靠持久投递（空闲时每秒一轮）送达。
  - design §3.3 要求结果不带事件，没有生产消费方的字段不公开。

## 2. 目标

- **G1**：平台新增一个通用的不透明身份句柄 `OpaqueIdentity<Tag>`：带品牌的对象类型，铸造函数 `mintOpaqueIdentity()` 返回一个冻结的空对象。它与平台日志器
  一样认作指定的平台合同接口（RFC-604 规则一的清单加一项）。
- **G2**：四个引用的 `reference` 改为各自 tag 的 `OpaqueIdentity`；所有铸造点改用 `mintOpaqueIdentity()`。运行期仍是同一种身份对象，`WeakMap` 与身份比对不变。
- **G3**：任务房间参与方的两个结果去掉 `eventRef`，实现不再返回它。事件照旧在同一事务里追加，照旧由持久投递送达。
- **G4**：这 3 条离开 `PUBLIC_SURFACE_DEBT`（19 → 16），`public-surface-deviations` 同步降到 16；其余计数不升。

## 3. 非目标

- 任务房间的提交后催发：要让 resource-catalog 在提交后催发，就得把平台的事件引用交给它，与 G3 相反。现状是持久投递约一秒内送达；需要更快时另议。
- 有限键映射类型与 `unknown` DTO，另立。
- 能力 / 凭据 / 身份一族，等 RFC-546。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：四个引用的 `reference` 是 `OpaqueIdentity`；铸造点都用 `mintOpaqueIdentity()`；`tsc` 通过，运行期行为不变。
- **AC-2**：任务房间参与方的结果不带 `eventRef`，消费方与用例不改断言。
- **AC-3**：`PUBLIC_SURFACE_DEBT` 去掉 3 条且逐条相等，计数降到 16；检测器对 `OpaqueIdentity` 放行、对 `object` 照旧记债（正反用例）。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
