# RFC-416 实施计划

**前置**：RFC-415 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                                                                              | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-416-T1 | 托管调用准备：`infrastructure/crewstation/agentInvocationPreparation.ts` 原样迁入，删除 `HAI`，四个托管 run family 改 import                                                                      | design §1     |
| RFC-416-T2 | MCP 会话：`infrastructure/crewstation/mcpDiagnosticSessions.ts`（命名约定、探测、清理、恢复判定、`invocation`）；`MDR` 改为绑定                                                                   | design §1、§2 |
| RFC-416-T3 | 守卫与用例：结构锁（含负例）、端口绑定用例；RFC-328 括号锁与执行账本改指；两个用例改 import；guard-manifest；Windows paths 与 suite；全仓 grep                                                    | design §5、§6 |
| RFC-416-T4 | 集中验证：静态检查、针对性验证集（全部架构测试、test-suite-policy、托管 agent / 系统代理 / MCP 诊断 / 运行时管理 / effect 用例）、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI | design §4     |

## 实施记录

T1～T4 完成（本会话实施），与落档设计无偏差。

1. **托管调用准备**：`HAI` 全文迁入 `infrastructure/crewstation/agentInvocationPreparation.ts`，正文逐字不变（与原文件的 diff 只有十处 import 相对路径与
   文件头注释）。三个托管 run family（系统代理、运行时管理、任务运行选择）改从 infrastructure import，`HAI` 删除。
2. **MCP 会话**：`createHostedMcpDiagnosticSessions` 与原 runner 做空白不敏感 diff，差异只有三处：
   - 导出入参类型 `HostedMcpDiagnosticInput` 与回合类型 `HostedMcpDiagnosticTurn`；
   - `run` 换成 `invocation(turn, log)`；
   - 去掉 logger 创建与 `runSystemAgentCore(...)` 包装。

   命名、探测、清理、恢复判定、工作区对象与 `compile` 逐字不变。绑定 `createCrewStationMcpDiagnosticRunner` 以 `{ ...会话, run }` 返回与原文相同的六个
   成员，`run` 以同一个 logger 名、同样的核心参数调用 `runSystemAgentCore`（`retainedRef` 取调用的工作区，即原文的同一个值）。

3. **守卫与用例**：
   - 新结构锁 `rfc416-hosted-agent-invocation-infrastructure`，各项均带负例：八个符号 owner 唯一；`HAI` 不复活、不被引用；九个适配器步骤记号不在
     task-execution composition 出现；MCP 绑定不含平台 / 托管执行 / helper 调用；两个 infrastructure 新文件不 import composition；会话不 import
     系统代理核心。
   - 端口绑定用例 `rfc416-port-bindings`：会话交出的调用（工作区引用、`prepare` 先 admission 后 helper 的顺序与参数、`acknowledgeStart`、`observe`
     透传）；绑定的 `run` 经核心跑完一轮，以 prepare 失败的哨兵核对 `spawn-failed`、`retainedRef` 与 helper 未被调用。
   - 改指与登记：RFC-328 effect 括号锁与执行账本的托管进程判定改指新路径；两个 M1 用例改 import；guard-manifest 新增一条；Windows 两份
     `paths:` 与 suite 补上。

## 集中验证（T4）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过（含 Windows
  workflow、guard-manifest 与 design 文档）。
- **实现门**（本会话自审，只审功能）：
  - 调用准备与原文件 diff 只有 import 相对路径与文件头注释；
  - MCP 会话与原 runner 的空白不敏感 diff 只差 `run` → `invocation` 与核心调用移入绑定；
  - 绑定的六个成员、logger 名、核心参数（`retainScratchOnSuccess: true`、`retainedRef`、`startedAt`）与原文一致；
  - 三个托管 run family 只改 import。

  PASS。

- **针对性验证集**（6 worker，负载约 9～22）：608 个文件，含全部架构测试与守卫命名的测试、`test-suite-policy`，以及提到托管 / CrewStation / 系统代理 /
  MCP 诊断 / 运行时管理 / 冒烟 / 进程 effect / agent 调用的用例。601 个通过，本 RFC 的新锁、端口绑定用例、RFC-328 守卫与托管 M1 / M2 用例全部
  在内；7 个失败均为负载下的 5 s 超时（PG 连接随超时关闭）：`rfc359-w5`、`rfc359-w28`、`rfc395-t19`、`rfc395-v2-content-closure`、`rfc396-mr-bridge`、
  两个 `scheduler-boundary-*`，均不触及托管调用或 MCP 诊断。
- **第二轮**（3 worker）：7 个全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`80b715e95`**：主 CI `41360494822` 70 个 job 全部 success，windows-platform `41360494756` success。AC-5 成立，RFC-416 Done。

## 冲突面

- `TE/composition/{crewstationAgentInvocation,crewstationMcpDiagnosticRunner,crewstationSystemAgentRunFamily,crewstationRuntimeManagement,crewstationTaskRunSelection}.ts`、
  `TE/infrastructure/crewstation/{agentInvocationPreparation,mcpDiagnosticSessions}.ts`；
- 守卫与账本：见 design §5。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`80b715e95`，见上）
