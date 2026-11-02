# RFC-430 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-429 落库后的源码（`338d7db0c`）为准。

## 1. 选择项与键表

`S/bootstrap/deploymentProfile.ts` 的 `DeploymentSelections` 与 `S/bootstrap/deploymentSelections.ts` 的键表删去 `historyRestrictions`、
`resourcePackageSkillContent`、`automationWorkspaceEffects`，以及只为它们存在的类型导入。

## 2. 消费点

| 位置                               | 改动                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S/bootstrap/daemonApplication.ts` | `const historyRestrictions = createActiveHistoryRestrictionProvider()`；交给 HTTP 组合的 `resourcePackageSkillContent: skillContent.packageContent`；开发工作区绑定不再传 `automationWorkspaceEffects`（`selectDevelopmentWorkspaceEffectBinding` 从 `actionWorkspaceEffects.contents` 派生） |
| `S/bootstrap/crewstation.ts`       | 选择项删去 `historyRestrictions`（本地常量仍给托管人工门恢复）；`...resources` 改为 `skillContent: resources.skillContent`；开发工作区装配结果改为逐字段取 `actionWorkspaceEffects` 与 `repositoryBaselines`                                                                                  |

HTTP 组合内部的 `selections.resourcePackageSkillContent` 是它自己的入参字段（由应用装配给出），不是部署选择项，保持不变。

## 3. 守卫

- `T/architecture/rfc428-retired-deployment-selections.test.ts` 的已退役清单加入这三项。
- guard-manifest：刷新该锁的行数。

## 4. 测试

- `rfc394-deployment-profile`：托管键集合与键表 64 → 61；`T/helpers/providerHttpApplication.ts` 的可传入键删去这三项。
- 断言这三项「保持可选 / 被接线」的源码锁改为断言它们不再是选择项，并断言派生关系：
  - 历史限制提供者由应用装配直接构造；
  - 技能内容取 `skillContent.packageContent`；
  - 开发工作区不再传自动化内容。
- 经测试入口注入这三项的行为用例改为注入其来源：`skillContent` 或 `actionWorkspaceEffects`。
