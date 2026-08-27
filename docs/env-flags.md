# 环境变量登记表（`AGENT_WORKFLOW_*` / `AW_*`）

> RFC-284 T26（审计 N26 / D 账）——本表是全部同形 token 的**唯一登记面**。
> `packages/backend/tests/rfc284-env-flags-registry.test.ts` 扫描
> `packages/backend/src` 与 `packages/shared/src`：源码里出现而本表未记载的
> token 直接红。新增开关时**先写这里**（含读取点与语义），再落代码。
> 各变量语义以「读取点」源码为准，本表只做索引。

## 运维 / 部署面（daemon 自身读取）

| 变量                                      | 读取点                                            | 语义                                                                                 |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `AGENT_WORKFLOW_HOME`                     | `backend/src/util/paths.ts`                       | app home 根目录覆盖（worktrees / skills / runs 等全在其下）                          |
| `AGENT_WORKFLOW_VERSION`                  | `backend/src/util/version.ts`                     | 版本号覆盖（dev/测试）；优先于构建期注入值，双缺省 `0.0.0-dev`                       |
| `AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK`     | `backend/src/cli/start.ts`                        | `=1` 跳过单二进制完整性自检——最后手段、不安全，错误提示里明示                        |
| `AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS`      | `backend/src/cli/start.ts`                        | dev 模式下单实例 flock 交接的等待毫秒数                                              |
| `AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY` | `backend/src/cli/start.ts`                        | 仅与 dev lock handoff 同时启用：类型包同 revision 漂移时使用内存草稿，不改冻结 DB 行 |
| `AGENT_WORKFLOW_OPENCODE_BIN`             | `backend/src/services/runtime/opencode/driver.ts` | opencode 默认 head 覆盖（runtime 行 / config 均未指定时；RFC-143 起保留的历史通道）  |

## 框架 ↔ 子进程契约（daemon 写入、child 读取）

| 变量                                                               | 写入点                                                                                    | 语义                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AW_ENVELOPE_NONCE`                                                | `backend/src/services/scriptRun.ts`                                                       | script 节点输出信封 nonce（防内容伪造信封；转义坑见 `envelope.ts` 注释）                                                                                                                |
| `OPENCODE_AW_INVENTORY_OUT`                                        | `packages/shared/src/inventory.ts`（协议常量）                                            | opencode dump 插件把启动 inventory JSON 写到该路径，框架运行后读回                                                                                                                      |
| `AW_GIT_CRED_HOST` / `AW_GIT_CRED_FILE`                            | `backend/src/main.ts`（credential-helper 子命令模式读取）                                 | 内部 git credential helper 通道（路径/host 而非明文密钥，RFC-205）                                                                                                                      |
| `AW_ADAPTER_SINK` / `AW_EXTERNAL_ID` / `AW_ADAPTER_CONNECTION_REF` | `backend/src/modules/integration/infrastructure/developmentAdapterRunner.ts`              | RFC-310 adapter 子进程契约：one-shot staged sink 目录、requirement 外部需求 ID，以及已发布 Adapter 定义冻结的连接引用（无连接时不注入；env 从空对象构造，只含 PATH/HOME/TMPDIR + 本族） |
| `AW_ADAPTER_QUESTIONS`                                             | 同上（questions.writeback 操作时）                                                        | 问题集 JSON 随 env 传给 adapter（小 payload；大字节仍走 sink 文件）                                                                                                                     |
| `AW_REQUIREMENT_MOCK_URL`                                          | `backend/src/modules/integration/composition/requirementSource.ts`（透传）；mock CLI 读取 | system-mocks E2E 座席：平台进程 env 存在该名时透传给 adapter 子进程，供 requirement-adapter-cli 找到 mock 上游；真实 adapter 走 connectionRef，不依赖此透传                             |
| `AW_EVENT_INPUT_FILE`                                              | `backend/src/modules/event-center/infrastructure/customEventObserverProgram.ts`           | 自定义事件观察程序的只读 input envelope 文件；大结果不经 env 传递                                                                                                                       |
| `AW_EVENT_OBSERVER_PROTOCOL`                                       | 同上                                                                                      | 自定义事件观察程序必须遵守的版本化 stdout envelope 协议标识                                                                                                                             |

### script 节点上下文族（`backend/src/services/scriptRun.ts` 组装）

`AW_WORKTREE`、`AW_TASK_ID`、`AW_NODE_ID`、`AW_NODE_RUN_ID`、`AW_RETRY_INDEX`、
`AW_ITERATION`、`AW_SHARD_KEY`、`AW_RUN_DIR`、`AW_INPUT_DIR`、`AW_DEPS_DIR`、
`AW_OUTPUT_MODE`、`AW_REPOS_JSON`、`AW_PORT_NAMES`、`AW_PORT_<NAME>`、
`AW_PORT_FILE_<NAME>`（大端口落盘间接层，`packages/shared/src/scriptNode.ts`）、
`AW_PORT_MY_PORT`（同上，保留名）、`AW_PORT_DIFF`（`backend/src/services/scriptPorts.ts`，
diff 端口的免拷贝特例）、`AW_PORT_PROMPT`（RFC-310 PR-11 数字员工 program 步骤：合成的
script host 快照只有 `prompt` 一个输入端口，程序从这里拿平台提示词——见
`backend/src/modules/task-execution/domain/digitalEmployeeHost.ts`）、`AW_PORT_CONTRACT_INPUT` /
`AW_PORT_FILE_CONTRACT_INPUT`（RFC-310 PR-19 平台执行合同：小输入直接注入，超过 script
端口阈值后只保留落盘文件路径；定义点
`backend/src/modules/execution-contract/domain/model.ts`）。语义契约见 script 节点相关 RFC / 源码；
此处只登记名字防漂移。

### development pipeline adapter 上下文族（`backend/src/modules/integration/infrastructure/developmentAdapterRunner.ts` 组装，RFC-310 PR-6）

pipeline-gate adapter 子进程的最小 env 面（空环境构造 + 固定基础变量之外的叠加）：

`AW_PIPELINE_HEAD`（采集/触发/重跑锚定的 MR head sha）、`AW_PIPELINE_TARGET`（collect 的
target 引用）、`AW_PIPELINE_GATES`（collect/trigger 的 gate key CSV）、`AW_PIPELINE_GATE`
（rerun 的单 gate key）、`AW_IDEMPOTENCY_KEY`（trigger/rerun 的平台幂等键，provider 幂等面
与 response-lost adopt 的依据）、`AW_PIPELINE_MOCK_URL`（system-mocks 上游座席，仅测试/装配
注入；`packages/system-mocks/src/development/pipeline-adapter-cli.ts` 消费，另有测试后门
`AW_PIPELINE_FIXTURE_JSON` 喂本地 fixture 防「子进程→回环 HTTP」坑）。`AW_ADAPTER_SINK`/
`AW_EXTERNAL_ID` 等 requirement 族沿用既有登记。

### development approval adapter 上下文族（同 `developmentAdapterRunner.ts` 组装，RFC-310 PR-12）

外部审批 gateway adapter 子进程的最小 env 面（与 pipeline 族同一个空环境构造，按 op 叠加）：

`AW_APPROVAL_STEP_RUN`（submit：发起该审批的 step run 引用）、`AW_APPROVAL_DRAFT_REF`
（submit：Agent/script 准备好的审批材料 blob 引用——平台只传引用，不传正文）、
`AW_APPROVAL_DEADLINE`（submit：平台侧 deadline，供 provider 呈现，不由 provider 决定）、
`AW_APPROVAL_INTENT_DIGEST`（submit：意图内容寻址指纹，重放对拍用）、
`AW_IDEMPOTENCY_KEY`（submit/lookup 共用的平台幂等键——response-lost 后按它 lookup 认领，
绝不重复提交）、`AW_APPROVAL_CORRELATION_REF`（observe：provider 回执的关联引用）、
`AW_APPROVAL_MOCK_URL`（system-mocks 上游座席，仅测试/装配注入；由
`backend/src/modules/integration/composition/approvalGateway.ts` 从平台进程 env 透传给子进程，
`packages/system-mocks/src/development/approval-adapter-cli.ts` 消费。真实 adapter 走
connectionRef，不依赖此透传）。

### 代码能力脚本上下文族（`backend/src/modules/code-capability/application/capabilityScriptRun.ts` 组装，RFC-304）

本族有两类使用者，共用同一套装配（design D4 明令**不得**出现第二套脚本执行实现）：

- **钩子**（`hookRunner.ts`）——挂在**阶段边界**上，不是工作流节点，没有 node / 画布位置 / 端口；
- **监视器四脚本**（`monitorScripts.ts`，T35）——采集 / 分类 / 仲裁 / 选型，部门层提供。

两者都复用 script 节点的 `assembleScriptEnv`（RFC-304 T7 已把它与 `WorkflowNode` 解耦）与受管
子进程，因此上面那一族 `AW_*` 同样可见；**本族是额外叠加的工作项上下文**（design §4.3 F10）：

`AW_CWI_CAPABILITY`（能力名）、`AW_CWI_ANCHOR_KIND` / `AW_CWI_ANCHOR_ID`（跟进对象：MR / issue /
pipeline 及其编号）、`AW_CWI_ROUND_ID` / `AW_CWI_ROUND_SEQ`（本轮标识与序号）、
`AW_CWI_BASELINE_SHA`（本轮基线，空串表示未定）。

钩子额外可见：`AW_CWI_STAGE` / `AW_CWI_PHASE`（挂载点与 pre/post）、`AW_CWI_INJECTABLE`（该挂载
点**允许注入的键**的 JSON 数组——告知而非静默丢弃，便于作者调试为何注入没生效）。

监视器脚本额外可见：`AW_CWI_SCRIPT`（本次是四步中的哪一步，让一个适配文件能实现多步）、
`AW_CWI_INPUT_FILE`（上一步输出的 JSON 落盘路径）。**读输入一律走这个文件**：标准端口协议在
32 KiB 以上会把 `AW_PORT_INPUT` 换成落盘文件并**故意不留内联变量**（防止读半个值当全值），
于是只认内联变量的适配脚本会在评论最多、最需要监视器的那些 MR 上 `KeyError`——该文件无论大小
恒定写入，只有一种读法。

这些键在装配之后写入，**作者 env overlay 覆盖不了**：它们是平台身份而非可配置项。

### RFC-333 人工门 decision commit→wake 进程 E2E 屏障（仅专用测试二进制）

`AW_E2E_HUMAN_GATE_DECISION_BARRIER_DIR`（专用 E2E 二进制在 decision 已提交、wake
尚未发生的窗口写入就绪文件，并等待测试进程放行）、
`AW_E2E_HUMAN_GATE_DECISION_BARRIER_KIND`（可选的 `review` / `clarify` / `questions` 精确门类型）。
两者只在构建期 `AW_E2E_BUILD=true` 的 test-only artifact 中生效；正式二进制把该构建期
define 固定为 `false`，所以同名进程变量不会暂停正式服务。

## 同形非 env（TS 符号 / 构建期注入 / 模板哨兵——**不是**环境变量）

| token                             | 位置                                                                              | 实为                                               |
| --------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| `AW_E2E_BUILD`                    | `scripts/build-binary.ts` → `backend/src/services/humanGateDecisionE2eBarrier.ts` | 构建期 test-only binary 布尔开关                   |
| `AW_BUILD_VERSION`                | `scripts/build-binary.ts` → `backend/src/util/version.ts`（`declare const`）      | 构建期 define 注入的全局常量                       |
| `AW_INTERNAL_GIT_IDENTITY`        | `backend/src/util/git.ts`                                                         | 导出的 TS 常量名（内部 git spawn 的身份 env 集合） |
| `AW_MANAGED_PROCESS_LAUNCH_ERROR` | `backend/src/services/execution/managedProcessLauncher.ts`                        | launcher stderr 失败控制帧前缀（不是环境变量）     |
| `AW_MANAGED_PROCESS_LAUNCH_READY` | `backend/src/services/execution/managedProcessLauncher.ts`                        | launcher stderr 就绪控制帧前缀（不是环境变量）     |
| `__AW_CODEHOST_VAR_`              | `packages/shared/src/codeHost/template.ts`                                        | code-host 模板变量哨兵前缀                         |

## 已删除

| 变量                                 | 处置                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS` | RFC-284 T26 删除：`/api/runtimes/status` 探针超时的测试注入改走 `runtimeDiagnosticTestDependencies.probeTimeoutMsForTest`（deps 缝），生产恒 5s 默认 |
