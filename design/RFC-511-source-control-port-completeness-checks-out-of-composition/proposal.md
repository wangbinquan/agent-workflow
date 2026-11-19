# RFC-511 源码控制组合层的端口完整性核对迁出 composition（RFC-294 S10 第十八步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。
  设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）。
- **前序**：[RFC-510](../RFC-510-task-execution-port-completeness-checks-out-of-composition/proposal.md)（S10 第十七步，Done，`90c631993`）：
  task-execution 的端口完整性核对已迁出。本 RFC 对 source-control 做同一件事，只改 source-control `composition/` 下的 7 个文件，给
  `application/conflictMerge.ts` 增一个名字、新增 application 下 2 个文件；所有装配入口、选择函数的名字、签名、返回形状与位置不变，原有的转出
  名字（含 public participants 从组合文件转出的两个 `require*`）照旧可取；不碰 `crewstation*` / `taskImage*`（RFC-370 余项）。

## 1. 背景

source-control 组合层的控制流（F13 口径）共 148 行，RFC-370 的 `crewstation*` / `taskImage*` 占 101 行，其余 11 个文件 47 行。其中 28 行是端口的
**装配期完整性核对**：交入的隔离工作区、仓库 Git 工作区、上传内容、排除配置、工作区只读查询、冲突合并效果与候选效果工厂不齐就抛原文错误：

- `isolationWorkspaces.ts`、`repositoryGitWorkspaces.ts`、`workspaceUploads.ts`、`workspaceExcludeProfiles.ts` 各 4 行：作用域或内容收发的核对与
  工厂（或参与者）的核对；
- `repositoryCandidate.ts` 8 行：候选效果工厂的核对（操作宿主的四个操作或分步工厂的 `acquire`）；
- `repositoryWorkspaceReadQueries.ts`、`conflictMerge.ts` 各 2 行：只读查询与冲突合并效果的核对。

其余 19 行是装配期选择与 `repositoryMirrors.ts` 里的缓存仓库用例（读行、刷新与错误映射），另立后继。

## 2. 目标

- **G1 核对归位**（函数体逐字不变）：source-control 的 5 组工作区端口核对迁入新的 `application/workspacePorts.ts`，候选效果工厂的核对迁入新的
  `application/repositoryCandidateEffects.ts`，冲突合并效果的核对并入既有的 `application/conflictMerge.ts`。
- **G2 composition 只装配**：7 个组合文件保留装配入口、选择与转出的名字，从新位置取核对；这 28 行不再在组合层。
- **G3 账本与锁**：`composition-control-flow-source-control` 148 → 120（按实测）；`rfc294-architecture-preflight` 的符号根允许清单里两个经 public
  participants 转出的 `require*` 随声明位置更新；钉着这些文件的其余用例仍通过；新增 RFC-511 用例。

## 3. 非目标

- 装配期选择；`repositoryMirrors.ts` 的缓存仓库用例；`crewstation*` / `taskImage*`（RFC-370 余项）；其余模块。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；7 个组合文件不再有这 28 行核对，从新位置取核对；装配入口、选择函数与转出的名字不变。
- **AC-2**：同样输入下，每个核对接受与拒绝的输入、抛出的错误类型与文案与此前一致；核对的先后与时机不变。
- **AC-3**：新位置的依赖面是闭集：只取本模块的 application、`application/ports` 与 public 的类型，不取 infrastructure、composition、bootstrap 与其他
  模块，不用进程全局；public surface 不升；`composition-control-flow-source-control` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
