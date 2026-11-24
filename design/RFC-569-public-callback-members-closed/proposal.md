# RFC-569 public 合同上的四处回调成员与一处裸 typeof 收成闭合形状（RFC-294 S9 第二十四步）

- **状态**：In Progress（2026-11-24）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan S9 范围第 2 项（“开放类型 39 条收成闭合接口”）与 design §3.2。
  不改检测规则。

## 1. 背景

`PUBLIC_SURFACE_DEBT` 还有 40 条。把检测器报的位置逐个定位后（101 个类型节点），其中五条可以直接收成闭合形状，而且每一条收完代码都更简单：

| 清单条目（public 根）                                        | 开放的地方                                             | 现状                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| task-execution `TaskRouteOperations`                         | `applyRepair` 入参里的两个回调 `onAlert`、`onResolved` | 同一个模块早有闭合接口 `TaskLifecycleAlertNotices`（诊断用例在用），路由为两条路径各拼了一遍同样的广播 |
| task-execution `TerminalWorkspacePrunePolicy`                | 策略本身是一个函数类型别名                             | 两个实现、一个调用点；其余六十多处只是把它当值传递                                                     |
| resource-catalog `SkillVersionCommitHooks`                   | `before`、`after` 两个函数类型的属性                   | 只在技能写入场景里被调用                                                                               |
| development-automation `DevelopmentMissionFileView`          | `openAll`、`open` 两个函数类型的属性                   | 与本模块的 `EvidenceDownloadHandle`（两个同名方法）重复声明                                            |
| resource-catalog `AgentResourceIntegrityQueries`（经问题码） | `typeof PLUGIN_DISABLED_ERROR_CODE`                    | 常量与类型各写一处就不必经 `typeof`                                                                    |

## 2. 目标

- **G1**：五处收成闭合形状（design §1～§5）；行为不变。
- **G2**：`public-surface-deviations` 40 → 35；其余计数不升；不改检测规则。

## 3. 非目标

- 借贷式的高阶入参（source-control 的 `withPreviewIndex(operation)`、隔离工作区的 `run(act)` 等）与日志器类型：前者是不是“确属合同的形态”、后者
  怎样跨合同传递，都要先定检测规则或做法（RFC-294 design §3.2：改检测规则须经用户确认），另议。
- 能力 / 凭据 / 身份一族的条目（identity-access 四条、`IntentSkillArtifactOwner` 与同族的 `HostedIntentResourceArtifacts`、source-control 的凭据与
  工作区维护合同、system-operations 的 `ExecutionAuthorityPort`）：暂不动。
- development-automation 两个操作面上的 `unknown` 入参与返回（约四十处），另立。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：五个 public 根的闭包里不再有函数类型节点或裸 `typeof`；`PUBLIC_SURFACE_DEBT` 删去 5 条，`public-surface-deviations` 40 → 35。
- **AC-2**：行为不变：修复后的告警广播、终态工作区回收的判定与失败时不回收、技能版本提交的前后钩子顺序、需求文件下载（整份与按范围）与
  “插件已停用”问题码都与改动前相同，由既有用例与新增断言覆盖。
- **AC-3**：新增 RFC-569 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
