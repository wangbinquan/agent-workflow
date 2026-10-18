# RFC-294：后台最终层次架构与能力归一总纲

- RFC 定位：**长期架构重构 RFC**（用户于 2026-10-14 明确）。持续维护目标架构、迁移波次、跨 RFC 依赖与完成证据；
  具体生产迁移由范围明确、独立批准的 successor RFC 承接。长期维护不降低退出标准，也不把未完成项无限展期。
- **2026-10-16 整体刷新**：按用户要求全面审视实现情况后重写三件套。审视证据与判断见
  [2026-10-16 全面审视](./review-2026-10-16.md)；刷新前全文归档于 `archive-20261016-{proposal,design,plan}.md`
  （取自已推送提交 `643d64db6`），仅供追溯，不再作为退出门。
- 目标架构状态：Approved。D1～D8 沿用 2026-08-30 记账的批准（各 successor 逐项确认，见 `review-2026-08-30.md` §A1）；
  本次按用户授权的整体刷新修订 D9、新增 D10～D13（§9）。总纲批准不授权任何未立项的生产迁移。
- 迁移状态：**In Progress（长期推进）**。P0、W2、W3 与 W4-A/C/E0/E2/E3/E4a/E4b/E6/E7 已由 successor 关闭；2026-10-17 后继 S3 / S4 / S8 由 RFC-375 / 376 / 377 关闭；
  RFC-363/364/365/368 按各自范围抵扣 E1/W5、E6、E9 的纵切。其余开放项与下一批后继见 [plan](./plan.md) §3。
- 当前指标以最近一次 dated review 或按需生成的报告为准；[status.md](./status.md) 只说明生成命令。三件套不手抄指标。
- RFC-376 起普通生产改动无需重采或投影伴随提交；结构变化由硬门、文件内精确例外与 `architecture/counts.json` 检查。
  纯测试、文档、视觉原语与边角功能仍不给任何波次计 credit。

## 0. 长期维护方式

1. `proposal.md` 维护定位、目标、修订记录、立即生效约束与决策；`design.md` 维护目标合同；`plan.md` 维护波次判定、
   后继队列、依赖与退出门。
2. 已提交源码是事实源；`bun run architecture:report --source-ref <rev>` 按需生成库存。保留的主题清单与 `counts.json` 手维护；
   带日期的 `review-YYYY-MM-DD.md` 保存一次审视的基线、判断与证据边界，
   不被后续快照改写。
3. successor 完成时同步其实际抵扣范围与剩余责任；合同批准、源码接线、功能验收、exact-SHA CI 与整波退出分别记账。
   后继 RFC 中已批准的功能取舍优先于总纲旧文字，不能以长期重构为由恢复已被用户否决的要求。
4. 总纲只定方向、边界、层次规则、不变量与 owner；**精确接口以代码与后继 RFC 的 design 为准**（D13）。
5. 必选波次全部达到退出门后，整体迁移才可置 Done；W8 独立决策。

## 1. 摘要裁决

后台的最终结构采用 **feature-first bounded context（按领域聚合）+ 模块内分层**，而不是继续把
`routes/`、`services/`、`db/` 横向铺开，也不是一次性机械搬目录。每个领域模块内部固定分为：

```text
inbound adapter ──► public application commands/queries/operations
                              │
                              ├──► domain（纯值与规则）
                              └──► application-owned ports ◄── infrastructure/<profile>/（local、crewstation…）

engine ──► domain + application-owned ports + 本模块机制库
composition.ts ──► 只构造与注入（不做业务判断、不放实现）
bootstrap ──► 唯一模块工厂图：选择 provider 与部署 profile 的适配器，供各薄入口根共用
```

全局依赖方向：

```text
HTTP / MCP / Webhook / Schedule / CLI / Worker / 任务镜像助手（薄入口根）
                  │
                  ▼
        Application Commands / Queries
                  │
                  ▼
   任务控制面 / scope 解释器 / 节点执行器（task-execution 内）
                  │
                  ▼
       Domain + Application Port Contracts
                  ▲
                  │
 DB（SQLite/PostgreSQL）/ FS / Git / Runtime / WS / Clock / Outbox / 托管平台
（infrastructure/<profile>/ 与 platform 机制实现端口）

bootstrap 只负责把两侧接起来，不承载业务判断；platform 只提供领域中性的机制，不依赖任何模块。
```

最终目标不是“所有代码都走一个万能 service”，而是：

1. 同一种机制只有一个实现；
2. 不同领域规则保留在各自模块；
3. 跨模块只依赖公开合同，不读取对方表、内部文件或全局单例；
4. 业务写命令显式携带可信 authority，并统一并发 fence、事务边界、审计和提交后事件；
5. 运行态身份、生命周期、恢复与副作用先成为可建模概念，再扩能力；
6. **部署形态（单机 / 托管）与存储 provider（SQLite / PostgreSQL）只是适配器选择**，业务路径只有一条。

## 2. 为什么还需要本 RFC（2026-10-16 现状）

横向层的物理迁移已经基本完成：`modules/` 已占后端源码约三分之二，`services/` 大幅收缩，route→DB、transport→DB 与
`AppDeps` 反向依赖归零，后端值级环只剩 `util/git` 一族。执行协调器、闭集注册表、WrapperRuntime、已提交事件和
双库共用事务都是真实生产链。

但腐化换了形态，在模块内部、装配根和执行链上重新出现（证据见 [review §5](./review-2026-10-16.md)）：

- `composition/` 成了新的 `services/`：大量业务与执行机制住在装配层，engine 层只剩委托壳；
- 装配根倍增，SQLite 与 PostgreSQL 两个根的装配大段逐字重复，SQLite daemon 内 HTTP 装配又把若干模块构造一遍并已造成缺陷；
- context 之间出现值级环，`platform/` 开始承载领域状态机并反向依赖模块；
- NodeRun 的新旧判定依赖非单调的 ULID，托管跨主机后还依赖时钟；
- 两套 apply 生命周期与两套资源写入栈，校验规则已经分叉；
- 托管部署作为新维度加入，但缺少总纲层面的落位规则；
- 原有治理方式（全量精确账本）每个提交都要付出成本，却没有挡住上述退化。

继续"小 helper 收口 + 大文件内再抽函数"只能降低重复行数，不能阻止下一项能力沿旁路长出第二套实现。本 RFC
因此持续定义所有后续重构必须共同指向的终局，并给出马上止血的约束（§6）。

## 3. 目标

### G1：可机器验证的单向层次

- Domain 不依赖 Hono、Drizzle、具体数据库、WS、FS、Git、Runtime driver、部署平台或进程全局状态。
- Application 只依赖本模块 domain / ports、`platform/contracts` 与其他模块受控 public 精确入口；不 import infrastructure、
  不直接执行 FS / 进程 / 网络 effect。
- Engine 只依赖本模块 domain / ports / 机制库；不直接发布 WS、不读 route context。
- Infrastructure 实现 ports；按部署 profile 分目录；不反向调用 application 内部实现。
- `composition.ts` 只构造与注入；`composition/` 下不放实现。
- Inbound adapter 只解析协议、调用 command / query、映射错误和 DTO。
- `platform/` 只放领域中性机制，**不 import 任何 `modules/`**。
- Bootstrap 是唯一知道具体实现、provider、部署 profile 与后台作业装配的位置。
- context 级值依赖必须是 DAG；目标 DAG 与 IA type-only 矩阵见 design §3.1。

### G2：按领域模块获得唯一 owner

| 模块                         | 唯一拥有的能力                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity-access`            | user / OIDC / session / token、profile / email、Git commit identity、role / permission、request authority 与认证审计                                                     |
| `task-execution`             | Task / NodeRun 生命周期、三类任务引擎（DAG、workgroup 轮次、动态工作流）、scope / wrapper、节点执行器、执行机制库、运行态 ownership、恢复、执行身份与 catalog membership |
| `task-catalog`               | 多来源只读目录：来源注册、actor-filtered 合并列表 / cursor / facets；不拥有任何写模型                                                                                    |
| `digital-employee`           | 员工类型 / 岗位 / 员工、EmployeeCase、Context / Attention / Reaction、冻结 adapter binding 与确定性职责执行                                                              |
| `event-center`               | Event / Source catalog、Subscription、Observer、EventRecord / Delivery 与来源中性的 `EventResponseRule`                                                                  |
| `execution-contract`         | 执行器中立的输入输出指南、兼容校验、fixture、exact 输出规则与验证回执                                                                                                    |
| `development-automation`     | Mission / ActionRun / AgentAttempt、策略与配置资源、evidence / effect intent、MR 生命周期；目标上吸收 capability template                                                |
| `resource-catalog`           | agent / skill / MCP / plugin / workflow / workgroup 六个聚合与共享的 ACL / ref / revision / catalog 小内核；**不拥有执行**                                               |
| `collaboration`              | review / clarify / question 等人工门、锚点 / 决定、park / release / rerun 命令                                                                                           |
| `knowledge-evolution`        | memory→skill 融合、融合决策 / provenance、skill restore 的成员关系不变量                                                                                                 |
| `integration`                | webhook endpoint / secret、`WebhookTrigger`、schedule、code-host 出入口、外部 adapter definition / connection                                                            |
| `intent`                     | Intent 会话、working set、turn / draft / checkpoint；资源提交只经共享 apply 端口                                                                                         |
| `memory`                     | memory 生命周期、scope policy、注入快照与 distill                                                                                                                        |
| `source-control`             | repo / repo-group / cache / worktree / submodule、Git transport credential、publication 与 Git 操作语义、工作区 GC 策略                                                  |
| `runtime-management`         | runtime inventory / profile / status / probe / diagnostic                                                                                                                |
| `run-observability`          | 运行时调用观测、用量与按运行时 × 模型的价格（RFC-371 v2 形态）                                                                                                           |
| `workspace-insight`          | structural diff、code intelligence、change narrative 与只读内容分析                                                                                                      |
| `system-operations`          | 备份 / 恢复 / 诊断编排、执行权（standby / active / frozen）端口；不拥有业务策略                                                                                          |
| `platform`（非业务 context） | 持久化 / 事务、进程 / runtime 机制、事件 outbox、配置、后台生命周期机制、错误 / 观测、厂商协议客户端                                                                     |

`code-capability` 不是目标 context：它的历史查询与 capability template 写入是待吸收的兼容岛（目标 owner 为
development-automation），不得在其中新增能力。跨域共享只能是稳定值对象、port 或领域事件。

### G3：执行结构如实分层

`task-execution` 内部固定为：

1. **任务控制面**：`TaskDriveCoordinator` 与三类任务引擎（DAG、workgroup 轮次、动态工作流），负责任务级推进、暂停 /
   恢复 / 取消；
2. **scope 解释器**：DAG scope、frontier 与 loop / git / fanout 策略，**显式允许递归**（wrapper 回到 scope）；
3. **节点执行器**：agent / script / call / code-host / review / clarify 等 kind，各自拥有本 kind 的执行主体；
4. **执行机制库**：assembly（spawn / iso / merge / settle 的装配顺序）、隔离与合并、许可与限流、NodeRun 铸造、进程。

每一层必须拥有自己的决策，不允许“类型化委托壳 + composition 里的真实主体”。机制库是引擎内部的库，不是链上的一级。

### G4：写命令和提交后副作用归一

所有业务 aggregate mutation 走显式 application command；lease / outbox / projection 等机械写入走 owner 定义的窄 claim /
fence。业务写命令使用可信 current authority，内部 effect 使用 family-scoped capability；同一事务内重读授权依赖的状态，
需要并发保护的资源带 expected revision / epoch，状态变更与 audit / domain event 同事务提交；正确性关键副作用走持久
outbox，可重建副作用走 reconcile，WS 只在提交后消费同一已提交事件。这是事务纪律，不是万能 CRUD engine。

### G5：运行态身份与 provenance 成为一等模型

NodeRun 的先后**首先**由每任务单调的 `seq` 决定（与 ULID 和主机时钟无关）；随后显式建模 `RunRole`、scope / container、
逻辑执行代、`attemptIndex`、`shardKey`、历史 parent 与当前 selected run 的分离，以及 consumer→producer 的逐边 provenance。
freshness、resume、retry、fanout replay 与 aggregator 消费同一合同。

### G6：恢复型副作用只保留一套 lifecycle engine

`platform/atomic-apply` 唯一拥有 AtomicApply 状态机；ResourcePackage、Intent 资源提交、fusion approve 与 skill restore
经行为对拍后以 domain provider 接入。同时只保留**一套**资源写入栈，同一非法输入在任何入口得到同一错误；收敛保护使用
持久 claim，不依赖进程内集合。确证不是同一生命周期的场景保留领域状态机，但复用事务、fence、journal 与提交后原语。

### G7：部署与存储差异只在适配器与装配处出现

单机与托管走同一条业务路径；SQLite 与 PostgreSQL 共用同一事务语义与业务算法。端口按语义定义，适配器按 profile 分目录，
选择只在 bootstrap 发生一次；进程角色（服务槽、迁移作业、Worker、任务镜像助手）显式化；进程内不变量要么声明为
standalone-only，要么改为持久 claim。

### G8：迁移过程可验证、可回退、不中断并发开发

- 每个后继先固定行为 oracle，再引入合同，再切 consumer，最后删除旧实现；
- 只保留一跳、无状态、无业务判断的兼容 facade；
- 不允许两套独立业务 writer；schema 采用 expand → backfill / oracle → cutover → contract；
- 高冲突文件（装配根、`nodeRunMint`、freshness、迁移目录）严格串行；
- 架构门是少量、能证明会红的硬结构门，而不是需要每个提交伴随维护的全量账本（D9）。

## 4. 必须保留的现有资产

- `RouteMeta` / OperationCatalog 与 HTTP / MCP 声明式门；
- `resourceAcl` 的资源可见 / 管理判据；
- `RuntimeDriver`、`SpawnPlan`、`managedProcess` 与 RFC-280/282 的资源注入链；
- 生命周期写点（`setTaskStatus` / `trySetTaskStatus` 及其 CAS 转移表）与 node status / merge state 唯一写点；
- 唯一 NodeRun 铸造程序（`node_runs` 单一 INSERT 站点）；
- RFC-328 的持久 ownership / intent / effect / fence 与 exact-token registry；
- RFC-341 的已提交事件与逐 consumer delivery；
- RFC-359 的 `DatabaseSession` 双库共用事务；
- RFC-292 trigger namespace 的全纵切归一范例；RFC-371 v2 的“删 v1、按目标分层重做”范例；
- depcheck 的 `no-circular` / `KNOWN_VIOLATIONS` 双向棘轮。

## 5. 原设计修订记录（2026-10-16）

| 编号 | 原设计                                     | 已不合理的原因（证据见 review §4）                                                                                                                     | 修订                                                    |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| R1   | 总纲手写 exact 接口与字段级账本 schema     | design.md 定义的 327 个类型名中 76% 从未出现在代码；外迁裁决六周未执行；后继普遍改名改形                                                               | 总纲只定方向与边界，接口以代码和后继 design 为准（D13） |
| R2   | 逐 symbol / 逐边 / 逐字段全量账本治理      | 约六分之一的提交只为维护账本、常驻约 34 MB JSON；“只降不升”的库存靠自助增长许可照样上升，96% 的 exception 是簿记；持久改善全部来自少数 depcheck 式规则 | 少量硬结构门 + 按需报告（D9 修订）                      |
| R3   | 四级线性链，ExecutionKernel 为最底层       | 只有 WrapperRuntime 是真实层；kernel 无落位；执行是递归 scope 解释而非链                                                                               | 如实分层，机制库归引擎（G3、D12）                       |
| R4   | 非目标“单 daemon”，无部署维度              | 托管已有服务槽、迁移作业、任务镜像助手与执行权租约；接入靠 55 槽 `StartOptions` 覆盖                                                                   | 部署 profile 成为一等维度（G7、D10）                    |
| R5   | 唯一 bootstrap 根，W9 最后再收             | 根在 W9 前已膨胀 4.6 倍并三份重复、同进程重复构造                                                                                                      | 薄入口根 + 唯一模块工厂图，提前到下一批（D11）          |
| R6   | 按“指向 legacy 文件的边”计债，W9/W9-D 兜底 | 70% 的条目落在兜底桶；平台原语边被当作债                                                                                                               | 按具体结构规则记债，删除兜底桶                          |
| R7   | 若干依赖与退出门                           | W4-B / W4-D 的计数早已归零；W7 依赖 W5 无技术理由；code-capability 并非“只剩一个写点”；加固类退出项与 2026-08-26 硬规则冲突                            | 重写波次依赖与退出门（plan）                            |
| R8   | 目标 context 表                            | 缺 run-observability；workspace-insight 无模块；workgroup 引擎住在 resource-catalog；public 入口多出 `operations`                                      | 更新 G2 与 design §3                                    |

## 6. 立即生效的架构约束

以下约束自本次刷新起对**所有新增代码**生效，不等待任何后继 RFC；它们只限制新代码的落点，不要求改动存量。
在制 RFC（例如 RFC-370）在收口前按这些约束对账；确需偏离的，在该 RFC 的 design 里逐条列出理由并呈用户确认
（CLAUDE.md §RFC workflow 第 8 条）。后继 S4 把可机器化的条目变成硬门。

- **C1 composition 只装配**：`modules/*/composition/` 与 `composition.ts` 只构造与注入；新的业务、机制与适配器实现
  不得放进 composition。
- **C2 不再复制装配根**：不得新增装配根；新模块接线只写一次，写在两种 provider、两种部署 profile 共用的
  provider-neutral 函数里，不得在 SQLite 与 PostgreSQL 根、或 `cli/start.ts` 与 `server.ts` 各写一份。
- **C3 部署维度**：domain / application / engine / 入站适配器 / platform / 入口根不得按部署模式分支；application 端口不得
  出现厂商字面量；部署适配器放 `infrastructure/<profile>/`，厂商协议客户端放 `platform/<vendor>/` 且操作类型化，
  不得以 `operation: string` + `input: unknown` 传递。
- **C4 platform 单向**：`platform/` 不得 import `modules/`；领域状态机、业务策略与装配不得放进 `platform/`。
- **C5 不按 id 判新旧**：不得新增按 node_run（或其他 ULID）id 判断先后、新旧或顺序的业务代码；需要顺序的地方使用
  显式序号（存量由 S1 收口）。
- **C6 不新增深引用与再导出桶**：不得新增 import 其他 context 的 infrastructure / application / composition 内部文件的边；
  不得新增 `export *` 形式转出 drizzle、schema 或模块内部的桶文件。
- **C7 无 consumer 不公开**：不得新增没有生产 consumer 的 public 符号或端口；“以后可能用”不是理由。
- **C8 后台作业有主**：新的周期作业或常驻循环必须作为带 stop 的工厂接入 provider runtime session（两种 provider 共用
  同一份定义），不得私设 `setInterval` / 循环。
- **C9 治理不再扩表**：不新增全量库存类账本与新的增长许可类别；架构门只增加能证明会红的结构规则。

## 7. 非目标

- 本批次只改文档，不修改生产代码、测试、schema、API、MCP、WS、账本生成物或产品能力。
- 不一次性搬迁全部存量；目录变化随 owner / 接口 / consumer 切换发生。
- 不把六类资源硬做成同一套泛型 CRUD；只统一 command、policy、repository、event 的合同形态。
- 不把 call-workflow 当 wrapper，也不把 workgroup assignment 混进 NodeRun 状态机。
- 不重写已有 RuntimeDriver / managedProcess / 资源注入链。
- 不以微服务拆分为目标：业务仍在同一个进程映像内；多进程只来自部署角色（服务槽、迁移作业、Worker、任务镜像助手），
  它们共享同一张模块工厂图。
- 不在架构门里做任何安全检视或加固（2026-08-26 用户硬规则）。

## 8. 能力影响

本次刷新**零产品行为变化**。后续后继的能力影响按以下规则处理：

| 类别                               | 处理                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| 纯依赖 / 目录 / 接口迁移、装配合并 | 行为对拍，允许一跳 facade，禁止 API / 错误码 / 事件顺序变化  |
| 统一两套写入栈后错误码收敛         | 属用户可见变化：后继 RFC 列出受影响入口与错误码，呈用户确认  |
| NodeRun schema / seq               | 新旧 oracle + 存量任务 resume 兼容 + 删除回退判据的明确时点  |
| fanout 内链                        | 作为能力扩张独立批准；失败 / 复用 / 恢复矩阵必须齐全         |
| lifecycle / outbox                 | critical 事件至少一次；consumer 幂等；WS payload 保持兼容    |
| AtomicApply                        | journal replay / duplicate / compensation 语义不弱于当前合同 |
| 治理门改造                         | 只改测试与生成器，不改产品行为                               |

## 9. 架构决策

- **D1**：采用 bounded-context feature-first，模块内分层；不建设新的横向 `services-v2/`。
- **D2**：跨业务模块只依赖受控 `public/{commands,queries,participants,events,types,operations}` 精确入口；consumer-owned
  required SPI 只经 `composition/required-ports` 给 bootstrap 与指定 provider adapter；bootstrap 只可额外依赖模块
  `composition.ts`；Drizzle table 与内部实现不外泄。
- **D3**：业务写命令强制可信 authority + fence + transaction + audit / outbox；内部 effect 使用 family-scoped capability；
  transport 不持有业务写逻辑。
- **D4**：Task ownership 使用持久 lease / epoch / fence，进程内 registry 只做句柄缓存（RFC-328 已落）。
- **D5（修订）**：NodeRun 先引入每任务单调 `seq` 作为唯一先后判据，再补 row kind、scope、逻辑执行代与逐边 provenance；
  ULID 不再承担任何顺序语义。
- **D6（扩展）**：`platform/atomic-apply` 唯一拥有 AtomicApply lifecycle，并且只保留一套资源写入栈与持久收敛 claim。
- **D7**：RFC-287 作为已落行为基线保留；RFC-288/289 保持 CLOSED；fanout 内链在 W7 后另立新号能力 RFC。
- **D8**：逐域绞杀与单写源；任何兼容 facade 都有 owner 与删除后继。
- **D9（修订）**：架构治理由**少量硬结构门**（各有会红的变异测试、不设增长许可）与**按需生成的库存报告**组成；
  逐 symbol / 逐边 / 逐字段的全量账本不再作为任何波次的退出条件，也不要求伴随提交。
- **D10（新增）**：部署 profile 是一等架构维度：端口按语义归拥有方，适配器按 profile 分目录，选择只在 bootstrap 一次，
  业务层零部署分支，跨进程协议类型化，进程内不变量须声明适用 profile 或改为持久 claim。
- **D11（新增）**：入口根是薄的、可以有多个，但共享唯一的模块工厂图与唯一的生命周期程序；provider 与部署 profile 都是
  图内的适配器选择。
- **D12（新增）**：`composition/` 只装配；实现落在 domain / application / engine / infrastructure；task-execution 的机制库
  归 engine；不允许“类型化委托壳”层。
- **D13（新增）**：总纲定方向、边界、层次规则、不变量与 owner；精确接口以代码（`public/*.ts`、`application/ports/*.ts`）
  与后继 RFC 的 design 为准，总纲中的类型草图不构成合同。

## 10. 验收标准（整体迁移）

- **AC-1**：design 给出依赖规范、层次矩阵、context DAG 与 IA type-only 矩阵；三者与 `rfc294Target.ts` 常量一致（design-parity 守卫保持）。
- **AC-2**：每个现存能力都有唯一目标 owner；没有“公共 service 待定”桶。
- **AC-3**：任务控制面 / scope 解释器 / 节点执行器 / 执行机制库四层各自拥有决策，`composition/` 不承载实现。
- **AC-4**：command / query、事务 / outbox、错误、后台生命周期、装配根合同在代码中各只有一份实现。
- **AC-5**：NodeRun 先后只由 `seq` 决定；身份与 provenance 覆盖 retry / resume / wrapper / fanout / call / review / clarify。
- **AC-6**：RFC-287 基线、RFC-288/289 关闭语义与新号 successor 顺序无歧义。
- **AC-7**：plan 为每个余下波次与后继列出前置、动作、退出门、回滚点与冲突面。
- **AC-8**：终局判据全部成立——后端 / 全仓值级 SCC=0、`KNOWN_VIOLATIONS`=0、route / transport→DB=0、context 值级依赖
  无环、`platform`→`modules`=0、跨 context 内部 import=0、composition 内实现=0、业务层部署分支=0、AtomicApply lifecycle=1、
  资源写入栈=1、装配为唯一模块工厂图、后台作业全部经唯一生命周期程序且有 stop。
- **AC-9**：兼容策略覆盖 REST / MCP / WS、存量 DB、在途 task / resume、测试 seam 与多 session 并发开发。
- **AC-10**：每个硬结构门都有能证明会红的变异测试；库存报告可从任意已提交源码按需重新生成。
- **AC-11**：部署 profile 规则（D10）在托管与单机两种装配下都有结构门或行为对拍证据。
- **AC-12**：本刷新批次只改文档、索引与 STATE；未夹带生产代码、测试或生成物变更。

## 11. 与 RFC-287 / 288 / 289 的关系

- **RFC-287**：Done，作为 assembly 与仓库准备行为的兼容基线保留；后来写入的 ownership、admission、事件与模块归位分属
  P0-D、W2～W5 的合同，不倒签给 RFC-287。不得恢复公开 `file://`、stale source 静默启动，或删除现有 `__repo_prep__` 可见性。
- **RFC-288**：CLOSED（未实现、零生产改动），结论已由 RFC-331 / W2-A 承接完毕。
- **RFC-289**：CLOSED（未实现、零生产改动）；fanout 内链的产品目标保留，W7 完成后另立新号 RFC，未获批时保留
  `fanout-inner-chain-unsupported` 挡板并跳过 W8。
- 已关闭各波的详细合同、证据与 SHA 见归档 `archive-20261016-plan.md`。
