# RFC-429 部署选择项的 evidence 一组收拢到 `evidenceArtifacts`（RFC-294 S2c）

- **状态**：Done（2026-11-02 落档并实施，`338d7db0c`；该提交主 CI 68/70 的一格红不归本 RFC，AC-4 以后继提交 `8c242c3fc` 的主 CI 70/70、windows-platform 与 maintenance-soak-nightly 全绿收尾）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你可以
  不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，无用户
  可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c 余项第 1 项的第二步
- **前序**：[RFC-428](../RFC-428-dead-deployment-selections/proposal.md)（第一步与 [72 项盘点](../RFC-428-dead-deployment-selections/inventory.md)）
- **落位**：`bootstrap/`（选择项、应用装配、开发目的根、开发自动化模块组）、`bootstrap/crewstation.ts` 与 development-automation 的托管 evidence
  装配。

## 1. 背景

部署选择项里，与 evidence 有关的除了 `evidenceArtifacts` 本身，还有四项：

| 选择项                     | 托管的值                                                                                                      | 消费点的回落                                                           | 结论   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| `evidenceRead`             | `{ contents, documents, downloads }`，即 `evidenceArtifacts` 的三个成员                                       | 读取回落到 `evidenceArtifacts` 的同名成员                              | 可派生 |
| `attemptContext`           | `evidenceArtifacts.contexts`                                                                                  | `?? evidence.contexts`（同一个 `evidenceArtifacts`）                   | 可派生 |
| `missionInputBlobs`        | `evidenceArtifacts` 本身                                                                                      | `blobs ?? artifacts ?? 本地懒加载`，`artifacts` 即 `evidenceArtifacts` | 可派生 |
| `evidenceDocumentCommands` | 托管设置，但只有默认的需求目的读它；托管给了 `developmentPurposes.requirement.documentCommands`（同一个对象） | 单机缺省时用本地文件实现                                               | 被遮蔽 |

四项让托管与单机各自多出一条装配路径，测试也借它们绕过 `evidenceArtifacts`。

## 2. 目标

- **G1 删除四项**：`DeploymentSelections` 与键表删去这四项（68 → 64；托管设置 68 → 64）。
- **G2 行为不变**：
  - 两种部署的 evidence 读取、尝试上下文、任务输入落盘都经 `evidenceArtifacts` 的同一个对象；
  - 默认需求目的的文档命令仍是本地文件实现；
  - 托管的需求文档命令仍经 `developmentPurposes`。
- **G3 托管装配只给 `evidenceArtifacts`**：托管 evidence 装配不再产出 `evidenceRead`，`crewstation.ts` 不再把 evidence 结果整个展开进选择项。
- **G4 锁住删除**：RFC-428 的结构锁把这四个名字加入已退役清单。

## 3. 非目标

- `historyRestrictions`、`resourcePackageSkillContent`、`automationWorkspaceEffects` 三个可派生项（各自牵动不同模块，另立）。
- 模块级 API：development-automation composition 的 `evidenceRead` / `attemptContext` / `evidenceContents` 与任务输入上传的 `blobs` 可选入参，
  仍是模块自身的可选端口；本 RFC 只停止从部署选择项传入。
- 单机默认值集中、改必填（inventory 后继第 2～4 步）；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：四项不再是部署选择项或键表的键；托管 evidence 装配不再产出 `evidenceRead`；结构锁的已退役清单含这四项（含负例）。
- **AC-2**：经 HTTP 测试入口注入 evidence 的用例改为注入 `evidenceArtifacts`（或托管的 `developmentPurposes`），断言不变；托管键集合 68 → 64、
  键表 68 → 64。
- **AC-3**：既有 evidence 读写、需求文档写入、任务输入捕获、冲突工作区与开发目的根用例，以及 P0 变异 lane 全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **四项一起删**：它们都由同一个 `evidenceArtifacts` 派生或被遮蔽，测试也集中在 evidence 一组用例里，一起核对等价性更容易。
2. **模块级可选端口保留**：它们是模块自身的组合参数，部分模块用例直接使用；收口模块 API 不在部署选择项的范围内。
