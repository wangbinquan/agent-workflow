# RFC-412 实施计划

**前置**：RFC-411 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-412-T1 | 端口 `application/ports/{commitPush,readonlyInspection}.ts`；`TaskMechanicsState` 迁入 composition 并改指全部 import | design §1、§2 |
| RFC-412-T2 | `maybeRunCommitPush` 迁入 `engine/node/commit-push/`、`inspectReadonlyRepos` 迁入 `engine/task/`，只做端口替换；`composition/commitPushBinding.ts` | design §1、§4 |
| RFC-412-T3 | `taskDagScope` / `taskEngineApplication` 改用绑定；`buildContainerMap` 调用方改用 shared；兼容再导出删除；删除 `SCH` | design §1 |
| RFC-412-T4 | 守卫与用例：新结构锁（含负例）、端口绑定用例；design §5 所列守卫改指；全仓 grep 旧路径；Windows paths 与 suite | design §5、§6 |
| RFC-412-T5 | 集中验证：静态检查、针对性验证集（全部架构测试与提交推送 / 只读巡检 / scope / 取消 / 恢复用例）、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI | design §4 |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **提交会话的 task 级字段由绑定补**：引擎经 `ports.runtime.runAgent(request, launch)` 发起，绑定按原文逐项补
   `observationInvocations` / `memorySnapshots` / `memoryInjectionQueries` / `runtimeSessionLeases` / `runtimeRegistry` / `persistence` / `signal`，
   **不**复用 agent 绑定的 `withTaskRunFields`（它会多补 `subagentLiveCapture`，原提交会话从不传）。
2. **仓库工作区工厂每次一份**：绑定在 `createAutoCommitPushPorts` / `createReadonlyInspectionPorts` 构造时选一次工厂，逐仓 status 与
   `runCommitPush` 的 deps 共用它——与原函数入口处选一次的时机相同。
3. **`readCommitExcludePatterns` 收窄参数**：只取 `operationConfiguration` / `configPath` / `commitPushExcludePatterns` 三个字段，用例的
   对象字面量随之去掉无关字段。
4. **账本**：commons-debt 删去 scheduler → task-execution composition 的 1 条 R1 边（216 → 215）；`architectureReport.ts` 删去两个 legacy
   归属与 scheduler 的符号波次特例；RFC-395 选择语义账本的提交父 run 站点随主体迁移（source 文本不变）；Windows 两份 `paths:` 换成新文件。

守卫与用例（T4）：读 scheduler 源码的锁——存在性断言改读新 owner（RFC-200 / 292 / 345 资源目录合同读引擎与绑定、RFC-282 B2 的合成注入
计数读绑定（仍 3 处）与「提交会话线程化取消信号」改为引擎的 `ports.runtime.runAgent(` + 绑定的 signal、runtime-freeze 读引擎、
subagent live capture 计数读绑定（仍 1 处）、RFC-066 / RFC-395 checkpoint / shared 三连并集清单换成新文件），缺席断言改为「scheduler 文件
不存在」（RFC-143 / 331 / 332 / 334 / 339）；RFC-339 的 legacy 清单删去已迁入 composition 的状态文件、状态锚点改读新路径；RFC-248 的绑定
锚点与「巡检不在提交体内」改读引擎；RFC-409 端口绑定用例的提交推送锚点更新；4 个直接调用 scheduler 函数的用例改用引擎 + 绑定或 owner；
`TaskMechanicsState` 的 31 处 import 改指；新结构锁 `rfc412-scheduler-residue`（owner 唯一、两个已删文件不复活不被引用、`TaskMechanicsState`
只在 composition、两个 engine 文件的 import 层级、source-control legacy 只在绑定，均带纯伪造输入的负例）与端口绑定用例 `rfc412-port-bindings`；
guard-manifest 新增一条、同步七个守卫行数。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning；prettier 通过（含 Windows
  workflow）；shared 的三连并集清单用例通过。
- **实现门**（本会话自审，只审功能）：提交推送与只读巡检逐段 diff，差异全部是端口替换（任务事实、取消信号、运行历史、运行时解析 / 冻结 /
  会话运行、node-run 铸造、提交节点 id 与提示词、仓库 status、提交运行器与写锁、配置）；引擎去掉的 task 级字段由绑定按原文逐项补回（无
  `subagentLiveCapture`），工作区工厂在端口构造时选一次。PASS。
- **针对性验证集**（6 worker，17 分钟，负载约 8～22）：全部架构测试与守卫命名的测试、提到提交推送 / 只读巡检 / 执行状态 / scheduler 的用例、
  经测试拓扑与 each-provider 夹具驱动整任务的用例，共 439 个；14 个失败。6 个是本 RFC 引入的锚点失败——另有 17 个用例以路径段
  （`'services', 'scheduler.ts'`）读 scheduler，第一轮清单的关键词没扫到其中 7 个；全部改读新 owner（提交推送引擎 / 只读巡检 / 绑定），
  RFC-098 的循环正则与 RFC-287 T9 的提交运行器 import 随之改写，RFC-287 T1 的 scheduler 源码锁清单删去改指的 17 个；其余 8 个为 PG 超时。
- **第二轮**（3 worker）：这 14 个、修过的锚点用例与两个新用例共 16 个，全部通过；第一轮清单外的 7 个另跑通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `S/services/{scheduler,execution/taskMechanicsState}.ts`、`TE/composition/*`（`TaskMechanicsState` 的 import）、`TE/engine/node/commit-push/*`、
  `TE/engine/task/readonlyInspection.ts`、`TE/application/ports/{commitPush,readonlyInspection}.ts`、`TE/infrastructure/taskRouteRepairOperations.ts`；
- 守卫与账本：见 design §5。

## CI（AC-6）

- **`76a8db35d`**：windows-platform `41334034610` success。主 CI `41334034519`：66 success；失败四格——继承自 RFC-410 的 Markdown link check
  （`15cca7442` 已修）；backend 分片 12/44（`rfc187-zero-delta-done` 读本 RFC 删除的 `services/execution/taskMechanicsState.ts`，ENOENT）与
  44/44（test-suite-policy「every source path a test reads at module scope still exists」列出同一条），属本 RFC 引入——该用例按路径段
  `'services', 'execution', 'taskMechanicsState.ts'` 读源码，改名半径漏扫，已由 `0ae7901c8` 改读 `composition/taskMechanicsState.ts`；
  `CI required` 随之失败。
- **后继证据**：`0ae7901c8`（本 RFC 提交是它的祖先；其后对本 RFC 代码文件的改动只来自本会话的后继提交，内容保留）的主 CI `41342269352` 70 个 job 全部 success；windows-platform 在包含本 RFC 的 `76a8db35d` 上 `41334034610` success。AC-6 关闭。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [x] 推送后 CI 全绿（AC-6，以后继证据关闭，见「CI（AC-6）」）
