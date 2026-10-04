# H4／H5 执行与材料调用者清单

状态：源码调查，2026-10-05。基准为已提交 `bba36c8960d81718987b26c100d25ff767fa3f14`；本清单没有引入执行 adapter，也没有通过 A-T5 或 A-G。当前 Candidate publication 与工作区 CI 候选不修改下表的执行函数。私有逐文件 hash／字节和 AST 调用地址留在 `aw-rfc370-execution-material-consumers-baseline.json`。

这部分的目标保持主设计 §5：task-execution 拥有 aw 中立执行合同，runtime-management 拥有协议与材料职责，平台本机进程原语及每个 owner 的本地材料实现留在 local adapter。`RuntimeKind=opencode | claude-code` 与执行目标相互独立；不能把旧 `cmd/cwd/env` 请求包装后当成 CS Agent 请求。

## 1. 当前三个 Agent 执行入口

| 当前入口                                                  | 实际装配／执行                                                      | 仍在入口中的物理材料                                                            | 必须保持的原行为                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Task／业务 Agent 的 `services/runner.ts:runNode`          | `driver.buildSpawn`（1116），`runAgentProcess`（1823）              | cwd、runRoot、configDir、taskMounts、binary、env；本机 session／子会话取证      | 全 Agent profile／注入闭包、冻结 runtime、resume／fresh、完整声明、逐行及 chunk ACK、原业务 node/effect 与 observation 顺序 |
| 系统 Agent 的 `services/systemAgentRun.ts:runSystemAgent` | `driver.buildSpawn`（442），`runAgentProcess`（531）                | scratch／seed、worktree／run 目录、可选 configDir、native session、plan cleanup | 独立系统 owner、同一规范事件流、sink 持久失败与 root-session 处理、原结果域分类和目录保留                                   |
| Runtime 测试台的 `services/runtimeSmoke.ts:smokeRuntime`  | `buildSmokePlan→driver.buildSpawn`（149），`runAgentProcess`（246） | 原 scratch、本机 binary/profile、probe 配置与清理                               | 双协议、原超时／取消、已退出尾流缺失与存活子进程的不同语义、原诊断分类                                                      |

三处共用的 `services/execution/agentProcess.ts:runAgentProcess` 在187行调用 `runManagedProcess`。当前它的 request／receipt／result 仍含 cmd、cwd、env、PID、binary path 与 launch nonce，因此只是现有本机执行机制，不是本 RFC 最终中立执行合同。

## 2. 系统入口的真实间接消费者

直接搜索 `runSystemAgent(` 不能覆盖这些入口：它们先以 `deps.runFn ?? runSystemAgent` 或 `options.runFn ?? runSystemAgent` 选择函数，再调用局部变量。后续接线必须沿实际 composition 与 application 传递，不增加全局默认执行目标。

| 当前消费者                                                                    | 实际选择地址    | 所属职责／剩余接线                                                                |
| ----------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| Intent `modules/intent/application/turnEngine.ts`                             | `runFn`（228）  | 每个 intent turn 的执行 owner、原事件 sink、超时／取消及会话重用                  |
| Memory `modules/memory/application/distill/memoryDistiller.ts`                | `runFn`（1094） | 蒸馏执行及其 schedule，原事件和候选审批流程；schedule 的 runFn 透传也属于同一入口 |
| MCP 测试台 `modules/resource-catalog/infrastructure/mcpDiagnosticsEffects.ts` | `runFn`（62）   | 每轮测试与 native-session receipt／admission，保留已完成的配置切面                |
| 变更叙述 `services/changeNarrative.ts`                                        | `runFn`（393）  | 对话／轮次执行、原 scratch 和会话取证；归其实际 owner 接线                        |

工作组 host/member、fan-out 与聚合继续沿现有 Task／node 机制进入业务 runner，不新建另一个系统执行器。commit、review 和 DE 等也要沿真实 Task／系统依赖核对；不能以本表的四个直接函数选择地址代替全部上游入口验收。

## 3. Command／脚本与其它本机效果

| 当前地址                                                                                    | 原效果                                                          | 下一步职责边界                                                                                 |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `services/scriptRun.ts:runScriptProcess`（488）                                             | 写 script／input／spill files，`assembleScriptEnv` 后执行并分类 | task-execution 的脚本意图与结果规则保留；原本机材料及进程进入完整 local 实现                   |
| `services/scriptDepsEnv.ts`（171）                                                          | 构建依赖环境的受管 command                                      | 同一脚本能力的依赖材料，不在服务槽另开一条远程模式兜底                                         |
| `modules/resource-catalog/infrastructure/local/filePluginInstallation.ts:runCommand`（780） | 安装／探测 command                                              | 既有本机插件 adapter 的内部机制；后续 CS 内容／安装 adapter 在 resource-catalog 自己的层次替换 |
| `modules/event-center/infrastructure/customEventObserverProgram.ts:execute`（80）           | 自定义 observer program                                         | event-center 保留业务归一／观测策略；program command 与本机材料必须可替换                      |
| `main.ts`（299）                                                                            | compiled doctor 的受管诊断 command                              | 启动／诊断入口按实际执行能力提示，不能把工具探针当成业务任务                                   |

真实脚本还经 `modules/task-execution/composition/nodeMechanics.ts`（3044）和独立 Execution Contract fixture adapter（124）调用 `runScriptProcess`。这两条地址也要在其实际调用者切换时保留原预算、输出模式和持久 receipt。

Git／验证／外部 development adapter 及索引器有各自已有执行机制，见原 `rfc284-spawn-site-ratchet.test.ts` 的实际库存。不能因为它们未调用上述 Agent executor 就漏掉，也不能将该原库存当作任意 command 已可远程执行的证据。H3 已抽出的 workspace／Git factory 应复用，其余入口在 A-T5／A-T7 按 owner 逐条收口。

## 4. native 原语和接线约束

原 canonical owner 表把 `agentProcess.ts`、`managedProcess.ts` 和预激活 `managedProcessLauncher.ts` 归为 platform；这三份文件不是另一套 Task 业务引擎。迁移其实际本机机制时要保持这个职责，task-execution 的中立执行合同及其业务 effect participant 另有 owner。

本机实现必须保留原两条启动路径：Task 的 required receipt 使用 launcher/nonce，持久 receipt ACK 后才激活 target；system/MCP/smoke 直接创建真实 target，保留原可选 receipt 与 PID 来源，不增加 launcher 或 callback 要求。两条路径均保留原 stdin／输出消费的等待、取消／超时与 TERM→KILL→reap、bounded pump／drain、逐行和 chunk ACK，以及未 reap 时不清理目录。普通系统辅助取证失败保持 incomplete 和有效业务结果，原 fatal/authoritative 回调保持原失败政策。原 argv/cwd request hash、Task claim／attempt、node/effect 持久规则也不能在抽取中默默换成新身份。

当前 `task-execution/application/processEffectObserver.ts` 仍读取 argv/cwd、记录 PID/binary/nonce，再按原效果规则结算。只替换 `runAgentProcess` 的调用函数尚未把这些物理字段隔离；最终合同须连同 receipt participant 和恢复读取完整接线，不能把 CS execution ID 写入 PID。

## 5. 材料拆分的完整输入

当前 `AgentSpawnContext` 不是单个 model 字段：它含根 Agent 与所有 dependents 的 `resolvedParamsByAgent`、MCP／plugins／skills、prompt／systemPrompt／memory、fresh／nativeSession／resume、冻结 binary／extraArgs、Git identity、workspace mounts，以及系统入口可省略的 configDir。省略和显式默认在原系统执行中有不同含义，不能在编译器中统一成一个默认。

下一份实施设计要逐项固定这些输入如何形成 aw-owned 冻结材料引用，以及本机实现如何从引用得到原完整 `buildSpawn` 输入。材料和执行 factory 必须在 composition 中匹配选择；选中非本机实现后不能热读旧 native hook、写服务槽文件或在不支持的组合上回退到 local spawn。协议解析、startup inventory、native usage/span 取证的真实来源与完整性也必须保持；不能从派发成功合成取证成功。

`RuntimeDriver` 还包含 `prepareUsageNormalizer`、`prepareNativeUsageCapture`、`prepareSpanCapture`、`drainFinalEvents`、`captureSessions`、`captureSessionsToSink`、`readInventory` 和 `startLiveCapture` 等本机效果或本机材料相关方法。仅拆出 `buildSpawn` 尚未隔离这些调用。`parseEvent`／`observeSystemEvent`／原结果判据和能力声明则要保留原协议职责；optional capability 缺省时保持原未支持语义。具体方法应按实际效果拆分，不能将整个旧 driver 对象改名为材料 adapter。

当前 `runtime/index.ts` 的 `DRIVERS` 保存两个既有 driver 对象，`getRuntimeDriver` 返回该对象，并对未知 protocol 抛原错误。抽取时不能未经验证改变这个对象身份、增加每次执行重新解析 mutable registry 的路径，或把未知协议转成一个隐式默认协议。System 的 `buildCtx` 与仅允许 beforeSpawn／cleanup 的 `wrapPlan` 也要连同其真正消费者一起迁移；测试专用 plan replacement 不成为生产材料接口。

本清单仅为下一步设计提供实际入口和原行为约束。中立 submit／inspect／events／message／cancel 合同、全调用者接线、H7 恢复／执行权、独立 A-G，以及后续 CS adapter 和 M0 首次部署均未据此关闭。
