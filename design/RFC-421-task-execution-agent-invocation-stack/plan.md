# RFC-421 实施计划

**前置**：RFC-420 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                      | 依据          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-421-T1 | application：`agentInvocationPreparation.ts`、`systemAgentRun.ts` 的 `createSystemAgentRunFamily`、`runtimeSmoke.ts` 的冒烟核心与材料声明 | design §1     |
| RFC-421-T2 | infrastructure/local：`agentInvocation.ts`、`agentInvocationPreparation.ts`；删除六个 composition 文件，取用方改 import                   | design §1     |
| RFC-421-T3 | 守卫与用例：结构锁（含负例）、端口绑定用例；RFC-328 / RFC-294 / RFC-376 账本改指；源码锁改指；guard-manifest；Windows；全仓 grep          | design §4、§5 |
| RFC-421-T4 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                                         | design §3     |

## 实施记录

T1～T3 完成（本会话实施），与落档设计无偏差。

1. **application**：
   - `agentInvocationPreparation.ts` 与原文件只差两条相对 import；
   - `createSystemAgentRunFamily`、`createRuntimeSmokeRunFamily` 与原 `compose…` 只差函数名；
   - `createRuntimeSmokeMaterialIntent`、`runPreparedRuntimeSmoke` 逐字迁入；
   - 两个文件补上 `createLogger`、`randomBytes` 与 runtime-management public 类型的 import（application 既有先例）。
2. **infrastructure/local**：`agentInvocation.ts`、`agentInvocationPreparation.ts` 与原文件只差相对 import；`nativeTaskAgentRun.ts` 改为同目录
   取用适配器，原先对 composition 的 import 消失。
3. **取用方**：五个运行 family、两个 legacy 服务与 RFC-370 用例改 import / 改名，各家逻辑不动。
4. **守卫与账本**：
   - 新结构锁 `rfc421-agent-invocation-stack` 与端口绑定用例 `rfc421-port-bindings`；
   - RFC-328 任务 effect 边界登记（含负例）与 provider 桥接债两条改指新文件；
   - RFC-294 预检与 RFC-376 跨模块边清单各两条改指（保持排序）；
   - `architecture/commons-debt.json` 里两个 legacy 服务对适配器的 R1 内部边改指新路径；
   - 两处读源码的锁改读新文件；
   - guard-manifest 新增一条并刷新 RFC-294 预检的行数；
   - Windows 两处 `paths:` 中五个被删路径换成后继文件、补上本 RFC 用例，suite 补上。

## 集中验证（T4）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0、0 个错误；改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过（四个
  只改 import 的文件因行宽由 `prettier --write` 折行，差异只在改动行）。
- **实现门**（本会话自审，只审功能）：六块主体与原文件做空白不敏感比对，归一化 import 与两处改名后全部相同；取用方只改 import / 改名。PASS。
- **针对性验证集**（6 worker，负载约 9～20）：429 个文件（全部架构与守卫测试、`test-suite-policy`，以及提到 agent 调用 / 系统代理 / 运行时冒烟 /
  诊断 / 任务代理运行 / 进程 effect / 材料 / commons-debt 的用例），426 个通过，本 RFC 的结构锁、端口绑定用例与全部改指的锁、账本均在内；
  3 个为负载下 PostgreSQL lane 的 5 s 超时。
- **第二轮**（3 worker）：3 个全部通过。
- **第三轮**（单进程，本候选与基线 HEAD `d9a5aefaa` 的导出对照）：3 个在两侧均通过（5 s / 4 s、8 s / 7 s、9 s / 8 s），判为负载超时，不归本 RFC。
- **按已提交源码生成报告的用例**：`rfc376-report` 与 `rfc370-committed-architecture-source` 在「HEAD 加本候选」的独立导出仓库（候选已提交，
  六个文件已删）里分别 16/16、2/2 通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`598054c42`**：主 CI `41390938703` 70 个 job 全部 success，windows-platform `41390938712` success。AC-5 成立，RFC-421 Done。

## 冲突面

- **composition**：`TE/composition/{agentInvocation,agentInvocationPreparation,localAgentInvocationPreparation,systemAgentRunFamily,runtimeSmokeRunFamily,runtimeSmoke}.ts`（删除）与五个运行 family 文件（改 import）。
- **application**：`TE/application/{agentInvocationPreparation,systemAgentRun,runtimeSmoke}.ts`。
- **infrastructure**：`TE/infrastructure/local/{agentInvocation,agentInvocationPreparation,nativeTaskAgentRun}.ts`。
- **legacy 入口**：`S/services/{systemAgentRun,runtimeSmoke}.ts`。
- **守卫与账本**：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`598054c42`，见上）
