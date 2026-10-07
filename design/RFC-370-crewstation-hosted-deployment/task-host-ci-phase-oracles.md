# RFC-370 Task host CI：两阶段释放与双引擎 SQL 断言

## 现有事实与修复边界

先完成用户要求的既有 RFC 代码正确性与质量回顾、修绿精确 SHA hosted CI，再继续新的 runtime lease / Node 写点 / CS adapter 实现。本记录只修既有测试的观测时点与 SQL 方言识别，不改变生产释放协议、心跳周期、事务、owner 转移或重试。

- `e28aafe910e6a2d2c866be77b8c2b9bbb57fee1b` 的主 CI `37690906725`、macOS 后端 shard 8 job `113030528097` 中，`rfc370-task-host-finalization.test.ts` 两条 SQLite 用例在 registry 已 release、尚未 settle 时断言 `tokenForTask(...)` 为 null。实际仍为原始 token；同阶段的读次数、未完成、未排空与 ACK 检查已经通过。
- 原有 `InMemoryTaskRuntimeRegistry` 协议是 `release()` 写停机结果、`settle()` 删除 token 索引并唤醒等待者。`hasTask()` 在 release 后立即为 false，`tokenForTask()` 则保留原始 token 到 settle。该两阶段行为早于 RFC-370，原 RFC-328 测试也先 release 再 settle。
- selected finalization 原调用顺序为 release、停原心跳、等待已发心跳 Promise、同步实际 writer、转移 owner、settle、完成 workspace。前两项等待在 transfer 的 settle-finally 外；ACK 拒绝时保留同一 pending barrier，必须允许原方法与 receiver 重试。
- `00ce2fea044e3ed32a02cb7d13f1bcdd6affd6c8` 的主 CI `37696635364`、Ubuntu shard 19 job `113049866909` 中，`rfc370-task-host-effect-writes.test.ts` PostgreSQL 回滚用例的 INSERT 匹配式漏掉固定 `agent_workflow` schema 前缀，实际匹配为 false。原 SQLite 裸表名匹配仍适用。

## 候选修复

1. 原心跳 drain 用例：在原 release 通知后、心跳 Promise 仍未获准继续时，断言 `hasTask(taskId) === false` 与 `tokenForTask(taskId) === driver.execution.token`。把原 `tokenForTask(...).toBeNull()` 完整保留到 `await finalizing`、`await draining` 之后，验证实际 settle 已完成。
2. 原 ACK retry 用例：在第一次同步 ACK 拒绝后断言 driver 已停止、token 仍为原 token。把原 null 断言完整保留到 `retryPending()`、原 `awaitReleasedSettled` 与同一 pending barrier 全部完成后。保留读次数、同一 barrier、resource edit、原 receiver/read 捕获、owner released、空 snapshot 的全部原断言。
3. effect 回滚用例的两笔 INSERT 匹配式沿用既有 Task callers CI 修复的固定可选 schema 形式：仅接受原 SQLite 裸表或 PostgreSQL 的 `agent_workflow` / `"agent_workflow"` 前缀；表名保持 `task_execution_effects`、`task_execution_effect_attempts`，保留结尾词边界，不能改成泛化 INSERT 匹配。ROLLBACK、完整前后账本与 owner 快照、原 work 未完成的检查全部保留。
4. 原用例名称、provider 注册、所有 await / deferred / finally、真实生产 15 秒心跳、`60_000` 与 `15_000` 超时预算保持。新增类型参数仅表达原 token 与 null 的现有返回类型，不改变运行时值。

## 验证与交付

设计门、实现门都只检视功能。先冻结两个原测试全文、原 registry / release / finalization / heartbeat 生产文件、旧双阶段测试与双引擎录制器，再做有限源码对拍：两条 null 断言只是移动，新增四条阶段断言；两条 SQL matcher 只是增加固定可选 schema；逆向还原后两个测试的完整语法树与原稿一致，所有原用例与预算一致，相关生产文件全文不变。比例相称的格式与 lint 检查可执行，不运行本地 AW 测试、typecheck、build 或服务；功能结论以修复提交的精确 SHA GitHub CI 为准。

本轮只有测试与 RFC 记录变化，不运行新的架构 census，不修改既有架构规则、分类、许可或 canonical metadata。只提交明确任务文件，保留共享 STATE / plan 的全部已有输出与未提交 runtime 设计稿。精确 SHA 主 CI / Windows CI 的功能结果尚未实际终态通过前不得宣称修绿、H7 / A-G 完成或部署完成；后续适配继续暂停。

## 源码依据

- `packages/backend/src/modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry.ts`：`release`、`settle`、`tokenForTask`、`hasTask`、`awaitReleasedSettled`。
- `packages/backend/src/modules/task-execution/infrastructure/taskDriverFinalization.ts`：selected release 的原方法捕获、两次 heartbeat 等待与原 transfer / settle 顺序。
- `packages/backend/src/modules/task-execution/infrastructure/taskDriverRelease.ts` 与 `taskDriverLifecycle.ts`：原生释放委托、心跳计时器与停机依赖。
- `packages/backend/tests/rfc328-durable-ownership.test.ts`：原 release / settle 序列。
- `packages/backend/tests/rfc370-task-host-callers.test.ts`：已经发布的固定可选 schema INSERT matcher。
- `packages/backend/tests/helpers/eachProvider.ts` 与 `statementRecorder.ts`：两个 provider 的真实 SQL 记录与原预算。

## 本轮实现候选

设计门 DESIGN-R1 已被 root 实际消费为有效稳定 PASS。两个原测试的全文逆向还原与 AST 对拍通过：原 finalization 13 个直接 test 声明、150 条 expect 保留，新增四条阶段断言；原 effect 14 个直接 test 声明、63 条 expect 不变。所有原预算不变，两个 null 断言完整移到实际 settle 完成之后，两条 INSERT 只扩展固定可选 schema。相关生产源码、Windows 入口与旧双引擎测试保持全文不变。实现门及新提交精确 SHA hosted CI 仍待完成，不代签 retrospective / H7 / A-G / CS 部署。
