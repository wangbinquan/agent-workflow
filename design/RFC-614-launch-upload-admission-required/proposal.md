# RFC-614 收上传的 launch 把 upload admission 当必填端口，子任务委派是不收上传的另一个用例（RFC-294 W4-E8 余项）

- **状态**：In Progress（2026-11-26）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  收法由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W4-E8（按用例、非可选的 required 端口）；接
  [RFC-603](../RFC-603-reconciler-ports-required/proposal.md)（端口必填、删去 `*-not-wired`）与 [RFC-607](../RFC-607-requirement-materializer-stated-inputs/proposal.md)
  design §5 记下的余项。

## 1. 背景

development-automation 的 Mission launch 用例（`application/commands/launchMission.ts`）收 `LaunchDeps`，其中 `uploadAdmission?` 可选：

- 带上传的 direct launch 在它缺席时落一个 `upload-admission-not-wired` 的 blocked Mission；上传预览（`previewDirectInput`）直接报错。
- 生产里 Mission 操作的 launch 一直给它（`missionOperationHandlers.ts`）；子任务委派（`childMissionParticipant.ts`）不给，但委派从不带上传。

可选端口其实是两个用例：收上传的 launch，与不收上传的 launch。W4-E8 的目标形状是“按用例拆分的必填端口”，缺席分支与“未接线”的业务状态不该存在。

## 2. 目标

- **G1**：`LaunchDeps` 的 `uploadAdmission` 必填，`launchMission` 与上传预览收它。预览、选源、重试、取消与共用的选择链只收新的 `MissionCommandDeps`
  （存储、准入查询、时钟）。
- **G2**：新增 `launchMissionWithoutUploads(deps: MissionCommandDeps, input)`：与 `launchMission` 共用同一条 launch 链，带上传时在写入任何东西之前以
  `mission-uploads-not-accepted` 拒绝。子任务委派改走它。
- **G3**：删去 `upload-admission-not-wired` 的阻断与预览里的同名报错；`baseline-reader-not-wired`（仓库没有可读的 baseline，是数据状态）不动。

## 3. 非目标

- Mission launch 的其他行为（选择链、上传放置、来源解析）。
- code-capability 兼容岛的物理并入（见 RFC-609 design §5）。

## 4. 能力影响清单

无。生产的 Mission 操作一直给 upload admission，子任务委派从不带上传；被删去的阻断在生产上走不到。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`LaunchDeps.uploadAdmission` 必填（编译期）；其余命令收 `MissionCommandDeps`；用例文件没有端口缺席的判断，也没有 `upload-admission-not-wired`。
- **AC-2**：子任务委派走 `launchMissionWithoutUploads`；它遇到上传即拒绝、零写入。
- **AC-3**：原用例照旧通过（RFC-310 的准入、上传与委派用例）；新增 RFC-614 用例并登记。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
