# RFC-418 实施计划

**前置**：RFC-417 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                         | 依据          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-418-T1 | 端口：`application/ports/providerBackground.ts`                                                                              | design §2     |
| RFC-418-T2 | 主体迁移：`application/providerBackground.ts`，只做端口替换                                                                  | design §1     |
| RFC-418-T3 | 绑定：`PB` 构造端口、`start` 映射；对外名字与类型不变                                                                        | design §1、§2 |
| RFC-418-T4 | 守卫与用例：结构锁（含负例）、端口绑定用例；读 `PB` 的锁改指；import 改指；guard-manifest；Windows paths 与 suite；全仓 grep | design §5、§6 |
| RFC-418-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                            | design §4     |

## 实施记录

T1～T5 完成（本会话实施），与落档设计无偏差。

1. **主体迁移**：`application/providerBackground.ts` 由脚本从 `PB` 生成，与原文的空白不敏感 diff 只有 design §1 表中的端口替换。变量名
   `runtime` / `dependencies` / `loops` 保留，读源码的锁的记号（循环名、pause / stop 片段、`runtime.module.pause(` / `.dispose(`、
   `await runtime.lifecycleRepair.run({`、`isPeriodicReconcileDue({`、`lastReconcileAt = now`）原样成立。
2. **端口**：执行模块与停止票据以泛型 `TTicket` 表达。节奏是四个 getter，清扫是两个。启动入参的 `scheduled.runDue` 只收
   `{ maxFailures, defaultRuntime }`。
3. **绑定**：`composeTaskExecutionProviderBackground` 原样保留两个对外类型。它把 `DAEMON_CADENCE` / `SCHEDULE_TICK_MS` 绑成 getter，
   `createFileTaskBackgroundConfigurationQuery` 绑成配置源工厂，并把 `runHeartbeatKillOnce`（含 `findStalledRunningChildren` 与进程树击杀的
   参数映射）、`reconcileDeadRunningRuns`（`graceMs: 60_000`）原样写进清扫。`start` 把启动依赖映射为 application 入参：`runDue` 携带
   `buildScheduleLaunch`、`identityAccess`、`SCHEDULE_MAX_IN_FLIGHT` 与 `onAutoDisable`。`pause` / `resume` / `stop` / `close` / `awaitIdle`
   直接转交。
4. **守卫与用例**：
   - 新结构锁 `rfc418-provider-background-application`，各项均带负例：十三个符号 owner 唯一；九个流程记号不在绑定出现；application 两个文件不
     import infrastructure / composition / `@/services`。
   - 端口绑定用例 `rfc418-port-bindings`：
     - 循环在布置时读节奏，到期循环以配置参数调用清扫 / 自动修复 / 定时任务，开机自动续跑；
     - 关闭的循环醒来但不调用；
     - 启动的配置源选择、缺源报错与只启动一次；
     - stop 排空票据；
     - 绑定把四个节奏与配置源绑到原常量。
   - 改指：读 `PB` 的三个锁改读 application 文件；孤儿对账热生效锁的睡眠记号改为监督拍 getter，并新增「绑定把该 getter 绑到监督拍常量」的
     断言；`isPeriodicReconcileDue` 的 import 改指。两处 legacy 注释改指新位置。guard-manifest 新增一条；Windows `paths:` 与 suite 补上。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：application 文件与原 `PB` 的空白不敏感 diff 只有 design §1 表中的端口替换（节奏四处、清扫两处、定时任务
  一处、配置源一处、类型三处）；绑定里的清扫与定时任务参数与原文逐项相同；启动映射保持 `=== undefined` 判据。PASS。
- **针对性验证集**（6 worker，负载约 15～20）：526 个文件（全部架构与守卫测试、`test-suite-policy`，以及提到 provider 后台 / provider 会话 / 心跳
  击杀 / 孤儿对账 / 定时任务 / 自动修复 / 自动续跑 / 后台配置 / 节奏的用例）。524 个通过，本 RFC 的锁、端口绑定用例与读 `PB` 的三个锁全部在内；
  2 个失败（`rfc359-w5`、`scheduler-boundary-presnapshot-rollback-skip`）为负载下的 5 s 超时。
- **第二轮**（2 worker）：2 个全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `TE/composition/providerBackground.ts`、`TE/application/providerBackground.ts`、`TE/application/ports/providerBackground.ts`；
- 守卫与账本：见 design §5。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-5）
