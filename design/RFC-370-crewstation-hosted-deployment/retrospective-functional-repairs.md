# RFC-370 既有实现回顾：引用生命周期、失败值与原 PG 探针

## 范围与已确认事实

用户要求先回顾既有 RFC 实现的正确性与质量、修绿精确 SHA CI，再继续新适配。回顾基于首个 RFC 提交之前的 baseline 与当前实际源码，分组覆盖 449 个历史生产路径（445 个现存、4 处删除／迁移），不把计划明确尚未完成的 H7 / roots / CS adapter 接线当作新增缺陷。本记录只修已确认的功能问题；新 runtime lease、Node 与 CS adapter 实现仍暂停。

- H345-P2-001：长期 System family 在每次 open 时向 `retained` 和 `referencesByRoot` 强 Map 登记原 retainedRef。失败／协议失败的 Intent 保留诊断目录，但退出后不再持有或使用该引用。Memory 的 unreaped／spawn-failed 链和 Narrative 的保留结果也存在同一登记生命周期缺口；正常物理 release／discard 已成功的结果不算泄漏。旧 TTL GC 删除诊断目录后仍不会退役原进程的登记，因而长期失败轮次持续累积引用与路径。原 GC 位于独立 maintenance Worker；在 Worker 里加一个本地回调不能清理主进程的 Map。RFC 前 baseline 的相同磁盘保留策略只有局部 scratchDir 字符串，没有这两个强 Map；问题在新增登记生命周期，不改变原保留策略，也不新增第三个 finding。
- H7-P2-001：执行权 lifecycle 用 `lastFailure: unknown` 的 undefined 同时表示“未失败”和合法失败值。订阅的 `onFailure(error: unknown)` 或异步 retirement 可以拒绝 undefined；已关闭 admission 并通知 failure listener 后，`settled()` 却因 `lastFailure !== undefined` 为 false 而 fulfilled。原具名 Error 行为不能覆盖这个错误边界。
- 原 PG heartbeat 探针：`00ce2fea` 主 CI `37696635364` 的 Ubuntu21 job `113049867005` 中，两条 commit / rollback writer 用例失败于“期望 raw rollbackError，实际 DrizzleQueryError”。实际 wrapper 的 cause 是原注入 error，query 是原 rollback。约 15 秒是原生产心跳第一次触发的等待；两用例现有预算均为 `60_000`，不能把这次失败诊断成预算不足或延长预算。

前一轮两阶段 token 时点与固定 PG schema matcher 修复已经发布到 `5bf9c109ce5285a176affd47e104c055127fbed0`；其主 CI `37700768526` 已正式 failure，Windows `37700768535` 已正式 cancelled。原 token 探针在双 provider 的新日志已通过，剩余实际功能失败是上述 PG cause 两用例及已消费 W5 增长许可未退役。两个有限修复已分别正常提交并一起推送到 `05e60236c42a3e3945bc4ed1d5575d521db557a1`；新主 CI `37705887143`／Windows `37705887174` 独立验终态。本轮不重写旧提交或将旧失败记作通过。

## 1. 退役 System 调用者已交出的引用，保留诊断内容

`SystemAgentRetainedContents` 增加同步、幂等的 `forget({ retainedRef })`：只退役调用者已经交出的进程内逻辑引用，不删除内容，不调用文件系统或远端对象 API，不改变原 `release({ retainedRef, scope })` 的物理删除与结果语义。Intent 的窄需求端口同步声明该方法，完整 producer family 仍直接满足其需求，不新增第二套 runner 或原生 facade。

local owner 只删除这一个 ref 的 `retained` 条目及对应 root 的 Set 成员；Set 为空才移除 `referencesByRoot` 条目。同一 root 的其他 ref 保持有效，原 `release` / workspace discard 成功时清掉该 root 全部登记的行为保持。重复 forget 或已经被原 release 删除的 ref 为 no-op。

Intent 在原调用 System family 的阶段、实际 run await 之前捕获原 retainedContents 对象与 forget 方法，捕获必须位于原 run 的 inner try 内，受原 releaseSlot finally 覆盖；完整 owner 的 getter 抛错也要释放已取得的槽位。仅在原 run 返回后保存原 retainedRef 的退役 closure，之后不重新查找或替换 owner。最外层 finally 在本轮已不会再进行内容操作时调用一次该 closure：失败／缺 envelope／协议无效／questions／changeset／release 失败／后续处理 throw 均覆盖。没有 run 结果时不制造 ref 或调用 forget。原成功 release 仍先执行；之后 forget 幂等，不改变物理结果。

finally 的退役错误仅记原 logger 的诊断；诊断本身若失败也不覆盖原 Intent outcome、settle 的 Promise 或原异常。该方法的合同是同步的进程内引用退役，不能承担远端 pin／对象删除或异步存储 ACK。`return settle(...)` 的原 Promise 交接时序保持：这时本轮已不再发起内容操作，退役引用与 durable turn settlement 是独立事实。

Memory 在原补问链 try 内、第一轮 run 前捕获同一 owner／forget 方法，逐轮 run 返回后保存精确 ref。链的原 finally 仍先执行原 releaseChainScratch(lastResult)：正常终止只物理释放最后 ref 所在的同一目录，unreaped／spawn-failed 仍跳过物理删除。其后内层 finally 才逐一退役本链所有已返回 ref，即使原 release 拒绝也覆盖；保留原失败值或成功结果。整个补问链中途不退役引用，不改变 workspaceScope、resumeSessionId、总 deadline、轮数、内容持久化与原错误。forget 或诊断失败不能阻止后续 ref 退役，也不能覆盖链结果。

Narrative 在原 run 前捕获 owner／forget 方法，仅在 run 返回后保存退役 closure；原结果解释及持久化置于同一 try，终端 finally 一次退役。原 core 成功时的物理 discard 不变，Narrative 不额外物理 release；非 ok、解析失败、任务已删除、持久化失败和正常完成均覆盖。forget 与诊断错误不覆盖原 ready／failed 状态或 single-flight 回收。

完整 producer family 在原 open 之后、core 第一动作所处的同步边界只读取一次原 workspace ref，保存使用原 owner／method／ref 的退役 closure。core 的内部输入增加必填 readonly retainedRef，只消费这次捕获的值，不再访问 workspace getter。已 open、但 core 直接拒绝且未返回结果时，family 执行该 closure，再原样重抛原 unknown rejection。真实的例子是 prepareWorkspace 拒绝后原 discard 再拒绝；调用方拿不到结果，不能承担该登记。首次引用读取本身失败时不制造不存在的 handle，仍传播原异常。

三个直接 core 调用点全部完成同一输入：完整 family、原 native services/systemAgentRun.ts、prepared composition/systemAgentRun.ts。后两者完整保留原输入对象及 invocation identity／receiver，只将原 workspace getter 的一次读取放在输入对象构造后，传入 required 值；不使用 optional 回退或新增观察 callback。原 logger／defaults／clock、workspace prepare／compile／discard 次序、成功结果与原物理清理保持。成功返回不提前退役；退役／诊断失败不能掩盖原拒绝。

失败诊断的 `scratchRetained`、runMeta、目录内容、原 retentionHours、按 mtime 选 stale、跳过 running、成功删除后 markScratchSwept、原日志和错误码全部保持。主进程无需收到 Worker 的跨进程 GC 事件；诊断内容继续由原 Intent scratch store / TTL GC 及原 shared orphan GC 管理。其他调用者原有物理 release 行为保持。

## 2. 分开 failure 的存在性与原值

只把 lifecycle 私有 failure 状态改为 `{ readonly error: unknown } | undefined`。`notifyFailure` 总是保存带标签记录，仍将原值直接交给原 onFailure；listener 抛出时仍用原 AggregateError 合并原错误与 listener error，只将 aggregate 放进记录。`settled()` 在原 tail 排空循环后检查记录是否存在并原样 throw 其 error，undefined / null / false / 0 / Error 均保留原 rejection 值。

原成功 adopt 与 close 两处清除 failure 的时点保持，原 phase / readyGroups / admission / grant / subscription / serialize / quiesce / drain / release 控制不变。不归一化错误、不引入新错误码、不把所有 raw errors 包成 Error，也不修改 callbacks 或 Promise 的原返回形状。

## 3. 独立 PostgreSQL 探针修复

PG 两条原 writer 探针按[独立修复设计](task-host-pg-rollback-cause.md)验原 wrapper / cause，单独完成设计门、实现门及发布。它不修改生产代码，也不承担上述两项 P2 的修复签署；本文件的实现门只签引用退役与 failure 存在性。

## 验证与发布边界

- 原 H1268 / H345 / H7 只读回顾分别消费真实稳定回执；H345 / H7 原 FAIL 不覆盖、不删去，修复通过独立设计门与实现门后按 finding ID 闭合。
- 原 System family identity、caller / Intent / Memory / Narrative、retained release、三个启动根、独立 Worker / 两个 provider GC、host authority lifecycle、PG finalization 探针作为控制。所有原测试名称、断言与预算保留；新测试验证 Intent 退役精确原 ref / receiver 且物理诊断保留、别名不受影响，Memory 双轮逐 ref 退役与原 unreaped／spawn-failed／release-failure／成功行为，Narrative 保留结果的原 ready／failed 状态，以及 common core 无结果时的原 undefined／Error 拒绝。forget 错误不覆盖 outcome，原 unknown rejection 值与恢复清除时点另验。
- 必需的旧 typed fixture 完整补上新进程内退役需求，不删除或放松旧断言，不用 optional method 或缺方法静默回退来掩盖未接线。
- 未应用的首份私有设计草稿将 getter 捕获放在取得槽位之后、inner try 之前，独立设计门实际 FAIL（RETROSPECTIVE-REPAIRS-D1-F01）已保留。修订只把捕获移到原 inner try 头部，并以 owner / forget getter 各抛一次后健康 turn 仍能完成的双 provider 回归验证原容量；不把这个私有草稿问题记为已发布实现的第三项缺陷。
- 补齐 caller 的私有 DESIGN-R1 已实际稳定 FAIL，仍沿用 H345-P2-001：草稿在 core 拒绝后重读 workspace retainedRef，getter 后续抛错／换值时漏退役。原回执与八文件草稿完整保留；修订由上述 single capture／required core input 覆盖，新增 undefined／Error 拒绝 × getter 后续抛错／换值的实际 owner 回归，验证只读一次、精确原 ref／receiver／method、物理诊断及原拒绝。全 packages 搜索确认三个直接调用点；此前仅两个自有草稿的私有 proof 不能作为完整 caller 证明。
- 只运行比例相称的格式 / lint、完整正文／语法树对拍与一个针对本次新生产候选的原架构 generation；不运行本机 AW tests / typecheck / build / services。保留原规则、完整 canonical 产物及有序库存／why，按当前源头生成，不能为数值或许可改原规则。
- 精确路径提交并保留共享 STATE / plan 和并行输出，推送前后验证 main / origin 同步。所有新提交精确 SHA 的实际 hosted 功能结果尚未通过前不宣称 CI 修绿；未完成的 H7 / A-T7 / A-G 和 CS M0～M4 仍照原计划验收，不能以本次回顾代签 RFC Done。

## 源码依据

- `packages/backend/src/modules/runtime-management/infrastructure/local/systemAgentRetainedContents.ts` 与同名 application port：两个索引及原 release / discard。
- `packages/backend/src/modules/task-execution/composition/localSystemAgentRunFamily.ts`、`systemAgentRunFamily.ts`：完整 producer family 与原 owner identity。
- `packages/backend/src/modules/task-execution/application/systemAgentRun.ts`：原 prepareWorkspace／discard 拒绝边界、物理清理与结果返回。
- `packages/backend/src/modules/task-execution/composition/systemAgentRun.ts`、`packages/backend/src/services/systemAgentRun.ts`：其他两个直接 core 输入与旧 native 兼容表面。
- `packages/backend/src/modules/memory/application/distill/memoryDistiller.ts`：整链 scope／resume、forensic 两状态与原最后结果 release。
- `packages/backend/src/services/changeNarrative.ts`：原结果／持久化、ready／failed 与 single-flight 收尾。
- `packages/backend/src/modules/intent/application/turnEngine.ts`、`ports/intentSystemAgent.ts`：原 run 结果、failure／协议边界、release 与 settlement。
- `packages/backend/src/modules/intent/composition/maintenance.ts`、`infrastructure/local/fileIntentScratchStore.ts`：原 TTL / running 排除及物理清理。
- `packages/backend/src/platform/background/maintenanceWorker.ts`、`maintenanceWorkerSupervisor.ts`：Worker 的独立内存与原两 provider 装配。
- `packages/backend/src/server.ts`、`cli/start.ts`、`cli/postgresqlDaemonApplication.ts`：长期 HTTP／daemon / PG 双家族 roots。
- `packages/backend/src/modules/system-operations/application/hostExecutionAuthority.ts`、`ports/hostExecutionAuthority.ts`：原 failure callback、tail 等待与清除时点。
- `packages/backend/tests/rfc370-task-host-finalization.test.ts`、`packages/backend/src/platform/persistence/postgresqlDatabaseClient.ts`、原 ORM 错误类：真实 pool 注入与原 wrapper / cause。

## 当前源码候选

完整 caller 修复设计 DESIGN46-R2 已由独立 reviewer 实际稳定 PASS，根会话已消费全 46 项及三个包装。11 份生产源码、三份原 typed 测试、两份新回归与原 Windows 四路径／两 suite 登记已应用，所有正文与该批准草稿一致；原失败回执完整保留。两项 P2 的实现门、一次原候选 generation／完整配套、精确发布与 hosted CI 继续分别验收。原 CI 的四处 held matcher 时序修复是独立零生产候选；该状态不表示 H7／A-G、CS adapter 或 RFC Done。
