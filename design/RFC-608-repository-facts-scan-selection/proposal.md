# RFC-608 仓库事实扫描的选择归 infrastructure（RFC-294 S10 余项：development-automation 的 composition 只装配）

- **状态**：In Progress（2026-11-25）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S10（composition 全模块只装配）。

## 1. 背景

development-automation 的 `composition/` 只剩一处控制流（`composition-control-flow-development-automation` = 1）：
`composition/repositoryFactsScanner.ts` 的 `repositoryFactsScannerOf` 按所选工作区效果有没有树操作，决定仓库事实在卷内扫描还是返回
`undefined`，再由采集器回落到进程内扫描。这是“按效果实现的能力选扫描方式”，属于 infrastructure 的实现选择，不是装配。

## 2. 目标

- **G1**：选择迁入采集器所在的 infrastructure（`repositoryFactsScanFor`）。没有树操作时直接给出进程内扫描、不再返回 `undefined`；composition 只把
  工作区效果交给它。
- **G2**：`composition/repositoryFactsScanner.ts` 删去；`composition-control-flow-development-automation` 1 → 0（max 同步降），其余计数不升。
- **G3**：行为不变：单机仍在进程内扫描，托管仍在开发卷内运行 `repository-facts-scan`。

## 3. 非目标

- 其他模块的 composition 控制流：
  - system-operations 的两处数据库准备选择受发布升级门的预载钩子约束，另议。
  - integration 的 webhook 入站挨着密钥箱与已验证接收，按会话约定不动。
  - resource-catalog 的 `resourceAcl` 属访问控制一族，不动。
- 任何用户可见行为。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`repositoryFactsScanFor` 在 infrastructure，按树操作的有无给出卷内或进程内扫描；composition 不再有这一处分支，`repositoryFactsScanner.ts` 删去。
- **AC-2**：`composition-control-flow-development-automation` 为 0 且 max 降到 0；新增 RFC-608 用例并登记。
- **AC-3**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
