# RFC-332：TaskEngine 拆分（RFC-294 W2-B）

> 状态：In Progress（2026-08-27；T3～T13 implementation candidate 已完成，待发布/provenance/exact-SHA hosted closeout）
>
> 架构位置：RFC-294 N5 / W2-B；承接已完成的 RFC-328 durable execution authority 与
> RFC-331 W2-A topology cut，不领取 P0-C、W2-C NodeExecutorRegistry、W2-D WrapperRuntime 或 W3 credit。
>
> current source：`b598d4a35e681d3623f44c15ef632d50a2b710d9`。批准只授权 T3～T13 的 W2-B 实现；
> 不授权 P0-C、W2-C/D、W3、W4/W5、安全/权限改动或能力收缩。

2026-08-27 implementation candidate 已形成唯一 coordinator、phase 0 preparation、闭合三路 TaskEngine、
DAG scope/graph/frontier 唯一 owner 与 exact compatibility ledger；canonical source report 保持 backend/repo value SCC
`4/6`，没有重新引入 RFC-331 已切除的 task SCC。当前仍不是 Done：四份 current-provenance artifact 必须在真实
payload commit 存在后重放，且最终结论以该 exact SHA 的 hosted CI terminal success 为准。

## 1. 背景与现状结论

RFC-331 已切断 `task.ts ↔ scheduler.ts` 的值级依赖，并以 instance-bound
`SchedulerDriverPort` 接住四个 drive 点。但运行职责仍没有真正分层：

1. `services/task.ts` 仍分别在 initial start、resume/sync/gate continuation、repository preparation retry、
   node retry 四处完成 attach → drive → release；boot auto-resume 又在 `cli/start.ts` 自己判断
   `__repo_prep__` 并重查 latest prep row。
2. `services/scheduler.ts` 仍同时拥有 task snapshot hydrate、`pending → running` claim、engine 选择、
   task terminal settle、DAG `runScope`、纯 `deriveFrontier`、node dispatch、wrapper recursion 与 workgroup host mechanics。
3. `services/execution/engines.ts` 已有闭合的三路 resolver：`dag | workgroup-turns | dw-generate`，
   但它只抽走了选择函数，三个 engine body 仍由 scheduler 驱动。
4. RFC-328 已提供唯一 durable owner/intent/effect/fence、exact-token runtime registry、
   `TaskExecutionContext` 与 `workspace-prepare` effect ledger；W2-B 不需要、也不允许再造一套。
5. RFC-287 的 repository preparation 已有可见 `__repo_prep__`、后台返回、重试、取消、shutdown、
   effect attempt 与成功回填 oracle，但初启和重试仍靠两个 legacy caller 把临时对象喂给同一私有函数。
6. 当前 canonical owner 生成器把 `${path}#${symbol}` 交给 `/schedule/`，导致文件名
   `scheduler.ts` 被子串命中：该文件 112 个 owner rows 中 111 个被误投影为 `integration`；
   `runTaskInner`、`runScope`、`deriveFrontier`、`runOneNode`、`runWrapperNode` 等都因此得到错误 owner 与
   `W4/W9` 删除波次。这不是报告美观问题，而会让 W2-B/C/D 的模块边界和完成判据失真。

因此，W2-B 的最小充分工作不是改名 `runTask` 或整体搬走 `scheduler.ts`，而是建立唯一任务驱动协调器，
把 task-level drive/frontier/settle 迁到 `task-execution`，同时用有删除波次的窄桥接端口保留 W2-C/D 尚未迁移的 mechanics。

## 2. 目标

### G1：所有已准入任务只走一个驱动协调器

initial、resume、sync-workflow、gate continuation、retry-node、retry-repository-preparation、call child、
boot auto-resume 与 lifecycle repair 最终都提交同一种 `TaskDriveSubmission`。协调器唯一拥有：

- RFC-328 intent claim 与 runtime attach；
- task-owned `AbortController` / exact `TaskExecutionContext`；
- repository preparation 第 0 步；
- TaskEngine 调用；
- catch、driver release、workspace finalization 与后台任务错误收口。

调用方仍可有各自的 admission/preflight/CAS；统一的是“已准入之后怎么被驱动”，不是把所有产品命令合成万能入口。

### G2：形成真实的三种 TaskEngine

保留当前三路业务语义，并落成闭合 registry：

- `DagTaskEngine`：普通 workflow、agent host、dynamic workflow execute phase 的 DAG frontier/scope；
- `WorkgroupTaskEngine`：leader-worker/free-collab 的 round/assignment 状态机；
- `DynamicWorkflowTaskEngine`：dynamic workflow generate/reject/confirm 前的生成状态机。

历史 `code-round` 只保留兼容读取与既有 retired outcome，不恢复为 active engine；TaskSource、Catalog source、
AgentAttempt 也不新增 engine kind。

### G3：TaskEngine 只拥有任务级控制

迁入 `task-execution/engine/task` 的职责是 snapshot hydrate、task claim、engine selection、DAG frontier/scope、
pause/cancel outcome 与 task settle。node kind mechanics 留给 W2-C，loop/git/fanout mechanics 留给 W2-D，
process/iso/merge assembly 留在既有 kernel seam。不得以 W2-B 名义整体搬迁 11k 行 scheduler。

### G4：repository preparation 成为同一 drive 的第 0 步

initial 与 retry prep 共用一个 `RepositoryPreparationStep`；boot 不再在 CLI 复制 row 查询与分流。
该 step 复用 RFC-328 `workspace-prepare` effect ledger 和 RFC-287 的 node-row/status/error/retry/cancel oracle，
不新增独立 worker、第二 operation journal 或第二恢复状态机。

### G5：保持全部已落功能

DAG、workgroup、dynamic workflow、agent host、child call、branch skipped/consumed、repository preparation、
pause/resume/retry/cancel、auto-resume、workspace prune/source termination、TaskCatalog membership、WS 与 lifecycle
事件都必须保持现行外部行为。架构重构不能以功能损失换取目录整洁。

### G6：纠正 canonical owner 与 wave 投影

canonical generator 必须按 token/exact symbol 识别 `schedule`，不能让 `scheduler` 子串整文件落入 integration。
W2-B symbols 指向 `task-execution/engine/task`；残留 node/wrapper symbols 分别指向 W2-C/W2-D；
真正的 schedule/webhook/code-host integration symbols 仍保留其实际 owner。

### G7：single-consumer 原子切换

生产切换后：

- `SchedulerDriverPort.kick` production consumer=0；
- `services/scheduler.ts` 中 `runTaskInner`、`runScope`、`deriveFrontier` inline body=0；
- `services/task.ts` 四处 `.kick({...})`=0；
- 不保留“旧 scheduler 和新 TaskEngine 都可能 drive”的双路窗口。

### G8：为 W2-C/D 留窄且可删的桥

W2-B 允许 composition 注入 legacy node、wrapper、workgroup-host mechanics，但每个 bridge 必须按用途拆分、
登记 owner/consumer/remove wave，并由 mutation fixture 防止扩张；不得把 `SchedulerState`、`DbClient` 或整个
`StartTaskDeps` 包成一个新 god port。

## 3. 非目标

- 不迁 `runOneNode` 的 kind switch 或建立 `NodeExecutorRegistry`；归 W2-C。
- 不迁 `runWrapperNode`、loop/git/fanout shell；归 W2-D。
- 不完成 clarify/questions/review 的 common durable continuation；归 P0-C/W3。
- 不重写 REST/MCP/WS、Task DTO、状态枚举、错误码、任务目录 UI 或 TaskCatalog query。
- 不完成 W4 的 command/query public surface，也不一次性清空 `StartTaskDeps` 的全部 legacy 字段。
- 不把 source-control materialization、workspace ownership 或 prune physical delete 搬进 TaskEngine；W2-B 只消费窄 participant。
- 不恢复 RFC-304/309 的 code-round writer、stage executor 或新 admission。
- 不新增权限、安全策略、能力挡板或功能收缩；本 RFC 的门检视只审功能正确性与模块职责。

## 4. 决策

- **D1 — 两级合同**：application 层 `TaskDriveCoordinator` 负责 attach/后台语义/第 0 步/finally；
  engine 层 `TaskEngine` 只接收已绑定 context 并返回闭合 outcome。两者不得合成万能 service。
- **D2 — request 最小化**：每次提交只带 `taskId + intentId + completionMode`；live runtime config 在 composition
  构造时冻结为 `ResolvedTaskDriveConfig`，不再由四个调用点各 spread 20+ 字段。
- **D3 — 单 attach/release owner**：只有 coordinator 能把 durable claim 绑定到 runtime handle，并确保每个 attached
  execution 恰好一次 release/finalize；engine/bridge 不自行注册 controller。
- **D4 — preparation 是 phase 0**：`taskWorkspacePhase` + persisted task/repository facts 决定 skip/drive/retry；
  current retry reconstruction 成为唯一 hydrate path。手工 resume 对 prep-incomplete 的既有错误保持，retry command 仍是明确入口。
- **D5 — 复用 RFC-328**：owner/intent/effect/fence/context/registry/outbox 全部复用；`workspace-prepare` 继续是唯一
  repository preparation effect kind，不新增表或 daemon worker。
- **D6 — 三路 engine registry**：registry exact keys 保持 `dag | workgroup-turns | dw-generate`；unknown key 可见失败，
  `dw.phase=executing` 仍走 DAG；`code-round` 不在 active registry。
- **D7 — DAG 与 workgroup 不互相伪装**：`DagTaskEngine` 拥有 frontier/scope recursion；`WorkgroupTaskEngine`
  拥有 round/assignment；二者只共享 node/kernel mechanics。dynamic generate 通过自己的 strategy，confirm 后再选择 DAG。
- **D8 — task settle 单写**：engine 只返回 `ok | failed | canceled | awaiting_review | awaiting_human` outcome；
  orchestrator 统一执行 readonly inspection、task terminal/park CAS、status projection 与 durable lifecycle writer。
- **D9 — 有界 mechanics ports**：W2-B 只允许 purpose-specific node-step、nested-scope、workgroup-host 与 pre-drive replay
  compatibility adapters；readonly inspection/commit-push 走独立 task-completion required port。任何 port 都不接 raw task command、
  状态目标或任意 callback bag，并登记由 W2-C/W2-D/W5 接管或删除的波次。
- **D10 — 先修 canonical 真值再领 credit**：owner generator 的 `schedule` 必须使用 token boundary；关键 symbols 的
  target context/layer/remove wave 由 exact assertions 固定，artifact 必须由生成器重放，禁止手改 JSON。
- **D11 — 一次生产 cutover**：additive contracts/oracles 可先落在同一 candidate，最终 consumer switch、旧 body 删除、
  facade ledger 更新必须在一个可回滚 production commit 中完成，不增加临时 `KNOWN_VIOLATIONS`。
- **D12 — 功能优先**：实现门只核对功能与架构职责；不提出或夹带新的安全/权限策略。任何现有正常能力发生变化，
  先更新本 RFC 的能力影响并重新请批。

## 5. 能力影响清单

目标影响全部为 **零行为变化**：

| 功能面                   | current 行为                                                             | W2-B 必须保持                                                       |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| initial launch           | task 先可见；deferred prep 默认后台；`awaitScheduler` 可等待             | 返回时机、task/prep row、错误与最终状态不变                         |
| repository prep          | `__repo_prep__` 可见；网络窗口重试；失败可 retry；cancel/shutdown 可恢复 | 同一 effect/attempt、retryIndex、error text、回填事务与取消竞态不变 |
| resume/sync/gate         | 各自 preflight + lifecycle/intent CAS 后 re-drive                        | allowed-from、错误顺序、rollback、await/background 不变             |
| retry node               | exact target/cascade/branch run-anyway/child cancellation 后 re-drive    | retryIndex、freshness、skipped/consumed 与返回时机不变              |
| boot/lifecycle repair    | interrupted/answered continuation 恢复；prep 走 retry command            | 候选、breaker/audit 与重试结果不变，只去掉 CLI 重复 drive wiring    |
| DAG                      | completion-driven frontier、nested scope、deferred question、commit-push | ready/park/stall/terminal 与并发度不变                              |
| workgroup                | round/assignment 独立于 DAG；host mechanics 共用                         | wake/adoption/reconcile/clarify/terminal 不变                       |
| dynamic workflow         | generate → confirm → execute DAG；reject/regenerate 有界                 | phase、gate holder、错误与 dispatch invariant 不变                  |
| task metadata            | immutable `launch_origin`；root catalog value、child 同 INSERT 继承      | 不从 engine kind/source反推，不默认改写，不改查询可见性             |
| prune/source termination | current task fence、terminal/prune claim 与 source-revival outcome       | 判定顺序和最终状态不变                                              |
| AgentAttempt host        | 仍是普通 agent/workflow host task                                        | 不新增 execution kind，不改变 mission/task link                     |
| wire/events              | REST/MCP/WS/DB status/error/lifecycle payload                            | 零 schema 与 payload 变化；WS 仍 after-commit projection            |

若实现需要改变任一行，本批准自动失效，必须先修订并重新请用户裁决。

## 6. 用户故事

- 作为任务使用者，我启动、恢复、重试、取消或等待 repository preparation 时，看到的 task/node 状态、错误、返回时机与恢复能力不因架构迁移改变。
- 作为 workflow 使用者，我的 DAG、嵌套 wrapper、branch skipped/consumed、人工暂停与自动提交继续按同一规则推进。
- 作为 workgroup/dynamic workflow 使用者，我的 round/assignment 与 generate/confirm 状态机不会被误并成普通 DAG。
- 作为数字员工/研发自动化使用者，我的 AgentAttempt 仍复用普通 host task，不需要理解新的 execution kind。
- 作为维护者，我能从唯一 coordinator、closed engine registry 和 canonical owner ledger 找到真实生产入口与后续删除波次。

## 7. current inventory（开工必须逐项对拍）

| 类别                   | current source                                                                   | W2-B 处置                                                           |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 四个 drive 点          | `services/task.ts` initial / `resumeKick` / `retryRepoPreparation` / `retryNode` | 改为同一 coordinator submission                                     |
| boot prep 分流         | `cli/start.ts` 查询 latest `__repo_prep__` 后调 `retryNode`                      | 收入 application recovery adapter，CLI 只触发一次 recovery use case |
| topology adapter       | `services/startTaskDeps.ts#createLegacyTaskExecutionTopology`                    | 替换为实例化 coordinator + narrow legacy mechanics bridges          |
| task drive             | `scheduler.ts#runTaskWithTopology/runTaskInner`                                  | 迁 application/orchestrator，legacy body 删除                       |
| DAG scope/frontier     | `scheduler.ts#runScope/deriveFrontier`                                           | 迁 `engine/task/dag`，测试改 import 唯一 owner                      |
| engine resolver        | `services/execution/engines.ts#resolveTaskEngine`                                | 迁 closed TaskEngine registry；旧 facade consumer=0 后删除          |
| workgroup/dynamic      | `workgroup/engine.ts`、`dynamicWorkflowRunner.ts` + scheduler hooks              | 保留领域状态机，经 typed strategy/host port 接入                    |
| node/wrapper mechanics | `scheduler.ts#runOneNode/runWrapperNode`                                         | 本 RFC 不迁；经 W2-C/D bridge 消费                                  |
| durable authority      | `modules/task-execution` RFC-328 stores/context/registry                         | 原样复用，无第二实现                                                |
| canonical projection   | `tests/architecture/rfc294Canonical.ts#targetContextFor`                         | 修 token/exact owner；重放 artifacts 与 mutation                    |

## 8. 验收标准

- **AC-1**：生产入口 inventory 覆盖 direct JSON/multipart、agent/workgroup、schedule、webhook、DE/DA、fusion、call child、
  resume/sync/gate/retry、boot auto-resume 与 lifecycle repair；每项都有 admission → intent → coordinator 证据。
- **AC-2**：`services/task.ts` 四个 inline kick=0，`cli/start.ts` 不再查询 prep row 并拼 recovery deps；
  `SchedulerDriverPort.kick` production consumer=0。
- **AC-3**：coordinator 是唯一 attach/controller/context/release/finalize owner；background 与 await 两种返回时序有行为测试，
  attach 失败、同步抛错、后台抛错和 cancel race 均不泄漏 handle。
- **AC-4**：initial 与 prep retry 共用一个 `RepositoryPreparationStep`；复用现有 `workspace-prepare` effect ledger；
  `__repo_prep__` 的 mint→running→terminal、retryIndex、错误文本、成功回填事务逐项等价。
- **AC-5**：manual resume 对 prep-incomplete 的当前错误保持；boot 仍经 retry-prep admission，但真正 drive 不走 CLI 特例；
  daemon shutdown 保持 interrupted、用户 cancel 保持 canceled。
- **AC-6**：closed registry 恰好三种 active engine；plain workflow/agent=`dag`、turn workgroup=`workgroup-turns`、
  dynamic generate=`dw-generate`、dynamic execute=`dag`；unknown/history code-round 不会进入 active engine。
- **AC-7**：`runTaskInner`、`runScope`、`deriveFrontier` 在 legacy scheduler inline body=0；对应生产实现唯一位于
  `modules/task-execution`，测试不再从 scheduler import frontier/drive。
- **AC-8**：`runOneNode` 与 wrapper mechanics 未冒领 W2-B；bridge consumer/field/method/remove wave 可枚举，
  不传 `SchedulerState`、`StartTaskDeps` 或通用 callback map。
- **AC-9**：top-level 与 nested wrapper scope 使用同一 DAG scope driver；loop/git/fanout 的现有 recursion、iteration、
  park/merge outcome 全部回归通过。
- **AC-10**：workgroup round/assignment 与 dynamic generation 状态机保持独立；host execution 只经共同 mechanics port，
  workgroup task 永不误入 DAG frontier。
- **AC-11**：RFC-306 `skipped/consumed`、freshness、run-anyway 与 deferred question行为保持，现有 frontier/audit corpus 迁 owner 后全绿。
- **AC-12**：RFC-301 `launch_origin`、TaskCatalog `public|internal` root value 与 child same-INSERT inheritance 保持；
  TaskEngine 只读持久事实，不从 kind/source/DE link 反推或回写默认值。
- **AC-13**：RFC-300 prune claim、RFC-303 source termination/revival fence、RFC-310 AgentAttempt host task 回归通过；
  不新增 engine kind或 parallel terminal writer。
- **AC-14**：task park/terminal CAS、readonly inspection、WS status projection 与 RFC-328 lifecycle outbox 次数/顺序保持；
  W2-B 不创建第二 durable event 通道。
- **AC-15**：canonical generator 不再让 `scheduler.ts` 命中 `schedule`；关键 B/C/D symbols 的 owner/wave exact assertions 正确，
  manifests 全由 generator 重放并与 source digest 对齐。
- **AC-16**：mutation fixtures 能分别抓住新增 direct kick、旧 inline drive/frontier 回流、第四 active engine、
  boot prep 特例、bridge god-port、owner substring 误分类和 catalog inheritance 漂移。
- **AC-17**：REST/MCP/WS/schema、错误码、状态枚举、用户可执行能力与权限均无变化；不添加安全策略或功能挡板。
- **AC-18**：targeted 功能/架构套件与唯一一次 candidate full gate 通过；发布后以 exact-SHA GitHub Actions terminal
  结果为全仓结论，cancelled/queued/无关 SHA 不记为绿。

## 9. 批准记录

用户于 2026-08-27 以“ok”显式批准 D1～D12、能力影响清单以及 design.md 中两个临时偏离：

1. **DEV-1**：W2-B 期间保留 purpose-specific legacy node/nested-scope/workgroup-host/pre-drive replay adapters，
   分别由 W2-C/W2-D 删除；task-completion required port 在 W5 更换最终 adapter；
2. **DEV-2**：W3 前继续复用 RFC-331 的 after-commit `TaskStatusPublisher` compatibility adapter，
   durable lifecycle outbox 仍是唯一持久事件通道。

批准只授权 `plan.md` T3～T13 的 W2-B 实现，不授权 P0-C、W2-C/D、W3、W4/W5、任何安全/权限改动或能力收缩。
