# RFC-395 实施计划与验收矩阵

## 1. 当前状态与前置门

- 本次交付：RFC 六份设计文档、217 表处置清单、RFC 索引与 STATE 登记。
- **状态：Draft**。用户批准的当前工作是调研与落档；未获得本 RFC 生产实现或真实数据操作批准。
- 独立 Codex 设计门尚未运行：当前会话无可调用 `openai-codex` review 工具；未创建独立 session 绕过仓库规则，也不把本会话静态自查标成设计门通过。
- 进入实施前记录功能设计门结论、用户批准、最新 source contract 与 RFC-394 等并发变更的已提交装配合同。
- 当前设计不预留实现中自行选择的缩减范围；若做不到某个终态，显式修订 RFC，不把未完成项换成永久 fallback。

## 2. 实施顺序

下表是开发依赖，不是分批功能验收。**先完成 T1～T17 全部生产实现、接线和测试用例编写，再集中执行 T18；发现本人缺陷后只复验受影响范围。** 不写一片表就反复跑全量测试 / 实现门，不把研究阶段的 schema 读取误当成实现已验证。

| 任务 | 完整交付 | 依赖 | 覆盖验收 |
| --- | --- | --- | --- |
| RFC-395-T1 | 固化 source fingerprint 支持列表、217 表 / 2,639 列逐项映射与当前读写者；每列明确 immutable / CAS mutable / derived；现有约束和 index 去向；收录本机差异源 fixture | 设计批准 | AC-1 |
| RFC-395-T2 | 领域 schema contribution 与显式 owner / codec / FK / CHECK / 索引 / retention，编译两种原生 DDL；保存最终 target contract digest | T1 | AC-1、6 |
| RFC-395-T3 | 原生 SQLite / PostgreSQL driver/query adapters、session/transaction/error contract；删除 SQLite proxy 类型伪装与 SQL 修补；统一业务 ports | T2 | AC-6 |
| RFC-395-T4 | Task core / definition / launch / termination / workspace 拆分；Agent / Workgroup launch 删除假 host；所有入口与子任务接线，API 兼容投影 | T2、3 | AC-2、9 |
| RFC-395-T5 | 仓库挂载与 per-run checkpoint，目录树旧数据离线物化；单仓/多仓 rollback / merge / prepare / prune 接线 | T4 | AC-2、7 |
| RFC-395-T6 | NodeRun role / generation / selected / provenance；冻结 config、运行态与结果；所有 mint / retry / resume / supersession / fanout / review / child continuation 读写转换 | T3、4、5 | AC-3 |
| RFC-395-T7 | 澄清答案/草稿/归属按问题存储；编辑 / 封口 / abandoned / 代理答复 / UI map 投影全部接线 | T3、6 | AC-4、9 |
| RFC-395-T8 | Agent 四类关系、Workflow dependency index 与 import/export/name-selector 边界；包 / Intent mutation participants 共用 | T3 | AC-4 |
| RFC-395-T9 | 内容引用 / bytes 后端 / publication 中立化；技能 tree、prompt、输出、文档、评论、托管归档、开发与 Employee 制品、备份恢复全接线 | T3 | AC-5、7 |
| RFC-395-T10 | AtomicApply 共用状态机，Intent / bundle / 既有相关恢复场景统一；原幂等域与回执保持；不合并 effect journals | T8、9 | AC-5、8 |
| RFC-395-T11 | 未改形状的表迁入各 owner contribution / 原生适配；移除跨域 schema 访问；事件、观测、identity、OS、development 等既有行为不缩减 | T2、3 | AC-1、6 |
| RFC-395-T12 | versioned source readers、确定性 transformer、row disposition、legacy evidence/history reader；旧 code work 历史、writer drain 退出；保留当前事件家族路由 | T4～11 | AC-1、3、8 |
| RFC-395-T13 | 迁移 run/chunk/receipt 与现有 logical-copy / generation 元数据整合；新 baseline、source/target schema admission、旧 binary 拒绝协议 | T2、12 | AC-6、7 |
| RFC-395-T14 | maintenance/quiesce、备份、水位、活动恢复、独立目标库、activation、首写边界、错误恢复与操作报告；现有 CLI/托管部署入口接线 | T9、12、13 | AC-7、9 |
| RFC-395-T15 | API、WebSocket、任务目录、history、导出、归档、浏览器草稿引用的兼容；用户完整旅程；如需新界面先审原型 | T4～14 | AC-9 |
| RFC-395-T16 | 删除清单 D1～D12 全部销账；旧 codec 仅迁移/历史可达；结构守卫按原意重定向；架构清单与必要计数更新，不提高债务基线掩盖遗漏 | T4～15 | AC-8 |
| RFC-395-T17 | 完成下述全部单元 / 双 provider / 迁移 / fault / 用户旅程 / 二进制测试编写；操作手册与真实演练模板 | T1～16 | AC-1～10 |
| RFC-395-T18 | 集中验证；功能实现门；exact-SHA hosted CI；逐项记录差异和真实引擎证据 | T1～17 完整 | AC-1～10 |
| RFC-395-T19 | 基于通过的完整候选，对真实实例只读预检并生成 reviewable MigrationPlan；取得该次切换批准后备份 / 搬迁 / 验收 | T18 + 实例操作批准 | AC-7、9、10 |

T1 输出是实现细化，不能推翻本文的领域边界、兼容承诺或迁移方式。新发现的模糊来源 / 功能收缩必须返回设计审批，不能靠 `default` / 空数组过关。

## 3. 必写测试矩阵

| 面 | 正向与边界用例 | 旧写法反例 / 失败用例 |
| --- | --- | --- |
| schema / codec | 两 provider 生成一致合同；整数/时间边界、Unicode、JSON null、空值、bytea/BLOB、unique-null、排序 | 漏 owner/codec、错误 jsonb 原文转换、bigint 截断、未生效 CHECK、弱化 FK |
| Task 主体 | Agent / Workflow / Workgroup、child launch、固定 snapshot、已删除 source 历史 | 仍创建 host 行；从当前资源补历史配置；重复主仓权威 |
| 工作区 | 一仓/多仓/internal/inherited/detached/unborn、只读挂载、submodule、显式空目录 | 227 branch 差异形状；缺 map 当 root；repo reorder 改身份；缺文件丢失 |
| NodeRun | 同毫秒/多进程 mint、负 seq、allocator 高水位、role、task synthetic、container、retry、review、loop、fanout shard 集合、selected anchor 删除、child continuation | `max(seq)+1`、ID 新鲜度、把 parent 当容器、简单 MAX 丢 supersession 语义、当前 producer 冒充实际消费 |
| 协作 | 同题 revision 冲突、不同题并发成功、草稿恢复、attribution、部分提交、封口、abandoned | 整 map 覆盖导致答案丢失；封口后继续写；未知 question key 静默丢弃 |
| 资源 | 四类关系顺序、传递依赖、Workflow ID/name selector、资源 rename / delete / 同名创建、包跨实例 import/export | name/ID 混用；索引与定义 revision 不一致；解析缓存取代动态 selector；重复依赖改变顺序 |
| 内容 | inline/文件/DB/object、BOM、非法 UTF-8、空 bytes、版本/目录/staging/trash、归档、备份恢复 | base64 解码变 bytes；JSON stringify 改 digest；发布未 ready 就引用；仍被备份持有却释放 |
| AtomicApply | prepared / applying 崩溃、幂等重复请求、失败重试、领域提交同事务、artifact 恢复 | 两条状态机分叉；重试事务重复外部 effect；同幂等键不同 payload 被忽略 |
| 其他保留表 | commit event 顺序/投递、event 去重/订阅、Case/Reaction/Task 关系、开发配置与 OS 共存、观测费用独立保留 | 合并事件导致重放；Task 删除级联费用；旧命名配置被误删 |
| 源识别 | 当前合同、无 seq 源、本机差异合同、非空 PG 源、已有跨 provider 路径 | journal 行数冒充版本；未知表/列悄悄忽略；不支持版本直接写目标 |
| 转换恢复 | chunk 中断重启、row disposition 守恒、source 不变、ID 高水位、历史可查 | receipt 响应丢失重复插入；source 变化仍复用 checkpoint；行数相等但链接错 |
| 活动恢复 | awaitHuman / awaitReview / interrupted、进行中的 effect/Apply/delivery、lease 重接管 | 自动取消任务；复制旧 owner 当新存活；重复外部效果；ACK 后丢 ingress |
| 激活 / 回退 | 每个阶段 crash、配置切换未开 admission、切换前撤回、首写后前滚 / 目标恢复 | 两套 active generation；部分 Worker 留旧库；首写后直接退源造成丢事实 |
| 完整产品旅程 | 启动 → 执行 → 人工门 → 恢复 → 完成 → retry/rollback → 历史/导出；single/hosted 与双 provider | 只看新建空库；历史链接断；浏览器草稿被清空 |
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
- [ ] AC-1～AC-10 逐项证据；D1～D12 删除清单逐项销账
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
| II-0 | 本会话修订设计：§6.4 缺口逐条裁决，写回 design / migration / table-mapping | 文档 |
| II | T2b、T4～T17：目标模型造数 builder 与 codemod、领域重建、转换器、回执与切换、兼容投影、删除清单 | 全部开发与用例写完后集中验证（T18），一次激活交付 |
| III | T19：每个真实实例只读预检 → MigrationPlan → 用户批准 → 备份、搬迁、验收 | 逐实例批准 |

阶段 I 在现有物理 schema 上完成，现有双引擎测试即等价判据，不产生 schema epoch，符合本 plan §4「前置提交不激活新合同」。

### 6.3 阶段 I 的 Codex 工作包

| 包 | 内容 | 验收 |
| --- | --- | --- |
| I-a | `platform/persistence/schema/`（contribution DSL、codec 目录、表达式 AST、registry、合同 / SQLite plan / PostgreSQL plan 编译器、drizzle 物化）；各模块 `infrastructure/persistence` 的 contribution；`bootstrap/persistenceSchema.ts` 唯一汇集；platform 内对合同的默认值调用改为注入；冻结的 legacy v2 投影 | 四条机械证明：legacy v2 合同 digest 相等（不能逐字节时规范化相等并注明）；PostgreSQL plan 逐条相等且真引擎 catalog 相等；SQLite 编译 DDL 与迁移 replay 的差异等于已审账本；两套 drizzle 表投影逐列相等；负例 |
| I-b1 | S0～S2：PostgreSQL 表固化为显式表；中立类型改名；清除 SQLite 专属终端与原始执行并加守卫 | 现有双引擎测试全绿；守卫负例 |
| I-b2 | S3～S5：会话提供表集、删除进程级投影与切换调用；PostgreSQL 改原生 bun-sql 会话、写闸只做语句分类；业务 SQL 不再依赖 PostgreSQL 同名函数 | 同上；PostgreSQL 客户端行为合同测试保持；性能对拍 |

I-b1 与 I-b2 在开发上前后衔接，作为一次交付集中验证。

### 6.4 阶段 II 实施前须修订的设计缺口

1. 宿主 workflow 共 4 个（另有数字员工宿主 `00000000000000DIGEMPHOST0`），`subject_kind` 缺数字员工与 code-round；宿主行被评审 join、
   内置布局、workflowName、记忆 scope、闭包 / intent 哈希隐性依赖。
2. 旧行形状已写进持久化 JSON（人工门续跑 payload、澄清 / 评审开门 manifest），新库需 v1 解码，否则迁移前等待人工的任务恢复后被拒。
3. 「当前选中哪次运行」约 77 处各自计算（9 种槽位键、5 种排序），先立统一选择端口，再拆表。
4. 拆表后变成多表 CAS：任务生命周期 CAS（状态 + prune 认领 + fence 同句）、node_run 状态 CAS、merge-state CAS。
5. 子任务树删除依赖 `tasks.parent_task_id` 的级联；移到 `task_launch_contexts` 会改变删除语义。
6. 「主仓 = ordinal 0 投影」的例外：延后准备的占位任务无挂载；`tasks.worktree_path` 兼作「未绑定」标记并参与 CAS；无 `task_repos`
   时合成 `repos[]` 的回落。
7. D 清单补项：`pre_snapshot` 自 RFC-130 起无新写入、`pre_snapshot_repos_json` 无写入点；启动期 seq 与 frame 回填。
8. `envelope_nonce` 在每行铸造时生成，与「运行态只给需要的角色建行」冲突。
9. design 内部待定：`merge_state` 归属（§4 与 §5.3）；`isolation_root_ref` 与 `iso_worktree_path` 重叠；per-repo map 的键是
   `worktree_dir_name`；快照四态；脑图下问题快照会被改写；consumed 记录只到源节点粒度；`review_iteration` 兼作并发令牌；
   `operation_generation` 与 `generation_seq` 两轴。
10. 前端严格解析：投影须精确；Agent / Workgroup 任务的 `Task.workflowId`；`NodeRun.seq` 非空与 `nodeRunOrder` 兜底退出；
    `worktreeDirName` / `repoCount` 是否保留投影；`parentNodeRunId` 保持「历史 parent」含义。
11. 迁移机制待决：新 epoch 后 SQLite 的演进机制；行处置粒度与存放；SQLite 目标文件位置与 pointer v2；provider 差异的目标裁决
    （7 trigger、8 FK、`tasks.name`、partial 与 full unique）；种子行 contribution；跨 epoch 备份恢复；`migrationRole` 退役。
12. 疑似现存缺陷：只有一个非根成员的仓库组任务，`isoNodeTree` 可能存为 NULL（崩溃重放报 node_tree missing）；先复现，属实则单独修复。
13. 先删 test-only 与死代码（`startTask`、`getTaskNodeRuns`、`systemWorkspaceGc` 的 DB 函数、intent 引擎 converge、
    `services/bundle/provider.ts`、无调用方的 `decideIntentApplyConverge`）可缩小 T4～T6 与 T10 的改动面。

### 6.5 并发约束

RFC-396 正在工作树中实施，改动 `db/schema.ts`、SQLite 迁移链与 `platform/persistence/schemaContract.ts` 等；阶段 I 重写的正是这些文件。
阶段 I 的代码实施在 RFC-396 的持久化改动提交后开始；之后新增的表须同时提供 contribution（I-a 的结构锁会要求）。
用户 2026-10-21 选择由接手会话协调：本会话不向其他会话发消息，以工作树中 `db/**`、`platform/persistence/**` 的提交状态为准，
在此之前只做 II-0 设计修订。
