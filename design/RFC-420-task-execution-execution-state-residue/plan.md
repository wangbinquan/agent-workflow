# RFC-420 实施计划

**前置**：RFC-419 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                                                 | 依据              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| RFC-420-T1 | application：`nodeInputs.ts` 的 `readPortInScope` / `priorFanoutConsumedJson`、`fanoutAgentResolution.ts`、`childCallInheritance.ts`；domain：`taskCollaborators.ts` | design §1         |
| RFC-420-T2 | engine：`engine/wrapper/wrapperBodyScope.ts`、`engine/kernel/mergeRecovery.ts` 的 `restoreNodeIso`                                                                   | design §1.1、§1.2 |
| RFC-420-T3 | composition：`WM` / `ANE` / `CCN` / `TEA` 改为绑定，`TMS` 清理                                                                                                       | design §1         |
| RFC-420-T4 | 守卫与用例：结构锁（含负例）、端口绑定用例；源码锁改指；语料 helper；guard-manifest；Windows；全仓 grep                                                              | design §4、§5     |
| RFC-420-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                                                                    | design §3         |

## 实施记录

T1～T4 完成（本会话实施），与落档设计无偏差。

1. **application / domain**：
   - `readPortInScope`、`priorFanoutConsumedJson` 与原 `readPort` / `priorFanoutConsumed` 做空白不敏感比对，只差参数名、一个尾逗号与一处
     `taskId: state.taskId` → `taskId` 简写；
   - `resolveFanoutAgent`、`sourcePortKindOf` 换名后逐字相同；
   - `delegatedCallActor` 的入参改为 `(delegated, { kind, ownerUserId, parentTaskId, parentNodeRunId })`；`buildChildRuntime` 的入参为窄类型
     `ChildRuntimeParent`，原写法对 `ownerUserId` 的 `as unknown as` 转换随之去掉（执行状态的任务快照本就带该字段，取值表达式
     `ownerUserId ?? undefined` 不变）；
   - 协作者投影原样迁入 `domain/taskCollaborators.ts`。
2. **engine**：挂载映射与「建日志 → 补合回 → 驱动」的顺序与原 `drive` 逐字相同；`restoreNodeIso` 经隔离端口，调用顺序与原写法一致。
3. **composition**：
   - 四个绑定只剩构造与注入；`agentResolutionResources(state)` 供两个绑定共用；`TaskScopeArgs` 改为别名，`NodeMechanicsResult` 删除。
   - 委托 actor 的绑定在调用时读 `state.opts.identityAccess.delegatedRequests`，而原写法在 NULL owner 分支之后才读。`BoundRunTaskOptions`
     把该字段定为必填，生产路径没有差别。
4. **守卫与用例**：
   - 新结构锁 `rfc420-execution-state-residue` 与端口绑定用例 `rfc420-port-bindings`；
   - 改指：RFC-285 B3、RFC-284 T20、RFC-305（委托锁与合同消费方账本）、RFC-347、RFC-292、RFC-271、RFC-193、RFC-103、RFC-282、RFC-345、
     子运行时透传锁，以及 RFC-404 / RFC-407 的符号 owner；
   - RFC-395 选择语义账本里上一次 fan-out 尝试的 `familyHistory` 站点改为新 owner（集中验证首轮由该账本发现，见下）；
   - `executionMechanismSources` 语料补入两个新文件；guard-manifest 新增一条并刷新三条行数；Windows `paths:` 与 suite 补上。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）首轮报本 RFC 新用例一处类型断言（`toEqual` 的期望对象类型过窄），改为 `as never` 后
  rc=0；改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过（本 RFC 新文件先经 `prettier --write`）。
- **实现门**（本会话自审，只审功能）：迁移主体与原文的空白不敏感比对见「实施记录」第 1、2 条；四个绑定只剩构造与注入；委托 actor 的读取
  时机差异只在必填字段上。PASS。
- **针对性验证集**（6 worker，负载约 30～70）：580 个文件（全部架构与守卫测试、`test-suite-policy`，以及提到 wrapper / fan-out / 调用节点 /
  协作者 / 闭包读 / 委托授权 / 本 RFC 各符号与文件的用例），565 个通过，本 RFC 的结构锁、端口绑定用例与首轮即改指的各锁均在内。
  - 3 个为本 RFC 引入、已修：
    - RFC-395 选择语义账本记录的 `familyHistory` 站点随 `priorFanoutConsumed` 迁走；
    - RFC-292 锁仍在绑定里找子运行时的触发上下文；
    - RFC-305 的 identity-access 合同消费方账本没有登记新文件。
  - 其余 12 个为负载下 PostgreSQL lane 的超时（5～15 s 上限）。
- **第二轮**（3 worker，负载约 10～30）：上述 15 个，加上读 guard-manifest 的三个 RFC-317 守卫与另一个读选择语义账本的用例，共 19 个，17 个
  通过；`lifecycle-property` 与 `scheduler-clarify-dispatch` 仍各有一例超时。
- **第三轮**（单进程，本候选与基线 HEAD `0804344c8` 的导出对照，负载约 9）：两者在两侧均通过（38 s / 35 s、53 s / 52 s），判为负载超时，
  不归本 RFC。
- **按已提交源码生成报告的用例**：`rfc376-report` 与 `rfc370-committed-architecture-source` 在「HEAD 加本候选」的独立导出仓库（候选已提交）
  里分别 16/16、2/2 通过；修完上述三处后同步候选再跑一次，结果相同。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`d9a5aefaa`**：主 CI `41387112670` 70 个 job 全部 success，windows-platform `41387112702` success。AC-5 成立，RFC-420 Done。

## 冲突面

- **composition**：`TE/composition/{wrapperMechanics,agentNodeExecution,childCallNodeExecution,taskEngineApplication,taskMechanicsState}.ts`。
- **application**：`TE/application/{nodeInputs,fanoutAgentResolution,childCallInheritance}.ts`。
- **engine**：`TE/engine/wrapper/wrapperBodyScope.ts`、`TE/engine/kernel/mergeRecovery.ts`。
- **domain**：`TE/domain/taskCollaborators.ts`。
- **守卫与账本**：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`d9a5aefaa`，见上）
