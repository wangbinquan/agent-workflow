# RFC-602 技术设计

## 1. 层次与共同约束

已阅读 RFC-294 proposal §1/§3 与 design 的层次、public surface、query、Resource Catalog、provider 约束。业务选择与游标解释归 owning application，SQL/内容读取归 owning infrastructure；composition 和 bootstrap 只装配/显式初始化。跨域保持既有 exact public 合同。不开第二套服务层、通用 repository 或进程全局缓存。

## 2. 历史查询

### 2.1 原始事实与派生投影

保留 code_history_archives、code_history_id_index 及 code-history@1 原 bytes。新增 code-capability 拥有的查询构建状态、record 点读投影、work item/round/stage/attempt/delivery 类型化投影，以及 metrics 累计计数。每个构建明确来源 generation/contract、归档元数据摘要和投影版本；派生数据按构建 ID 隔离，完整构建后原子发布。旧 ready 构建不被半成品覆盖。

原包在首次升级/显式构建时读取和解码一次，以有界批次写派生行。构建校验行数、原 record 身份与查询所需字段；失败不发布，重试清理或接续本构建，不更改原归档。启动初始化在提供历史查询前完成所需构建；不在 HTTP GET 内构建或回退全表读取。失败保留明确诊断并允许后续重试，不伪报空历史。fresh install 保持空历史。

完整包的 digest/格式/缺失诊断发生在首次构建、显式重建及元数据变化后的初始化。正常 GET 核对来源/归档元数据、ready 状态及所取派生记录，不再逐次重新校验完整原包。因此外部只修改包字节但未改变声明元数据的损坏，需要显式重建时发现；不能同时承诺零整包读取和每 GET 全包字节校验。既有完整包损坏用例迁至明确的构建/重建边界，原错误码与失败诊断保持。

强制重建入口固定为 `agent-workflow db rebuild-code-history-index [--json]`：main 的 db 分派交给薄 CLI，再由 bootstrap 打开当前配置选定的 SQLite/PostgreSQL generation 与 ContentStore，调用 code-capability 同一 owner 构建器的 force 模式并关闭句柄。沿用数据库维护命令的 daemon lock 使用规则，服务运行中提示先停止服务，不并行修改构建。失败退出非零并保留原错误码/表诊断；修复来源后重跑该命令。正常启动自动重试缺失/未 ready 构建。force 失败不能用旧 ready 冒充本轮重建成功，旧已发布数据仍不被半成品覆盖。用例经真实命令操作入口验证失败、修复、重试。

### 2.2 查询算法

- work items：endpoint/project/capability 筛选下推，保留 created_at/id 降序 keyset。构建时保存 roundCount 与稳定 round rank；只读页内 work items、其被选择的 rounds 以及这些 rounds 的 stages。
- attempts：按 round 索引读取并保持 started_at/rerun_seq/attempt_seq 原排序，同键使用原 ordinal 保持稳定次序，输出上限不变。
- deliveries：project/correlation/failed 查询走相应索引。原本完整返回的 correlation/负 limit 仍完整，按批获取匹配集，不加载无关行。
- metrics：构建按 capability 与精确毫秒时间保存累计计数；since 边界索引 seek 后差分，保留 >= since、四桶、outcome 优先级与 join 语义；不在请求中重新扫描原历史行。
- find：派生 record 具有独立的 build/source/table/originalId 点读索引；结合旧 ID 索引核对 archive/ordinal、原 key 和目标身份，保留 canonical/raw 值及索引错误检查。旧索引缺项但派生原事实存在时仍报 code-history-index-invalid，只有事实也缺失才返回 null；不靠全包扫描判断。
- ready 核对只读取元数据，不选择 content_inline_bytes；重新装配/冷进程查询不依赖暖缓存。索引未就绪/来源变化明确拒绝，不能假空或隐式全量回退。

### 2.3 存储与升级

新增十张表及索引归 code-capability 的 history schema owner；遵循现有每条 add-table edge 只增加一张表的合同，追加十条 epoch-2 additive schema-history edge，使用现有生成器生成 SQLite/PG17 资产。旧历史 fixture/oracle 条目保持冻结。对新表追加独立升级种子与 mapping oracle 条目，覆盖旧 epoch-2 数据库升级、重放和重建。所有 schema 定义完成后统一生成资产。

## 3. 精确资源摘要

内部 ResourceCatalogSummaryReadPort 增加 readOne(actor, ref)。getVisibleResourceSummary 直接委托。基础设施复用六类既有 SELECT/摘要转换，增加精确 ID 条件并 limit 1。保留目录条件和 workflowCatalogPredicate、全部 revision 形态、缺失 null、坏目标行错误；无关坏行不影响点读。

public query、列表分页/游标与装配形状不变，无 schema 变化。目前没有生产调用方使用 getVisibleSummary，不能宣称全量 selector/dump 已因此加速。

## 4. 仓库组按需读取

拆分图、轻量全局索引和辅助引用事实：

| 用例            | 读取范围                                                          |
| --------------- | ----------------------------------------------------------------- |
| layout / launch | 指定根的后代闭包及引用仓库                                        |
| preview         | 草稿 child roots 的后代闭包、直接引用 repo IDs；零导入/写入       |
| get             | 指定闭包与目标组 memory count                                     |
| currentGroup    | 目标 id/version 单行                                              |
| create          | 全局 id/name/version 轻索引、草稿引用闭包                         |
| update          | 目标全部祖先及祖先全部后代，加新草稿 roots；另保留全局版本集合    |
| delete          | 目标、直接引用组、相关 enabled schedules 和轻版本集合             |
| list            | 完整输出所需全部组/节点、引用仓库与 memory counts；不读 schedules |

SQLite/PostgreSQL 共用递归 CTE，ID 集合用 UNION 去重避免 SQL 环；原 flattenRepoGroup 继续决定循环、深度、挂载冲突、展开数量与错误细节。update 保留祖先兄弟分支验证，事务内全局图锁和 expectedGraphVersions 集合比较不变，防止遗漏新祖先等现有 OCC 行为。

完整 list 与全局 OCC 轻索引本身随组数增长，这是完整输出/现有并发合同的必要成本；不再因此装载全库节点、仓库、记忆和 schedules。计划任务候选过滤减少传回数据，不宣称无引用索引的 payload 扫描是常数成本。

## 5. 完整子任务分页

新增 task-execution 窄查询与 GET /api/tasks/:id/children：返回版本化 {schemaVersion:1, parentTaskId, items:[{id,status}], nextCursor}。旧 /api/tasks 的数组合同保持。接口复用既有路由任务可见性与列表谓词；直接子任务条件、public catalog 条件下推。默认页 100、最大 200，按 started_at/id 降序，游标含版本、parent ID、请求者口径与边界；不合规格先拒绝。数据库复用现有 idx_tasks_list_parent_started_id，最多取 limit+1 行，不做 descendant graph/owner 富化。

application 定义查询/读取端口与游标规则，infrastructure 实现窄 SQL，providerRuntime 装配 query，daemonHttpComposition 注入 taskRoutes；不向旧 TaskRouteOperations 大接口增加方法。

useTaskChildren 保留 ['tasks','children',parentId]、enabled、父/子活跃轮询与 WS 失效。queryFn 使用同一 AbortSignal 顺序消费到 nextCursor=null，一轮全部成功后才发布完整数组，不设总数 500 上限。续页失败保留上一轮完整结果和 error；首轮失败不发布部分数组。相同父的消费者共用整个分页链；末页不再请求；重复游标报错避免无穷循环。每项只消费 id/status，ChildTaskLink 与画布判定不需要完整 TaskListItem。

刷新时旧完整数组可能仍存在，所以两个消费者均把 isFetching 视作本轮尚未完成：ChildTaskLink 只有非 error、非 fetching 且完整 data 中缺失时才显示不可用；callNavIsReachable 显式接收 fetching/未完成状态并采用相同规则。补真实组件用例：旧完整空数组之后刷新第二页挂起，新 childTaskId 保持可点击，直到本轮全部完成才能作缺失结论。

分页是一轮实时读取，不承诺跨 HTTP 请求数据库快照；后续创建/状态变化由既有 WS 和轮询重新完整读取。大结果总体成本与子任务数相关，每页查询/响应固定有界。

## 6. 验证与门

全部生产实现、接线、schema 资产和用例编写完成后集中执行。设计门/实现门只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

- 历史：真实旧库转换/升级后四 HTTP 响应 parity、点读 raw/canonical；构建幂等/中断/来源变化；重新创建 reader 后禁止整包读取；稀疏过滤与大小历史的取回行预算、metrics 独立逐行预言、精确时间边界。
- 摘要：六类 revision 全字段对拍，>500 背景行的命中/缺失一 SELECT 且最多一行，错 kind、坏目标/无关坏行、宿主 workflow；原分页回归。
- 仓库组：九入口功能、菱形/环/纯目录/深度/数量、preview 零效果、祖先兄弟冲突与 OCC、强制删除/完整列表；扩张无关图不增加目标读量，启动冻结结果保持。
- 子任务：双库 0/1/100/101/500/501/1201、同时间戳、混合种类、仅直接子/不相关父、游标/limit；SQL 预算和索引计划；真实 hook/组件跨500导航、分页中途失败/恢复、取消、共享、失效、父切换、重复游标。
- 相关回归与 schema replay/upgrade/PG catalog、测试枚举策略、前后端类型/静态检查、精确路径功能实现门及 exact-SHA CI。
