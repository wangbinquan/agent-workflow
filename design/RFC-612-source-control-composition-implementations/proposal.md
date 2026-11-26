# RFC-612 source-control 组合层里余下的两份实现归 infrastructure（RFC-294 S10 余项：composition 只装配）

- **状态**：Done（2026-11-26，落地 `1d4faeac5`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S10（C1：composition 只构造与注入）；接
  [RFC-608](../RFC-608-repository-facts-scan-selection/proposal.md) 的做法（取决于所选实现能力的选择归 infrastructure）。

## 1. 背景

source-control 的 `composition/` 还有 6 行控制流（`composition-control-flow-source-control`）。其中 4 行是候选与提交两个绑定的装配期选择（操作宿主
还是本机步骤、工作区作用域还是进程内），另 2 行在两份实现里：

- **缓存仓库操作**（`composition/cachedRepositoryOperations.ts`）：`CachedRepositoryOperations` 端口的实现。刷新时远端登记走镜像、本机镜像缓存去
  fetch，批量导入与重试读当时的设置。
- **仓库组写入的 URL 导入**（`composition/repositoryGroups.ts` 的 `writeDeps`）：托管登记已验证的远端，单机克隆（或复用）镜像、按克隆预算等待。

两者都在每次调用时按所选镜像的实现走不同的路，是 infrastructure 的实现，不是装配。

## 2. 目标

- **G1**：缓存仓库操作原样迁入 `infrastructure/cachedRepositoryOperations.ts`，组合层的文件删去；模块根照旧转出 `composeCachedRepositoryOperations`
  与 `CachedRepositorySettings`。
- **G2**：仓库组的 URL 导入选择迁入 `infrastructure/repositoryUrlImport.ts`（连同单机的 `localRepositoryUrlImport`），`composeRepositoryGroups` 只把
  用例绑到存储与 URL 导入上；模块根照旧转出两个名字。
- **G3**：`composition-control-flow-source-control` 6 → 4（max 同步降）；其余计数不升。

## 3. 非目标

- 候选与提交两个绑定的装配期选择（4 行）：它们在装配时按所选效果的形状选一次，属于装配；另议。
- task-execution 与 system-operations 组合层的控制流。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：组合层没有缓存仓库操作的实现，仓库组的装配没有分支；两个实现在 infrastructure，模块根转出不变。
- **AC-2**：行为不变：远端登记时 URL 导入走 `register`、不读克隆预算；单机每次写入读一次克隆预算；缓存仓库操作的原有用例照旧通过。
- **AC-3**：计数 6 → 4；新增 RFC-612 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
