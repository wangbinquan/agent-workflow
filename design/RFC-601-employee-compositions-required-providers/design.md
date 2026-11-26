# RFC-601 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `18ddbc87e`。
生产行为不变。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：改动在 development-automation 的两个装配文件 `DA/composition/digitalEmployeeWorkspace.ts`、
  `DA/composition/digitalEmployeePlatformWorkItems.ts`：装配入参在继承 application 入参时把这 5 个成员换成必填。application 的入参、use case 与
  “未接入”分支不动——与 RFC-597 一样只收装配边界，按用例拆分必填端口另立。
- **为什么图交付的替身是“没有图设计”**：application 对每条发布路径都会调 `graphDelivery?.beforePublish(…)`、准备工作区时调 `repairMaterial(…)`；没给时
  前者跳过、后者没有材料。真实的图研发 MR 照看对没有图设计的案例正是“验证通过（`{ ok: true }`）、没有材料（`null`）”，用这个替身行为与此前相同；
  调用即抛错的替身反而会让每条发布路径都失败。
- **偏离项**：无。

## 1. 改动

- `DevelopmentEmployeeWorkspaceCompositionInput`：`Omit` 里加上 `graphDelivery`，另声明必填的 `graphDelivery`（类型取 application 入参同名成员去掉
  `undefined`）。
- `DevelopmentEmployeePlatformWorkItemsCompositionInput`：同样把 `approvalGateway`、`pipelineEvidence`、`graphDelivery`、`mrFacts` 换成必填。
- `T/helpers/developmentAutomation.ts`：新增 `graphDeliveryWithoutDesign()`（两个装配都能用：`beforePublish` 返回 `{ ok: true }`、`repairMaterial` 返回
  `null`）与 `unusedEmployeePlatformProviders()`（审批网关、流水线证据与 MR 事实的每个方法调用即抛出带名字的错误）。
- 调用两个装配、没给这些 provider 的用例：先展开替身再给自己用的；`rfc396-mr-lifecycle` 的“缺图验证绑定”夹具以一次类型断言复现那种输入（与
  RFC-597 对 P0 变异的做法相同），断言不变。

## 2. 门、用例与文档

- 新增 `T/rfc601-employee-compositions-required-providers-boundary.test.ts`，登记 guard-manifest：
  1. 两个装配入参接口里这 5 个成员都没有 `?`，且在 `Omit` 的键里（不再从 application 继承可选版本）；编译期断言它们是必填键（判据带负对照）。
  2. `graphDeliveryWithoutDesign()` 的两个回答与真实图照看对没有图设计的案例相同；`unusedEmployeePlatformProviders()` 给全 3 个 provider、每个方法被调用
     时抛出带名字的错误。
- 计数：预计都不变。

## 3. 失败模式

- **有人把 provider 改回可选、或 daemon 漏给**：`tsc` 报错，RFC-601 用例 ① 红。
- **用例走到了没给的审批 / 流水线 / MR 事实**：替身抛错，用例按真实错误失败，而不是静默停在“未接入”。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：provider 由 bootstrap 显式交入。**C12**：RFC-601 用例 ① 读两个装配文件，② 跑替身；调用方由 `tsc` 全量核对。**C13**：计数不升。

## 5. 留下的

- application 入参的可选 provider 与“未接入”分支（连同 `ReconcilerPorts`），按用例拆分时处理；`ReconcilerPorts` 一侧涉及 RFC-359 P0 指纹，须用户定。
