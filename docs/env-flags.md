# 环境变量登记表（`AGENT_WORKFLOW_*` / `AW_*`）

> RFC-284 T26（审计 N26 / D 账）——本表是全部同形 token 的**唯一登记面**。
> `packages/backend/tests/rfc284-env-flags-registry.test.ts` 扫描
> `packages/backend/src` 与 `packages/shared/src`：源码里出现而本表未记载的
> token 直接红。新增开关时**先写这里**（含读取点与语义），再落代码。
> 各变量语义以「读取点」源码为准，本表只做索引。

## 运维 / 部署面（daemon 自身读取）

| 变量                                  | 读取点                                            | 语义                                                                                |
| ------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `AGENT_WORKFLOW_HOME`                 | `backend/src/util/paths.ts`                       | app home 根目录覆盖（worktrees / skills / runs 等全在其下）                         |
| `AGENT_WORKFLOW_VERSION`              | `backend/src/util/version.ts`                     | 版本号覆盖（dev/测试）；优先于构建期注入值，双缺省 `0.0.0-dev`                      |
| `AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK` | `backend/src/cli/start.ts`                        | `=1` 跳过单二进制完整性自检——最后手段、不安全，错误提示里明示                       |
| `AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS`  | `backend/src/cli/start.ts`                        | dev 模式下单实例 flock 交接的等待毫秒数                                             |
| `AGENT_WORKFLOW_OPENCODE_BIN`         | `backend/src/services/runtime/opencode/driver.ts` | opencode 默认 head 覆盖（runtime 行 / config 均未指定时；RFC-143 起保留的历史通道） |

## 框架 ↔ 子进程契约（daemon 写入、child 读取）

| 变量                                    | 写入点                                                    | 语义                                                                     |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `AW_ENVELOPE_NONCE`                     | `backend/src/services/scriptRun.ts`                       | script 节点输出信封 nonce（防内容伪造信封；转义坑见 `envelope.ts` 注释） |
| `OPENCODE_AW_INVENTORY_OUT`             | `packages/shared/src/inventory.ts`（协议常量）            | opencode dump 插件把启动 inventory JSON 写到该路径，框架运行后读回       |
| `AW_GIT_CRED_HOST` / `AW_GIT_CRED_FILE` | `backend/src/main.ts`（credential-helper 子命令模式读取） | 内部 git credential helper 通道（路径/host 而非明文密钥，RFC-205）       |

### script 节点上下文族（`backend/src/services/scriptRun.ts` 组装）

`AW_WORKTREE`、`AW_TASK_ID`、`AW_NODE_ID`、`AW_NODE_RUN_ID`、`AW_RETRY_INDEX`、
`AW_ITERATION`、`AW_SHARD_KEY`、`AW_RUN_DIR`、`AW_INPUT_DIR`、`AW_DEPS_DIR`、
`AW_OUTPUT_MODE`、`AW_REPOS_JSON`、`AW_PORT_NAMES`、`AW_PORT_<NAME>`、
`AW_PORT_FILE_<NAME>`（大端口落盘间接层，`packages/shared/src/scriptNode.ts`）、
`AW_PORT_MY_PORT`（同上，保留名）、`AW_PORT_DIFF`（`backend/src/services/scriptPorts.ts`，
diff 端口的免拷贝特例）。语义契约见 script 节点相关 RFC / 源码；此处只登记名字防漂移。

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

## 同形非 env（TS 符号 / 构建期注入 / 模板哨兵——**不是**环境变量）

| token                      | 位置                                                                         | 实为                                               |
| -------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `AW_BUILD_VERSION`         | `scripts/build-binary.ts` → `backend/src/util/version.ts`（`declare const`） | 构建期 define 注入的全局常量                       |
| `AW_INTERNAL_GIT_IDENTITY` | `backend/src/util/git.ts`                                                    | 导出的 TS 常量名（内部 git spawn 的身份 env 集合） |
| `__AW_CODEHOST_VAR_`       | `packages/shared/src/codeHost/template.ts`                                   | code-host 模板变量哨兵前缀                         |

## 已删除

| 变量                                 | 处置                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS` | RFC-284 T26 删除：`/api/runtimes/status` 探针超时的测试注入改走 `runtimeDiagnosticTestDependencies.probeTimeoutMsForTest`（deps 缝），生产恒 5s 默认 |
