# RFC-622 source-control 的候选与提交绑定器迁入 application（RFC-294 S10 余项）

- **状态**：In Progress（2026-11-26）。用户 2026-11-26「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S10（`composition/` 全模块只装配）；接
  [RFC-612](../RFC-612-source-control-composition-implementations/proposal.md)（source-control 组合层的两个实现迁入 infrastructure）。

## 1. 背景

`composition-control-flow-source-control` 余 4 行，全在两个绑定文件里：

| 文件                                 | 函数                                                                 | 分支                                                                   |
| ------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `composition/repositoryCandidate.ts` | `bindChangeCandidateParticipant`、`bindCandidateDeliveryParticipant` | 选中的候选效果是托管的操作宿主（一个用例在远端卷里整体跑）还是本地步骤 |
| `composition/repositoryCommit.ts`    | `bindRepositoryCommitParticipant`                                    | 有工作区作用域时在它的卷里跑、否则在本进程跑；可移植的 git 选项        |

它们决定的是“由哪一面执行用例”——用例编排；`application/repositoryCandidateEffects.ts` 早已在 application 里做同一判断。三个函数只取本模块的 application 与
public 类型，与组合层的其他装配（本地夹具工厂、工作区选择）无关。

## 2. 目标

- **G1**：三个绑定器原样迁入 `application/repositoryCandidateParticipants.ts` 与 `application/repositoryCommitParticipant.ts`；模块根 `composition.ts` 照旧转出它们
  （bootstrap 的取法不变）；`composition/repositoryCommit.ts` 删除，`composition/repositoryCandidate.ts` 只剩本地夹具的装配。
- **G2**：`composition-control-flow-source-control` 4 → 0（max 同步降）；钉着旧路径的锁与账本随之改。

## 3. 非目标

- 绑定器的任何行为改动。
- 其他模块的组合层分支（system-operations 的两处与发布升级预载钩子相连、integration 的入站与重放可用性规则、resource-catalog 的按库缓存，各自另立）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：旧的提交绑定文件不在；三个绑定器只在 application 声明，模块根从 application 转出；两个 application 文件只取本模块的 application、domain 与 public 类型。
- **AC-2**：没有文件再取旧的提交绑定文件，也没有文件从组合层取候选绑定器。
- **AC-3**：`composition-control-flow-source-control` 为 0，max 降到 0；新增 RFC-622 用例并登记。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
