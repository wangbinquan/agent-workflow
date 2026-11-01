# RFC-408 实施计划

**前置**：RFC-407 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-408-T1 | 端口 `P`：`TaskRunPorts<Admission>`、`TaskDrivePreparation` 与 `PreparedTaskDrive`，只用 task-execution 自有类型 | design §1.2 |
| RFC-408-T2 | `taskDagGraph.ts` 迁为 `engine/scope/dagGraph.ts`，改指 `taskDagScope.ts`、`services/dispatchFrontier.ts` 与用例 | design §1.1 |
| RFC-408-T3 | 主体迁入 `ET/runTask.ts` 与 `ET/taskSettlement.ts`，只做端口替换；`C` 改为 `createTaskRunPorts` + `driveTaskEngineApplication` | design §1.1、§2 |
| RFC-408-T4 | 守卫与用例：新结构锁 `rfc408-task-control-plane`（含负例）、端口绑定用例；design §3 所列守卫改指与清单补齐；Windows 两份 `paths:` 与 suite；账本按 T5 实测填值 | design §3、§4 |
| RFC-408-T5 | 集中验证：静态检查、针对性验证集（含全部架构测试与任务生命周期 / 人工门 / 取消 / workgroup / 动态工作流行为用例）、复跑、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §2 |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **端口只有一个类型参数**：资源会话的类型在 `services/`，作 `Admission` 参数；仓库挂载用 domain 已导出的 `TaskRepositoryMount`，
   不需要第二个参数。
2. **注册表在 engine 内构造**：三个引擎类由 `runTask` 以 `prepare` 返回的 `bodies` 构造（闭包与原文同为
   `taskEngineOutcomeFromScope(await body())`），ownerless 接缝调 `bodies[engine]()`。两条路径共用同一份主体，`buildNodeExecutionWorkgroupHooks`
   的构造点因此 4 → 2；三个引擎类仍是对主体的委托，主体迁入 engine 留给 scope 解释器、workgroup 轮次与动态工作流的后续 RFC。
3. **`settlementLog` 与 `log` 分开**：终态写入 helper 原本用 `createLogger('scheduler')` 而非任务 logger 记 lost-CAS 警告，端口保留这一区分。
4. **异常边界不变**：`prepare` 在驱动 try 之外调用并立即装配状态（三个池、写锁、扇出池即刻取得），合并恢复工厂、引擎主体、`runtimeConfig`
   都在 try 之内才被调用；授权与资源会话在 `admit` 内按原顺序完成。
5. **`taskDagGraph.ts` 进 `engine/scope/dagGraph.ts`**：`services/dispatchFrontier.ts` 只在注释里提到它（无 import），legacy 文件边不变。

守卫与账本（T4）：

- 按 `C` 路径取语料的锁改读新 owner：RFC-146 kind 准入、RFC-202 取消检查点、RFC-243、RFC-248 只读巡检、RFC-332、RFC-333 人工提问
  （计数 4 / 4，正则改为容忍 prettier 对更长接收者的折行）、RFC-339 scope 索引 owner、wrapper-fanout routing；RFC-164 / RFC-167 读 `C` + `runTask`
  拼接；RFC-359 W5-T19b 的缺席断言把 `runTask` / `taskSettlement` 并入语料；RFC-334 的 hook 构造点 4 → 2 并逐路径钉住 `drive.bodies`；
  守卫文件一律在文件内 `readFileSync` 读 owner（RFC-407 记下的负 fixture 判据坑）；
- 读 `taskDagGraph` 的 5 个用例改路径；
- 新结构锁 `tests/architecture/rfc408-task-control-plane.test.ts`（owner 唯一、退役名与绑定内的控制面 reason 灭绝、`engine/task/` 与
  `engine/scope/` 的 import 层级、已删文件不得复活或被引用，均带纯伪造输入的负例）；端口绑定用例 `tests/rfc408-port-bindings.test.ts`；
  Windows 两份 `paths:` 与 suite；guard-manifest 新增一条、同步四条行数。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning；prettier 通过（含
  Windows workflow）。
- **实现门**（本会话自审，只审功能）：把原编排函数体按固定替换（`opts` → 端口）规范化后与 `runTask` + `settleTaskScopeOutcome` 逐段 diff，
  35 处差异全部是预期的端口替换（授权、仓库投影、排除配置、触发器预检、准备驱动、合并恢复、动态工作流、编排节点常量、三个引擎主体、
  ownerless 接缝、驱动配置、只读巡检）；绑定一侧的状态字面量、三个引擎主体、`dynamicWorkflowArgs`、`runtimeConfig` 的字段剔除与资源会话
  的构造与原文逐字一致；异常边界（装配在 try 外、恢复 / 主体 / 配置在 try 内）与原文相同。PASS。
- **针对性验证集**（6 worker，37 分钟，负载约 8～21）：全部架构测试、本 RFC 改动的测试、RFC-407 的 fanout / wrapper / agent 行为用例，以及
  恢复 / 取消 / 人工门 / workgroup / 动态工作流 / 只读巡检 / 触发器预检 / 工作区 profile / 启动失败等用例，共 906 个；13 个失败，均为负载下
  的超时（以 PG 为主），其中 `rfc368-implementation-gate` 的一条 PG 用例为时序断言，第二轮即通过。
- **第二轮**（3 worker）：13 个里 6 个通过；跑到后段 Docker 虚拟机满载、负载升到 68，其余 7 个仍是超时。
- **第三轮**（等负载降到 15 以下，单进程）：这 7 个在候选与 RFC-407 基线（`90a7857d3` 的导出）上全部通过，逐个耗时几乎相同（例如
  `rfc396-mr-bridge` 208 s 对 202 s、`scheduler-clarify-dispatch` 49 s 对 49 s），判为负载超时，与本 RFC 无关。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `TE/composition/{taskEngineApplication,taskDagScope,taskDagGraph}.ts`、`TE/engine/task/*`、`TE/engine/scope/*`、`TE/application/ports/taskRun.ts`、
  `services/dispatchFrontier.ts`；
- 守卫与账本：见 design §3。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## CI（AC-6）

- **`7aca6d6f0`**：windows-platform `41314173155` success。主 CI `41314173016`：
  - Frontend 分片 1/3（ubuntu、windows）失败：`packages/frontend/tests/clarify-reverse-drag-two-edges.test.ts` 跨包读旧的
    `composition/taskDagGraph.ts`（ENOENT）。属本 RFC 引入——改名半径只扫了 `packages/backend`；已由 `a06fcae26` 改读 `engine/scope/dagGraph.ts`。
  - backend 分片 20/44 失败：`rfc359-w8-t28-lost-update` 的 L6 [postgresql] 在 deleteTask 认领链上撞到 PG 串行化冲突（40001，pivot），
    第二笔删除没有停到写锁上。本 RFC 未触及删除与维护认领路径；同一分片在 `57103c231` 上通过，本机在候选与 RFC-407 基线（`90a7857d3`
    导出）上各复跑 4 次全部通过，判为偶发竞态，不归本 RFC，证据已留。
- **后继证据**：`0ae7901c8`（本 RFC 提交是它的祖先；其后对本 RFC 代码文件的改动只来自本会话的后继提交，内容保留）的主 CI `41342269352` 70 个 job 全部 success；windows-platform 在包含本 RFC 的 `76a8db35d` 上 `41334034610` success。AC-6 关闭。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [x] 推送后 CI 全绿（AC-6，以后继证据关闭，见「CI（AC-6）」）
