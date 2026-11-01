# RFC-413 实施计划

**前置**：RFC-412 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                                                                                                 | 依据          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-413-T1 | 端口：`application/ports/isolationMechanics.ts`；`wrapperWorkspace.ts` / `wrapperRunLedger.ts` 增 engine 端口；`IsoSubmoduleTopology` 类型名；`snapshotIsolatedWorkspace` 端口类型补 `forcedPaths`                   | design §1、§2 |
| RFC-413-T2 | 主体迁移（原样，只做端口替换）：`engine/kernel/{mergeRecovery,wrapperIsolation}.ts`、`engine/wrapper/{wrapperWorkspace,wrapperRunLedger}.ts`                                                                         | design §1、§4 |
| RFC-413-T3 | 绑定：`composition/isolationMechanicsBinding.ts`；`wrapperMechanics.ts` 只剩绑定；`wrapperRuntime.ts` 接账本端口与状态发布；`agentNodeExecution` / `runtimeAssembly` / runtime participants 改接；删除 `EMR` / `WRL` | design §1、§3 |
| RFC-413-T4 | 守卫与用例：新结构锁（含负例）、端口绑定用例；design §5 所列守卫改指与账本；Windows 两份 `paths:` 与 suite；全仓（`packages/`、`e2e/`、`scripts/`、`design/` 链接）grep 旧路径                                       | design §5、§6 |
| RFC-413-T5 | 集中验证：静态检查、针对性验证集（全部架构测试与 wrapper / 合并恢复 / 冲突 / 续跑 / 隔离用例）、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                                                      | design §4     |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **wrapper 合回经 kernel 绑定的工作区端口**：`ExecutionIsolationWorkspace.snapshotIsolatedWorkspace` 的端口类型补上可选 `forcedPaths`
   （实现早已接受）；合回调用 `ports.binding.workspace.snapshotIsolatedWorkspace / mergeIsolatedWorkspace`，绑定里就是原文直接 import 的
   同一对 infrastructure 函数，不新增端口方法。
2. **子模块拓扑在绑定里转换**：kernel 传 domain 形状（`parseIsoSubmodules` 的返回值，类型名 `IsoSubmoduleTopology`），恢复绑定按原文用
   infrastructure 的 `restoredSubmodules` 转换；kernel 不传时绑定也不加该键（同原文只做 discard 的重建）。
3. **场景表归 engine**：`createWrapperWorkspace(ports, log)` 返回 `{ port, resolve }`，composition 的 scope driver 用 `resolve` 取隔离句柄与
   wrapper 类型来组装 nested 执行状态；场景表仍是每个 `createWrapperMechanicsPorts` 一份。
4. **账本的 `scheduler` logger 由绑定的 getter 现取**：`createLogger('scheduler')` 与原文一样在写日志时才构造。
5. **装配落位**：`composeExecutionMergeRecovery` 与 `createIsolationMechanicsPorts` 在 `composition/isolationMechanicsBinding.ts`
   （`runtimeAssembly` 与 runtime participants 改从这里取）；`createWrapperStatusPublisher` 与 `createWrapperRunLedgerPorts` 在
   `composition/wrapperRuntime.ts`；`wrapperMechanics.ts` 730 → 约 295 行，只剩 data / scope driver 转发、工作区与 fanout 端口构造。
6. **注释改指**：`domain/wrapperProgress.ts` 的 preDirty 上限出处改指 `engine/wrapper/wrapperWorkspace.ts`；`wrapperMechanics.ts` 的 RFC-040
   段落补一行新落位。

守卫与用例（T4）：直接 import 被迁符号的 5 个用例改从 engine / 绑定取（`rfc144-stale-replay-regression`、`single-nonroot-member-workspace`、
`iso-single-nonroot-member-replay` 经 `createIsolationMechanicsPorts` 驱动 kernel，`rfc370-isolation-workspace-bindings`、
`rfc370-wrapper-gate-handoff` 改接绑定）；按路径读源码的锁改读新 owner——`executionMechanismSources` 的 `WRAPPER_MECHANICS_SOURCE`
并入两个新 owner 并新增四个源码常量，RFC-188 / 210 / 230 / 287-t9 / 339 / 395 checkpoint / RFC-066 两份 / `wrapper-git-list-path` /
`scheduler-wrapper-fanout-routing` / `rfc407-port-bindings` 的锚点随 owner 改指（RFC-188 的原语计数、RFC-210 的 discard 带锁棘轮在新语料上
逐项相等；RFC-339 的恢复顺序断言原先第一半已是空断言，改为锚定 `completeFrameMerges(... containerRunId: null ...)` 先于人工冲突重放），
RFC-287 T1 五个扫描用例的语料并入两个新 owner；RFC-317 allowTerminal 账本的 wrapper 再认领站点改记新文件（总数不变），RFC-402 kernel
文件数 7 → 9；新结构锁 `rfc413-wrapper-workspace-merge-recovery`（31 个符号 owner 唯一、两个已删文件不复活不被引用、三个绑定文件不含
14 种机制调用、kernel / wrapper 新文件的 import 层级，均带纯伪造输入的负例）与端口绑定用例 `rfc413-port-bindings`（绑定逐项转发；
伪造端口驱动帧恢复的跳过与顺序、git 入口快照的 preDirty 上限降级与改动文件扣减）；Windows 两份 `paths:` 与 suite、guard-manifest 新增一条
并同步六个守卫的行数；`docs/dev-gotchas.md` 补「搬家 RFC 的验证集必须含 test-suite-policy」。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning；prettier 通过（含 Windows
  workflow）。
- **实现门**（本会话自审，只审功能）：四块主体按归一化（端口替换折叠）逐段 diff——恢复只差子模块拓扑转换移入绑定与 compose 改为 engine 入口；
  wrapper 隔离只差同一转换与 `mergeBackWrapperIso` 导出；工作区只差场景表 `kind` 的类型与 `ports.isolation`；账本只差 logger 来自端口。
  composition 侧 scope driver 经 `resolve` 取同一张场景表，内层帧恢复的端口建在 nested 状态上。PASS。
- **针对性验证集**（6 worker，负载约 9～40）：全部架构测试与守卫命名的测试、提到 wrapper / merge_state / 隔离 / wrapper 进度 / 账本 /
  执行机制源码 helper 的用例，加 `test-suite-policy`、`rfc187-zero-delta-done` 与 shared 的 `wrapper-kind-single-source`，共 631 个文件；
  10 个失败，全部是 PostgreSQL lane 的负载超时或时序（SQLite lane 均通过），无本 RFC 引入的失败。
- **第二轮**（3 worker）：这 10 个里 8 个通过；`lifecycle-property`、`rfc359-w26-workgroup-empty-scan` 仍只以 PG 超时失败。
- **第三轮**（负载降到 16 以下，单进程，候选与 RFC-413 基线 `0ae7901c8` 的导出各跑一次）：两个都在两侧通过，耗时一致——`lifecycle-property`
  32 s / 32 s、`rfc359-w26` 20 s / 20 s；判为负载超时，与本 RFC 无关。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `TE/composition/{wrapperMechanics,executionMergeRecovery,wrapperRunLifecycle,wrapperRuntime,agentNodeExecution,runtimeAssembly}.ts`、
  `TE/infrastructure/taskExecutionRuntimeParticipants.ts`、`TE/engine/kernel/*`、`TE/engine/wrapper/*`、
  `TE/application/ports/{isolationMechanics,wrapperWorkspace,wrapperRunLedger,executionKernel}.ts`、`TE/domain/isoSubmodules.ts`；
- 守卫与账本：见 design §5。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## CI（AC-6）

- **`7f8abe5a0`**：主 CI `41346141897` 70 个 job 全部 success；windows-platform `41346141884` success（含本 RFC 的端口绑定用例与结构锁）。
  AC-6 在 exact SHA 上成立。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-6，见「CI（AC-6）」）
