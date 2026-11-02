# RFC-429 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-428 落库后的源码（`e41e5dbde`）为准。

## 1. 选择项与键表

`S/bootstrap/deploymentProfile.ts` 的 `DeploymentSelections` 与 `S/bootstrap/deploymentSelections.ts` 的键表删去 `evidenceRead`、`attemptContext`、
`missionInputBlobs`、`evidenceDocumentCommands`，以及只为它们存在的类型导入。

## 2. 消费点

| 位置                                                                  | 改动                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S/bootstrap/daemonApplication.ts`                                    | 不再把 `evidenceDocumentCommands` 交给开发目的根，不再把 `evidenceRead` / `attemptContext` / `missionInputBlobs` 交给开发自动化模块组                                                                       |
| `S/bootstrap/developmentPurposeRoot.ts`                               | 删去 `evidenceDocumentCommands` 入参；默认需求目的的 `documentCommands` 直接是本地文件实现                                                                                                                  |
| `S/bootstrap/daemonModules/developmentAutomation.ts`                  | 删去 `evidenceRead` / `attemptContext` / `missionInputBlobs` 入参；开发自动化与任务输入上传从 `evidenceArtifacts` 取（模块内既有回落）                                                                      |
| `S/bootstrap/crewstation.ts`                                          | 选择项只给 `evidenceArtifacts: evidence.evidenceArtifacts`，删去 `missionInputBlobs` / `attemptContext` 两行；`developmentPurposes.requirement.documentCommands` 照旧取 `evidence.evidenceDocumentCommands` |
| `S/modules/development-automation/composition/crewstationEvidence.ts` | 结果删去 `evidenceRead`，保留 `evidenceArtifacts` 与 `evidenceDocumentCommands`                                                                                                                             |

等价性逐项见 proposal §1 的表：托管时各回落取到的是同一个 `evidenceArtifacts` 对象的同名成员；单机时这四项本来就缺省。

## 3. 守卫

- `T/architecture/rfc428-retired-deployment-selections.test.ts` 的已退役清单加入这四项；负例照旧覆盖「重新声明为选择项」。
- guard-manifest：刷新该锁的行数。

## 4. 测试

- 经 HTTP 测试入口（`T/helpers/providerHttpApplication.ts`）或伪造 profile 注入这四项的用例：
  - 改为注入 `evidenceArtifacts`；
  - 需求文档命令走托管形状的 `developmentPurposes`，或断言默认的本地文件实现；
  - 断言不变。
- 断言「该项保持可选 / 被接线」的源码锁：改为断言它不再是选择项（`expectNoDeploymentSelection`）。
- `rfc394-deployment-profile`：托管键集合 68 → 64、键表 68 → 64；HTTP 测试入口的可传入键列表删去这四项。
