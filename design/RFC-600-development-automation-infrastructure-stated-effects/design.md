# RFC-600 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `84be64f92`。
行为不变。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：改动在 development-automation 的 infrastructure 与一个装配文件（`DA/composition/missionOperations.ts`），外加
  `DA/composition/repositoryFactsScanner.ts` 的参数类型。本机实现照旧在 `DA/infrastructure/local/`；单机部署的选择照旧在 bootstrap。
- **镜像里的执行器为什么显式用本机实现**：`taskImageWorkspace.ts` 是托管任务镜像里接收树操作（业务树快照、受保护根快照、工作区结果校验）的执行端，
  对镜像内自己的文件操作——本机实现正是它要的，此前经核对函数的回落拿到，现在写明。
- **偏离项**：无。

## 1. 改动

- `DA/infrastructure/automationWorkspaceEffects.ts`：`selectedAutomationWorkspaceEffects(factory)` 只核对完整性（去掉 `undefined` 分支与本机构造的 import），
  `withAutomationWorkspaceEffects` 的工厂必填。
- `DA/infrastructure/actionWorkspaceEffects.ts`：`selectActionWorkspaceEffects(selected)` 同上。
- `DA/infrastructure/gitBaselineReader.ts`：删去 `selectedRepositoryBaselineEffects`；`createActionBaselineResolver`、`createRepositoryBaselineResolverFromLocations`、
  `resolveActionBaseline`、`createRepositoryBaselineResolver`、`createGitBaselineReader` 的工厂必填（完整性照旧由 `withRepositoryBaselineEffects` 核对）。
- `DA/infrastructure/workspaceValidator.ts`（`businessTreeSnapshot`、`validateWorkspaceOutcome`）、`DA/infrastructure/protectedSnapshot.ts`（`snapshotProtectedRoots`，
  选项随之必填）、`DA/infrastructure/attemptSupport.ts`（`createWorkspaceValidationAdapter`）：工厂必填；“远端卷原样交、否则核对”的选择照旧。
- `DA/composition/repositoryFactsScanner.ts`：入参必填（没有树操作时照旧返回 `undefined`、走本机扫描——这是按能力选择，不是回落）。
- `DA/composition/missionOperations.ts`：`repositoryBaselines` 必填（daemon 本来就给）。
- `DA/infrastructure/crewstation/taskImageWorkspace.ts`：三处树操作显式给 `createFileAutomationWorkspaceEffectsFactory()`。
- 用例：`T/helpers/developmentAutomation.ts` 的平台工作项证据助手自己给此前的回落；14 处直接调这些包装的用例与两处调任务操作装配的用例显式给本机实现；
  `rfc496` 钉着包装选择表达式的锁随写法改（工厂不再可选，读它不带 `?.`）。

## 2. 门、用例与文档

- 新增 `T/rfc600-development-automation-infrastructure-stated-effects-boundary.test.ts`，登记 guard-manifest：
  1. 两个核对函数的函数体不调用任何本机构造、不以 `undefined` 为条件；`gitBaselineReader.ts` 没有 `selectedRepositoryBaselineEffects`（判据带负对照）。
  2. development-automation 的 infrastructure 与 composition 全部源码里，类型是效果工厂的参数都不带 `?`、不并 `undefined`（判据带负对照）。
  3. backend 全部生产源码里调用三个本机效果构造的文件恰好是 `bootstrap/standalone.ts`、`DA/infrastructure/local/fileActionWorkspaceEffects.ts` 与
     `DA/infrastructure/crewstation/taskImageWorkspace.ts`（判据带负对照）。
- 计数：预计都不变。

## 3. 失败模式

- **有人给核对函数加回回落、或把工厂参数改回可选**：RFC-600 用例 ① ② 红。
- **新的生产文件自己造本机效果**：RFC-600 用例 ③ 红——单机默认值应由 standalone profile 给出。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：单机默认值只在 standalone profile（与镜像里明确要本机实现的执行器）。**C12**：① 读三个文件，② 扫 development-automation 的 infrastructure 与
  composition 全部源码，③ 扫 backend 全部生产源码。**C13**：计数不升。

## 5. 留下的

- 员工两个装配继承来的可选 provider（RFC-599 §3）与 `ReconcilerPorts`（W4-E8 下一步，涉及 RFC-359 P0 指纹，须用户定）。
