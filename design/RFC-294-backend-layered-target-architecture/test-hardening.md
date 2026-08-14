# RFC-294 重构风险与用例加固门禁

- 状态：重构前行为基线
- 适用范围：P0-A～P0-D、W0-R～W9
- 原则：目录和 owner 可以迁移；用户可见合同、持久状态、授权、幂等、恢复与副作用边界不得被静默改写。

本文不替代 `plan.md` 的 wave 验收条件。它把真实用户旅程、分层测试和已知待修语义绑定起来，防止重构仅靠单元测试或“编译通过”形成假绿。

## 1. 风险裁决

| 风险面          | 真实场景                                                                  | 最容易出现的回归                                                                       | 必须阻断的证据                                                                                                  |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 模块边界        | 开发者移动文件、抽 public port 或临时 re-export                           | type-only/dynamic import 绕过规则；adapter/DB 类型污染 public surface；能力对象可伪造  | AST 规则自身变异测试 + 当前债务 exact ratchet + typecheck                                                       |
| HTTP/ACL/OCC    | 协作者写评论；陌生人猜测 review id；两标签页提交旧 iteration              | 404/403/409 混淆、资源枚举、拒绝请求仍落库                                             | real route → policy → SQLite 测试，并验证拒绝路径零写入                                                         |
| 任务唯一执行权  | 用户重复点击、网络重试、scheduler 同时 kick                               | 两个 driver、重复 node run、重复进程或双终态                                           | 真并发 `runTask`，断言单 claim、单 node run、单 spawn、单终态                                                   |
| 手工恢复竞争    | 一个标签页 resume、另一个标签页 retry                                     | 两个 winner、loser placeholder 污染、重复进程                                          | resume/retry 混合竞态，断言恰一成功、单进程和 loser 零污染                                                      |
| daemon 生命周期 | 执行中升级/关机后恢复                                                     | task done 但 node running；旧进程继续写；resume 复用错误 generation                    | shutdown → task/node interrupted → owner 释放 → 新 generation done                                              |
| 人工门          | 用户在 Clarify/Review 页面等待时 daemon 被强杀                            | gate 消失、run id 重铸、问题/审批丢失、答案落库但不续跑                                | 真实 daemon + HTTP + runtime stub E2E；Clarify/Review 分别 SIGKILL/restart，原 identity 最终 done               |
| Webhook 执行链  | 代码平台重投；runtime 崩溃、拒绝、空响应或超时                            | delivery/fire 与 task/node 归因混淆；重复任务；超时进程迟到写入；伪造 nonce 被采信     | 真实 GitLab HTTP → daemon → scheduler → OpenCode/Claude child；去重、retry/reap、零 ghost output 与持久 lineage |
| MR 终态竞态     | 同 MR 并发 update/close；执行中 close/merge；effect leased 时 daemon 崩溃 | stream 乱序启动；terminal 伪造 task/fire；旧任务复活；进程未释放；恢复 worker 重复控制 | 不同 UUID 同 stream 线性化、closed/reopen/merged 矩阵、真 runtime stop/reap、同 home restart 收敛               |
| Apply/导入      | UI 请求超时后重放；进程在 prestage 中退出                                 | 新鲜 journal 被误扫；旧行重复副作用；receipt 因外围状态变化不可重放                    | Intent/Bundle 新鲜与 aged recovery、终态 receipt replay、owner 隔离                                             |
| 后台 worker     | provider 短暂失败、服务重启、stop 后迟到 wake                             | effect 丢失/重复；旧 worker 复活；未释放 timer/handle                                  | durable retry 跨 worker 接管、stop terminal、最终 durable terminal state                                        |
| 定时任务        | daemon 在 durable claim 后、launch 前崩溃                                 | 新 daemon 重复发射同一 schedule slot                                                   | claim 后同一 logical time 重扫，launch count 为 0                                                               |
| 启动来源        | multipart/call/workgroup 已物化空间，同时携带 deferred-prep 参数          | 重新 clone、覆盖 task identity、伪造 `__repo_prep__`                                   | pre-materialized failure handoff 优先，保留 task id 且零 node/process                                           |
| 协议与矩阵      | REST/MCP/WS、所有 runtime/wrapper/child mode                              | 局部用例绿但能力组合掉线                                                               | capability catalog exact spine + 现有 runtime/workflow E2E matrix                                               |
| schema/在途数据 | additive migration、旧 daemon 创建的未终态行                              | 新 reader 读不懂、backfill 非幂等、回滚后新行无人收敛                                  | 每个 schema wave 独立 old/new row、重复 backfill、rollback/forward-fix 测试                                     |

## 2. 本轮新增的绿色兼容 oracle

这些用例只锁定重构必须保留的正确行为，不把 RFC 已点名的错误语义变成兼容合同。

| 层级                     | 文件                                                                  | 保护合同                                                                                                        |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 静态架构                 | `packages/backend/tests/rfc294-architecture-preflight.test.ts`        | cross-context edge、public entrypoint/type taint、capability forge、god-port；每条规则有会红的 mutation fixture |
| transport/application/DB | `packages/backend/tests/rfc294-route-gate-compat.test.ts`             | 协作者写入、隐藏资源 404 等价、403/409 零写入；不锁 decision 后 route resume saga                               |
| apply/recovery           | `packages/backend/tests/rfc294-apply-replay-recovery-parity.test.ts`  | fresh/aged journal、terminal replay、receipt owner isolation；重放使用相同请求 hash                             |
| execution/concurrency    | `packages/backend/tests/rfc294-task-execution-compat-oracles.test.ts` | duplicate kick、resume/retry race、shutdown/resume generation、pre-materialized handoff                         |
| background               | `packages/backend/tests/rfc294-background-worker-boundary.test.ts`    | durable retry takeover、stop fence、schedule claim、窄 participant information budget                           |
| real E2E                 | `e2e/rfc294-human-gate-restart.spec.ts`                               | Clarify 与 Review 分别跨硬崩溃恢复，identity 不变并续跑到 done                                                  |
| real Webhook/runtime E2E | `e2e/rfc294-webhook-runtime-failures.spec.ts`                         | GitLab 入口去重后的两 runtime 崩溃/超时/空响应/错 nonce，区分 launch 成功与执行失败，锁 retry/reap/零迟到输出   |
| real MR terminal E2E     | `e2e/webhook-mr-runtime-races.spec.ts`                                | 坏 JSON 零启动、同 stream 并发/终态矩阵、runtime crash 竞态、leased effect 跨 daemon SIGKILL 恢复               |
| coverage ledger          | `packages/backend/tests/execution-capability-coverage.test.ts`        | human-gate、webhook runtime failure 与 MR terminal recovery 三条命名 orchestration spine 不能静默消失           |

## 3. 不允许提前写成绿色的 P0 红测

下列目标合同在当前实现仍有已知缺口。对应实现 RFC 开工时必须先补“当前会红”的精准测试，再改生产代码；本轮不得写相反断言来维持全绿。

1. P0-A：Memory generic PATCH 不再接受 scope；move 同事务重读旧/新 scope 授权；rollback 无 durable/WS ghost event。
2. P0-B：Intent session lock 按实际 derived chain identity 清理；compensation 任一失败保持 retryable；完整 artifact codec；post-commit throw 不补偿 durable commit。
3. P0-C：Clarify/Review/Questions open 与 park 原子化；decision、snapshot、transition、continuation 同事务；route 不再单独 resume。
4. P0-D：durable owner/epoch/lease/fence；manual、auto、scheduler、recovery 共用 claim；stale epoch 的 DB/FS/Git/process receipt 必须为零。
5. W6 幂等身份：Intent 与 Bundle 的同 key 不同 actor 或 canonical request hash 必须 conflict；不得仅按 key 返回 receipt。
6. Runtime 协议对称：OpenCode 当前没有与 Claude `parseTerminalResultError` 对称的 terminal-result contract；不得把它当成不重试的 `runtime-result-error` 写成绿色兼容语义。

这些红测至少要覆盖 crash-at-every-boundary、重复请求、同 key 异 payload/actor、stale OCC、compensation/roll-forward 失败、lease takeover 与旧 worker 迟到提交。

## 4. 每波最小验证栈

1. 规则/纯核：typecheck、lint、domain/application 单测；新增规则必须附正反 mutation。
2. 持久合同：真实 SQLite transaction、CAS loser、rollback、replay、old/new row 与重复 convergence。
3. 边界合同：REST/MCP/WS 的 status/code/body/ACL/audit/event parity；拒绝路径验证 durable 与广播均为零。
4. 执行合同：真并发、真实子进程、cancel/shutdown/retry/resume、workspace/Git 清理和 generation/fence。
5. 用户旅程：至少一个真实 daemon E2E；涉及 runtime 协议时覆盖 stub 确定性矩阵，并把有凭据的 live-provider sweep 单独记账。
6. 仓库总门：`bun run gate:local`；若失败必须按精确文件/owner 归因，不能用局部绿替代总门。

## 5. Stop-ship 判据

任一项发生即停止当前 wave，而不是把异常登记成临时兼容：

- 同一 task 同时出现两个可写 driver、两个进程或两个 workspace owner；
- stale epoch、未授权 actor、冲突 OCC 请求产生任意 durable/FS/Git/WS 副作用；
- 已提交 decision/receipt 在重试或 daemon restart 后不可达；
- parked human gate 丢失、换 identity、重复打开，或答案/审批落库后永远不 continuation；
- compensation 未完成却进入不可恢复终态；
- public contract 泄露 DB/route/adapter/process/worker/lease/capability 内部类型；
- facade/exception/KNOWN 债务增加，或测试通过新增生产 re-export 维持；
- 新 schema 使旧在途行、回滚后新行或未完成外部 effect 无 owner。

通过上述门只证明本地确定性基线；commit、push、托管 CI、带真实凭据 runtime sweep 与线上服务状态必须分别报告。
