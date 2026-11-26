# RFC-607 需求物化器的需求源必填，本机兼容物化器迁入用例 helper（RFC-294 W4-E8 余项）

- **状态**：In Progress（2026-11-25）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W4-E8（按用例的必填端口）与 S12（单机默认值只留在 standalone
  profile）；接 [RFC-603](../RFC-603-reconciler-ports-required/proposal.md) design §7 留下的“需求物化器的 `source`”。

## 1. 背景

development-automation 的需求物化器（`createSelectedRequirementMaterializer`）有两个可选入参：

- **`source?`（外部需求源的执行端口）**：没给时，取件、外部渠道发问与收答三处给出 `requirement-source-not-wired` 失败。
  - 唯一的生产装配一直给它：RFC-597 起装配入参的 `requirementSource` 必填。
  - 只有用例与一份本机兼容物化器不给。
- **`documents?`（需求文档读取的覆盖）**：没给时取证据端口自己的 `documents`。生产装配不给；只有两个用例借它注入假的文档读取。

那份本机兼容物化器（`infrastructure/local/legacyRequirementMaterializer.ts` 的 `createRequirementMaterializer`）把物理目录形式的需求源包成选定形式：

- 生产代码没有任何地方调用它，只有用例在用。
- 它所在的 `infrastructure/requirementMaterializer.ts` 只因 `childMissionParticipant.ts` 取一个类型才算可达。

这与 RFC-584 迁出的“只供契约用例的兼容入口”同类。

## 2. 目标

- **G1**：物化器的 `source` 必填，删去三处端口缺席的分支。外部渠道发问在问题集没有适配器绑定时的失败照旧，那是绑定缺失，不是端口缺席。
- **G2**：`documents` 覆盖删去，需求文档一律经证据端口的 `documents` 读取（RFC-598 删去同类覆盖的做法）。
- **G3**：本机兼容物化器迁入 `tests/helpers/`；`infrastructure/requirementMaterializer.ts` 删去，唯一的生产使用方改从 application 取类型。
- **G4**：用例照旧覆盖原有行为：不用外部源的用例给调用即抛错的替身，原来注入假文档读取的两个用例改为经证据端口注入。
- **G5**：生产行为不变；架构计数都不升。

## 3. 非目标

- launch 的 `uploadAdmission?`：子任务启动不收上传是有意的用例差异，不是端口缺席。
- 任何用户可见行为。

## 4. 能力影响清单

无。生产装配本来就给需求源，也从不覆盖文档读取。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：物化器入参的 `source` 必填、没有 `documents`；application 里不再判断需求源是否缺席。
- **AC-2**：本机兼容物化器不在 `src/`；`infrastructure/requirementMaterializer.ts` 删去；生产装配不变。
- **AC-3**：受影响用例全部通过，行为与此前相同；新增 RFC-607 用例并登记；架构计数都不升。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
