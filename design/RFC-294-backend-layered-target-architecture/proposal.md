# RFC-294：后台最终层次架构与能力归一总纲

- 目标架构状态：Draft（2026-08-19 刷新；仍待用户批准 D1～D9）
- 迁移事实：Out-of-order in progress（RFC-287、RFC-297～311 已按各自范围形成多条 production vertical slice；
  RFC-288/289 已关闭且未实现；这些落点均不等于 RFC-294 任一完整 wave 已获批或完成）
- 性质：目标架构总纲 + 迁移治理合同；本次刷新只改设计文档，不修改生产代码
- 当前 committed tip：`HEAD=origin/main=9ec2a4694e3c0d6d15bcc11792ee99ae7c07b614`；但该 tip 的 clean backend
  typecheck 仍因 `DevelopmentAutomationModule.drive` 缺口失败，因此标为 **NOT-CLEAN / inadmissible**，不得计作 landed
  architecture 或行为 oracle。最后可准入、可复跑的量化基线仍为 `dfda2d027016b026be9ca632d3b97333aa1c602b`，已包含
  RFC-304～311 的生产改造（含 RFC-311 G4、T20、T21）。`7c542729/9ec2a469` 的 mission keyset/limit 分页与 admission
  preview 仅记 pending source delta；共享工作树中的 RFC-312 与后续 UI/runtime 改动也不计入 landed architecture。量化与
  下一步顺序以 `plan.md` §1/§3.2 为准；每个实施 wave 开工时仍须重钉新的干净、已发布 exact SHA
- 直接输入：
  - `design/system-commons-unification-audit-2026-08-12.md`
  - `design/task-execution-architecture-audit-2026-08-03.md`
  - RFC-271、RFC-280、RFC-282、RFC-284～RFC-289、RFC-292、RFC-295、RFC-297～RFC-311

## 1. 摘要裁决

后台的最终结构采用 **feature-first bounded context（按领域聚合）+ 模块内分层**，而不是继续把
`routes/`、`services/`、`db/` 横向铺开，也不是一次性把 300 多个 service 文件机械搬目录。

每个领域模块内部固定分为：

```text
inbound adapter ──► public application commands/queries
                              │
                              ├──► domain
                              └──► application-owned ports ◄── infrastructure

engine ──► domain + application-owned ports + kernel contracts
bootstrap ──► public contracts + concrete infrastructure（只装配，不做业务判断）
```

`domain` 与 `ports` 不是 `domain → ports` 关系：domain 只依赖中性值对象；需要时由 application/engine 依赖
application-owned port。运行时调用方向与源码 import 方向不能混写。

全局依赖方向为：

```text
HTTP / MCP / Webhook / Schedule / CLI
                  │
                  ▼
        Application Commands / Queries
                  │
                  ▼
       Task Engines / Node Executors
                  │
                  ▼
             Execution Kernel
                  │
                  ▼
       Domain + Application Port Contracts
                  ▲
                  │
 DB / FS / Git / Runtime / WS / Clock / Outbox

Bootstrap / Composition Root 只负责把两侧接起来，不承载业务判断。
```

最终目标不是“所有代码都走一个万能 service”，而是：

1. 同一种机制只有一个内核；
2. 不同领域规则保留在各自模块；
3. 跨模块只依赖公开合同，不读取对方表、内部文件或全局单例；
4. 业务写命令显式携带 trusted authority，internal effect 携 family-scoped capability，并统一并发 fence、事务边界、
   审计和提交后事件；
5. 运行态身份、生命周期、恢复与副作用先成为可建模概念，再扩能力。

## 2. 为什么还需要本 RFC

RFC-280/282/284/285/292 已经完成了多块重要归一：agent spawn、资源注入、runtime driver、
ACL 判据、生命周期写点、RouteMeta 权限元数据、触发上下文等都已经有单一事实源。当前问题不再是
“完全没有抽象”，而是抽象停在了机制层，尚未形成稳定的后台层次架构。

截至最后可准入、可复跑的 `dfda2d02` 量化基线（当前 committed tip `9ec2a469` 另按 NOT-CLEAN 偏差记账）：

| 指标                              |                   当前值 | 说明                                                                       |
| --------------------------------- | -----------------------: | -------------------------------------------------------------------------- |
| backend TypeScript 源文件         |                      676 | `packages/backend/src/**/*.ts`                                             |
| `services/` 内实现文件            |                      362 | 其中根目录平铺 192 个                                                      |
| `modules/**` production TS        |   182 / 7 个现存 context | `development-automation` 90 个；其余见 `plan.md` §1                        |
| `scheduler.ts`                    |                10,513 行 | 仍同时承载图引擎、wrapper、fanout、装配、状态与广播                        |
| `task.ts`                         |                 6,692 行 | 仍同时承载入口、物化、控制面、读模型、恢复和 active registry               |
| route→DB 值级文件                 |                       15 | transport 仍可绕过 application/use-case 层                                 |
| route/MCP `AppDeps` consumer 文件 |                       52 | transport 仍反向依赖 composition root                                      |
| 值级 SCC                          | backend 5 个 / 全仓 7 个 | 依赖图形状未因目录增长而完成收口                                           |
| `KNOWN_VIOLATIONS`                |                       35 | task 6、git 5、其余环 6、services→routes 1、route→DB 15、util→upper 2      |
| production `setInterval(`         |          28 处 / 23 文件 | 另有 34 个 token 命中；W0-R 必须按 job/worker/execution-local 重建正式分母 |

RFC-305/306/308/310/311 已经证明目标方向可落地：identity authority、branch activation、source-control participant、
development mission 以及 archive/retention 都已有真实纵切。但“聚合与行为已落”“模块内分层已落”“跨 context exact
surface 与 consumer 已切完”是三种不同状态；当前没有一个 RFC-294 wave 满足完整退出门。

典型结构性裂缝已经产生正确性问题，而不仅是“代码不好看”：

- Memory 通用 PATCH 先按旧 scope 授权，事务内却能把 approved memory 移到新 scope；新 scope
  不再校验，随后内容会按新 scope 注入 agent prompt。
- Intent 与 BundleApply 各维护一套 claim/stage/commit/compensate/converge 引擎，前者已经出现
  lock 永不释放、补偿失败仍终态化、收敛漏 artifact 的漂移。
- review decision 的多份文档 mutation 尚未纳入同一事务，daemon crash 或后续步骤失败可留下部分决定、
  部分未决定的半态。
- task ownership 被 `activeTasks`、`driverLease`、状态 CAS 和 recovery 多套机制共同表达。
- lifecycle 状态写点已归一，但 WS、child budget、execution watch、terminal human-gate sweep 等
  提交后效果仍由调用点和全局 hook 自觉拼接。
- fanout child 的身份与来源仍依赖 `parentNodeRunId`、ULID 新旧和 JSON consumed map 组合推断；
  RFC-289 已关闭设计的“当前 wrapper parent”与跨 generation 复用直接冲突。
- HTTP/MCP/API docs 复用 route/server 注册表，`AppDeps` 同时暴露 DB、配置、dispatcher 和测试 seam，
  transport、composition root 与 application 边界没有真正分开。

继续以“小 helper 收口 + 大文件内再抽函数”的方式推进，只能降低重复行数，不能保证下一项能力不会
再次沿旁路长出第二套实现。本 RFC 因此定义所有后续重构必须共同指向的终局。

## 3. 目标

### G1：形成可机器验证的单向层次

- Domain 不依赖 Hono、Drizzle、SQLite、WS、FS、Git、Runtime driver 或进程全局状态。
- Application 只依赖本模块 domain/ports、`platform/contracts` 与其他模块受控
  `public/{commands,queries,participants,events,types}` 精确入口；consumer-owned required SPI 只经
  `composition/required-ports` 给 bootstrap 与指定 provider adapter，bootstrap 只额外依赖 module `composition.ts`。
- Engine 只依赖 domain/ports，不直接发布 WS、不直接读 route context。
- Infrastructure 实现 ports；除 bootstrap 外，不得反向调用 application 内部实现。
- Inbound adapter 只解析协议、调用 command/query、映射错误和 DTO。
- Bootstrap 是唯一知道具体实现、定时任务和 adapter 装配的位置。

### G2：按领域模块获得唯一 owner

最终后台至少形成以下 bounded contexts：

| 模块                         | 唯一拥有的能力                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `identity-access`            | user/OIDC/session/token、role/permission、opaque request/transaction authority 与认证审计                    |
| `task-execution`             | Task/NodeRun 生命周期、调度、恢复、运行态 ownership、wrapper/fanout、执行身份与 provenance                   |
| `development-automation`     | DevelopmentMission/ActionRun/AgentAttempt、确定性策略与配置资源、evidence/effect intent、MR 生命周期编排     |
| `resource-catalog`           | agent/skill/MCP/plugin/workflow/workgroup 六个聚合子模块；共享 ACL/ref/revision/catalog kernel               |
| `collaboration`              | review/clarify/question 等 human gate、授权、park/release/rerun 命令                                         |
| `knowledge-evolution`        | memory→skill fusion aggregate、融合决策/provenance，以及 skill restore 时 fused-membership 不变量            |
| `integration`                | webhook、schedule、code-host ingress/egress 及其触发合同                                                     |
| `intent`                     | Intent 会话、working set、turn/draft/checkpoint；资源提交只通过共享 atomic apply port                        |
| `memory`                     | memory 生命周期、scope policy、注入快照与 distill；fusion 生命周期不再埋在 memory CRUD 中                    |
| `source-control`             | repo/repo-group/cache/worktree/submodule/credential 与 Git 操作语义                                          |
| `runtime-management`         | runtime inventory/profile/status/probe/diagnostic；执行只消费冻结 RuntimeDriver port                         |
| `workspace-insight`          | structural diff、code intelligence、change narrative 与只读内容分析                                          |
| `system-operations`          | admin backup/restore/recovery/diagnostic orchestration；不拥有 readiness、task limits 或 workspace GC policy |
| `platform`（非业务 context） | persistence/tx、runtime/process mechanism、event outbox、config、background、errors/observability            |

跨域共享只能是稳定值对象、port 或领域事件；不能以“复用方便”为由共享 Drizzle table、route context、
内部 service 或可变 singleton。

`resource-catalog` 内共享的是 ACL/ref/revision/catalog 小内核，不是一个 `switch(resourceType)` 万能 CRUD；
六类资源各自保留独立 aggregate、command 和不变量。

RFC-304 的 `code-capability` 不再是目标态 active writer context：RFC-310 已把五条能力的写模型切到
`development-automation`。当前残留 19 个 production 文件只作为历史查询/兼容资源岛；其中 capability template 同步仍是
活跃兼容例外，必须在 retention/owner 决策后迁走或退役，不能借兼容名义恢复 code-round writer。

### G3：执行链形成四级内核

`task-execution` 内部固定为四层：

1. `TaskEngine`：任务级 frontier、暂停/恢复/取消与 scope 推进；
2. `WrapperRuntime`：loop/git/fanout 的 scoped graph 行为；
3. `NodeExecutor`：agent/script/call/code-host/review/clarify 等 kind 的显式执行器；
4. `ExecutionKernel`：许可、iso、spawn、retry、merge、settle 所需的机制原语。

RFC-287 的 `runAssembly(spec)` 是第 4 层的必要第一刀，但不等于整套目标架构；它不能继续吸收 task
控制面、fanout 身份、human gate 或领域状态判断。

### G4：写命令和提交后副作用归一

所有业务 aggregate mutation 都必须通过显式 application command；lease/outbox/projection 等 mechanical writer 则走
owner 定义的窄 claim/fence，不伪装业务 command：

- direct/delegated business command 必须使用 trusted current authority；internal effect 使用 event-family/job-scoped
  private capability，不允许 `actor?`、调用点伪造 `SystemActor` 或一个万能 system key；
- 在同一事务内重读授权依赖的旧状态与新目标；
- 需要并发保护的资源必须带 expected revision/version/epoch；
- 状态变更与 audit/domain event 同事务提交；
- 正确性关键副作用走 durable outbox；可重建副作用走 reconcile；WS 等短暂通知只允许在 commit 后
  消费同一 committed event，不能在事务内外发；
- adapter 不能自行补一段 DB 查询、broadcast 或补偿逻辑。

这是一套 command envelope 与事务纪律，不是一个万能 CRUD engine。资源删除、memory scope move、
task retry、review decision 仍保留各自的领域不变量。

### G5：运行态身份和 provenance 成为一等模型

最终不再用 ULID 大小、nullable parent 与多个附加列共同猜测“这行是谁”。NodeRun 至少显式建模：

- `RunRole`（node-attempt/container/synthetic）与 synthetic owner axes；
- `scopePath` / `containerRunId`；
- 每个 physical row 的 task-scoped 单调 `seq`（`UNIQUE(taskId,seq)`）；
- 逻辑执行代 `generationSeq`，与 retry `attemptIndex` 分离；
- `attemptIndex`；
- `shardKey`；
- 历史 parent 与当前 selected run 分离；
- consumer→producer 的逐边 provenance。

freshness、resume、retry、fanout replay 和 aggregator 都消费同一 selected-run/provenance 合同，
不再各自拼 SQL + JSON + ULID fallback。

### G6：恢复型副作用只保留一套 lifecycle engine

BundleApply 已经具备较完整的 record-before-act、big transaction、compensation、roll-forward 与 convergence
合同。最终由 `platform/atomic-apply` 唯一拥有 `AtomicApplyEngine` 状态机，ResourcePackage、Intent 资源提交、
fusion approve 与 skill restore 等经行为对拍后以 domain provider 接入。场景可以保留自己的 aggregate、journal
adapter 与 versioned artifact payload，但不能复制 claim/prestage/commit/compensate/roll-forward/converge lifecycle、
active set 或恢复终态。若某场景经证明确实不是同一生命周期，则保留自己的**领域状态机**，但仍必须复用事务、
fence、journal 和 post-commit 原语，不能再造另一台名为 apply 的通用恢复引擎。

### G7：迁移过程本身可验证、可回退、不中断并发开发

- 每波先固定行为 oracle，再引入合同，再切一个 consumer，最后删除旧实现；
- 只保留一跳、无状态、无业务判断的兼容 facade；
- 不允许两套独立业务 writer；涉及 schema 时采用 expand → backfill/oracle → cutover → contract，兼容期只允许
  同一 writer 在同一事务维护 canonical 字段与确定性的 legacy projection；
- `scheduler.ts`、`task.ts`、`lifecycle.ts` 等高冲突文件严格串行；
- 每波独立提交、独立门禁、独立实现门，不以“大重构最后一起测”作为安全策略。

## 4. 必须保留的现有资产

本 RFC 不推倒重来，下列已归一能力作为目标架构的既有地基：

- `RouteMeta` 与 HTTP/MCP 声明式鉴权门；
- `resourceAcl.ts` 的资源可见/管理判据；
- `RuntimeDriver`、`SpawnPlan`、`managedProcess` 和 RFC-280/282 的资源注入链；
- `setTaskStatus` / `trySetTaskStatus`、node status/merge state 的唯一写点；
- `nodeRunMint`、freshness 纯函数、retry index 原语；
- `dbTxSync` 作为 SQLite 同步事务事实，不另造异步 UnitOfWork；
- RFC-292 的 trigger namespace 作为“shared contract → admission → persistence → execution → UI”
  全纵切归一范例；
- dependency-cruiser + `KNOWN_VIOLATIONS` 的账外新违规/stale 账双向棘轮。

## 5. RFC-287 与已关闭 RFC-288/289 的定位

### 5.1 RFC-287：已落地，保留为 W1 behavior baseline

RFC-287 已经 Done。它把五条 scheduler spawn 装配线统一到 `runAssembly(spec)`，并交付 G4 配额设置、G5 公开
`file://` 收缩、G6 仓库同步窗口和 G7 task 落库后可见的 `__repo_prep__`/失败留痕等行为。这些均进入兼容 oracle，RFC-294
不重新打开其批准范围，也不得回滚公开 `file://` 收缩、stale-source hard-fail 或现有 prep 可见性。

同时必须区分“RFC-287 已交付”与“RFC-294 后来定义的终局边界”。当前 assembly 仍在 legacy `services/`；生产 G7
仍由 `startTaskImpl` 推进，task 与 synthetic run 不是原子 admission，stronger “所有入口共用 normal `runTask` 第 0 步 +
durable operation/receipt + SC sealed source”也不是已落事实。若目标仍保留这些能力，必须按 `plan.md` §5.2 重分配：

- assembly port/物理归位进入 W2-A；
- durable execution authority 进入 P0-D；
- task/repository admission、claim、retry/resume/boot 同路进入 W2-B 的独立行为 RFC；
- source seal/frozen preparation policy 进入 W4-E1/W5；
- audit/committed event/after-commit WS 进入 W3。

这不是把 RFC-287 判回未完成，而是禁止用一个已经 Done 的编号替后来扩大的架构合同背书。RFC-287 的 G1～G3
assembly 仍只属于 ExecutionKernel 机制层；G4～G7 不能被塞进 `RunAssembly`，后续迁移必须保持现有 wire/status/错误与
恢复 oracle，任何能力变化另行呈批。

### 5.2 RFC-288：已关闭；结论和六条环债转入 W2

RFC-288 已于 2026-08-14 由用户决定关闭：**未实现、零生产改动，旧 plan 永久不可执行**。关闭不否定
task↔scheduler 解环，而是因为三轮设计门后其有效范围已完全收敛为本 RFC §16.2/W2 的四合同拓扑；同时 P0-D
未落、源码锚两天漂移三轮，继续维护独立三件套只会在开工前再重写。六条 depcheck ledger 的 owner 已转给 W2。

W2 的新号轻量 implementation RFC 必须复用 RFC-288 留下的九条结论，并至少实现：

- `TaskRuntimeRegistry`：只拥有本进程 active handles/abort reason；
- `TaskOwnershipPort`：lease/epoch/fencing；
- `TaskStatusPublisher`：只发布已提交 lifecycle fact；durable outbox cutover 仍归 W3；
- `SchedulerDriverPort`：由 application 显式注入，未装配时 bootstrap fail-fast；
- `TaskReadModel` 与 workspace materialization 各自归域。

同时必须携带 `OwnershipToken`/epoch，保留非可选 `abortAll(reason)` 的 RFC-202 `interrupted` 语义，覆盖
`startTask/resumeTask/retryRepoPreparation/retryNode` 四个 kick；先把同一 `TaskExecutionContext` 穿入 consumer，再替换
registry backing，避免双 registry。开工门是 W0-R + P0-D 退出证据与当前源码 inventory，不是重新打开 RFC-288。

### 5.3 RFC-289：已关闭；产品目标排在身份/provenance 之后另立新号

fanout 内链是合理能力扩张，但当前设计把 child 上游限定为
`parentNodeRunId === 当前 wrapperRunId`，同时既有跨 generation replay 明确保留 child 原 parent；两者不能
同时成立。当前 child 行也不记录内链 consumed provenance，`pickReusableShardRun` 只看 shardKey/valueHash/status，
所以“已有 consumed gate 会让 B 随 A 失效”并不成立。

RFC-289 同样已于 2026-08-14 关闭：**未实现、零生产改动**。关闭的是当前设计，不是 fanout 内链产品目标；旧
T2～T8 不得继续执行。W7 完成后，如仍要该能力，必须另立新编号并满足：

- 通过 generation 的 selected-run map 找同 shard 上游，而不是改写历史 parent；
- 在 B 行持久记录它实际消费的 A child run；
- reuse 同时比较 shard identity 与 consumed dependency fingerprint；
- validator 规则从可达的真实集合推导，避免死规则或重复规则；
- 先完成 NodeRun 身份轴与兼容迁移，再解除能力挡板。

W7 之前继续保留 `fanout-inner-chain-unsupported` 挡板。该能力属于独立、可选的 post-W7 扩张线；没有新 RFC 的
独立批准时跳过 W8，不阻塞 RFC-294 核心分层迁移与 W9 清仓。

## 6. 前置 P0 安全与一致性阻断

大规模搬迁不能掩盖现有正确性缺口。下列安全项必须在各自依赖的 wave 前以独立小 RFC/修复批处理：

1. **Memory scope move**：通用 PATCH 禁止改 scope；专用 command 在同一事务用 trusted current authority
   校验旧 scope、新 scope与目标存在性。command input 不接收或持久化 Actor/权限快照；approved/archived 是否允许移动
   必须单列能力影响请批，默认 fail-closed。
2. **Memory 提交后事件**：事务内不得同步 publish，避免 rollback 后 ghost WS。
3. **Intent apply**：先修 lock 清理与不可恢复终态，再让 Intent 以 provider 接入 AtomicApplyEngine；
   不继续双修两套 converger。
4. **Review decision 原子性**：durable decision、文档快照、node/task transition 与 continuation intent
   必须同一事务提交；FS/output 走 prepare+journal+roll-forward，route 不再拼接 resume saga。
5. **最小 durable ownership fence**：旧路线要求它先于 RFC-287，但历史实施已打穿此前置；现在必须前向修复，在
   RFC-303 已落事实与 W0-R 最小 capability gate 后，把人工、自动与 scheduler 入口统一到持久 owner/epoch claim；所有
   execution-plane task/node DB mutation 同事务 CAS epoch，control/gate command 使用 expected revisions 并原子写
   desired-control/continuation 或使旧 epoch 失效；FS/Git/process side effect 使用 task-scoped exclusive fence。它是
   新号 W2 implementation RFC 的硬前置，不能以 process-local supervisor 替代。
6. **关闭项承接**：RFC-288 的九条结论与六条环债只作为 W2 新号 implementation RFC 的输入；RFC-289 的五条
   identity/provenance 要求只作为 W7 后新号能力 RFC 的输入。两份 CLOSED 文档都不再充当 gate，也不再修订状态。

RFC-287 已落地，旧的 P0-A/B/C/D→W1 箭头改记 prerequisite deviation，不伪造为已完成。P0-A/B/C 分别重新绑定
W4-E2、W6、W2-C/W3；W0-R + P0-D 在新号 W2 implementation RFC 前汇合。W7 identity/provenance 完成后才允许新号
fanout 能力 RFC；未获批时跳过 W8。最新 partial order 以 `plan.md` §3.1 为准。

## 7. 非目标

- 本 RFC 当前批次不修改生产代码、DB schema、API、MCP、WS 或产品能力。
- 不一次性搬迁全部 `services/` 文件；目录变化随 owner/接口/consumer 切换发生。
- 不把六类资源硬做成同一套泛型 CRUD；只统一 command、policy、repository、event 的合同形态。
- 不把 call-workflow 当 wrapper，也不把 workgroup assignment 混进 NodeRun 状态机。
- 不重写已有 RuntimeDriver/managedProcess/resource injection。
- 不以微服务、容器或多进程 daemon 为目标；当前仍是单 daemon，但内部边界必须支持可靠测试与演进。
- 不承诺一次 RFC 完成全部迁移；本 RFC 是 umbrella contract，各行为/迁移波次仍需独立 RFC 和批准。

## 8. 能力影响

当前设计批 **零产品行为变化**。后续波次的能力影响按以下规则处理：

| 类别                 | 处理                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| 纯依赖/目录/接口迁移 | 行为对拍，允许 facade，禁止 API/错误码/事件顺序变化                       |
| 安全修复             | 独立 RFC 列收缩面、受影响 actor/状态/资源和迁移策略                       |
| NodeRun schema       | 新旧 oracle + 存量任务 resume 兼容 + 删除 fallback 的明确时点             |
| fanout 内链          | 作为能力扩张独立批准；失败/复用/恢复矩阵必须齐全                          |
| lifecycle/outbox     | critical 事件至少一次；consumer 幂等；WS payload 保持兼容                 |
| AtomicApply          | journal replay/duplicate/compensation 语义必须不弱于 BundleApply 当前合同 |

## 9. 需要用户批准的架构决策

批准本 RFC 表示接受以下目标，而不是授权一次性实现所有波次：

- **D1**：采用 bounded-context feature-first，模块内分层；不建设新的横向 `services-v2/`。
- **D2**：跨业务模块只能依赖受控 `public/{commands,queries,participants,events,types}` 精确入口；consumer-owned
  required SPI 只经 `composition/required-ports` 给 bootstrap 与指定 provider adapter，bootstrap 只可额外依赖 module
  `composition.ts`，Drizzle table 与内部实现不外泄。
- **D3**：业务写命令强制 trusted authority + fence + transaction + audit/outbox；internal effect 强制 family-scoped
  capability；transport 不持有业务写逻辑。
- **D4**：Task ownership 最终用显式 lease/epoch/fencing，process registry 只做运行句柄缓存。
- **D5**：NodeRun 增加 row kind、scope、persistent sequence 和逐边 provenance；ULID 不再承担 freshness 序号。
- **D6**：`platform/atomic-apply` 唯一拥有通用 AtomicApply lifecycle；Intent/ResourcePackage/fusion/skill-restore
  只提供领域 provider 或显式证明不适配，不得复制恢复机。
- **D7**：RFC-287 作为已落 behavior baseline 保留；RFC-288/289 保持 CLOSED，不重新打开。W2 另立轻量实现 RFC，
  fanout 内链在 W7 后另立新号能力 RFC。
- **D8**：迁移采用逐域绞杀和单写源；任何兼容 facade 都有 owner、删除波次和棘轮。
- **D9**：模块边界按 consumer 的最小信息预算治理：exact public entrypoint、offered/required 方向、递归 leaf 字段/方法级
  consumer 账本、capability 防伪造、DTO/event codec 与 type-taint/god-port 棘轮均为硬合同。

## 10. 验收标准

- **AC-1**：design.md 给出完整依赖图、目录树、每层职责和禁止依赖。
- **AC-2**：每个现存散点能力都有唯一目标 owner；没有“公共 service 待定”桶。
- **AC-3**：TaskEngine/WrapperRuntime/NodeExecutor/ExecutionKernel 四级合同清楚，并说明合理特化。
- **AC-4**：command/query、transaction/outbox、error、observability、background、composition root 合同完整。
- **AC-5**：NodeRun identity/provenance 的目标模型可覆盖 retry/resume/wrapper/fanout/call/review/clarify。
- **AC-6**：RFC-287 的已落基线、RFC-288/289 的关闭语义、结论承接与新号 successor 顺序无歧义。
- **AC-7**：plan.md 为每波列前置、输入、动作、退出门、回滚点、冲突面和量化指标。
- **AC-8**：终局量化目标至少包含值级 SCC=0、route→db=0、KNOWN_VIOLATIONS=0、生产全局 setter=0、
  跨 context internal import=0、事务内外发事件=0。
- **AC-9**：兼容策略覆盖 REST/MCP/WS、存量 DB、在途 task/resume、测试 seam 和多 session 并发开发。
- **AC-10**：本批仅设计文档、索引与 STATE；未夹带生产代码或测试变更。
- **AC-11**：每个 bounded context 有最小 public surface 与明确禁止跨界字段；机器账本能对 symbol/method/recursive-field/
  consumer/authority/transaction/data-class 做 unknown+stale 双向检查，以 transitive leaf/union budget 阻止 nested payload
  逃逸，并以变异测试证明 taint、伪造、错绑和 god-port 会红。
