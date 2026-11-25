# RFC-599 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `e98136958`。
行为不变。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：改动在 development-automation 的两个装配文件 `DA/composition/digitalEmployeeWorkspace.ts`、
  `DA/composition/digitalEmployeePlatformWorkItems.ts`。单机部署的选择照旧在 bootstrap（`daemonModules/digitalEmployee.ts` 交入部署选择里的自动化效果与
  基线效果）；本机实现照旧在 infrastructure，用例直接调它们。
- **为什么不顺带收继承来的可选 provider**：它们与 RFC-597 同类（没给 = 业务层的“未接”分支），且有用例按“没给”断言（`rfc396-mr-lifecycle` 的
  门缺失、`rfc323` 只给流水线证据），要逐条定替身或改断言，另立。本 RFC 只收 S12 一类的本机回落。
- **偏离项**：无。

## 1. 改动

- `DevelopmentEmployeeWorkspaceCompositionInput.automationWorkspaceEffects` 去掉 `?`；装配照旧 `selectedAutomationWorkspaceEffects(input.automationWorkspaceEffects)`
  （只核对完整性）。
- `DevelopmentEmployeePlatformWorkItemsCompositionInput.automationWorkspaceEffects`、`repositoryBaselines` 去掉 `?`；装配照旧核对自动化效果，基线读取照旧
  `createGitBaselineReader(…, input.repositoryBaselines)`。
- 两个文件头注释写明效果选择由调用方给出。
- 用例：调用这两个装配的 9 个用例文件里，没给的调用点（含三处先建入参对象再交入的）显式给出 `createFileAutomationWorkspaceEffectsFactory()`，平台工作项另给
  `createFileRepositoryBaselineEffectsFactory()`——与此前 `select*` 的回落相同；已经自己给自动化效果的两处不动。

## 2. 门、用例与文档

- 新增 `T/rfc599-employee-compositions-stated-effects-boundary.test.ts`，登记 guard-manifest：
  1. 两个装配入参接口里这三个成员都没有 `?`；编译期断言它们是必填键（判据带负对照）。
  2. 两个装配文件里对 `input.automationWorkspaceEffects` / `input.repositoryBaselines` 的读取只是 `selectedAutomationWorkspaceEffects` / `createGitBaselineReader`
     的实参，都不在条件或回落里（判据带负对照）。
- 计数：预计都不变。

## 3. 失败模式

- **有人把效果选择改回可选、或在装配里加回回落**：RFC-599 用例红，`tsc` 报编译期断言。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：单机默认值只在 standalone profile（daemon）与用例里。**C12**：RFC-599 用例只读两个装配文件；调用方由 `tsc` 全量核对。**C13**：计数不升。

## 5. 留下的

- 两个装配继承来的可选 provider（§0）。
- `select*` 助手对 infrastructure 其他调用方的本机回落。
