# DeploymentSelections 72 项盘点（2026-11-02，RFC-427 落库后的源码 `c96f2c907`）

RFC-294 S2c 余项第 1 项（单机默认值集中、选择项改必填、死槽 / 被遮蔽槽 / 可派生槽清理）的范围依据。本会话委托一次只读调研逐项追踪，
关键论断已在 RFC-428 实施时按源码复核。路径缩写：

- **CS** = `bootstrap/crewstation.ts`；**DS** = `bootstrap/daemonStart.ts`；**DSe** = `bootstrap/daemonSession.ts`；
  **DA** = `bootstrap/daemonApplication.ts`；**DH** = `bootstrap/daemonHttpComposition.ts`；
- **DE** / **DDA** = `bootstrap/daemonModules/{digitalEmployee,developmentAutomation}.ts`；**DPR** = `bootstrap/developmentPurposeRoot.ts`；
- **CSX** = `modules/task-execution/composition/crewstationExecution.ts`；**CSE** = `modules/development-automation/composition/crewstationEvidence.ts`；
  **CSDW** = `modules/development-automation/composition/crewstationWorkspace.ts`；**SCB** = `modules/resource-catalog/composition/skillContentBinding.ts`。

## 结论

- 托管 profile 设置 72 项中的 69 项（与 `tests/rfc394-deployment-profile.test.ts` 的 `HOSTED_SELECTION_KEYS` 一致）；单机 profile 一项不设。
- 分类：

| 类别                           | 数  | 键                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 死槽（生产从不设置）           | 3   | `databasePreOpenRecovery`、`nodeRunPromptContentEffects`、`startupLease`                                                                                                                                                                                                                                     |
| 被遮蔽（托管设置但永远读不到） | 2   | `portArtifactContentEffects`（托管同时给 `taskRunSelection`，后者优先）、`evidenceDocumentCommands`（只在默认的需求目的里读，托管给了 `developmentPurposes`）                                                                                                                                                |
| 可派生 / 冗余                  | 6   | `historyRestrictions`（托管值 ≡ 默认的无状态工厂）、`missionInputBlobs`（= `evidenceArtifacts`）、`resourcePackageSkillContent`（= `skillContent.packageContent`）、`automationWorkspaceEffects`（= `actionWorkspaceEffects.contents`）、`evidenceRead`、`attemptContext`（均为 `evidenceArtifacts` 的成员） |
| 启动时派生                     | 6   | `applicationConfiguration`、`workspaceUploads`、`isolationWorkspaces`、`repositoryGitWorkspaces`、`workspaceReads`、`secretBox`                                                                                                                                                                              |
| 托管覆盖                       | 55  | 其余各项                                                                                                                                                                                                                                                                                                     |

## 后继分步（建议）

1. **删除 11 个死槽 / 被遮蔽槽 / 可派生槽**（RFC-428）：72 → 61，无新增必填项。
2. **单机默认值集中**：`bootstrap/standalone.ts` 的 `standaloneSelections({ appHome })` 构造默认值无参或只需 `appHome` / `Paths` 的各项并改必填，同时删去三处重复的
   归一化（DS / DA / `providerRuntime.ts`）与 RFC-394 的 `REQUIRED_OVERRIDES` 特例；只在托管存在的功能给出显式的中立值或 `| null`。
3. **需要会话图的默认值**：`contentStore`、`skillContent`、`reviewArtifacts`、`repositoryPreparationEffects`、`scratchWorkspaceEffects`、
   `repositoryPublicationTransport`、`developmentWorkspaceRepositoryPreparation`、`resourcePackageSkillArtifacts`、`intentArtifacts`、
   `databaseBackup` 改为两侧都给的工厂型选择项，或作为写明理由的最后几个可选项。
4. **按有无分支的项**：`databaseInstallation`（缺省即单机的整条启动路径）、`secretBox`（缺省会创建 `secret.key`，须在启动锁之后）、
   `repositoryRemote`、`crewStationEvents`（有无即部署开关）需要各自的端口或 `null` + 独立判定。

改必填时需要同步的测试锁：`tests/helpers/deploymentSelectionSource.ts` 要求 26 个键保持可选；RFC-394 架构锁的 `REQUIRED_OVERRIDES`；
`tests/rfc394-deployment-profile.test.ts` 的托管键集合；`tests/helpers/providerHttpApplication.ts` 的可传入键 `Pick` 列表。

逐项的设置点、单机默认值、测试设置点与分类见本次调研的完整表（2026-11-02 会话记录），RFC-428 只依赖上面 11 项。
