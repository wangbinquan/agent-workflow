# RFC-357：任务列表页查询归一（一份查询，两个 provider）

- 状态：Draft（待批）
- 日期：2026-09-04
- 起因：用户报「切了 PostgreSQL，任务列表还是卡」
- 关联：RFC-311（SQLite 侧的同一课题，已完工）、RFC-349（PostgreSQL provider）、RFC-294 W4-E1 / §629 task-catalog 目标合同

## 1. 背景

`/tasks` 是本产品**被打开次数最多的一页**，也是 WS 每次任务状态迁移后会重取的一页。
它在 PostgreSQL 部署上慢——而慢的原因不是「PostgreSQL 比 SQLite 慢」，是**这一页在两个
provider 上是两份完全不同的实现，其中 PostgreSQL 那份从来没有过 RFC-311 的任何一项优化**。

### 1.1 现状对账（全部对着源码核过）

SQLite 走 `services/taskOperations.ts`（`sqliteTaskCatalogSources.ts:77`）：过滤 / 排序 /
分页 / facets 全部在 SQL 里，走 RFC-311 的 keyset 快路径（`taskOperations.ts:781-905`），
只为返回的一页付费。

PostgreSQL 走 `postgresqlTaskCatalogSources.ts`：把行**全部拉进内存再处理**。逐条：

| #   | 事实                                                                                                                                                                                  | 锚点                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 每个源各发一次 `listItems({ limit: 10_000 })`，条件字节相同、结果三选一                                                                                                               | `postgresqlTaskCatalogSources.ts:201-211` / `:274`；扇出在 `taskCatalogQueryService.ts:93-117`                                                                           |
| 2   | 那条查询是裸 `db.select().from(tasks)`——`SELECT *`，把 `workflow_snapshot`（整份工作流定义 JSON）/ `inputs` / `error_message` / `trigger_context_json` 一起搬过来，而列表项一个都不用 | `postgresqlTaskRouteOperations.ts:443-467`；列 `db/schema.ts:948`；实际消费面 `:394-424`                                                                                 |
| 3   | 失败任务逐行发一次 `SELECT … FROM node_runs`（N+1，且随 1 一起 ×3）                                                                                                                   | `postgresqlTaskRouteOperations.ts:285-300`、`:469-488`                                                                                                                   |
| 4   | 过滤 / 搜索 / 排序 / 分页 / facets 全在 JS 里做                                                                                                                                       | `postgresqlTaskCatalogSources.ts:216-256`                                                                                                                                |
| 5   | 物化列 `branch_started_at` / `root_task_id` 与它们的索引在 PostgreSQL 上**都在**，只是没人用                                                                                          | 索引 `db/postgresql-migrations/0000_rfc349_baseline.sql:4003,4006,4027`；维护点 `postgresqlTaskRouteLaunchOperations.ts` / `postgresqlTerminalMaintenancePersistence.ts` |

第 2 条多半是主导项：`services/task.ts:6615-6618` 的注释记着 RFC-311 audit L1-8 在 **SQLite**
上修掉的正是同一个形状——「`task: tasks` 拖着 workflow_snapshot / inputs / ref_closure_json /
trigger_context_json（每行**上百 KB**）」。PostgreSQL 适配器把它原样重新引入了一遍，还乘以 3。

### 1.2 分叉的代价不止性能

两份实现已经在**语义**上漂了，而且是用户能看见的：

- **facets**：PostgreSQL 侧把四个页签计数数在 view 过滤**之后**，换页签就把四个数字整体重写。
  已由 `bfc84968a` 单独修掉。
- **origin**：PostgreSQL 侧按 `scheduled_task_id` 猜启动来源，界面上的「事件」/「API」两个选项
  直接落到 `throw ValidationError` ⇒ 400。已由 `d7b2fab72` 单独修掉。
- **层级与排序**：PostgreSQL 侧把 `matchKind` 写死 `'self'`、`branchStartedAt` 写死
  `= startedAt`、`qualifying/matchingDescendantCount` 写死 `= childCount`
  （`postgresqlTaskCatalogSources.ts:127-135`）。于是同一份数据在两个 provider 上**排序不同**：
  PostgreSQL 上一个根任务的子执行刚跑完，这个根**不会**冒到列表顶部；SQLite 上会。
  「上下文祖先」行（`matchKind: 'context'`）在 PostgreSQL 上永远不出现。本 RFC 修这一条。

三条都不是「写错了一行」，是**同一页有两份实现**的必然产物：修一侧不会自动修另一侧，
而漂移的症状（少几条、顺序不对、某个筛选打不开）没人会第一时间当成 bug。

## 2. 目标

- **G1 一份实现**：任务列表页的过滤 / 搜索 / 排序 / 分页 / facets / 分支聚合只写一份，
  两个 provider 共用；`services/taskOperations.ts` 的 SQLite 专属裸 SQL 退役。
- **G2 O(页)**：PostgreSQL 上单次翻页只为返回的一页付费——不再有 `limit: 10_000`、
  不再有 `SELECT *`、不再有 N+1；十万任务库上首屏与翻页与 SQLite 同量级。
- **G3 每次查询都窄**：目录页对 task-execution 的三个源仍各发一次查询（每个源有自己的
  游标与 facets，这是 task-catalog 的既有合同），但**每次都是 subject 已下推、O(页) 的窄查询**，
  而不是三次条件字节相同的全量查询再各自在内存里挑三分之一。
- **G4 语义收敛**：PostgreSQL 取得与 SQLite 相同的分支聚合排序与层级语义
  （§1.2 第三条），两侧由同一份 oracle 钉住。
- **G5 真库证据**：新写的查询在**真 PostgreSQL** 上被 CI 每次执行并断言结果，
  而不是只断言渲染出来的 SQL 文本。
- **G6 前端不整段重取**：WS 帧到达时按帧增量更新已加载的页，而不是把整棵
  `['task-operations']` 缓存全部失效重取。

## 3. 非目标

- 不引入全文搜索（`LIKE` / `ILIKE` 语义保留，只做形状与大小写对齐）。
- 不改 `/api/task-catalog` 的 wire 契约（item / cursor / facets 形状逐字不变）。
- 不动 digital-employee 源（它自己的分页与 origin 处理已经正确）。
- 不做 RFC-294 W4-E1 的整体结构搬迁——本 RFC 只把**这一页**归位，其余 legacy 面照旧。
- 不碰安全（按 CLAUDE.md §工作准则 2026-08-26 硬规则）。

## 4. 用户故事

- 运维在装了几万条任务的 PostgreSQL 部署上打开 `/tasks`，首屏与翻页在一秒内出来；
  开着页面时后台任务状态一直在变，列表就地刷新而不闪、不回顶部。
- 同一份数据在 SQLite 与 PostgreSQL 两种部署上，`/tasks` 的**排序、页签计数、
  子任务展开、筛选结果逐条相同**——迁库不会让人觉得「列表变了」。
- 一个根任务的子执行刚刚跑完，这个根在 PostgreSQL 部署上也会冒到列表顶部。

## 5. 能力影响清单（CLAUDE.md §RFC workflow 第 7 条）

本 RFC **不关闭任何既有能力**，但有两处用户可见的行为变化，逐条呈报：

| #   | 变化                                                                                                     | 影响                                                     | 判定                                                 |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| C-1 | PostgreSQL 部署上 `/tasks` 的**排序**由「根任务自己的 `started_at`」改为「分支聚合 `branch_started_at`」 | 列表顺序会变；子执行活跃的根会上浮                       | **修正**（对齐 SQLite 既有语义与产品意图），不是收缩 |
| C-2 | PostgreSQL 部署上开始出现 `matchKind: 'context'` 的上下文祖先行                                          | 受限可见性用户会多看到「因为后代匹配而被带出来的祖先行」 | **补齐**既有设计，SQLite 侧一直如此                  |

`services/taskOperations.ts` 的删除是内部结构变化，无对外能力面。

## 6. 验收标准

> **落地状态（2026-09-04，四个 PR 全部推上 main）。** 逐条如实标注，未做的写「未做」，
> 不放宽措辞。提交链与过程记录见 `plan.md §6`。

- **AC-1**（G1）✅ `services/taskOperations.ts` 与 `postgresqlTaskCatalogSources.ts` 里的
  过滤 / 排序 / 分页 / facets 逻辑各自归零，两个源都只调同一个 page query builder；
  仓内不存在第二处「把 view / origin / subject / statuses / q 翻译成条件」的实现
  （由源码守卫钉死）。
- **AC-2**（G2）✅ PostgreSQL 路径上不再出现 `limit: 10_000`、`db.select().from(tasks)` 全列投影、
  以及逐行 `failedCode`；投影列表与 SQLite 侧逐字相同（守卫断言列清单）。
- **AC-3**（G2）十万任务基准❌ **未做**（原文见下）——：PostgreSQL 上首屏与第 N 页的查询计数与返回行数**与页大小成正比、
  与库大小无关**（断言查询条数与扫描行数上界，不断言墙钟时间）。
- **AC-4**（G3）🟡 **部分**——一次 `/api/task-catalog` 请求对 task-execution 产生**三次**列表查询
  （agent / workflow / workgroup 各一次，subject 谓词在 SQL 里），且三次的返回行数上界都是
  `limit + 1`；不存在两次条件相同的查询。
- **AC-5**（G4）✅ 新旧 oracle：同一批随机森林上，新实现与 RFC-311 既有穷举管线逐页 byte-equal
  （沿用 `rfc311-task-page-fastpath` 的对照手法），且**两个 provider 各跑一遍同一份 oracle**。
- **AC-6**（G5）✅ CI 有一条真 PostgreSQL lane 执行这一页的用例；lane 红则合并门红。
- **AC-7**（G5）✅ 方言差异清单（design.md §6）逐条有可执行断言，且「前提」侧
  （例如「SQLite 的 LIKE 确实大小写不敏感」）在 `bun:sqlite` 里可执行地钉住。
- **AC-8**（G6）🟡 **部分**——任务级 WS 帧到达时，已加载页按帧就地更新；`invalidateQueries` 只在
  帧不足以判定（重连对账、断线轮询、成员变更）时使用，且列表不空屏、不回顶部、
  不折叠已展开分支——由前端测试锁定。
- **AC-9** ✅ `/api/task-catalog` 的 wire 输出（items / cursor / facets）在两个 provider 上
  与本 RFC 之前的 SQLite 输出逐字相同（cursor 编码除外，若 §design 决定改版则另立断言）。
- **AC-10** ⏳ **待取证**——exact-SHA CI 全绿（含新 lane），取证 sha 与 run id 写回本文件。

### 6.1 逐条落地说明

- **AC-1**：守卫 `rfc357-narrow-projection`「the catalog source has exactly one implementation」
  ——两个 provider 文件不许出现 `normalizeItem` / `facets:` / `nextCursor` / `.filter(` / `.sort(`。
- **AC-2**：同一守卫钉 `TASK_LIST_COLUMNS` 列清单逐字相等且不含五个大列、`listRows` 真的用它、
  失败码走批量、infrastructure 下不存在 `limit: 10_000`。
- **AC-3 未做**：没有种十万级数据的规模档，因此「查询条数与返回行数上界与库大小无关」只有
  **形状**证据（`LIMIT limit + 1` ×3 + 无 10k + 无 N+1），没有**执行**证据。写在这里而不是把
  AC 改软：要补就在真库 lane 里加两档种子。
- **AC-4 部分**：`limit + 1` 上界与「无重复全量查询」由形状守卫覆盖；「一次请求恰好三次查询」
  没有计数断言。
- **AC-5**：`expectRfc357PageScenario` 被 SQLite 与真 PostgreSQL 各调一次，是同一个函数——
  对齐因此是结构性的。SQLite 那一遍另带一条空库反证（场景必须会红）。
- **AC-6**：`test-backend-postgresql` 已进 `CI required`，并有两道防「绿着骗人」（起跑前
  `select 1`；跑完 grep，真库用例一旦 skip 就 `::error::` 退出）。
- **AC-7**：九条前提逐条断言，含两条在 `bun:sqlite` 里可执行钉住的前提。清单在实现中被真库
  改写了两条，如实记在 `design.md §6` 的「实现后修订」里。
- **AC-8 部分**：按帧就地更新与三条 UX 不变量都由 `task-operations-sync.test.tsx` +
  `rfc357-task-list-frames.test.ts` 锁住；但**没有**按 design §9 原文去就地算 facets——
  理由见 `plan.md §6.4`，那是刻意的偏离，不是漏做。
- **AC-9**：wire 形状（items / cursor / facets）由 `rfc244-task-operations` /
  `rfc310-task-catalog*` / `rfc349-task-catalog-facets-ignore-view` 覆盖，断言一条未放宽。
- **AC-10 待取证**：`architecture/` 的 canonical 重采已在 `ca158aa7b` 补完（改用「在 HEAD 的
  只读导出上重采」的姿势，副本上 446 个架构用例全绿，见 `plan.md §6.5`）；还差一次含全部提交的
  exact-SHA CI 全绿作为终局证据。
