# H7 启动执行恢复效果家族

本增量属于已批准 RFC-370 阶段 A。它先解决启动恢复仍直接调用本机孤儿收割的问题；执行权 claim／renew／activate 与全部后台效果的生命周期接线仍是后续 H7 增量，不能由本片替代。阶段 A 通过 A-G 后才编写 CS adapter，阶段 B 仍先 M0 实际部署，再逐项 M1～M4。

## 实际调用与已有能力

`task-execution/composition/bootRecovery.ts` 已有唯一四步编排，SQLite 的 `cli/start.ts:composeSqliteProviderSession` 与 PostgreSQL 的 `cli/postgresqlDaemonApplication.ts:composePostgresqlApplication` 在监听及自动续跑前调用它。原顺序为 prepare 旧 owner、reap 孤儿、repair runtime session lease、finalize effect／owner。prepare／finalize 已经通过 provider 中立的持久端口，但 reap 和 repair 仍在这份共同编排内硬连 `services/orphans` 和 `services/runtimeSessionLease`；原生恢复还把 `orphanReaperCompleted: true` 等进程事实直接拼在共同层。

H7 不重新建立后台控制器。现有 `cli/daemonProviderRuntimeSession.ts` 和 `daemonProviderRuntimeHandles.ts` 已将 Task、Intent、maintenance、MCP、观测报告及全部 background writers 统一纳入 start／stop／drain；关闭顺序和每个原在途 Promise 必须保持。host readiness 已在 system-operations 的独立合同内，不能被当作执行授权。

本片只切启动执行恢复完整效果家族，复用原 prepare／finalize 业务及 provider 实现。本机全部原孤儿规则、记录、进程操作、lease 修复和 code-host 恢复保持原实现，既不重写，也不增加其它检查。

## Owner 与完整合同

新增代码归 task-execution，落在 `application/ports/bootExecutionRecovery.ts`、`application/bootExecutionRecovery.ts`、`infrastructure/local/bootExecutionRecovery.ts` 和显式 local composition。原 `composition/bootRecovery.ts` 保持精确兼容 API；其 native 兼容入口选择 local 工厂并调用同一共同编排，没有第二份四步业务规则。所有旧公开输入／报告名和两种 daemon proof 构造的原行为保持。

工厂 `BootExecutionRecoveryFactory.create(input)` 接收本次调用已经选定的 recovery persistence、recovery administration、runtime session leases、lock proof 和可选 code-host probe；这些都是既有 owner 合同，不传数据库连接、PID 或 CS DTO。create 在原 prepare 的位置调用一次，不提前读取或执行恢复，不缓存跨启动实例。

local create 只捕获同一个 input 对象，不 spread／枚举其成员。各持久端口、proof、lease 和可选 probe 的 getter 在原四步各自的位置读取，保留错误先后及可选字段的省略语义；不把 finalize 的输入热读提前到 prepare。

所选家族完整包含四项，并保留调用 receiver：

- `prepare()` 返回原 revokedTaskIds。
- `reap()` 返回原 tasks／runs 计数及 opaque recovery 引用。共同层只使用原日志计数，把引用原样传给下一步。
- `repair(reapRef)` 返回原 repairedRuntimeLeases 及 opaque finalization 引用。共同层等待它完成，仍按原条件记录原日志。
- `finalize(finalizationRef)` 返回完整原 TaskExecutionRecoveryFinalization。

共同层独占四步顺序、原日志条件／文字及原报告构造。每一步 ACK 先于下一步；create 或任意成员的缺失／拒绝保持可见，不选择本机兜底。共同层不得读取引用的 path／pid／本机 evidence 字段，也不替所选实现合成进程收割完成事实。

## Local 配对与真实根

独立 local 家族逐项调用原 prepare、reap、repair、finalize 函数。原 `orphanReaperCompleted: true`、orphanTasks、orphanRuns、repairedRuntimeLeases 和可选 probe 的准确参数只在 local 配对中形成；同一次 create 的私有映射把两段 opaque 引用关联到真实原结果。`repair(..., true)` 仍只发生在原 reap 完成之后，所有原错误边界保持。原 prepare／finalize 持久规则和 `services/orphans` 整体保持，不评价或扩展其余既有内容。

CLI start 的原选项和两条 provider session 传递链允许注入整族工厂；SQLite 和 PostgreSQL 的实际 daemon 恢复调用明确在 undefined 时选择 local 工厂，已选完整家族不热读旧 native 默认。纯 HTTP 装配仍不执行 daemon 启动恢复。旧直接调用兼容 API 的测试保持准确 native 行为，无需为兼容消费者开放 CS 模式。

未来 task-execution 的 CS 实现依据 durable request／receipt 及有效 active authority 提供这四项效果，继续调用 AW 的业务恢复规则；它不得把远程执行 ID 放进 PID 或声称已经完成本机进程收割，也不能因服务重启就把全部远程 running 标 interrupted。本片不写 CS 代码、不宣称远程恢复已具备；如果其余业务恢复端口在后续实现中仍缺少所需事实，按主计划独立补中立合同及 local 回归后再接入。

## 功能验证与发布

固定原 bootRecovery 完整前像、两个真实根与传递链。四步完整共同语句可逆恢复；local 四个原调用及 evidence 对象／可选字段完整 AST 保持。原 dual-provider boot recovery、daemon startup lease、host readiness、provider session 和后台控制用例、全部判断和预算保持，源码 reader 只随真实代码 owner 与显式装配机械更新。

新增功能用例覆盖 opaque 引用、prototype／private receiver、一次 create、每个 ACK、缺成员及四阶段错误、日志／报告完全一致、同一个 persistence／lease／proof／probe 绑定，以及双 provider 真实旧 owner／run／effect 恢复和兼容入口。Windows push／PR 对称登记相关路径与适用用例，不改变原平台判据。

设计门通过后才实现；源码实现门、一次必要的原 matching census、有限元数据门和发布后 exact-SHA hosted CI分别留证。本机仅 owned format/lint、纯 AST／字节／JSON，不运行 AW tests/typecheck/build/service。H7 剩余执行权／后台接线、全调用者 A-T7 与 A-G、CS adapter、首次部署及全能力验收继续开放。
