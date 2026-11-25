# RFC-598 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `8cc1e0ff3`。
行为不变。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：改动在 development-automation 的模块装配（`DA/composition.ts`），删去 `DA/composition/evidenceReadBinding.ts`。本机实现
  照旧在 infrastructure；单机部署的选择照旧在 bootstrap（daemon 经 `selectDevelopmentWorkspaceEffectBinding` 与部署选择给出），用例经测试助手给。
- **为什么只收装配这一处**：`select*` 助手的本机回落还服务 infrastructure 里另外几个调用方（它们的入参本身就是可选的），一并收要改那几处的
  合同与调用方，另立。本 RFC 让模块装配不再走到这些回落——它的唯一生产调用方本来就给全。
- **偏离项**：无。

## 1. 改动

- `DA/composition.ts`：
  - `actionWorkspaceEffects`、`automationWorkspaceEffects`、`repositoryBaselines` 去掉 `?`；装配写成
    `selectActionWorkspaceEffects(deps.actionWorkspaceEffects)`、`selectedAutomationWorkspaceEffects(deps.automationWorkspaceEffects)`（不再按是否给出从
    动作效果的 `contents` 推出）、`createActionBaselineResolver(…, deps.repositoryBaselines)`。
  - 删去 `evidenceContents`、`evidenceRead`、`attemptContext` 三个成员：模块交出的 `evidenceContents` / `evidenceDownloads` 取 `evidence.contents` /
    `evidence.downloads`，尝试上下文取 `evidence.contexts`，需求物化器不再收 `documents`（它本来就在没给时取 `evidence.documents`）。
- 删去 `DA/composition/evidenceReadBinding.ts`；`T/helpers/evidenceSelections.ts` 改用 `Pick<EvidenceArtifactPort, 'contents' | 'documents' | 'downloads'>`
  （导出为 `EvidenceReadSelection`），`rfc370-evidence-read-root-bindings` 改取它。
- `T/helpers/developmentAutomation.ts` 的 `composeStandaloneDevelopmentAutomationSelections` 另给三组效果，规则与此前装配的回落相同：给了的原样交出；
  没给时动作效果是 `createFileActionWorkspaceEffects()`，自动化效果是动作效果的 `contents`，基线效果是 `createFileRepositoryBaselineEffectsFactory()`。
  调用装配的 12 个调用点本来就展开它，不用改；两处自己给效果的照旧写在后面覆盖。
- `rfc370-pipeline-evidence-content`：原来以 `evidenceContents` 覆盖内容读取，改为把同一个读取放进交给助手的 `evidenceArtifacts`。
- 两个钉着旧写法的 RFC-370 锁随改：`rfc370-attempt-context-root-wiring`（尝试上下文只取 `evidence.contexts`，不再有 `deps.attemptContext ??`）、
  `rfc370-evidence-artifact-root-bindings`（自动化效果的选择改为直接核对 `deps.automationWorkspaceEffects`）。

## 2. 门、用例与文档

- 新增 `T/rfc598-development-automation-stated-composition-inputs-boundary.test.ts`，登记 guard-manifest：
  1. 装配入参的接口（连同继承的 provider 接口）没有带 `?` 的成员；编译期断言没有可选键。
  2. 装配里没有对 `deps.evidenceRead`、`deps.evidenceContents`、`deps.attemptContext` 的读取；三组效果选择只出现在核对它们的调用里（`select*`、
     基线解析与事实扫描器），都不在条件或回落里；`evidenceReadBinding.ts` 不在（谁再 import 它，`tsc` 报错）。判据带负对照。
  3. 测试助手给了的原样交出；没给时动作效果完整、自动化效果就是它的 `contents`、基线效果能解析出基线（与此前的回落相同）。
- 计数：预计都不变（模块符号少一个 `EvidenceReadBinding`）。

## 3. 失败模式

- **有人给装配入参加回可选成员、或重新从覆盖读证据**：RFC-598 用例 ① ② 红，`tsc` 报编译期断言。
- **测试助手的缺省与此前的回落不同**：RFC-598 用例 ③ 红；调用装配的用例按行为红。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：单机默认值只在 standalone profile（daemon）与测试助手里，模块装配不再替部署决定缺省。**C12**：RFC-598 用例 ① ② 只读模块装配文件，③ 跑助手；
  对删去文件的 import 由 `tsc` 全量核对。**C13**：计数不升。

## 5. 留下的

- `select*` 助手对其他调用方的本机回落（见 §0）。
- `ReconcilerPorts` 的按用例拆分（W4-E8 下一步，RFC-597 design §5）。
