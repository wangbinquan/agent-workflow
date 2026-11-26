# RFC-613 provider 运行期的驱动绑定必填，旧的逐次驱动直绑只供用例（RFC-294 S12 余项）

- **状态**：In Progress（2026-11-26）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  收法由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S12 第 1 项（装配的回退改为必填注入，生产代码不为用例留默认分支）；接
  [RFC-527](../RFC-527-source-control-required-selections/proposal.md) 把只供用例的选择迁入测试助手的做法。

## 1. 背景

task-execution 的 `composition/localTaskRunSelection.ts` 有一处分支（`composition-control-flow-task-execution` 的 10 行之一）：

- `bindProviderTaskRunParticipantsInput` 在 provider 运行期的入参给了驱动绑定（`taskRunBinding`）时检查后原样使用。
- 没给时退回一条旧的直绑：每次驱动从四个工厂（`taskAgentRunsFor`、`taskScriptRunsFor`、`nodeRunPromptsFor`、`portArtifactsFor`）现绑 prompt → archive →
  Agent → script，并把 provider 运行期的入参当作这些工厂的接收者。

bootstrap 从来都给绑定（单机与托管的任务运行选择各绑定一次，`daemonApplication.ts`、`daemonModules/taskExecution.ts`）；`src/` 里没有别处给出四个
工厂。旧直绑只有用例在用——生产代码为用例留着一条默认分支，正是 S12 第 1 项要清掉的形态。

## 2. 目标

- **G1**：`ProviderTaskRunBindingSelection` 只剩必填的 `taskRunBinding`；`bindProviderTaskRunParticipantsInput` 只检查给定的绑定，不再选择。
- **G2**：旧直绑（`composeLegacyTaskRunDriveBinding` 与 `LegacyTaskRunComposition`）迁为 `tests/helpers/legacyTaskRunDriveBinding.ts`，与单机选择共用
  导出的 `createLocalTaskRunConfigurationBridge`（原来文件私有的同一段桥接）。
- **G3**：用例与助手改从测试助手取旧直绑；`composition-control-flow-task-execution` 10 → 9（max 同步降），其余计数不升。

## 3. 非目标

- task-execution 组合层其余 9 行控制流（运行期绑定、门的执行上下文核对、托管运行族的夹具选项等），另议。
- 托管运行族的 `options.fixture`：生产 bootstrap 会按 MCP 诊断夹具给它，不是只供用例的分支。

## 4. 能力影响清单

无。生产路径一直给绑定，行为不变。只供用例的一项变化：旧直绑的工厂不再以 provider 运行期的入参为接收者（`this`）；全仓只有一条用例断言过这一点，
随之改写（design §2）。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：绑定必填（编译期），这个文件没有控制流、不再导出旧直绑；`src/` 里没有旧直绑与四个工厂名。
- **AC-2**：用例与助手经测试助手构造旧直绑，原用例照旧通过；改写的那条用例照旧验证每次驱动的工厂调用与内容归属。
- **AC-3**：计数 10 → 9；新增 RFC-613 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
