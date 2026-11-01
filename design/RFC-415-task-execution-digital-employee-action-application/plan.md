# RFC-415 实施计划

**前置**：RFC-414 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                                                                           | 依据          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-415-T1 | 端口：`application/ports/digitalEmployeeExecution.ts`（`DigitalEmployeeHostLaunch`、`DigitalEmployeeExecutionPorts`）、`application/ports/actionExecution.ts`                                  | design §1、§2 |
| RFC-415-T2 | 主体迁移：`application/digitalEmployeeExecution.ts`（核心与纯函数）、`application/actionExecutionRunners.ts`，只做端口替换                                                                     | design §1、§4 |
| RFC-415-T3 | 绑定：`DEE` 的 `launchDigitalEmployeeHost` 与 deps → ports 映射、纯函数再导出；环境绑定补 `taskStatus` / `workspaceEntries`；`agentActionExecution` / `scriptActionExecution` 改接；删除 `AER` | design §1、§3 |
| RFC-415-T4 | 守卫与用例：结构锁（含负例）、端口绑定用例；旧路径锚点改指；账本；Windows paths；全仓 grep                                                                                                     | design §5、§6 |
| RFC-415-T5 | 集中验证：静态检查、针对性验证集（全部架构测试、test-suite-policy、数字员工 / Reaction / 动作执行 / 执行合同用例）、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI            | design §4     |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **composition 的依赖接口复用端口类型**：`DigitalEmployeeExecutionDependencies` 改为 `extends Omit<DigitalEmployeeExecutionPorts, 'programs' |
'launchHost'>` 再加 `appHome` / `programs?` / `resolveActor` / `resourceAuthorityFor` / `launch`，读端口只在 application ports 写一份；对外形状
   不变，bootstrap 与用例的构造不动。
2. **deps → ports 的映射**：绑定以解构 + 展开构造端口对象（调用方的 deps 是普通对象，与原核心在调用时读同一属性等价），`programs` 在构造时按
   `programs ?? createFileProgramToolSource(appHome)` 选定，`launchHost` 绑到 `launchDigitalEmployeeHost`。
3. **启动主体的两个形状**：核心交出 `{ kind: 'workflow', workflowId, workflowName, workflowVersion, workflowSnapshot }` 或
   `{ kind: 'digital-employee', workflowSnapshot }`，绑定按原文补 `builtin`（false / true）与 `workflowVersion: 1`，注释随之迁入绑定。
4. **纯函数经 composition 再导出**：`buildDigitalEmployeeFixedPrompt` / `buildDigitalEmployeePlanPrompt` / `digitalEmployeeExecutionIsLive` 的现有
   import（约十个用例）不改；声明只在 application。
5. **动作环境**：`ActionExecutionEnvironment.workspaceEntries` 改为必填、新增 `taskStatus`；`createActionExecutionEnvironment` 补两者（缺省入口检查与
   RFC-414 的 `readTaskStatus`），`ActionWorkspaceEntries` 经该 composition 文件再导出给 bootstrap 的部署档案；`rfc359-t3` 的伪造环境补同样两项。

6. **legacy 依赖经端口进入（集中验证中 RFC-317 R2 账本发现）**：首轮验证里 `rfc317-module-boundary` 报四条新的「模块 → legacy」边——迁入 application
   的两个执行器直接 import 了 `@/services/execution/outcome`（核心与运行器）、`@/services/execution/executionWatch` 与
   `@/services/taskPlatformInputPaths`；这些 import 在 composition 里不计入 R2。处置：核心新增 `projectOutcome` 端口（绑定为
   `projectExecutionOutcome`），动作环境新增 `executionOutcome` / `awaitTerminal`（绑定为 `getExecutionOutcome` / `watchTaskTerminal`），
   `normalizeTaskPlatformInputPaths` 本就定义在 task-execution 的 `domain/`，改为直接取；R2 账本不变。composition 的依赖接口同时把
   `projectOutcome` 列入 `Omit`；`rfc359-t3` 的伪造环境补两项；RFC-310 OS 架构清单（`design/RFC-310-…/os-architecture-manifest.json`）里
   execution-contract `public/types` 的外部 import 由 composition 文件改记为 application 的核心与端口两个文件。

7. **删除死的 legacy 再导出**：动作执行器是 `services/taskPlatformInputPaths.ts`（只再导出 task-execution `public/operations` 的平台输入路径
   语法）最后一个生产 import 方；改为直接取 domain 后 RFC-376 `unreachable-production-files` 报它不可达（28 > 27）。按「删除优于 deprecate」删去该
   文件与 `architectureReport.ts` 里它的 legacy 归属条目，不可达计数回到 27。

守卫与用例（T4）：新结构锁 `rfc415-digital-employee-action-application`（十九个符号 owner 唯一、`composition/actionExecutionRunners.ts` 不复活不被
引用、composition 不含两个执行器的步骤、application 新文件不 import infrastructure / composition——`required-ports` 类型除外，均带负例）与端口
绑定用例 `rfc415-port-bindings`（两种主体与有无仓库场景的启动请求映射、环境的缺省入口检查与两 provider 上的状态读）；读源码的锁随 owner 改为
「composition 绑定 + application 核心」两份语料（`rfc319-task27` / `rfc368-reaction-execution-adapter` / `rfc370-v4-program-tools` /
`rfc310-digital-employee-authoring` / `rfc310-digital-employee-task-source-link`，以及 RFC-414 自己的 `rfc414-port-bindings`）；RFC-395 选择语义账本的
`inspectTask` 站点改记新路径（源文本不变）；Windows 两份 `paths:` 与 suite；guard-manifest 新增一条。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过（含 Windows
  workflow、两份 JSON 账本与 design 文档）。
- **实现门**（本会话自审，只审功能）：迁移主体与原文件逐段归一化比对——核心的解析、提示词、精确引用校验、宿主快照合成、检查与取消只差
  `deps.*` → `ports.*` 与 `launchHost` / `projectOutcome` 的端口替换，两个动作执行器只差环境端口替换（状态读、执行结果读、终态观察、入口检查）；
  `launchDigitalEmployeeHost` 的启动请求与原核心内联构造逐字段一致（两种主体、有无仓库场景）；composition 的再导出与依赖接口对外形状不变。PASS。
- **针对性验证集**（6 worker，负载约 9～30）：全部架构测试与守卫命名的测试、`test-suite-policy`，以及提到数字员工 / Reaction / 动作执行 /
  计划人审 / 程序工具 / 平台输入路径 / 执行合同的用例，共 402 个文件。首轮 6 个失败，其中 2 个属本 RFC——`rfc317-module-boundary`（迁入
  application 的执行器直接 import legacy，R2 账本多出四条边）与 `rfc310-digital-employee-os-architecture`（OS 架构清单仍记 composition 文件），
  按实施记录 6 修复；其余 4 个为负载超时。
- **第二轮**（402 个文件，修复后全量重跑）：4 个失败，其中 `rfc376-structural-guards` 的 `unreachable-production-files` 28 > 27 属本 RFC，按实施
  记录 7 删除死的再导出修复；其余 3 个为负载超时（`rfc368-implementation-gate` 的 50 ms 等待等）。
- **第三轮**（237 个文件：全部架构与守卫测试、`test-suite-policy` 与此前全部失败项）：只余 `rfc359-w5` / `rfc359-w9` 两个负载超时。
- **第四轮**（单进程、本候选与基线 `c4b025f4c` 对照）：两个文件在两侧均通过，耗时相当（4 s / 4 s、33 s / 31 s），判为负载超时，不归本 RFC。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`e90d6fc4f`**：主 CI `41355835823` 70 个 job 全部 success，windows-platform `41355835835` success。AC-5 成立，RFC-415 Done。

## 冲突面

- `TE/composition/{digitalEmployeeExecution,actionExecutionRunners,actionExecutionEnvironment,agentActionExecution,scriptActionExecution}.ts`、
  `TE/application/{digitalEmployeeExecution,actionExecutionRunners}.ts`、`TE/application/ports/{digitalEmployeeExecution,actionExecution}.ts`、
  `S/bootstrap/daemonModules/digitalEmployee.ts`、`S/bootstrap/deploymentProfile.ts`；
- 守卫与账本：见 design §5。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`e90d6fc4f`，见上）
