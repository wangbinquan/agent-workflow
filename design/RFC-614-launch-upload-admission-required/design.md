# RFC-614 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `0339842ab`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：development-automation 的 application（`DA/application/commands/launchMission.ts`）与它的 infrastructure 调用方（`childMissionParticipant.ts`）。
- **裁定一：按用例拆，不按“给没给”分支**。
  - 收上传的 launch（Mission 操作）把 upload admission 当必填端口。
  - 不收上传的 launch（子任务委派）是另一个入口，它的依赖里没有这个端口。
  - 两者共用同一条 launch 链：链内部收 `UploadAdmissionDeps | null`，只在输入带上传时取用。取不到时报 `mission-uploads-not-accepted`——这是不收上传的入口对输入的拒绝，
    不是端口缺席。
- **裁定二：不为子任务委派造一份用不到的 admission**。委派的装配在模块装配里，upload admission 的两个依赖（上传会话、baseline 解析）只在 Mission 操作的装配里有；
  为了凑类型给委派接上一份从不调用的依赖，是死接线。
- **裁定三：只读命令收 `MissionCommandDeps`**。预览、选源、重试、取消与共用的选择链只读存储、准入查询与时钟；它们的调用方不必为满足类型给 upload admission。
- **偏离项**：无。

## 1. 改动

| 位置                                                                                                              | 改动                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DA/application/commands/launchMission.ts`                                                                        | 新增 `MissionCommandDeps`；`LaunchDeps` 继承它并必填 `uploadAdmission`；`launchMission` 与 `launchMissionWithoutUploads` 共用 `launchWith`；删去 `upload-admission-not-wired` 的阻断与预览里的报错；只读命令改收 `MissionCommandDeps` |
| `DA/infrastructure/childMissionParticipant.ts`                                                                    | 依赖类型改为 `MissionCommandDeps`，改调 `launchMissionWithoutUploads`                                                                                                                                                                 |
| `T/helpers/rfc310Pr2Fixture.ts`、`T/helpers/rfc310Pr3Fixture.ts`、`T/rfc359-w14-legacy-mission-execution.test.ts` | 不给 upload admission、不带上传的 launch 改调 `launchMissionWithoutUploads`                                                                                                                                                           |
| `T/rfc310-pr2-admission.test.ts`                                                                                  | “未接线”用例改为“不收上传的入口遇到上传即拒绝、零 Mission”                                                                                                                                                                            |

## 2. 用例

- 新增 `T/rfc614-launch-upload-admission-required-boundary.test.ts`，登记 guard-manifest：
  1. **合同**：编译期断言 `LaunchDeps.uploadAdmission` 必填、`MissionCommandDeps` 没有它；AST 核对同一件事。
  2. **无缺席判断**：用例文件里没有 `…uploadAdmission` 与 `undefined` / `null` 的比较，也没有 `upload-admission-not-wired`。
  3. **委派**：子任务委派只调 `launchMissionWithoutUploads`，依赖类型是 `MissionCommandDeps`。
  4. **行为**：不收上传的入口遇到上传即以 `mission-uploads-not-accepted` 拒绝，只读过幂等键。
  5. **负对照**：②③ 的判据认得出伪造源码里的缺席判断与经可选端口的 launch。
- 原用例照旧覆盖：`rfc310-pr2-admission`（launch / 预览 / 选源 / 重试 / 取消）、`rfc310-pr3-upload-security`（上传放置）、委派与执行用例。

## 3. 失败模式

- **有人把端口改回可选、加回缺席分支**：`tsc`（编译期断言）与 RFC-614 用例红。
- **委派改回经收上传的入口**：`tsc`（委派的依赖没有 upload admission）与 RFC-614 用例 ③ 红。

## 4. 对 RFC-294 刷新后规则的对账

- **W4-E8**：按用例、非可选的 required 端口；端口缺席的业务状态删去（同 RFC-603）。**C12**：RFC-614 用例跑入口、读源码。**C13**：计数不升。
