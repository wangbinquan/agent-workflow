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
- [ ] 独立功能设计门
- [ ] 用户批准生产实现

### 5.2 实现与运行（未开始）

- [ ] T1～T17 全部开发与测试用例编写完成
- [ ] AC-1～AC-10 逐项证据；D1～D12 删除清单逐项销账
- [ ] SQLite targeted / full evidence、PostgreSQL real-engine evidence 分别记录
- [ ] 用户完整旅程、性能、故障恢复、备份恢复及二进制证据
- [ ] 功能实现门 + 必需 hosted exact-SHA CI
- [ ] 真实实例 MigrationPlan、操作批准、切换回执和切换后验收

文档完成、设计获批、实现完成、真实搬迁、线上验收是五个不同状态。不得用本节第一组复选框将 RFC 置 Done。
