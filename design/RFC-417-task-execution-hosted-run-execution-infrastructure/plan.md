# RFC-417 实施计划

**前置**：RFC-416 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                           | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| RFC-417-T1 | 任务材料准备迁入 application（函数与两个接口），删除 `TMP`，改 import                                                          | design §1     |
| RFC-417-T2 | 托管运行范围与材料引用迁入 `CS/taskAgentRunScope.ts` / `CS/taskMaterialReferences.ts`；`TRS` 只剩装配                          | design §1、§2 |
| RFC-417-T3 | 执行 owner 中的逻辑迁入 `CS/`（执行工作区、能力缓存与判定、命令对账、Intent scratch 释放）；`CXE` 只剩构造与注入               | design §1     |
| RFC-417-T4 | 守卫与用例：结构锁（含负例）、端口绑定用例；RFC-414 锚点改指；用例改 import；guard-manifest；Windows paths 与 suite；全仓 grep | design §5、§6 |
| RFC-417-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                              | design §4     |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的唯一偏差是恢复证明留在 composition（集中验证中由 RFC-328 守卫发现，见下）。

1. **任务材料准备**：函数原样迁入 `application/taskAgentMaterialPreparation.ts`（与原文件函数段逐字相同），两个接口原样并入
   `application/ports/taskAgentMaterial.ts`；`TMP` 删除，本地 run family 与三个用例改 import，Windows `paths:` 中两处 `TMP` 改指新路径。
2. **托管运行范围**：`open(scope)` 主体经脚本原样抽出，只把五处闭包引用改为 `run.*`（`binding.nodeRunPrompts` / `binding.portArtifacts` / 两处
   `physical.businessTaskId` / `participants` 与 `participants.bind`），迁入 `openHostedTaskAgentRun`；入参接口 `HostedTaskRunSelectionInput` 原样搬入
   同文件。材料引用原样迁入 `createHostedTaskMaterialReferences`（只改名）。`composeCrewStationTaskRunSelection` 只剩确保物理工作区与交出运行范围。
3. **执行 owner**：
   - 执行工作区原样迁入，只改名，并删去一行已过时的 RFC-414 注释；
   - owner 改写的 helper 原样迁入；
   - 能力缓存逐字迁入，能力判定为同一表达式；
   - 恢复证明闭包留在 composition（集中验证中 RFC-328 守卫发现的本 RFC 缺陷，见「集中验证」）；
   - 命令对账与 Intent scratch 释放的主体逐字迁入，释放的执行实例由 composition 构造后传入。

   `composeCrewStationExecutionOwner` / `composeCrewStationIntentScratchRelease` 只剩构造与注入。

4. **守卫与用例**：
   - 新结构锁 `rfc417-hosted-run-execution-infrastructure`，各项均带负例：十七个符号 owner 唯一；`TMP` 不复活、不被引用；十四个适配器步骤记号
     不在两个托管 composition 文件出现；infrastructure 新文件不 import composition；application 新文件不 import infrastructure / composition。
   - 端口绑定用例 `rfc417-port-bindings`：能力缓存窗口与并发共享、能力判定、owner 改写的 helper、对账循环、Intent scratch 三条分支与成功参数、
     运行范围（引用、三类 helper 调用、调用 ID、participants）、技能暂存规则直到平台材料请求、缺版本的托管技能在任何平台请求前被拒。
   - 锚点与登记：RFC-414 工作区读锚点改指新文件；三个用例改 import；guard-manifest 新增一条；Windows `paths:` 与 suite 补上。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）首轮报本 RFC 新用例的两处类型断言（helper 伪造返回值与快照类型不符），改为显式 `as never` 后
  rc=0；修复下文守卫缺陷后再跑 rc=0。改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：任务材料准备的函数段与接口和原文件逐字相同；运行范围由脚本抽出，只有五处 `run.*` 替换；材料引用、执行工作区
  只改名（执行工作区另删一行过时注释）；能力缓存逐字相同，能力判定为同一表达式；命令对账与 Intent scratch 释放主体逐字迁移。PASS。
- **针对性验证集**（6 worker，负载约 10～25）：820 个文件，808 个通过。
  - 本 RFC 引入 1 个失败：`rfc328-architecture-guards` 报 `raw capability factory createExclusiveDaemonLockProof`。RFC-328 的 `FACTORY_ALLOWLIST`
    只允许 `composition/bootRecovery.ts` 铸造该证明，而最初设计把恢复证明闭包迁入 infrastructure 并直接调用 domain 构造。处置：恢复证明闭包
    改回 composition 原样（infrastructure 的 `bootRecovery.ts` 恢复为 HEAD），RFC-385 锚点随之回到原文件，结构锁与端口绑定用例删去相应项，
    proposal §6.3 / design / 实施记录同步。
  - 其余 11 个均为负载下的 5 s 超时（每个失败都有对应的超时）。
- **第二轮**（4 worker，143 个文件：首轮全部失败项、全部架构测试与相关用例）：140 个通过，`rfc328-architecture-guards`、本 RFC 锁与端口绑定用例、
  RFC-385、托管归档与托管 job 用例均通过；`api-code-routes`、`rfc359-w26`、`scheduler-boundary-presnapshot-rollback-skip` 仍为超时。
- **第三轮**（单进程，本候选与基线 `80b715e95` 对照）：三个文件在两侧均通过，耗时相当（49 s / 48 s、22 s / 21 s、8 s / 9 s），判为负载超时，
  不归本 RFC。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`ffde0e5f6`**：主 CI `41365632523` 70 个 job 全部 success，windows-platform `41365632483` success。AC-5 成立，RFC-417 Done。

## 冲突面

- `TE/composition/{crewstationTaskRunSelection,crewstationExecution,taskAgentMaterialPreparation,localTaskAgentRunFamily}.ts`、
  `TE/application/{taskAgentMaterialPreparation.ts,ports/taskAgentMaterial.ts}`、`CS/{taskAgentRunScope,taskMaterialReferences,executionWorkspaces,hostedCapabilities,workspaceCommandReconciliation,intentScratchRelease}.ts`；
- 守卫与账本：见 design §5。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`ffde0e5f6`，见上）
