# RFC-419 实施计划

**前置**：RFC-418 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                 | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| RFC-419-T1 | `infrastructure/hostTaskLaunch.ts`：借用工作区、两个启动适配；`AEE` / `DEE` 改为绑定                                                 | design §1     |
| RFC-419-T2 | `infrastructure/taskRecoveryAdministration.ts`；`TEP` 改为调用                                                                       | design §1     |
| RFC-419-T3 | 守卫与用例：结构锁（含负例）、端口绑定用例；源码锁语料与 owner 改指；架构报告写入点；import 改指；guard-manifest；Windows；全仓 grep | design §4、§5 |
| RFC-419-T4 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                                    | design §3     |

## 实施记录

T1～T4 完成（本会话实施），与落档设计无偏差。

1. **启动适配与借用工作区**：`infrastructure/hostTaskLaunch.ts` 由脚本从原文生成。
   - 借用工作区与原文逐字相同；
   - 动作启动的主体与原 `launchHostTask` 逐字相同（空白不敏感）；
   - `launchDigitalEmployeeHost` 只把 `deps` 的类型从 composition 依赖接口的 `Pick` 换成同形的 `HostTaskLaunchDependencies`。

   `AEE` 的环境绑定改为 `launchHostTask: (input) => launchActionHostTask(deps, input)`；`DEE` 的端口绑定不变（原本就传
   `{ resolveActor, resourceAuthorityFor, launch }`），只改 import。

2. **恢复管理**：`createTaskRecoveryAdministration` 与原 `createRecoveryAdministration` 只差改名与导出；`TEP` 删去四个随之不再使用的 import。
3. **守卫与用例**：
   - 新结构锁 `rfc419-host-launch-recovery-infrastructure`，各项均带负例：八个符号 owner 唯一；八个适配器记号不在三个绑定；新文件不 import
     composition（`required-ports` 类型除外）。
   - 端口绑定用例 `rfc419-port-bindings`：动作启动的请求映射（有无墙钟预算、输入拷贝、合成宿主、internal 事实、借用工作区）；环境返回启动 ID；
     借用工作区的单次结算状态机。
   - 改指与登记：
     - RFC-368、RFC-319（两处）、RFC-310 任务来源锁的语料补入新文件；
     - RFC-415 锁中 `launchDigitalEmployeeHost` 的 owner 改指（删去随之不用的常量，行数不变）；
     - 架构报告 internal 目录可见性写入点由两条合为一条；
     - 三处用例 / helper 与 RFC-415 端口绑定用例改 import；
     - guard-manifest 新增一条；Windows `paths:` 与 suite 补上。

## 集中验证（T4）

- **静态**：后端 typecheck（含 tests，6 GiB heap）首轮报本 RFC 新用例一处类型断言（解构后的请求对象类型过窄），放宽为 `Record<string, unknown>`
  后 rc=0；改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：
  - 借用工作区与动作启动主体逐字相同；
  - 数字员工启动只换 `deps` 的同形类型；
  - 恢复管理只改名与导出；
  - 三个绑定只剩构造与注入。

  PASS。

- **针对性验证集**（6 worker，负载约 15～28）：709 个文件（全部架构与守卫测试、`test-suite-policy`，以及提到数字员工 / 动作执行 / 借用工作区 / 宿主
  启动 / 恢复管理 / 孤儿 / 开机恢复 / Reaction / internal 目录可见性的用例），698 个通过，本 RFC 的锁、端口绑定用例与全部改指的锁均在内。
  - `rfc376-report` 与 `rfc370-committed-architecture-source` 报「missing governed field anchor: …/hostTaskLaunch.ts」：两者按**已提交**源码
    （HEAD）生成架构报告，而新文件尚未提交，属未提交候选的环境差异。在 `c91c711ac` 加本候选的独立导出仓库（候选为 HEAD）里两者分别 16/16、
    2/2 通过。
  - 其余 9 个为负载下的 5 s 超时。
- **第二轮**（3 worker，负载约 28）：9 个里 8 个通过；`rfc359-w26` 仍超时。
- **第三轮**（单进程，本候选与基线 `c91c711ac` 对照）：`rfc359-w26` 两侧均通过（21 s / 20 s），判为负载超时，不归本 RFC。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`1cd551c10`**：主 CI `41372733610` 70 个 job 全部 success，windows-platform `41372733594` success。AC-5 成立，RFC-419 Done。

## 冲突面

- `TE/composition/{digitalEmployeeExecution,actionExecutionEnvironment,taskExecutionPersistence}.ts`、`TE/infrastructure/{hostTaskLaunch,taskRecoveryAdministration}.ts`；
- 守卫与账本：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`1cd551c10`，见上）
