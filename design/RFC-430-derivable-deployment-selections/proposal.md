# RFC-430 部署选择项删余下三个可派生项（RFC-294 S2c）

- **状态**：Done（2026-11-02 落档并实施；exact SHA `8c242c3fc` 主 CI 70/70、windows-platform 与 maintenance-soak-nightly 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你可以
  不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，无用户
  可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c 余项第 1 项的第三步
- **前序**：[RFC-428](../RFC-428-dead-deployment-selections/proposal.md)（[72 项盘点](../RFC-428-dead-deployment-selections/inventory.md)）、
  [RFC-429](../RFC-429-evidence-deployment-selections/proposal.md)
- **落位**：`bootstrap/`（选择项、应用装配、`crewstation.ts`）。

## 1. 背景

盘点里的可派生项还剩三个：

| 选择项                        | 托管的值                                         | 消费点                                        | 结论                                                 |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| `historyRestrictions`         | `createActiveHistoryRestrictionProvider()`       | `?? createActiveHistoryRestrictionProvider()` | 冗余：无状态（每次在调用方事务里查询），两个实例等价 |
| `resourcePackageSkillContent` | `skillContent.packageContent`（同一个 `skills`） | `?? skillContent.packageContent`              | 可派生                                               |
| `automationWorkspaceEffects`  | `actionWorkspaceEffects.contents`                | `?? actionWorkspaceEffects.contents`          | 可派生                                               |

## 2. 目标

- **G1 删除三项**：`DeploymentSelections` 与键表删去这三项（64 → 61；托管设置 64 → 61）。
- **G2 行为不变**：
  - 应用装配直接构造历史限制提供者；
  - 资源包的技能内容取 `skillContent.packageContent`；
  - 开发工作区的自动化内容由模块从动作工作区派生；
  - 托管值与这些派生值是同一对象，或是等价的无状态实例。
- **G3 托管只给需要的字段**：`crewstation.ts` 不再把资源内容与开发工作区两个装配结果整个展开进选择项，只取仍是选择项的字段。
- **G4 锁住删除**：RFC-428 结构锁的已退役清单加入这三项。

## 3. 非目标

- 单机默认值集中、改必填（inventory 后继第 2～4 步）。
- 模块级 API 与托管装配函数自身的返回形状。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三项不再是部署选择项或键表的键；托管选择项不再含它们；结构锁的已退役清单含这三项（含负例）。
- **AC-2**：托管键集合与键表 64 → 61；经测试入口注入或断言这三项的用例改为断言派生关系，断言的值不变。
- **AC-3**：既有资源包、开发工作区、历史限制与部署 profile 用例，以及 P0 变异 lane 全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **历史限制提供者各建各的**：它无状态，托管自己的人工门恢复照旧用本地实例，应用装配另建一个，不再经部署选择项传递同一实例。
2. **托管装配结果不整体展开**：展开会把非选择项字段带进选择项；逐字段取更清楚，托管键集合的锁也能逐项对账。
