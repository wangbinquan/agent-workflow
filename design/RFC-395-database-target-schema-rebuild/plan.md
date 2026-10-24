# RFC-395 实施计划与验收矩阵

## 1. 当前状态与前置门

- 本次交付：RFC 六份设计文档、217 表处置清单、RFC 索引与 STATE 登记。
- **状态：In Progress（2026-10-21）**。落档时为 Draft，当时用户批准的只是调研与落档；同日用户把本 RFC 交接手会话做任务分解并指挥 Codex 实施，视为批准生产实现，真实数据操作仍按实例逐次批准（见 §6）。
- 设计门：落档会话无可调用 `openai-codex` review 工具，未运行独立 Codex 设计门；接手会话按本会话惯例免设计门与实现门（可推翻，见 §6）。
- 进入实施前记录功能设计门结论、用户批准、最新 source contract 与 RFC-394 等并发变更的已提交装配合同。
- 当前设计不预留实现中自行选择的缩减范围；若做不到某个终态，显式修订 RFC，不把未完成项换成永久 fallback。

## 2. 实施顺序

下表是开发依赖，不是分批功能验收。**先完成 T1～T17 全部生产实现、接线和测试用例编写，再集中执行 T18；发现本人缺陷后只复验受影响范围。** 不写一片表就反复跑全量测试 / 实现门，不把研究阶段的 schema 读取误当成实现已验证。

| 任务 | 完整交付 | 依赖 | 覆盖验收 |
| --- | --- | --- | --- |
| RFC-395-T1 | 固化 source fingerprint 支持列表、217 表 / 2,639 列逐项映射与当前读写者；每列明确 immutable / CAS mutable / derived；现有约束和 index 去向；收录本机差异源 fixture；启动序列逐步分类表（旧数据升级 / 在途恢复） | 设计批准 | AC-1 |
| RFC-395-T2 | 领域 schema contribution 与显式 owner / codec / FK / CHECK / 索引 / retention，编译两种原生 DDL；保存最终 target contract digest | T1 | AC-1、6 |
| RFC-395-T3 | 原生 SQLite / PostgreSQL driver/query adapters、session/transaction/error contract；删除 SQLite proxy 类型伪装与 SQL 修补；统一业务 ports | T2 | AC-6 |
| RFC-395-T4 | Task core / definition / launch / workspace 拆分与来源终止状态归位（design §3.1～§3.4）；四个宿主 workflow（Agent / Workgroup / 数字员工 / code-round）退出 catalog；所有入口与子任务接线，API 兼容投影 | T2、3 | AC-2、9 |
| RFC-395-T5 | 仓库挂载与 per-run checkpoint，目录树旧数据离线物化；单仓/多仓 rollback / merge / prepare / prune 接线 | T4 | AC-2、7 |
| RFC-395-T6 | NodeRun role / generation / selected / provenance；冻结 config、运行态与结果；所有 mint / retry / resume / supersession / fanout / review / child continuation 读写转换 | T3、4、5 | AC-3 |
| RFC-395-T7 | 澄清答案/草稿/归属按问题存储；编辑 / 封口 / abandoned / 代理答复 / UI map 投影全部接线 | T3、6 | AC-4、9 |
| RFC-395-T8 | Agent 四类关系、Workflow dependency index 与 import/export/name-selector 边界；包 / Intent mutation participants 共用 | T3 | AC-4 |
| RFC-395-T9 | 内容引用 / bytes 后端 / publication 中立化；技能 tree、prompt、输出、文档、评论、托管归档、开发与 Employee 制品、备份恢复全接线 | T3 | AC-5、7 |
| RFC-395-T10 | AtomicApply 共用状态机，Intent / bundle / 既有相关恢复场景统一；原幂等域与回执保持；不合并 effect journals | T8、9 | AC-5、8 |
| RFC-395-T11 | 未改形状的表迁入各 owner contribution / 原生适配；移除跨域 schema 访问；事件、观测、identity、OS、development 等既有行为不缩减 | T2、3 | AC-1、6 |
| RFC-395-T12 | versioned source readers、确定性 transformer、row disposition、legacy evidence/history reader；旧 code work 历史、writer drain 退出；保留当前事件家族路由 | T4～11 | AC-1、3、8 |
| RFC-395-T13 | 迁移 run/chunk/receipt 与现有 logical-copy / generation 元数据整合；新 baseline、source/target schema admission、旧 binary 拒绝协议；两 provider 统一的合同历史机制、边编译器与准入；`scripts/schema-history.ts`；`migrationRole` 退役与约 20 处消费者、shared DTO、启动序列守卫账本同一提交改齐 | T2、12 | AC-6、7 |
| RFC-395-T14 | maintenance/quiesce、备份、水位、活动恢复、独立目标库、activation、首写边界、错误恢复与操作报告；现有 CLI/托管部署入口接线 | T9、12、13 | AC-7、9 |
| RFC-395-T15 | API、WebSocket、任务目录、history、导出、归档、浏览器草稿引用的兼容；用户完整旅程；如需新界面先审原型；DTO 对拍夹具与测试 | T4～14 | AC-9 |
| RFC-395-T16 | 删除清单 D1～D13 全部销账；旧 codec 仅迁移/历史可达；结构守卫按原意重定向；架构清单与必要计数更新，不提高债务基线掩盖遗漏 | T4～15 | AC-8 |
| RFC-395-T17 | 完成下述全部单元 / 双 provider / 迁移 / fault / 用户旅程 / 二进制测试编写；操作手册与真实演练模板 | T1～16 | AC-1～10 |
| RFC-395-T18 | 集中验证；功能实现门；exact-SHA hosted CI；逐项记录差异和真实引擎证据 | T1～17 完整 | AC-1～10 |
| RFC-395-T19 | 基于通过的完整候选，对真实实例只读预检并生成 reviewable MigrationPlan；取得该次切换批准后备份 / 搬迁 / 验收 | T18 + 实例操作批准 | AC-7、9、10 |

T1 输出是实现细化，不能推翻本文的领域边界、兼容承诺或迁移方式。新发现的模糊来源 / 功能收缩必须返回设计审批，不能靠 `default` / 空数组过关。

## 3. 必写测试矩阵

| 面 | 正向与边界用例 | 旧写法反例 / 失败用例 |
| --- | --- | --- |
| schema / codec | 两 provider 生成一致合同；整数/时间边界、Unicode、JSON null、空值、bytea/BLOB、unique-null、排序；每类边在两 provider 上编译并应用后物理结构等于新头合同编译结果；rebuild-table 边保留行、FK 与索引；两种行级规则（`immutableOnceSet` / `appendOnly`）在两 provider 上都拒绝改写 / 删除并映射同一错误；8 条 FK 的删除动作两侧一致；记忆删除后引用置空；t19g 对账守卫改为「两份编译 DDL 同义」，并补 FK、可空性、默认值的对账 | 漏 owner/codec、错误 jsonb 原文转换、bigint 截断、未生效 CHECK、弱化 FK；物理结构偏离头合同仍被准入；旧二进制在非只扩展后继上继续服务；合同出现无类型触发器；PG 上可删除 append-only 账本行 |
| Task 主体 | 五类主体（Agent / Workflow / Workgroup / 数字员工两种实现 / 历史 code-round）启动 / 恢复 / 详情 / 评审列表、child launch、固定 snapshot、已删除 source 历史；切换前冻结的 v2 调用闭包在目标上仍按边键取到定义（含 workgroup 宿主任务内的 call 节点）；读时排版对 platform 定义生效、对 authored 不生效 | 任何代码路径插入或查询四个宿主 id 的 `workflows` 行（仍创建 host 行）；从当前资源补历史配置；重复主仓权威；`workflowId` 投影为空串；数字员工任务被判为 agent / workgroup；删除根任务后留下任何后代任务或后代的从属行（两 provider）；删除后父链 `branch_started_at` 未重算 |
| 工作区 | 一仓/多仓/internal/inherited/detached/unborn、只读挂载、submodule、显式空目录；延后准备占位与物化失败任务的 GET / 列表 / 重试 / 引用计数投影与旧二进制逐字段相等；单仓任务重新启动仍走根仓物化；单个非根成员仓库组的隔离运行崩溃重放、收养与 wrapper 重建 | 227 branch 差异形状；缺 map 当 root；repo reorder 改身份；缺文件丢失；`repoCount` 投影为 0；`repos[]` 为空；未绑定用空串而非 NULL；以 `repoCount === 1` 代替根挂载判据 |
| NodeRun | 同毫秒/多进程 mint、负 seq、allocator 高水位、role、task synthetic、container、retry、review、loop、fanout shard 集合、selected anchor 删除、child continuation；每种槽位（node / container / shard / aggregator / synthetic / workgroup-host）的 oracle 与表实现在随机任务历史上逐槽位相等（参照 `packages/backend/tests/rfc369-node-run-supersession.test.ts:192` 的对拍形式）；跨 wrapper 代 shard 复用；聚合输入集合判据与旧「比每个 shard 都新」判据等价；评审原地重置后选中不变；call 续接收养；wrapper / io / review / clarify / commit 行铸行即有 nonce 且无运行态行；历史无 nonce 行的输出解析与提示渲染与今天一致；多仓 checkpoint 三态与部分仓记录；iso 目录推导与 `worktree_dir_name` 等值 | `max(seq)+1`、ID 新鲜度、把 parent 当容器、简单 MAX 丢 supersession 语义、当前 producer 冒充实际消费；业务模块直接查询 `node_runs` 做选择（结构守卫）；按 id / startedAt 排序做业务选择；选择写入不在 owner 事务内；目标启动序列仍含 seq / frame 回填步骤（`packages/backend/tests/rfc379-daemon-lifecycle.test.ts` 的步骤清单改指） |
| 聚合写协议 | 双 provider 并发：生命周期迁移 vs prune 认领 vs 复活；同步工作流 vs 取消；runner 结算 CAS vs 评审取代；merge-state CAS vs 取代收尾；会话租约竞争 | CAS 未命中却留下 tokens / 快照；从属表 UPDATE 出现在协议文件外；source-control 直写 `tasks` |
| 协作 | 同题 revision 冲突、不同题并发成功、草稿恢复、attribution、部分提交、封口、abandoned；follow-up 追加与同轮草稿保存并发；封口时题集已变 | 整 map 覆盖导致答案丢失；封口后继续写；未知 question key 静默丢弃；改写既有题目；封口后追加 |
| 资源 | 四类关系顺序、传递依赖、Workflow ID/name selector、资源 rename / delete / 同名创建、包跨实例 import/export | name/ID 混用；索引与定义 revision 不一致；解析缓存取代动态 selector；重复依赖改变顺序 |
| 内容 | inline/文件/DB/object、BOM、非法 UTF-8、空 bytes、版本/目录/staging/trash、归档、备份恢复 | base64 解码变 bytes；JSON stringify 改 digest；发布未 ready 就引用；仍被备份持有却释放 |
| AtomicApply | prepared / applying 崩溃、幂等重复请求、失败重试、领域提交同事务、artifact 恢复 | 两条状态机分叉；重试事务重复外部 effect；同幂等键不同 payload 被忽略 |
| 其他保留表 | commit event 顺序/投递、event 去重/订阅、Case/Reaction/Task 关系、开发配置与 OS 共存、观测费用独立保留 | 合并事件导致重放；Task 删除级联费用；旧命名配置被误删 |
| 源识别 | 当前合同、无 seq 源、本机差异合同、非空 PG 源、已有跨 provider 路径；新装、测试 baseline、托管安装三处的种子行逐字节一致；epoch-1 SQLite 备份、epoch-1 逻辑工件、托管备份三种源恢复到目标 epoch | journal 行数冒充版本；未知表/列悄悄忽略；不支持版本直接写目标；转换器把种子覆盖到迁入库的已有行 |
| 转换恢复 | chunk 中断重启、row disposition 守恒、source 不变、ID 高水位、历史可查；任一源键可经 trace 得到处置；chunk 回执与行同事务 | receipt 响应丢失重复插入；source 变化仍复用 checkpoint；行数相等但链接错；行级处置表出现同键可推导行（守卫）；chunk 行已提交而回执缺失 |
| 活动恢复 | awaitHuman / awaitReview / interrupted、进行中的 effect/Apply/delivery、lease 重接管 | 自动取消任务；复制旧 owner 当新存活；重复外部效果；ACK 后丢 ingress |
| 持久化载荷 | 切换前已决定、尚未驱动的续跑（含工作区回滚计划）在目标上执行；切换前等待人工、切换后决定；托管领养重建请求逐字节相等；同代 effect 重开 CAS 命中 | 预检放过 prepared 的开门清单；非字面量对象写入被重塑表静默丢列；派生键被重算 |
| 激活 / 回退 | 每个阶段 crash、配置切换未开 admission、切换前撤回、首写后前滚 / 目标恢复；pointer 替换前后各点崩溃；首写前撤回恢复原 pointer 字节；新装写 v2 | 两套 active generation；部分 Worker 留旧库；首写后直接退源造成丢事实；epoch-1 二进制打开目标文件或读取 v2 pointer 后继续服务；SQLite 目标首写后仍允许撤回 |
| 完整产品旅程 | 启动 → 执行 → 人工门 → 恢复 → 完成 → retry/rollback → 历史/导出；single/hosted 与双 provider | 只看新建空库；历史链接断；浏览器草稿被清空 |
| API 投影对拍 | 同一迁移 fixture：旧二进制在源库上的 `GET /api/tasks/:id`、`/node-runs`、任务目录、评审列表、澄清详情，与新二进制在目标库上的响应逐字节相等（只允许 design 登记的差异） | 投影多键使 strict 解析失败；`parentNodeRunId` 被替换为 container；`repoCount` 为 0；agent 任务被判为 workflow |
| 二进制与运行图 | Linux/macOS/Windows binary 启动、新 baseline/旧库识别、维护 Worker、实际 driver 导入初始化 | 静态 TS 通过但打包 driver 不可用；应用图重复装配；错用旧 `cli/` 路径 |

测试使用项目现有双 provider harness 与统一应用图；新的 scope 对应的前后端行为必须都被覆盖。PostgreSQL 测试需要真实引擎和非空 fixture，不能只检查生成 SQL 文本。former-wiring 对照应证明旧写法触发相同功能缺陷，不是仅断言文件名消失。

## 4. 提交、并发与部署

此 RFC 横跨持久化基础设施和全部业务域，默认一个完整实现交付；允许按领域拆成若干可审阅 commit，但不部署半成品 schema epoch，不以多次线上迁移实现多个短期终态。若需要拆多个 PR，必须保证前置 PR 不激活新合同、最终激活 PR 已包含全部实现和测试，并在此登记精确范围。

所有开发、测试与发布只在主 checkout 的 `main`；不建分支或 worktree。共享文件先查 status/diff，保留并发产出；按实际触及路径检查架构锁。发布使用短临界区、共享 index 完整核对、明确文件 allowlist；不发跨 session 消息，不撤掉别人的修改凑干净树。

重点冲突面：`db/**`、`platform/persistence/**`、所有模块 persistence、`bootstrap/**`、共同的 provider 测试工厂、迁移 journal、`architecture/*.json` 与 RFC-294 后继结构锁。当前只落档不修改上述生产文件。正式实施时重新核对当时状态，不冻结其他域长期开发。

## 5. 完成账本

### 5.1 文档交付（本次）

- [x] proposal / design / migration / research / table-mapping / plan 六件套
- [x] 217 张源表恰好覆盖一次，目标处置与明确保留边界
- [x] 核心 Task / NodeRun 字段去向、双 provider 原则、一次切换和首写回退边界
- [x] 文档静态检查：217 表无漏项 / 重复；Task 70 列、NodeRun 62 列恰好各有一个去向；32 个本地 Markdown 链接有效；共享索引原内容完整保留；`git diff --check` 通过
- [x] RFC 索引与 STATE 登记；具体文档 commit / push 证据以 Git 历史和本次交接为准
- [ ] 独立功能设计门（接手会话按惯例免，可推翻；见 §6）
- [x] 用户批准生产实现（2026-10-21 交接手会话分解并指挥 Codex 实施；不含 T19 真实实例操作）

### 5.2 实现与运行（未开始）

- [ ] T1～T17 全部开发与测试用例编写完成
- [ ] AC-1～AC-10 逐项证据；D1～D13 删除清单逐项销账
- [ ] SQLite targeted / full evidence、PostgreSQL real-engine evidence 分别记录
- [ ] 用户完整旅程、性能、故障恢复、备份恢复及二进制证据
- [ ] 功能实现门 + 必需 hosted exact-SHA CI
- [ ] 真实实例 MigrationPlan、操作批准、切换回执和切换后验收

文档完成、设计获批、实现完成、真实搬迁、线上验收是五个不同状态。不得用本节第一组复选框将 RFC 置 Done。

## 6. 实施分解（2026-10-21 本会话接手）

用户 2026-10-21 将本 RFC 交本会话做任务分解并指挥 Codex 实施，视为批准生产实现；T19 对真实实例的预检、搬迁与切换仍按实例逐次批准。
按本会话惯例免设计门与实现门（可推翻）。分解依据是同日四路只读研究（基线 `2a6b366f9`）：provider 查询面与方案、测试面、合同与迁移机制、
重建字段的全部读写点。研究原文在本会话 scratchpad，结论摘入本节。

### 6.1 研究结论摘要

- **查询面**：337 个生产文件含查询，modules 内全部在 `infrastructure/`；builder 语句 2,931 条，另有 32 处原始执行；SQLite 专属终端
  `.get/.all/.run` 876 处（97 个文件）。drizzle-orm 0.45.2 自带原生 `drizzle-orm/bun-sql`，PostgreSQL 连接池本就是 Bun.SQL，无需新依赖。
- **T3 方案**：采用「方案 B」——显式合同生成 SQLite 与 PostgreSQL 两套原生表、会话提供表集、业务写在约 25 个 builder 方法的窄中立接口上，
  运行时直接是原生 bun-sqlite / bun-sql。类型原型已验证可行；每模块两份适配器（重建 RFC-359 刚合掉的 153 对孪生）与「底层换驱动、
  上层仍 sqlite 类型」均不采用。
- **合同**：现合同从 SQLite 声明反射，owner 按前缀、codec 按列名正则推断，实测至少 8 个 JSON 列被判为 `text`；两 provider 实测差异
  有 7 个仅 SQLite 的 trigger、8 条仅 SQLite 的 FK、`tasks.name` 可空性不一致、42 张表列序不同。
- **测试面**：目标模型下必改 664 个测试文件（1,887 个写入点，上界约 726）；473 个文件各自写本地造任务函数，只改共享 helper 最多省
  42 个文件。采用目标模型造数 builder + AST codemod，不做按旧列名映射的测试兼容层。
- **重建读写点**：T4～T10 直接访问文件数依次约 71 / 36 / 53 / 28 / 20 / 53 / 15。

### 6.2 落地顺序（用户 2026-10-21 确认阶段 I 单独落地）

| 阶段 | 内容 | 交付方式 |
| --- | --- | --- |
| I-a | T1 机器可读库存与源指纹基础 + T2a：217 表按今日声明等价重述为各领域显式 contribution，`@/db/schema` 导出编译出的表，336 个引用方不动 | 不改物理 schema、不搬数据；全部开发与用例写完后集中验证一次，单独提交 |
| I-b | T3（方案 B）：中立查询接口、会话提供表集、原生 bun-sqlite / bun-sql，删除 sqlite-proxy、SQL 修补与进程级表投影 | 同上；单行 INSERT 往返合并的性能须以原生方式保持 |
| II-0 | 本会话修订设计：§6.4 缺口逐条裁决，写回 design / migration / table-mapping（2026-10-21 完成，见 §6.6） | 文档 |
| II-pre | §6.4-13 的死代码删除与测试改接线 | 独立提交；不改产品行为；完成后集中验证一次 |
| II | T2b、T4～T17：目标模型造数 builder 与 codemod、领域重建、转换器、回执与切换、兼容投影、删除清单。T6 的开发顺序固定为：先立选择端口与 oracle 适配器并迁移全部调用点，再写表实现与双实现对拍，最后把 oracle 适配器移入迁移模块 | 全部开发与用例写完后集中验证（T18），一次激活交付 |
| III | T19：每个真实实例只读预检 → MigrationPlan → 用户批准 → 备份、搬迁、验收 | 逐实例批准 |

阶段 I 在现有物理 schema 上完成，现有双引擎测试即等价判据，不产生 schema epoch，符合本 plan §4「前置提交不激活新合同」。

### 6.3 阶段 I 的 Codex 工作包

| 包 | 内容 | 验收 |
| --- | --- | --- |
| I-a | `platform/persistence/schema/`（contribution DSL、codec 目录、表达式 AST、registry、合同 / SQLite plan / PostgreSQL plan 编译器、drizzle 物化）；各模块 `infrastructure/persistence` 的 contribution；`bootstrap/persistenceSchema.ts` 唯一汇集；platform 内对合同的默认值调用改为注入；冻结的 legacy v2 投影 | 四条机械证明：legacy v2 合同 digest 相等（不能逐字节时规范化相等并注明）；PostgreSQL plan 逐条相等且真引擎 catalog 相等；SQLite 编译 DDL 与迁移 replay 的差异等于已审账本；两套 drizzle 表投影逐列相等；负例 |
| I-b1 | S0～S2：PostgreSQL 表固化为显式表；中立类型改名；清除 SQLite 专属终端与原始执行并加守卫 | 现有双引擎测试全绿；守卫负例 |
| I-b2 | S3～S5：会话提供表集、删除进程级投影与切换调用；PostgreSQL 改原生 bun-sql 会话、写闸只做语句分类；业务 SQL 不再依赖 PostgreSQL 同名函数 | 同上；PostgreSQL 客户端行为合同测试保持；性能对拍 |

I-b1 与 I-b2 在开发上前后衔接，作为一次交付集中验证。

### 6.4 阶段 II 实施前须修订的设计缺口（2026-10-21 已全部裁决，见 §6.6）

1. **宿主 workflow**——已裁决：四个宿主（Agent / 工作组 / 数字员工 / code-round）全部退出 catalog；`subject_kind` 五值；`definitionAnchorId()` 领域常量只在边界投影 `workflowId`，并作为调用闭包与记忆 workflow 作用域的稳定键；读时排版改由冻结的 `definition_origin` 决定；共享记忆作用域保留（Q1）、显示不变（Q2）。见 design §3.1、§3.2、§8、§10 D1，migration §4.1 第 5～7 条，table-mapping §2 `workflows`，本文 §3「Task 主体」。
2. **旧行形状写进持久化 JSON**——已裁决：人工门续跑围栏在决定事务内计算与比较，提交后不再重算，不是切换风险；会回插被重塑表的在途清单与准备回执冻结前收敛、目标只处理 v2，由旧字段派生的身份与幂等键按值搬运，自含载荷与托管协议保持原字节，归档升 v3。见 migration §4.6，design §7.3、§10 D13，本文 §3「持久化载荷」。
3. **「当前选中哪次运行」**——已裁决：先在现有 schema 上立 `RunSelection` 端口与 oracle 适配器并迁移全部调用点，再写表实现、双实现对拍；`node_run_selections` 主键 `(task_id, slot_key)`，代次作为属性；任务内唯一排序是 seq。见 design §5.1、§5.2、§5.4、§10 D4，本文 §6.2 II 行、§3「NodeRun」。
4. **多表 CAS**——已裁决：与生命周期 CAS 同句读写的可变列（`workspace_root_ref`、prune 三列、来源终止 fence / effect_rev）留在 `tasks`，`task_source_termination_states` 不再成表；同时写 `tasks` 与从属表的事务先锁聚合根；NodeRun 根行 CAS 先行、从属表同事务后写，`merge_state` 与 iso 根、wrapper 进度同在运行态表；工作组运行期配置进 `workgroup_task_state`。见 design §3.1、§3.3、§5.5，migration §4.1 第 8 条，table-mapping §2 `tasks` / `workgroup_task_state` 与 §3「Task 分层」，本文 §3「聚合写协议」。
5. **子任务树删除**——已裁决：树结构列（`parent_task_id` 自引用级联、`root_task_id`、`invocation_depth`、`branch_started_at`）留在 `tasks`，删除语义不变；启动来源事实进 `task_launch_contexts`；纠正 `branch_started_at` 被误归工作区。见 design §3.2、§3.4、§9，本文 §3「Task 主体」。
6. **「主仓 = ordinal 0 投影」的例外**——已裁决：显式 `requested_source` 与 `task_branch`（`task_workspaces`，冻结）、`tasks.workspace_root_ref` 可空（NULL = 未绑定）、单一投影函数；无挂载时合成 `repos[0]`、`repoCount = max(1, n)`；写者总落最小目录树。见 design §4「主仓字段投影」、§10 D2，migration §4.2，本文 §3「工作区」。
7. **D 清单补项**——已裁决：D3 补 pre-snapshot 无生产者事实与 retry 模式删除，D4 / D5 补启动期 seq / frame 回填（改由转换器一次性完成），D12 补启动期旧数据升级步骤的逐项分类义务。见 design §10，本文 §2 T1、§3「NodeRun」。
8. **`envelope_nonce`**——已裁决：归 `node_runs` 身份列（铸行即生成、不可变），`node_run_runtime_states` 保持按需建行。见 design §5.1、§5.3、§5.6。
9. **design 内部待定 8 点**——已裁决：`merge_state` 归运行态表；checkpoint 不存 `isolation_root_ref`；map 键经 `worktree_dir_name → repo_key` 映射；checkpoint 三态字段 + 行存在性；问题集只增 + `questions_revision`；消费边按（源节点, shard）粒度；`review_iteration` 是 CAS 可变属性；两条代轴独立。见 design §4、§5.1～§5.3、§6.1，migration §4.3，本文 §3「NodeRun」「协作」。
10. **前端严格解析**——已裁决：现有 shared zod 合同即投影验收标准，除 `NodeRunSchema.seq` 收紧为非空外不改合同；逐字段投影规则写入 design；增新旧二进制 DTO 对拍。见 design §8「API 兼容投影合同」，本文 §2 T15、§3「API 投影对拍」。
11. **迁移机制待决**——已裁决（拆为 M1～M8）：M1 两 provider 统一的「合同历史 + 类型化边」，drizzle-kit 不再生成迁移（design §13、§10 D12）；M2 同键可推导转换用 chunk 级证明、例外行级记录，元数据存目标库（migration §3，table-mapping §3「迁移元数据」）；M3 代次目录文件 + pointer v2（migration §3、§5 第 8 步，Q3）；M4 provider 差异逐条裁决到两侧一致的原生表达（design §2.4，migration §4.7，Q4）；M5 contribution `seeds`（design §9、§12.1，migration §4.5）；M6 旧 epoch 备份经转换器恢复（migration §2）；M7 `migrationRole` 退役（migration §3，design §10 D10，本文 §2 T13）；M8 规范化只作用于 SQL 表达式文本（design §12.1）。
12. **疑似现存缺陷**——已确认属实（代码阅读）：仓库组展平后只有一个非根成员时，`iso_node_tree` 落 NULL、恢复时 base 以 `''` 为键错配；按缺陷修复 + 回归用例单独修复，不属于 RFC-395（Q5）；RFC-395 转换器按 migration §4.2 处理已受影响的行。见本文 §3「工作区」。
13. **先删 test-only 与死代码**——已裁决：阶段 II 之前单独提交删除 `startTask` / `startTaskWithLocalRepo` 与 `codeRoundLaunch` 写槽（42 个测试改走生产启动内核）、`getTaskNodeRuns`（8 个测试改用 `taskNodeRunsProjection`）、`systemWorkspaceGc` 的库函数（9 个测试，`materializingSpaces` 迁至使用方模块）、intent 引擎内 `converge`、`services/bundle/provider.ts` 中 RFC-271 旧合同段（`opSlug / planBundleOps / resourceTypeOfOp` 有生产使用，保留）；`decideIntentApplyConverge` 不删，由 T10 收编。见本文 §6.2 II-pre 行。

### 6.5 并发约束

RFC-396 正在工作树中实施，改动 `db/schema.ts`、SQLite 迁移链与 `platform/persistence/schemaContract.ts` 等；阶段 I 重写的正是这些文件。
阶段 I 的代码实施在 RFC-396 的持久化改动提交后开始；之后新增的表须同时提供 contribution（I-a 的结构锁会要求）。
用户 2026-10-21 选择由接手会话协调：本会话不向其他会话发消息，以工作树中 `db/**`、`platform/persistence/**` 的提交状态为准，
在此之前只做 II-0 设计修订。
RFC-396 的持久化改动已于 `5f11d1857` 提交，`db/**`、`platform/persistence/**` 干净后 I-a 于 2026-10-21 交 Codex 实施。

### 6.6 II-0 修订记录（2026-10-21）

本会话依据只读研究写出 II-0 修订草案，逐项裁决 §6.4 的第 1～10、12、13 项与迁移机制 M1～M8（由第 11 项拆出），共 20 项；全部按草案推荐采纳，
并写回 design / migration / table-mapping / plan，各项去向见 §6.4。用户 2026-10-21 对需决定的问题答复如下：

| 编号 | 问题 | 用户决定 |
| --- | --- | --- |
| Q1 | Agent / 工作组 / 数字员工任务今天共用以宿主 id 为键的 workflow 记忆作用域，宿主行删除后是否保留 | 保留：作用域键改由领域常量提供，现有记忆原样迁移，注入与蒸馏结果不变（design §3.1，migration §4.1 第 7 条） |
| Q2 | 非 workflow 任务在首页任务行、评审列表里显示宿主名，是否顺带改为显示真实主体名 | 不改：RFC-395 只做等价投影（design §3.1、§8） |
| Q3 | SQLite 业务库文件改为 `~/.agent-workflow/databases/<generationId>/db.sqlite`，由 pointer v2 指定；旧文件在 `completed` 后移入迁移操作目录保留 | 接受（migration §3、§5 第 8 步） |
| Q4 | PostgreSQL 删除记忆后，其他记忆中的 `supersedes_id / superseded_by_id` 今天保持悬空 | 两 provider 统一为 `ON DELETE SET NULL`；转换器把 PostgreSQL 存量悬空指针置空并记证据（design §2.4，migration §4.7） |
| Q5 | 第 12 项缺陷的修复方式 | 按缺陷修复 + 回归用例单独提交（进行中，不属于 RFC-395）；RFC-395 只记录转换器对已受影响行的规则（migration §4.2） |

M6（切换前的旧 epoch 备份可经转换器在新版本上恢复）此前已由用户确认，II-0 只补实现约束（migration §2）。

逐项事实、方案对比与未逐字转录的实施细节（「当前选中运行」77 处计算点的 12 组迁移分组、各项事实表、复现步骤）保存在附录 [ii0-revision.md](./ii0-revision.md)。

至此阶段 II 的其余工作在设计上不再有待决项，只等阶段 I（I-a、I-b）交付；阶段 I 的开工时点仍按 §6.5。

### 6.7 I-a 交付记录（2026-10-22）

I-a 由 Codex 实施、本会话审核，一次提交落地，不改物理 schema、迁移文件、运行时查询与 API。

- **落位**：
  - `platform/persistence/schema/`：数据类型（`contribution.ts`）、16 个 codec、表达式 AST、简写 DSL（`dsl.ts`）、registry 校验、
    v3 合同 / SQLite plan / PostgreSQL plan 编译器、drizzle 物化；
  - 冻结的 legacy v2 投影在 `platform/persistence/migration/legacy/v2Contract.ts`（5f11d1857 的 `ownerFor / codecFor / postgresqlType`
    与默认值渲染逐字移入）；
  - 18 个 contribution 文件（19 组 owner），各模块 `composition/schema.ts` 为只含 schema 的入口；`bootstrap/persistenceSchema.ts`
    是唯一汇集点；`@/db/schema` 改为兼容转出，引用方不改。
- **规模**：222 张表、2,671 列。217 张按 table-mapping 的目标 owner 落位；RFC-396 新增的 5 张 `development_design*` 表不在
  table-mapping 中，按实际写入方归 development-automation。contribution 共 9,842 行，原声明 9,171 行。
- **一次性冻结对比**：基线由改动前的 HEAD 5f11d1857 代码导出，本会话独立复跑：
  - v2 合同 canonical JSON 逐字节相等，digest `sha256:3f8b275e388697cc6d9f5005dc3c9cf9acd70fe97c1bb00407223dfcf4d39743`；
  - PostgreSQL plan 977 条逐条相等，生产路径与新编译器各比一次，digest `sha256:f44eb752fa49d7c4736e5ad3be6516b56862c92297f82aac1e88f437e2654815`；
  - 两套 drizzle 表 222 张逐列相等；
  - drizzle-kit 视角下 217 张既有表与 `0260_snapshot.json` 相等，其余 5 张与 RFC-396 手写的 0261 SQL 语义一致。
  冻结基线不入库：此后其他 RFC 仍会新增 epoch-1 表与列，钉死基线的测试会在下一次 schema 变更时失败且无法再生。
- **长期测试**：
  - `rfc395-schema-equivalence`：bootstrap 的 v2 合同等于生成器维护的 RFC-349 `schema-contract.json`；owner 等于已审 owner 账本；
    每表 `migrationPolicy` 等于 v2 处置；编译 PostgreSQL plan 等于生产 plan；两套物化列与 v2 的两侧投影逐列一致；
  - `rfc395-provider-catalog-equivalence`：SQLite 编译 DDL 与迁移 replay 的差异等于 92 条账本（含 §12.1 第 3 条的各类）；
    PostgreSQL 编译 plan 建的库与「root baseline + 已发布升级」经生产迁移器建的库 catalog 相等；
  - 负例（`rfc395-schema-invalid-contributions`）、DSL（`rfc395-schema-dsl`）、结构锁（`rfc395-explicit-schema-contributions`）、
    迁移历史按二进制头合同校验（`rfc395-head-history-injection`）。
- **偏离与取舍**：
  - 306 条 CHECK / 索引表达式保留 epoch-1 原文（`raw`），类型化 AST 自阶段 II 的目标 contribution 起使用；
  - 40 列保留复用旧 builder 留下的 SQLite `uniqueName` 元数据；
  - SQLite 账本另记实测的 PRAGMA 默认值拼写与 TEXT 主键可空性差异；
  - SQLite 逻辑源 Worker 改为接收父进程选定并校验 digest 的合同；
  - PostgreSQL 迁移历史一律按二进制头合同（`headContract`）校验，目标库、备份源的合同另行传入。
- **遗留（不属于本 RFC）**：RFC-396 的迁移 0261 未附 drizzle 快照 `0261_snapshot.json`，下一次 `db:generate` 会重复生成这 5 张表，
  由 RFC-396 处理。
- **下一步顺序调整**：II-pre 先于 I-b。II-pre 删除的 `startTask` 族、`getTaskNodeRuns`、`systemWorkspaceGc` 库函数含大量 SQLite
  专属终端与原始执行，先删可免 I-b 改写注定删除的代码；两者改动面重叠，不并行。

### 6.8 II-pre 交付记录（2026-10-22）

II-pre 由 Codex 实施、本会话审核，一次提交落地，不改产品行为、API、schema 与迁移。`packages/backend/src` 共 18 个文件，净删 3,637 行。

- **删除**：
  - `services/task.ts` 的 `startTask` / `startTaskWithLocalRepo` / `startTaskImpl` 及其私有依赖；`StartTaskDeps` 收窄为续跑所需的
    `TaskContinuationDependencies`，code-round 写槽 `codeRoundLaunch` 随之删除；
  - `getTaskNodeRuns`；
  - `platform/persistence/sqlite/systemWorkspaceGc.ts` 整份 GC 库与兼容转出 `services/gc.ts`；
  - intent 引擎内的 `converge` 与其测试 facade；`decideIntentApplyConverge` 保留给 T10；
  - `services/bundle/provider.ts` 的 RFC-271 旧合同段，生产规划器与回执类型保留；
  - 连带删除：旧启动入口删除后，`services/users.ts` 与 identity-access 的 `legacyUserService`（composition / infrastructure）
    已无生产引用，一并删除。
- **迁移**：进程内物化租约 `materializingSpaces` 迁到无依赖的 `platform/workspace/materializingSpaces.ts`，7 个生产导入方改址。
- **测试改接**：
  - 原用旧启动入口的测试改走生产根启动内核与子启动（`tests/helpers/productionTaskLaunch.ts`）；
  - `getTaskNodeRuns` 的测试改用生产读投影 `taskNodeRunsProjection`；
  - GC 测试改走生产工作区维护命令（`tests/helpers/workspaceMaintenance.ts`）；
  - intent 收敛测试改走生产收敛；
  - 140 个测试文件的造用户夹具改为 `tests/helpers/userFixture.ts`，底层是生产 identity-access 的命令与查询（建用户走
    `createManagedUser`，改用户 / 停用 / 启用走 `updateUser`，重置密码走 `resetPassword`，目录查询走运行时 `userDirectory`），
    夹具不重写密码算法与账户规则。
- **RFC-199 竞态回归**：`rfc199-start-task-workflow-race` 的 11 个用例原先挂在旧启动器的提交钩子上，现全部改接生产路径：
  - 物化后版本变更 / 删除先赢（URL、scratch、多仓三例）分别锁定两件事：生产启动拒绝，以及持有物化租约的调用方经生产清理
    只删任务自有产物；
  - 分支只在 ref 未变时删除、被 base merge 推进的既有分支 CAS 恢复、结构化清理失败保留注册、并发 CAS 推进不被强制重置，
    改由 source-control 物化器的生产清理（`cleanupMaterializedSpace` / `createMaterializedSpaceCleanup` /
    `cleanupMaterializedSpaceLease`）驱动；
  - fusion 自有根目录在启动失败后删除，改走生产 fusion 启动；
  - 任务行先提交时 fenced 删除工作流报 `workflow-in-use`，改为生产启动内核提交后执行真实 `deleteWorkflow`。
- **其他改接或恢复的用例**：
  - `rfc165-agent-launch` A5：在生产 `loadVisibleAgent` 的两次读取之间删除 agent，锁定 `agent-id-mismatch` 与零副作用；
  - `rfc287-t13` file:// 缓存仓：改锁生产的延后准备拒绝；旧的「同步拒绝且不留任务行」不是生产行为（同步段只保存缓存仓 ID）；
  - `rfc370-task-launch-configuration-closure`：旧启动器把配置读取与预创建工作区接管绑在同一时序，生产中两者分开，拆成两例；
  - `rfc158` reopened-empty-review：恢复用例，期望改为生产读投影实际返回的 `decided`（旧读入口返回 `null`，该入口无生产调用方）。
- **删除的用例**（生产没有对应行为）：
  - `rfc271-bundle-planner` 的 `pendingSeamsFor` 3 例与 `opAction` 2 条断言，随 BundleApply 死合同删除；
  - `rfc359-w7-intent-apply-operations-conformance` 中只凭 `kind` 接受不完整 `skill-version-stage` 的宽松解码；生产解码器
    `modules/intent/infrastructure/intentApplyArtifactLifecycle.ts:412` 不接受；
  - `rfc301-task-launch-origin-inheritance` 中子启动夹带根来源与平铺来源 ID；生产请求
    `modules/task-execution/application/ports/childExecutionLaunchOperations.ts:17` 没有这组字段；
  - `rfc269-webhook-trigger-context-atomicity` 中 direct 来源同时夹带平铺 `scheduledTaskId`；生产 `ExecutionInvoker`
    （`modules/task-execution/public/commands.ts:24`）无法表达这种组合；
  - `rfc165-scratch-space` S6：旧启动器拒绝预创建 scratch 的分支；生产 multipart 启动支持 scratch。
- **守卫与账本**：新增删除锁 `rfc395-ii-pre-architecture-lock`（含 users 三个模块）；`counts.json` 的 legacy-horizontal-files
  397 → 395、legacy-thin-facades 48 → 47，unreachable-production-files 保持 27；commons-debt 入边 252 → 247，CC-12 以 II-pre 销账。
- **验证**：本地 SQLite 复跑全部 241 个改动测试文件，失败的 2 例为机器负载下的超时（RFC-321 系统模拟 e2e 超过 30 秒，
  RFC-075 续跑用例超过 5 秒；后者在 CI 上原本耗时 0.46 秒）。本地 PostgreSQL 复跑时本机负载过高，大量用例因 5 秒钩子超时失败，
  不作为证据；PostgreSQL 结果以 CI 为准。
- **观察（不改行为）**：生产根启动在准备工作区之前比较工作流版本
  （`modules/task-execution/infrastructure/taskRouteLaunchOperations.ts:1439`），任务行插入事务内不再复查；旧启动器的
  「物化后在插入事务内复查版本 / 存在性」没有生产对应物。阶段 II 重建 Task 写协议（design §3.3）时一并考虑。
- **遗留（不属于本 RFC）**：手动性能脚本 `packages/backend/scripts/perf-sweep.ts` 不在 typecheck 范围，2026-09-17 起已因
  `listTasks` / `getNodeRunEvents` 导出移除而无法运行，本次删除的 `startTask` 也是它的引用之一；需要按生产启动路径重写。

### 6.9 I-b 交付记录（2026-10-22）

I-b 由 Codex 实施（S0～S5），本会话审核并补正，一次提交落地，不改物理 schema、迁移文件、API 与产品行为。

- **落位**：
  - 中立查询面 `platform/persistence/querySurface.ts`（`PersistenceDb` / `PersistenceTx`，入口 `persistenceDb.ts`）：只收实测用到的
    builder（select / selectDistinct / from / where / having / groupBy / orderBy / limit / offset / innerJoin / leftJoin / crossJoin /
    unionAll / insert / values / onConflictDoNothing / onConflictDoUpdate / returning / update / set / delete，可直接 await），
    结果类型复用 drizzle 根层类型（含 left join 可空性），每个子句只能调一次；运行时就是原生 drizzle 对象，不包一层。
    类型级一致性测试 `rfc395-query-surface` 锁住两个原生库对象无需断言即可赋值、错误列类型被拒。
  - 表：`schema/nativeTables.ts` 由同一份 contribution 生成两套原生表（`nativeTableSets.sqlite` / `.postgresql`，按定义缓存，
    与 `@/db/schema` 留给 drizzle-kit 的导出是同一批对象）；`sessionTables.ts` 把表集与能力绑定在句柄上，事务与 savepoint 继承，
    业务一律 `tablesOf(db)`；`schema/neutral.ts` 是去掉方言品牌的中立表类型。全表集先给出，收窄到本模块的表留给 T11。
  - 辅助（`queryHelpers.ts`）：`first`（select 加 `limit 1`，带 RETURNING 的写照常整条执行）、`affectedRows`（bun:sqlite
    `changes` / Bun.SQL `count`）、`rawRows` / `rawFirst` / `rawExec`（按合同 codec 解码 int8、布尔、JSON），以及保留 SQLite
    同步事务程序原有执行时序的 `queryRows` / `queryWrite`；中立别名 `tableAlias.ts`；单行插入入口 `singleInsert.ts` 的 `insertOne`。
  - 能力矩阵签名改为中立 `Table` / `Column`；新增 `instr`（SQLite `instr` / PostgreSQL `strpos`，两侧测试
    `rfc395-instr-capability`），标量 `max(a, b)` 走既有 `greatest`；删除 `numericFromRawRow`；两个能力工厂改为单例，
    `session.engine` 与 `engineOf(tx)` 恒为同一对象。
  - PostgreSQL 改原生 `drizzle-orm/bun-sql`：先 reserve 再在该连接上 begin（不嵌套 reserve，reserve 等待遥测覆盖 begin），
    隔离级别走 `PgTransactionConfig`，嵌套事务用原生 savepoint，40001 / 40P01 重试保留；连接包装只按语句分类（读放行，写前依次执行
    部署写闸、首写标记与世代围栏），不改写 SQL。单行 INSERT 往返合并改为原生构造
    `INSERT … SELECT … WHERE EXISTS (活跃世代)`，经 `insertOne` 显式进入（生产 182 处），仍是一次往返；`on conflict` /
    `returning` / 多行 / 首写标记之前 / 配了部署写闸时回到原生 builder 与分类连接。AC-11 的三条锁按原生客户端重写后保持。
- **删除**：`db/providerSchema.ts` 整份（`providerTableFacade`、`concreteDatabaseTable`、`selectDatabaseSchemaProvider`、
  `currentDatabaseSchemaProvider`）；`ProviderNeutralDatabase` 与 `DatabaseTransaction` 类型；sqlite-proxy PostgreSQL 客户端与
  `compilePostgresqlSql`、`SQLiteAsyncDialect` 原始编译、`decorateDatabase`；daemon 启动的投影切换；测试侧的投影切换（harness
  种子改为两套表按定义逐表复制）。`taskOverviewQuery` 的模板缓存改为随会话持有。
- **规模**：1,953 个路径（新增 18、删除 1），其中 `src` 547 个文件。同口径 grep（`src` / `tests`）：
  - 无参数 `.get / .all / .run`：948 → 92 / 1,868 → 679；按类型识别的 drizzle builder 终端为 858 → 0 / 1,197 → 1（测试侧剩下的
    是 `@ts-expect-error` 负例），grep 剩余的是 bun:sqlite 语句、Map 等非查询对象；生产侧库级原始执行只剩持久化边界 4 处
    （围栏插入的原生 execute，SQLite 的 BEGIN / COMMIT / ROLLBACK）；
  - `ProviderNeutralDatabase` 1,491 → 0 / 2,997 → 0，`DatabaseTransaction` 381 → 0 / 31 → 0，`BaseSQLiteDatabase` 9 → 0 / 10 → 0；
  - 从 `@/db/schema` 导入表的文件 336 → 3 / 1,140 → 14（生产 3 个都是 schema 接线；测试 12 个是守卫负例文本，2 个是历史 SQLite
    迁移的原生 schema 构造）；三个投影切换符号 17 → 0 / 173 → 0。
- **守卫与账本**：新增 `rfc395-neutral-query-boundary`（持久化接线之外不得用方言终端或库级原始执行、不得 import `sqlite-core`）与
  `rfc395-session-table-imports`（持久化接线之外不得直接导入方言表）；`postgresqlSurface`、RFC-349 surface / cutover、W5 系列、
  T17～T20、`architectureReport` 等改指原生面，未删除或放宽。`counts.json` 未变。T28 / T29 扫描器学会识别 `first(…)`、
  元素访问与块体事务步骤后，各补录一处既有形状（`scheduledTaskPersistence.ts` 的 limit + 下标读、`graph-development/designStore.ts`
  经别名展开的插入），业务流程未改，属识别范围扩大。
- **审核补正（本会话）**：
  - PostgreSQL 写结果计数：Bun.SQL 的 `begin()` / `savepoint()` 把回调返回的数组过一遍 `Promise.all`，`count` 随之丢失。
    事务外的单条写经围栏事务回来、事务体把写结果返回给调用方，这两种情况的影响行数都成了 0，依赖「恰好 1 行」的 CAS 判定会误判。
    客户端改为装箱跨过事务边界，`rfc395-query-helpers` 增加两条真库断言；
  - `rfc395-database-defaults`：SQLite 侧按 I-a 已审漂移账本（`rfc395-sqlite-drift.json`，由
    `rfc395-provider-catalog-equivalence` 精确锁定）放行 `workgroup_member_cursors.updated_at` 的历史默认值差异，PostgreSQL 侧
    保持严格（真库逐表逐列相等）；
  - `rfc359-w27` 两处 PostgreSQL 期望值仍按 int8 字符串写，改为按 codec 解码后的数字；
  - 收敛 codemod 留下的冗余：同一函数内对同一句柄的重复 `tablesOf` 解构合并到第一处支配位置（`src` 777 处、测试 2,940 处），
    插在注释与其所注释语句之间的解构移到注释上方（`src` 82 处、测试 385 处），5 个生产文件里内联的 `tablesOf(x).表.列` 改回原有
    形状；清除指向已删机制的过时注释，`docs/dev-gotchas.md` 七处追加 I-b 更正。
- **验证**（本地仅作诊断，两个 provider 的全量以 CI 为准）：
  - 静态：backend typecheck（6144 MiB 堆，与 CI 一致）、全部改动 TypeScript 文件的 `eslint --max-warnings=0` 与 prettier 通过；
    Codex 另跑 depcheck、`lint:promises`、`db:check` 与性能微基准门（回归 0），均通过；
  - SQLite：Codex 的全量跑了一次（分片 4 完成：4,822 过 / 51 失败；分片 1～3 到 45 分钟时限，未出总数），初始失败的 110 个文件
    逐个隔离复跑后 103 个转绿。其余 7 个文件是 6 个 Codex 沙箱读不到进程信息的已知失败，加上默认值对拍；本会话在本机复跑这 7 个文件，
    73 过 / 0 失败。两个新守卫与 T17～T20、T28、T29 等 15 个文件 130 过 / 0 失败；
  - PostgreSQL（本机 postgres:17，`--timeout 60000`）：Codex 列出的 21 个重点文件中有 3 例失败，即上面补正的写结果计数与 W27；
    修复后连同受影响文件在两种数据库上复跑 10 个文件，148 过 / 0 失败。postgresql-evidence 的 T10-C 预言 10 个文件
    （含逐表真库 INSERT 写矩阵）73 过 / 0 失败。
- **偏离与遗留**：
  - `onCurrentSelected` 钩子已无生产调用方，只剩两份测试用它观察割接后正在服务的 session，暂留；
  - PostgreSQL 同名 shim 在 CHECK / 默认值里的用法（`json_valid` / `unixepoch` / `hex`）按 D12 保留到新 baseline；
  - 部署写闸配置时单行插入不走一次往返的快路径（与改动前一致）。
- **CI 与补正（2026-10-22，`9e66d89df` 之后的后续提交）**：`9e66d89df` 的主 CI（run 39824594590）后端 24 个分片中 9 个失败，
  去重后是 13 个用例，另有 Markdown 链接检查与真库 PostgreSQL job 失败；归因全部在本次交付内，已在后续提交中修复：
  - 本会话合并解构造成 4 个：W23、W26 的源码指纹（先确认改动前的源文件仍还原到旧指纹，再按新文本重算），W7 账本行号，
    以及 RFC-328 权限扫描器——`taskCollab.ts` 原用别名 `tasksTable`，这个按名字匹配的扫描器本就看不到这处既有的属主写入；
    codemod 统一成 `tasks` 后它变成「未登记权限」。恢复原别名，扫描结论与改动前一致；
  - 其余来自 Codex 的交付：
    - 生产缺陷：PostgreSQL 的事务句柄不带 `$provider` 品牌，嵌套的 `databaseSessionFor(tx)`（如 MCP 测试租约在外层事务里
      再开 `runResourceCatalogTransaction`）被误判成 SQLite，当场崩溃。provider 改按句柄绑定的引擎判断（`boundEngineOf`）；
    - 新守卫 `rfc395-neutral-query-boundary` 在 guard-manifest 里错标为语料扫描器，按同类守卫惯例改登记；
    - W25 未剥开 drizzle 对驱动错误的包装；RFC-357 的 LIKE 源码判据未随能力矩阵写法更新（T20 J1 要求 `ESCAPE` 只在矩阵内，
      搜索比较两侧仍先 lower）；
    - W12、RFC-234 的打桩与故障注入缝只覆盖 sqlite-core 的入口，§5ef 的录制器不认 pg-core 带括号的 union；
    - 研究文档里一处 Markdown 链接指向已删除的 `providerSchema.ts`，改为纯文本路径。
  - 本地在两种数据库上复跑上述文件，全部通过。RFC-370 MCP 诊断里三处 2 秒等待、能力矩阵里一处 300 毫秒等待，在本机负载 190
    下超时；它们在 `9e66d89df` 的 CI 上通过，以后继 CI 为准。
- **p95 对拍**（postgresql-evidence 的 HTTP 性能档，weekly 语料，同一 workflow 各起一台 runner）：改动前 `67795ed46`
  （run 39824658001）与 I-b `9e66d89df`（run 39824667609）的 PostgreSQL p95（毫秒），依次为 tasks-first 25.26 → 16.79、
  tasks-second 21.21 → 13.02、tasks-running 20.89 → 10.83、repos-first 7.63 → 2.85、repos-referenced 6.47 → 4.12、
  reviews-pending 4.33 → 1.94、clarify-pending 2.19 → 1.08、workgroup-pending 6.97 → 3.77、overview 13.98 → 5.11。
  I-b 九个端点全部在原始预算与 PostgreSQL 容差之内；改动前这次有两个端点超出容差。两台 runner 不同，绝对值只作参考，结论是没有退化。
- **第二轮 CI（`c35067361`，run 39836782229）**：49 个 job 中 5 个失败。后端 24 个分片中 23 个通过，含全部 PostgreSQL 泳道，
  上一轮本机超时的 MCP 诊断与能力矩阵用例在 CI 上通过。归因：
  - 本会话：分片 20 的 S-14 棘轮账本。`taskCollab.ts` 恢复别名后，按名字计数的 `update(tasks)` 回到 0，删除 Codex 补录的那一行，
    账本与 I-b 之前逐字一致；
  - I-b 交付：真库 job 的 RFC-359 P0 变异取证。P0-5、P0-6 的变异点原文随 I-b 改写而漂移（放行注释挪进了 `if (flipNow)`、
    删除路径多了一行会话取表）；P0-2 的历史谓词仍从 `@/db/schema` 取表，在 PostgreSQL 上用 SQLite 列解码，int8 回成字符串，
    严格相等恒不成立。三处夹具按现状更新，P0-2 改从会话取表；
  - 与本次无关：
    - 静态扫描的依赖审计门因外部新公告 dompurify GHSA-mrv2-3pqr-j5jr 失败，属安全类依赖处置，不在本 RFC 范围；
    - Playwright e2e ubuntu 2/3 在安装浏览器依赖时 apt 源返回 403，未执行任何用例。
- **收口（`d41f068f1`，run 39843156514）**：49 个 job 中 47 个通过，两个 provider 的后端全部分片、真库 job（含 P0 变异取证）、
  e2e 全绿；唯一失败的依赖审计门仍是上面的外部公告。本地另在 PostgreSQL 上直接跑了 P0-2 / P0-5 / P0-6 三个变异：本机负载下脚本的
  PG 基线阶段会撞 5 秒默认超时，所以加 `--timeout 60000` 单独跑，结果与 SQLite 一致。

### 6.10 阶段 II 实施分解（2026-10-22）

用户 2026-10-22 选定阶段 II 拆两次交付，依据 §4「前置交付不激活新合同，最终激活交付包含全部实现和测试」：

| 交付 | 内容 | 验证与提交 |
| --- | --- | --- |
| II-a 端口先行 | 在现有物理 schema 上，把业务改为经目标形状的端口读写；行为与 API 不变，不新增表、不改迁移、不激活新合同 | 全部开发与用例写完后集中验证一次，单独提交 |
| II-b 一次切换 | 目标 contribution、各域适配器换到目标表、转换器、迁移回执与激活、兼容投影、删除清单 | T18 集中验证，一次激活交付 |

理由：II-a 的重构错误由现有双 provider 测试在已知正确的旧 schema 上抓出；II-b 只剩存储切换、转换与激活，改动面与归因难度都小得多。
II-a 写在现有 schema 上的读侧映射（主体判定、挂载与逐仓 checkpoint 解码、逐题答案分解、引用数组解析、选择 oracle）
就是转换器所需的源读者规则，II-b 冻结后移入迁移模块；只有写侧适配器会在 II-b 被替换。

II-a 的精确范围（每包一次 Codex 派发，同一工作树只并行文件不相交的包）：

| 包 | 范围 | 留给 II-b |
| --- | --- | --- |
| A1 测试造数（T2b 测试侧） | 目标模型 fixture builder：spec 用公共 API 投影字段名；已删或派生的形状（`repoCount`、`worktreeDirName`、`seq: null`、单仓 / 多仓 checkpoint 双编码、`consumed_upstream_runs_json` 原文）不进 spec，改用目标形状输入（挂载列表、逐仓 checkpoint、消费边）。实现写现有 schema，seq 经生产分配器；被迁列的更新与读取也经 builder。幂等 AST codemod 改写全部测试直写；机器可读的列去向清单（tasks 70 列、node_runs 62 列等）及 builder 覆盖测试；守卫：fixture 模块之外不得直写被重塑表（只降棘轮，余量逐文件登记）；e2e 裸 SQL 收进单一夹具模块 | builder 实现切到目标表；迁移链测试归位到转换器 |
| A2 Task 主体与工作区（T4、T5 端口） | 五类主体判定与 `definitionAnchorId`；`taskSubjectProjection`（评审不再 join `workflows`）；读时排版按定义来源判定；D1 宿主工作流退出 catalog：停止播种，对宿主行的 join 与存在性依赖全部改为常量与投影，旧库残留行由转换器删除；单一任务创建 participant，lineage 推导移入领域函数；主仓字段单一投影 `projectTaskRepositorySurface`；挂载列表 + 逐仓 checkpoint 端口 DTO，`repoCount === 1` 二分与 `worktreeDirName` 键收进适配器 codec；回滚计划与执行合一，删除 `gitStashSnapshot` 与 retry 模式（D3 中不依赖 schema 的部分） | 物理拆表；镜像列与 `repo_count` 删除 |
| A3 NodeRun（T6 端口） | 按 §6.2 的固定顺序：`domain/runSelection` 领域模型、`application/ports/runSelection.ts`、包装现有 picker 的 oracle 适配器；77 处选择计算与 22 条 SQL 按 ii0-revision §3.3 的 G1～G12 迁到端口；NodeRun 身份快照 + 配置 / 运行态 / 结果 / checkpoint 视图，扁平 patch 与 extra 改为按目标表分组的类型化写入；铸行显式传 role，不变量改为「角色 + 容器」，存储仍按现 schema，由同一个领域函数推导；collaboration / memory / 工作组改经 task-execution public query 与 participant | 选择表实现与双实现对拍；oracle 移入迁移模块；seq / frame 启动回填删除 |
| A4 澄清与内容（T7、T9 端口） | 逐题答案 / 草稿 / 归属领域模块与 map 投影，seal、编辑、follow-up 都走该模块；memory 改经 collaboration public query；`ContentRef` 判别联合与字节型技能端口，内容位置推断收敛到 ContentRef codec | 逐题表；去掉 Task 锁与整 map 读写；内容表与 bytes 列 |
| A5 资源依赖（T8 端口） | agent 引用单一写者 participant、workflow 定义单一写者、共享依赖收集、单一依赖校验 | 关系表与依赖索引；去掉 JSON LIKE |
| A6 AtomicApply（T10） | `platform/atomic-apply` 共用状态机；intent 与资源包 apply 改为场景适配器，两份收敛合一；旧制品形状只留在一个 legacy codec | legacy codec 移入迁移模块（D9） |
| A7 跨域收口（T11） | 模块只访问本模块表，跨域读写改经 public query / participant，加守卫 | — |

派发顺序：A1 与 A6 并行（A1 的 codemod 暂跳过 A6 触及的测试文件，II-a 收尾时全树重跑一次）→ A2 → A3 → A4 与 A5 并行 → A7 → 集中验证。

II-b 的工作包：
- B1：目标 contribution；冻结 epoch-1 合同与源表；合同历史机制；新 baseline；pointer v2；`migrationRole` 退役。
- B2：各域适配器换到目标表；选择表实现与双实现对拍；builder 换到目标模型；删除清单其余项。
- B3：转换器（T12）、迁移回执（T13）、切换与恢复（T14）、旧 epoch 备份恢复。
- B4：兼容投影与 DTO 对拍（T15，夹具取自 II-a 提交）；守卫与账本（T16）；其余测试与操作手册（T17）。
- 之后执行 T18。

### 6.11 II-a 交付记录（2026-10-23）

按 §6.10 的包划分完成 A1–A7 的全部开发与用例编写后集中验证一次，单独提交。物理 schema、迁移文件、HTTP API、用户可见行为与持久化字节不变（下列「有意变化」除外）。

| 包 | 交付 |
| --- | --- |
| A1 | 目标模型 fixture builder（`packages/backend/tests/helpers/model/`）、幂等 AST codemod 改写测试直写、列去向清单与 builder 覆盖测试；fixture 外直写 / 直读被重塑表的只降棘轮；e2e 裸 SQL 收进单一夹具模块 |
| A2 | Task 主体五类判定与 `taskSubjectProjection`；D1 宿主工作流停止播种、读侧不再依赖宿主行；单一任务创建 participant；主仓字段单一投影 `projectTaskRepositorySurface`；挂载列表与逐仓 checkpoint 端口；任务定义写端口与工作组配置拆分（解码器 `packages/shared/src/schemas/workgroupRuntime.ts`）；纯 SQL 辅助移入 `platform/persistence/`；守卫 `rfc395-task-definition-boundary` 等 |
| A3 | `domain/runSelection` + `application/ports/runSelection.ts` + 包装现有 picker 的 oracle（`task-execution/infrastructure/runSelection/**`）；类型化 NodeRun 快照与分组写入；铸行显式传 role；消费边 participant；collaboration / memory 改经 `NodeRunQueries`；守卫 `rfc395-run-selection-boundary` 与选择口径账本；oracle 快照要求完整行或声明范围（K4）；冻结 HEAD SQL 的随机对拍证据（K8） |
| A4 | 澄清逐题答案模型、单一投影与写端口；memory 经 collaboration public query 读澄清轮次；中立 `ContentRef`（`platform/content/`）与各旧位置 codec；技能内容端口按字节 |
| A5 | agent 引用单一写者 participant、workflow 定义单一写者、共享依赖收集（`packages/shared/src/resourceReferences.ts`）、单一依赖校验、反查端口；knowledge-evolution 融合种子改经 resource-catalog public participant |
| A6 | `platform/atomic-apply` 共用状态机；intent 与资源包 apply 改为场景适配器 |
| A7 | 表归属守卫扩到全部 registry 表：模块间跨域引用 249 → 199 处（被重塑表 75 → 31），其余逐条入只减不增账本；模块外文件 60 处引用中 18 处为全局基础设施（精确列出）、12 处闭合、30 处记账；新增 owner public query / participant（任务门、节点输出、知识、触发、详情、准备、删除、澄清指令等场景合同） |

有意变化（行为层面，需知会）：

- 记忆提炼读取多轮澄清时按 round id 二进制序排列（PostgreSQL `COLLATE "C"` / SQLite BINARY，`platform/persistence/binaryTextOrder.ts`）；HEAD 无 ORDER BY，顺序随执行计划。

保持现状、留待后续功能决定：

- 技能文本视图的 BOM：数据库适配器去掉前导 BOM，文件适配器保留；两者不一致原样保留。
- 各写者对重复引用的处理不同（普通 API 与 Intent 保留重复；资源包对三类去重、技能不去重），原样保留，作为 II-b 关系表主键的裁决依据。

偏离与债务：

- RFC-294 公共合同新增 38 条过渡债务（`packages/backend/tests/rfc294-architecture-preflight.test.ts` 的 `PUBLIC_SURFACE_DEBT` 末尾、带注释的 RFC-395 II-a 块）：owner 查询 / participant 必须在调用方的会话、事务或同一条语句里执行（`PersistenceDb` / `PersistenceTx` 参数、同语句关联 SQL 片段），另有两个留在 platform 的 DTO 类型；没有用别名或类型改写躲过守卫，HEAD 原有 97 条不变。后继为 RFC-294 S5/S6 在组合根绑定。2026-10-23 已向用户说明这一偏离并给出改为依赖注入的替代方案，未收到反对，按推荐方案提交。
- 被重塑表仍有 39 处记账访问，`removeWhen` 都要求在 II-b B2 替换对应适配器前收口，收口方式（required SPI 或组合根绑定）需要 RFC-294 层面的裁决：模块间 31 处（`tests/fixtures/rfc395-module-table-ownership-debt.json`）——28 处没有 offered 边（resource-catalog → tasks ×6、source-control ×7、system-operations ×4、development-automation ×4、runtime-management ×2、task-execution → clarify_rounds ×4、collaboration → agents ×1），3 处虽有 offered 边但闭合会形成文件级值依赖环或越出 RFC-376 已提交 DAG（人工门 journal → tasks、code-capability → agents、runtime-management → workflows，测试中精确列为 `OFFERED_BUT_BLOCKED`）；模块外 8 处（`tests/fixtures/rfc395-horizontal-table-ownership-debt.json`）。
- design §12.2 S3 的会话表集按模块收窄未做：task-execution / resource-catalog / collaboration 分别有 109 / 82 / 34 个文件使用 `tablesOf`，随 II-b 逐 owner 换适配器时收窄。

留给 II-b 的事项：

1. **K1 / K3 / K6（稳定 role 与 canonical slot）推迟到 II-b。** II-a 中标签没有消费者：生产选择与 HEAD 相同，铸行守卫与 HEAD 的拒绝集合相同，`apply` 只校验且无生产调用触发。II-b 增加显式 role / container 列（D5），转换器也必须为存量行推导 role。规则：

   | 行类 | 稳定事实 | role / canonical slot |
   | --- | --- | --- |
   | wrapper 每次运行，含级联占位、评审 reject / iterate 重跑 | 任务冻结定义中的 wrapper kind + frame | container / container(node, frame) |
   | 普通节点，含保留字名称的用户节点与 `__wg_clarify__` 澄清停泊行 | 冻结定义中的普通 kind；不能只凭 id 判为系统行 | node-attempt / node(node, frame)；fanout 内部按拓扑分槽 |
   | turn-engine 工作组 host | 任务主体 + workgroup engine + host 写者 | synthetic(workgroup-host) / workgroup-host(node, shard) |
   | 共享 / 广播或逐 shard 的 fanout 行 | parent / frame 对应的 fanout 定义与节点拓扑 | node-attempt / shard(node, iteration, shardKey)，NULL key 仍可为广播 |
   | fanout 聚合行 | parent / frame + fanout 汇合节点 | node-attempt / aggregator(node, iteration) |
   | repo-prep / commit-push / merge-resolve / dw / wg gate | 实际系统写者身份，排除同名用户节点 | synthetic(kind) / synthetic(owner, kind, discriminator) |
   | commit-session，含 cause 为 NULL 的历史行 | 父行是 commit-push 系统行这一结构事实 | synthetic(commit-session) / synthetic(attempt owner, commit-session, discriminator) |

   #70 的历史 host + gate 分组须表达为 canonical slot 上的 reader 查询，不能把 gate 标成 host。待迁移的 `deriveNodeRunRole` 调用：生产 28 处、测试 58 处（以 `rg -n deriveNodeRunRole packages/backend` 为准）。
2. 聚合行重放判据：目标「记录的已消费 shard 集合 == 当前 shard 选择」与今天「聚合行比所有参与 shard 新」并非无条件等价（① 消费 {A,B}、现只剩 {A} 参与：旧判据真、集合判据假；② 聚合行原地重跑后消费了更晚铸出的 shard：集合相等、旧 seq 更小）。今天聚合行不持久化消费集合；II-a oracle 保留旧比较，II-b 物化与转换器须先由用户裁决（design §5.2、ii0-revision §3.3 曾假定等价）。
3. `decodeRequestedSource` 有损（local → internal；remote 缺 cached id + url → scratch；requestedRef = 解析后的 base_branch），转换器不能把它当精确来源。
4. D1 回退窗口：II-a 写过的库在 HEAD 二进制上会隐藏宿主类评审，直到其重新播种；code-round 从不重新播种。
5. 包与 intent 恢复的 `list()` 每轮（启动 + 每小时）前滚全部已提交行（HEAD 行为，开销在树哈希）；II-b 可加提交完成标记。两个 journal 的同键异载荷：II-b 增加规范请求摘要与身份版本列。
6. 单个非根成员缺陷族的 4 处候选（call child ×2、调用图展开、工作树文件内容读取）不属于 RFC-395，按 §6.4-12 另行修复。

验证：本地集中验证（2026-10-23）。后端 SQLite 全量三轮：第一轮 4116 过 / 161 败，其中 405 个文件被 A7 引入的模块初始化环连带（collaboration 人工门文件反向 value-import task-execution 的 `public/participants`）；修环与 RFC-376 结构门后第二轮 105 个文件 181 败；三个 Codex 修复线程（守卫与源码锁 / 选择与旅程 / 持久化与一致性）修复后第三轮 5 个文件 6 败，均已修复并单独复验；`rfc220-oauth2-callback-route` 为负载下本地模拟授权服务器的抖动（单独 7/0，前两轮通过）。验证中发现并修复的生产回退：调度采纳 pending 重跑行时读取尚未实现的 slot 标签（澄清 / 评审 / 包装节点旅程不再重跑）、准备重试与 commit 中断恢复的 oracle 范围、任务空间目录多写根与祖先行（已恢复 HEAD 的「只写调用方给出的 nodePaths」）、AtomicApply 返回数组未冻结、评审徽标计数从 1 条 SQL 退化为 3 次查询、收件箱轮询带出整份冻结定义（RFC-311 L1-3）、保存期依赖校验的 `VALIDATE_CALL_POLICY` 调用点丢失。shared 2349/0、frontend 7327/0、system-mocks 102/0。e2e：A1 改动的 24 个 spec 本地冒烟 195 过 / 3 败，均与 II-a 无关——MEM-X8 在 `67ab6b9ae` 的 nightly 已失败；WG-06 是本机 UTC-7 时区下 `util/zip.ts` 固定 mtime 换算为 1979 年触发 `date not in range` 的既有缺陷（UTC 的 CI 不复现）；TASK-X2 是本机真实 runtime 带凭据，使变更叙述生成成功而非预期的失败。本地 PostgreSQL 因 Docker 虚拟机磁盘满中断（满之前约 1849 个 PG 用例无失败），以 CI 的 ubuntu PostgreSQL 分片为准。静态检查：三包 typecheck、eslint、prettier、depcheck、lint:promises 均通过；RFC-294 公共合同与 RFC-376 结构门的静态扫描无未登记项。

CI：`106d06d84` 的 run 40012778786 暴露 5 类本次引入的问题（typed lint 堆上限、双引擎启动对等未摘逐仓易变格、PG 触发器错误包装、A1 全量扫描守卫超时、P0-6 变异锚点），由 `5b947545e` 修复；run 40017338430 第 2 次尝试 47 成功 / 2 失败，仅余 Static scans（依赖审计类，II-a 之前已红，按规则不分析）与派生汇总。第 1 次尝试中 Windows e2e 2/4 的 1 个失败与 ubuntu e2e 2/3 的取消，经本地用 II-a 二进制复跑（6–7 s 通过）与一次重跑归因为 runner 慢（daemon 就绪 90 s 超时）和作业准备耗时（约 11 分钟），不是本次改动。

### 6.12 II-b 前置裁决（2026-10-23）

II-a 交付后向用户提了三项待定事项，用户 2026-10-23 回复「按你推荐做，3 改」：

1. **公共合同过渡债务**（§6.11「偏离与债务」第 1 条）：用户明确接受推荐方案。38 条过渡合同保留，后继仍是 RFC-294 S5/S6 在组合根绑定。§6.11 中「未收到反对，按推荐方案提交」的表述，以本条的明确接受为准。
2. **II-b 动工前的两项裁决**。提问时只列出了问题，没有写出推荐内容，所以用户回复「按你推荐做」时没有看到下面的具体方案。以下是此后首次写出的推荐，作为 II-b 设计的默认前提，用户可以推翻：
   - **39 处被重塑表记账访问的收口方式**：采用 RFC-294 的 consumer-owned required SPI（RFC-294 design §2、§3.1）。
     - 模块间 31 处：消费方在自己的 `composition/required-ports.ts` 声明按用例拆分的端口；表 owner 在自己的 `application/adapters/` 实现；bootstrap 负责实例化和注入。这样不新增 offered 边，也不形成文件级值依赖环。3 处 `OFFERED_BUT_BLOCKED` 同样走这条路。
     - 模块外 8 处：业务 SQL 移入 owner 模块，`platform` 只保留领域中性的端口，由 owner 实现、bootstrap 注入，不新增 platform → modules 边。其中 `db/query.ts` 的可见性联合查询按调用场景移入 owner，经端口保持单语句语义，与账本 `removeWhen` 一致。
     - II-b design 须逐条列出新增的 required-SPI 实现边（RFC-294 §3.1 要求它们与 offered 边分开登记），经用户确认后才开始 B2。
   - **聚合行重放判据**：II-b 保持今天的判据，即同时满足以下四条：
     - 聚合行的铸行序晚于每个参与 shard 的可复用输入行；
     - 聚合行状态为 done；
     - 合并状态已落定或为 `conflict-human`；
     - 非强制重跑，且未禁用复用。

     判据位置：`packages/backend/src/modules/task-execution/infrastructure/runSelection/oracle/shards.ts:57-76`。`node_run_inputs` 照常记录聚合行实际消费的 shard 运行集合，但这个集合只记录，不参与判定。存量聚合行没有持久化的消费集合，转换器不为它们反推。如果改成「已消费集合 == 当前 shard 选择」，会带来用户可见的行为变化（反例见 §6.11「留给 II-b 的事项」第 2 条），因此另行立项。design §5.2 的相应表述以本条为准。

3. **`util/zip.ts` 时区缺陷**：与 RFC-395 无关，已由 `7e48a0035` 单独修复。固定 mtime 改为按本地时间构造，并附五个时区的子进程回归测试；本机 e2e WG-06 已转为通过。§6.11 验证段对 WG-06 的归因不变。

### 6.13 II-b 实施分解（2026-10-23）

用户 2026-10-23 要求继续推进。II-b 仍是一次交付：全部包开发与用例写完后集中执行 T18，一次激活（§6.10）。

**开发期两个 epoch 并存**：

- 目标表（epoch 2）先与现行表（epoch 1）并列声明。`bootstrap` 另行汇集目标 registry，经 `targetTablesOf(handle)` 取目标表集；在激活包之前，运行时、`tablesOf` 与 `@/db/schema` 仍指向 epoch 1。
- 激活包一次性完成以下切换：
  - 运行时改指 epoch 2；
  - epoch 1 的表声明与合同冻结进迁移区，只供转换器的源读者使用；
  - 新库直接按目标 baseline 建库；
  - 启用 pointer v2 与准入；
  - 退役 `migrationRole`。
- 理由：开发期间工作树的 typecheck 保持可用，不阻塞同一工作树里其他会话的静态自查。即使在制改动被其他会话的整文件提交带上 `main`，运行行为也不会改变：II-a 期间 `ba7b8c6c4` 就曾把在制改动带上 `main`，后由 `67ab6b9ae` 撤回。
- 结构守卫：激活后，epoch 1 的被重塑表只允许迁移区 import。

**先收口、后换表**：39 处被重塑表的跨域访问先在现有表结构上按下表 O 收口，消费方从此不依赖表结构；之后各 owner 换表时只改自己的内部存储。收口方案见下文「跨域收口（O）」。

| 包 | 内容 | 依赖 | 主要落点 |
| --- | --- | --- | --- |
| R1 目标 registry（T2b） | 被重塑与新增表的目标 contribution（design §3～§7、§9；table-mapping §2、§3）。§2.4 的 provider 差异裁决：类型化行级规则 `immutableOnceSet` / `appendOnly` 及其两侧原生编译与错误映射；两侧 FK 与删除动作；`tasks.name` 非空；唯一约束的 NULL 语义；删除三个无类型触发器。退役与收缩：旧 code work 表归档 / 历史化、`employee_os_writer_state`、`committed_event_family_cutovers.mode`。install-only 种子；目标 registry、两侧编译产物与机读目标清单 | — | `platform/persistence/schema/**`、各域 `infrastructure/persistence/`、`bootstrap/` |
| R2 合同历史与代次（T13 机制部分） | design §13 的合同历史 + 类型化边：编译、两侧应用、SQLite 重建表边、准入比较物理目录与头合同 plan、只扩展后继。`scripts/schema-history.ts`；meta 表机制；pointer v2 读写与原子替换；SQLite 代次目录；目标库哨兵与首写标记。全部以库的形式交付，由激活包接线 | — | `platform/persistence/schema/history/`、`platform/persistence/`、`scripts/` |
| O 跨域收口（T11 余项） | 见下文；在现有表结构上完成 | — | 各消费模块、task-execution、bootstrap、RFC-294 DAG 登记 |
| T 任务主体与工作区（T4、T5 写侧） | Task 拆表后的 owner 内部存储；挂载与逐仓 checkpoint 表；聚合写协议（`lockAggregateRoot`）；单一任务创建 participant 写全部从属表；D1 余项、D2 | R1、O | task-execution |
| N NodeRun（T6 写侧） | 身份列与 `slot_key`；K1 / K3 / K6 稳定 role 与 canonical slot（§6.11 规则表；`deriveNodeRunRole` 生产 28 处、测试 58 处）；`node_run_selections` 表实现，与 oracle 双实现随机对拍；`node_run_inputs`；配置 / 运行态 / 结果 / checkpoint 表与写协议；envelope nonce；D3、D4（含 RFC-374 S1b 的 id 回退删除）、D5；oracle 移入迁移区 | R1、T | task-execution |
| C 澄清（T7 写侧） | 逐题答案 / 草稿表；去掉 Task 锁与整 map 读写（D6）；归档内协作段改出逐题表（`ARCHIVE_SCHEMA_VERSION` 随 Q 定） | R1、O | collaboration |
| F 资源依赖（T8 写侧） | agent 四类关系表、`workflow_dependency_index`；去掉 JSON LIKE 与名称充 ID 的回退（D7） | R1、O | resource-catalog、shared |
| X 内容（T9 写侧） | `content_objects` / `content_bytes` / `content_publications`（取代 `hosted_object_publications`）；12 张内容引用表；技能内容按字节（D8） | R1 | platform/content、各内容表 owner |
| P AtomicApply（T10 余项） | 旧 artifact codec 移入迁移区（D9） | R1 | platform/atomic-apply、intent、resource-catalog |
| M 造数与测试基座 | A1 builder 改写到目标表；测试库按目标 baseline 直接建库，不再重放 260 个迁移；历史迁移测试移到转换器 | R1、R2、各写侧包 | `tests/helpers/**` |
| V1 源识别与读者（T12 前半） | `SourceFingerprint`；四类源的版本化读者（`preflight / assertUnchanged / readChunk`）：epoch 1 SQLite 文件、VACUUM INTO 备份 + manifest v2、PG 逻辑工件、托管备份；RFC-374 之前的合同与本机差异样本 | R1 | 迁移区 |
| V2 转换规则（T12 后半） | migration §4 全部转换规则；行处置、chunk 回执、`execution_legacy_evidence`、历史包；用 II-a 的读侧解码器与 oracle 计算选择 | V1、T、N、C、F、X | 迁移区 |
| V3 迁移运行与切换（T13 余项、T14） | 迁移 run / chunk / receipt 与 trace；切换状态机：备份、静默、冻结、转换、验证、激活回执、pointer 替换、首写边界、首写前撤回；PG 目标库切换；CLI 与托管部署入口；旧 epoch 备份恢复 | R2、V2 | system-operations、bootstrap、CLI |
| A 激活 | 运行时改指 epoch 2；epoch 1 冻结进迁移区；新装按目标 baseline 建库；pointer v2 与准入接线；`migrationRole` 退役；drizzle-kit 停止生成；二进制内嵌合同历史；启动序列删除旧数据升级步骤 | 以上全部 | `bootstrap/`、`db/`、`scripts/`、各 provider |
| Q 兼容与收尾（T15～T17） | API / WS / 任务目录 / 历史 / 导出 / 归档 v3 / 浏览器草稿的兼容，新旧二进制 DTO 对拍；D1～D13 销账、守卫改指、架构清单；故障注入、完整旅程、二进制、操作手册与演练模板 | A | 全仓 |

派发顺序：
1. R1 ∥ R2。
2. O（分三个 Codex 线程，文件冲突处只做局部修改）∥ V1。
3. T ∥ C ∥ F ∥ X ∥ P。
4. N ∥ M。
5. V2。
6. V3。
7. A。
8. Q。
9. T18。

同一工作树内只并行文件不相交的包，否则限定局部修改。

#### 跨域收口（O）

依据 2026-10-23 只读研究（39 处逐条：读写内容、事务语境、目标表、端口签名与 DAG 检查）。用户 2026-10-23 确认按此方案执行。

**required SPI（模块间 31 处中的 22 处）**：消费方在自己的 `composition/required-ports.ts` 声明按用例拆分的端口。表 owner 在 `application/adapters/` 中以仅类型 import 实现，适配器委托 owner 内部端口，SQL 留在 owner 的 infrastructure。bootstrap 实例化并注入。事务内端口用 `(tx) => XxxParticipant` 工厂，不以 `Tx` 结尾命名。每条新边同一提交登记进 `tests/architecture/rfc294Target.ts` 的 `REQUIRED_CONTEXT_EDGES` 与 RFC-294 design §3.1 的 mermaid。这些边不改变 RFC-376 结构门的任何基线。

| 实现方 ⇢ 消费方 | 合同 | 条目 |
| --- | --- | --- |
| task-execution ⇢ source-control | `WorkspaceGcTaskPort`、`TaskWorkspacePruneParticipant`、`CachedRepositoryTaskUsagePort`、`TaskRepositorySourceSealingPort`（事务工厂） | M9、M12、M13、M14、M25、M26、M27 |
| task-execution ⇢ runtime-management | `RealtimeTaskFactsPort` | M8、M24 |
| resource-catalog ⇢ runtime-management | `RealtimeResourceAclPort` | M31（原 `OFFERED_BUT_BLOCKED`） |
| task-execution ⇢ resource-catalog | `SubjectTaskReferencePort`（事务工厂，在删除事务内执行） | M18、M22、M23 |
| resource-catalog ⇢ collaboration | `ReviewUpstreamAgentPort` | M2 |
| task-execution ⇢ collaboration | `HumanGateTaskLockPort`（事务工厂） | M17（原 `OFFERED_BUT_BLOCKED`；RFC-294 S5 解开值依赖环后改用 offered participant） |
| collaboration ⇢ task-execution（该对已有） | `TaskArchiveCollaborationSectionsPort`、`TaskRecoveryHumanGateFactsPort`、`TaskNodeRunClarifyNavPort` | M4、M5、M6 |
| task-execution ⇢ system-operations | `DoctorTaskLifecyclePort` | M29 |

**不适合 required SPI 的 17 处**：
- 代码能力 M1、M7、M11、M15、M16：code-capability 不是目标 context，不能作依赖边端点。由 bootstrap 把 owner 查询注入窄端口：resource-catalog 现有的 `existingIds`，以及 task-execution 新增的 `TaskCodeWorkspaceQueries` / `existingTaskIds`。不加边，并删除 code-capability 自己的实现。
- 系统运维 M28（`/health`）、M10 / M30（资源限额）：这些事实不归 system-operations（RFC-294 design §3.4）。由 bootstrap 注入 task-execution 的计数与限额事实查询，system-operations 只保留恢复审计。
- `findWorktreeTask`（M12 / M25 的一部分）：只有旧路由与 service 调用，改为由 bootstrap 注入 task-execution 的 `TaskWorktreeLocator`。
- M3（启动期 frame 回填）：随 D5 删除。
- M19～M21：没有生产调用的旧删除函数，直接删除，测试改指模块仓储。
- 模块外 8 处：
  - H2 / H7：旧生命周期写者迁入 task-execution。
  - H3、H4 / H8：迁入 task-execution；H4 / H8 与 source-control 收口同包。
  - H5：可见性谓词迁入 `task-execution/infrastructure/taskAuthorization.ts`。该文件已持有 `task_collaborators` 的账本键，每条语句仍完整留在 task-execution 内。
  - H1：platform 的 `EventsArchiveStore` 由 task-execution 实现、bootstrap 注入。
  - H6：platform 只保留清理的游标与阶段机制，以中性 `RetentionSweepPhase` 端口由各 owner 实现。

**一条语句跨两个 owner 的两处（用户 2026-10-23 裁决）**：
- M12 / M25 缓存仓库的「被任务引用」筛选与计数：**拆成两步**。source-control 先经 `CachedRepositoryTaskUsagePort` 取被引用集合（分批），再在本地过滤与计数，合同中不出现 SQL。task-execution 一侧必须走索引探测，不得全表扫描 `tasks`。列表与计数不再出自同一快照（计数本就缓存 5 秒）。锁定执行计划的 4 个测试改写：`rfc359-w8-t26-plan-reshape-conformance`、`rfc359-w6-t26-postgresql-plan-audit`、`rfc359-w20-repository-reference-counts`、`rfc359-w20-repository-search-conformance`。T18 做同库前后性能对比。
- H6 webhook 触发记录清理：**保留一条 DELETE**。task-execution 公开同语句片段（形如 `nonTerminalTaskExists(db, taskIdColumn)`），由 integration 的清理阶段使用；integration → task-execution 是 offered 边。新增的 `PUBLIC_SURFACE_DEBT` 条目与 II-a 已接受的 38 条同类，属本 RFC 记账的偏离，后继随 RFC-294 S5 / S6 处理。

**承担的 RFC-294 演进**：O 一并完成 RFC-294 S5 中的两步——工作区 GC 归 source-control 与 task-execution 各自所有（G1），旧生命周期写者迁入 task-execution（G16）。

**收口顺序**：H2 / H7 先于或与 source-control 收口同包；H3 在代码能力收口之后；M16 与 G1 共用 `existingTaskIds`、M28 与 M29 共用任务状态计数，各只建一次。
- resource-catalog 换表前须完成 M1、M2、M31；
- collaboration 换表前须完成 M3～M6；
- task-execution 换表前须完成其余全部。

**待测试证明的口径**：
- 引用计数今天同时计入挂载引用（design §4 的「只读 `requested_source`」不改变这一行为）；
- 主体判据 `subject_kind / source_id` 与今天 `source_agent_id / workflow_id / workgroup_id` 等价；
- runtime-management 的成员指任意 `task_collaborators` 行；
- M6 同 `createdAt` 的平序保持今天的结果。

#### 对已批准文本的修订

- §3「NodeRun」测试矩阵中「聚合输入集合判据与旧『比每个 shard 都新』判据等价」一句，按 §6.12 改为：表实现在随机历史上复现今天的判据，并记录聚合行实际消费的 shard 集合。
- RFC-374 留下的 S1b（删除 id 回退）由 D4 承担，不再单独立项。
- §6.11「留给 II-b 的事项」第 6 条的 4 处候选缺陷已确认属实，于 2026-10-23 由 `6198ae144` 作为缺陷单独修复（不属于 RFC-395）。
- 本节开头「II-b 仍是一次交付」有一处例外：O 不随激活包交付。用户 2026-10-23 批准先单独验证并提交 O，它不激活任何新合同，运行行为、API 与持久化字节不变，见下文「进度」。

#### V2 分解（2026-10-24）

V2 覆盖 migration §4 的全部规则与 222 张源表，规模大，拆为公共框架与四个领域包，文件互不相交：

| 包 | 内容 | 落点 |
| --- | --- | --- |
| V2-core A | 转换合同与引擎：迁移键、确定性子 ID、目标行校验、拓扑序、暂存库、查找集合、行处置 / chunk / 表 / 制品回执、`ConversionSink`（由 V3 实现）、trace；ContentRef 列 codec；测试 harness 与冻结原始行写入器；各领域包的桩文件与 bootstrap 装配；R1 / V1 的前置小改 | `platform/persistence/migration/conversion/`、`platform/content/contentRefCodec.ts`、`bootstrap/conversionRules.ts` |
| V2-core B | 173 张原样复用表的通用复制；归档、元数据、身份高水位与种子存在性；§4.7 对齐的 8 张表；222 表覆盖守卫 | `conversion/generic/`、`conversion/alignment/` |
| V2-T | Task 主体、定义、启动来源、工作区与挂载（§4.1、§4.2、§4.6 第 1–2 条、§4.7 的任务行） | `modules/task-execution/infrastructure/migration/task/` |
| V2-N | NodeRun 序号、frame 回填（承接 O2 删除的覆盖）、身份（调用 N 的推导）、oracle 选择、输入、checkpoint 与拆表（§4.3） | `modules/task-execution/infrastructure/migration/run/` |
| V2-C | 澄清逐题拆分、协作门操作、agent 引用关系化、工作流依赖索引、宿主占位删除、apply journal（§4.4 前两条、§4.1 第 6 条） | `modules/{collaboration,resource-catalog,intent}/infrastructure/migration/` |
| V2-X | 12 张内容引用表、内容发布、历史包与原 ID 索引、家族路由与 writer drain（§4.4 后三条、§4.5） | `platform/content/migration/`、`platform/persistence/migration/archives/` |
| V2-core C | 两侧端到端集成（含 227 形状与 89 个在途任务的组合），汇总 T18 账本条目 | `tests/` |

顺序：core A → core B ∥ V2-T ∥ V2-N ∥ V2-C ∥ V2-X → core C → V3。

模块相关规则不能放进 `platform/`：RFC-376 的 `platform-to-modules-file-pairs` 只降不升，design §12.1 也规定 platform 不 import modules。因此本节包表中 V2 一行的「主要落点：迁移区」改为三部分：引擎在迁移区；领域规则在各 owner 的 `infrastructure/migration/`；经 `composition/conversion.ts` 由 bootstrap 装配。N 包的「oracle 移入迁移区」相应落在 `modules/task-execution/infrastructure/migration/oracle/`。

开工前的裁定（2026-10-24）：

- 可执行口径由用户决定，见 migration §4 开头的补充。
- 聚合行输入按 §6.12 不反推（migration §4.3 的更正）；seq 按 RFC-374 启动规则回填（design §8 的更正）。
- 写者证据只能由多项持久事实共同证明：保留 id、冻结定义中没有同名节点、结构事实，以及可用的独立账本。仅凭节点名或 `rerun_cause` 不成立。
- 澄清答案与草稿表加 `occurrence`；detached 挂载的 `base_branch` 可为 NULL 或等于 `base_commit`；`requested_source` 无损记录请求事实。三项见 design §6.1、§4 的更正。
- 每个任务补一行 generation 0。FK 与行规则在 V3 装载时延后，激活前全量校验。测试用冻结的原始行写入器构造 epoch-1 数据，不用 A1 builder。

#### 休眠包与共享账本

休眠包（R1、R2、V1 及后续各包）不修改共享账本：`architecture/counts.json`、`architecture/guard-manifest.json`、provider 分叉、同文件孪生、T18 / T19d / T19f、RFC-376 基线，以及被审消费方清单。这些文件常被其他会话整文件提交，未提交的条目会指向不存在的文件。各包在报告中列出所需条目，由 T18 统一登记；休眠文件的「不可达」由 A 接线消解，不登记。

#### 进度

- R2：2026-10-23 开发完成（库形态，未接线；64 个用例待 T18 执行）。偏离有四条，均待激活包处理：
  - CLI 显式接收 registry；
  - 每表 DDL 辅助暂放在 `history/compiler.ts`，与 R1 的编译器在激活包合并；
  - PG 预期目录经注入的参照库 loader 取得；
  - PG 侧拒绝列重排，expand-only 判据从严。
- R1：2026-10-23 开发完成：目标 registry 共 236 张表，其中 178 张原样复用；两侧编译产物与机读目标清单齐备，未接线。功能审查后修复一轮，epoch-1 的四个摘要（显式合同、legacy v2、SQLite plan、PG plan）复核与 HEAD 逐字节相等。
- O：2026-10-23 开发完成，单独提交为 `5ffdbace7`（675 个路径）。CI 收口两笔：`00e355174` 把守卫与账本改指新结构，`407a7a943` 删除 provider 分叉账本的过期条目。另删除失去最后生产消费方的 `db/query.ts` 与 `services/agent.ts` 门面。启动期 frame 回填（M3）随 D5 删除，其测试意图由 V2 重建。
- V1：2026-10-23 开发完成。冻结的 epoch-1 共 222 张表（digest `sha256:3f8b275e…`），其中保留 178、转换 31、归档 13。功能审查发现两项阻断：v0.19.0 之前的 SQLite 版本不受支持，而转换器须支持全部已发布版本；三个架构守卫不认冻结文件。
- 2026-10-24 起并行开发三项：V1 修复轮；R1 / R2 第二轮修复（含 SQLite 重建表边遇到带表名限定的 CHECK 时失败）；N 的 K1 / K3 / K6 纯领域规则（`rs1` 槽位编码、旧行推导、铸行计算，均不接线）。
- 2026-10-24：上述三项完成，三包写完后整个后端 typecheck 无错误。
  - V1 修复轮：支持全部 261 个已发布 SQLite 前缀，含 v0.18.18 / v0.18.19 的备份；三个守卫识别冻结文件；删除 6.9 MB 的 `migrations.json`，改为按哈希校验原迁移文件。
  - R1 / R2 第二轮：epoch-1 的四个摘要不变。
  - N：只新增文件，未改已有文件。
- 2026-10-24：V2 分解与裁定完成（见上文「V2 分解」），V2-core A 开发中。
- 2026-10-24：V2 的 core A、core B 与四个领域包开发完成。随后按领域做了三次静态功能审查（只读代码，不执行），共发现 5 个阻断与 15 个主要问题，再分两阶段修复：先改 core 与 R1 / V1 的合同，再改三个领域包。修复后整个后端 typecheck 无错误；全部用例只编写、未执行，留待 T18。主要修复：
  - core：
    - 所属规则可按表、按列接管源 codec 失败（含冻结 NOT NULL 列里的 NULL），被接管的失败必须由规则逐行给出决议；
    - 可执行任务内，只有「既未被选中、也不被恢复读取」的 NULL nonce 行可记为 history-only，理由取自封闭清单；
    - 删除逐单元的全源复核，否则每个单元都要做一次全源摘要；
    - PostgreSQL 原始通道的布尔文本按值解码。
  - R1：澄清归属改为独立逐题关系，加 `attributions_recorded` 与 `legacy_answers_json`（见 design §6.1 的更正）；`requested_source` 落库为 v2。
  - V1：PostgreSQL 内容摘要改用单个有序游标，摘要字节不变。
  - 领域规则：
    - 平台生成的工作组 / 动态工作流宿主快照中的保留节点属于系统自身，不按「同名用户节点」冲突处理；
    - fanout 聚合节点由本任务的持久写者证据认定，不读当前 agent 配置；
    - D26 只认真正的目录引用位置，历史任务与载荷文本不阻止删除宿主占位；
    - D22 中旧 delivery 与 finding 不再判为未完成，经 adopt-mr 接管的工作项视为已移交；
    - writer drain 像 D3 一样复现启动时的 `activate()` 判定；
    - v0.19.2 技能文本去掉 BOM、却按原长度记 size 的已知缺陷按已知形状转换，不阻塞。
  - 待用户决定（V3 设计时提出）：没有接管途径、旧写者又已退役的未完成旧代码工作，按 design §9 会永久阻塞。拟在迁移运行中提供「操作者逐项显式确认」的输入，确认后归档并在回执中记录确认，不属于静默删除。
