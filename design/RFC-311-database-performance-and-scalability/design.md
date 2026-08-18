# RFC-311:数据库性能治理与十万级列表渲染(design)

> 读法:病灶清单与全部 `file:line` 证据在 `audit-2026-08-18.md`(下称"证据档",编号 L1-x/L2-x/L3-x)。
> 本文只写"改成什么样、为什么这样改、怎么测"。

## 1. RFC-294 架构对齐

- 本 RFC 是**横切性能修复 + 数据治理**,不新增业务能力、不新增跨模块耦合:
  - 查询形状修复(投影/count/聚合/分批)全部**就地修**存量文件(`services/` 平铺层与 `modules/` 内部),
    不做目录搬迁——搬迁属 RFC-294 各演进波次,与性能修复捆绑只会放大冲突面;
  - 新增组件按 294 语义落位:连接 PRAGMA/慢查询计时 → `db/`(platform·persistence 现实位置);
    事件字节水位/三胞胎 TTL → 各表 owner 的既有 GC 文件就地扩展;**任务归档器**(新文件
    `services/taskArchive.ts`)语义上属 task-execution 生命周期 + system-operations 编排,现实落
    `services/` 平铺并只依赖既有 `taskDelete` 级联与 `db` 客户端;备份子进程化在
    `services/backup*.ts` 内部改;定时装配沿用 `cli/start.ts` + `services/daemonCadence.ts`(bootstrap 现实位置)。
- **偏离项呈报**(按 CLAUDE.md §RFC workflow 第 8 条):
  - D-1 不迁移触及文件到目标 bounded context 目录(理由:改动面已横跨 40+ 文件,捆绑搬迁会让
    oracle 等价验证失去"只有查询形状变了"的前提);
  - D-2 新周期任务(归档 sweeper、备份 prune、checkpoint loop)注册进现有 `start.ts` 装配点而非
    模块 bootstrap(理由:该装配点尚未按 294 拆分,先到先用,随所属域的 294 波次一起迁)。

## 2. 修复组 A:常驻轮询 count 化(证据档 L1)

**原则**:徽章/计数端点只允许 `SELECT count(*)`(或少量索引化 count)+ 必要 JOIN,禁止"列表物化后
`.length`"。每处改写以**现实现为 oracle**:新查询在随机 fixture 上与旧实现结果逐值相等,测试锁定。

| 端点 | 现状 | 目标形状 |
|---|---|---|
| `/api/reviews/pending-count` | L1-1/L1-2:三张全表全列 + JS 过滤 | 一条 `count(*)`:doc_versions(decision='pending',走新 partial 索引)⋈ node_runs ⋈ tasks(排除终态)+ 非 admin 的可见性半连接(见下"批量可见性") |
| `/api/clarify/pending-count` | L1-3/L1-4 | `count(*)`:clarify_rounds(status='awaiting_human',走既有 `idx_clarify_rounds_kind_status`)⋈ tasks 排除终态 + 可见性半连接 |
| workgroup 徽章 | L1-5 | assignments/成员资格一次 `IN (taskIds)` 批查 + `count(*)`;workgroupConfigJson 的 memberIds 用 SQL `json_extract` |
| `/api/overview` 9 计数 | L1-6/L1-7 | 每类一条 `count(*)`(可见性语义 = `filterVisibleRows` 的 EXISTS 等价形;既有 oracle 测试 `countCachedRepos == listCachedRepos().length` 模式推广到全部 9 项);done7d/failed7d 走新索引 `(status, finished_at)` |
| `listClarifyRoundSummaries` 主列表 | L1-3/L1-4 | 过滤/排序/limit 全下推(WHERE 走既有索引 + `ORDER BY created_at DESC, id DESC LIMIT ?`;`id` 二级键沿 tokenAudit 先例保证同毫秒稳定);两个 helper 改 `WHERE id IN (…)` + 窄投影 |

**批量可见性原语**:新增 `taskCollab` 的批量版 `visibleTaskIdsOf(actor, taskIds): Set<string>`
(一条 `IN` + owner 判定),替换 L1-10 三处逐任务 `canViewTask` 循环;room.ts/reviews/clarify/webhookDeliveries 共用。

## 3. 修复组 B:窄投影(证据档 L1-8/9、L2-2/3/4/5/9、L3-10)

**原则**:凡消费方可枚举字段的查询,一律显式列投影;**wire 形状不变**(投影只影响 DB→JS 边界)。
逐处列清单(实现时以 `rg` 复核消费点,DTO 字节等价测试锁定):

- `services/task.ts:5688` listTasks:投影 rowToSummary 实际消费的 ~20 标量列;`workgroup_name` 用
  SQL `json_extract(workgroup_config_json,'$.workgroupName')` 取代整列拉取。
- `services/limits.ts:35`:投影 `{id, status, maxDurationMs, maxTotalTokens, runningMs, runningSince}`;
  `SUM(tok_total)` 只对设了 `maxTotalTokens` 的任务执行,并降频至每 10 tick。
- `services/task.ts:5851` getTaskNodeRuns:投影映射消费列(排除 prompt_text 与全部 iso/inventory JSON);
  `:6017` outputs 列表改回 `length(content)` + 首 4KB 预览,大内容走既有 port-artifacts 详情端点懒加载
  (前端 diff/端口面板同步改懒加载;**wire 有形状变化,但仅限该内部端点,前端同 PR 改造**)。
- `routes/tasks.ts:1214` visibility 中间件:投影 `{id, owner_user_id, status}` 并把行挂 context 供 handler 复用。
- `services/scheduler.ts:1876` 与 `services/taskQuestionDispatch.ts:865`(及同文件三处同型)、
  `modules/task-execution/application/branchTrace.ts:80`、`resolveNodeActivation.ts:93`、`services/task.ts:4297`:
  统一投影 frontier 消费列 `{id,nodeId,status,iteration,retryIndex,parentNodeRunId,shardKey,mergeState,…}`。
- `services/gc.ts:343`、`services/worktreeBackup.ts:100`、`services/memoryInject.ts:415`、
  `services/clarify/autoDispatch.ts:170`:各自窄投影。
- `services/fusion.ts`:列表/角标只读不 reconcile(交给既有 60s loop);列表 SQL 排序 + LIMIT。

## 4. 修复组 C:`/api/tasks/page` O(页) 重构(证据档 L2-1)

这是最复杂的一处。现实现每页全量物化的根因是**排序键 `branch_started_at` 是树聚合值**(分支内最新
started_at),无法直接用行级索引取页。设计:

1. **新增物化列 `tasks.branch_started_at`**(所有行都维护"以我为根的子树 max(started_at)";列表只消费
   root 行的值)+ 索引 `(branch_started_at DESC, id DESC)`。
   - 维护点:任务创建/启动时,沿 `parent_task_id` 链向上 `UPDATE … SET branch_started_at = max(branch_started_at, ?)`
     (链长受 `MAX_TREE_DEPTH=64 约束`,每次启动最多 64 行单行 UPDATE,与现有写量相比可忽略);
     迁移一次性回填(自底向上聚合)。
   - 该列是**纯派生缓存**:invariants 扫描加一条校验规则,漂移即修复(自愈,不作为真值源)。
2. **查询改两段**:
   - 段一(取页):按 `(branch_started_at, id)` keyset 直接取 root 候选页(root 定义不变:无父或父不可见)
     + view/scope/subject/origin 谓词下推。无搜索词时这一步是纯索引 range scan。
   - 段二(富化,仅页内 ≤limit 行):alert 计数、workgroup_name json_extract、qualifying_child_count、
     matching_descendant_count、树上下文——全部只对页内 root 的子树计算(递归 CTE 保留但作用域从
     全库缩为 ≤50 棵子树)。
   - 搜索词(q)路径:LIKE 过滤仍需扫可见集,但只在有 q 时发生且不再拖全量富化;"祖先不匹配但后代
     匹配"的 context-match 语义保持(qualified_walk 只对匹配行向上走,匹配集通常远小于全表)。
3. **facets** 拆为独立轻查询(4 条索引化 count),服务端 30s 内存缓存(按 filterFingerprint 键控,
   任一任务状态写事务后失效);首屏与翻页不再重复付费。
4. 排序键、cursor 封套、wire 形状全部不变(cursor 仍编码 `branchStartedAt+taskId+fingerprint`)。
   等价性:随机树 fixture 上新旧实现整页序列逐字节对比(含 context-match/子树计数/翻页边界)。

## 5. 修复组 D:周期任务与写路径(证据档 L3)

- **事件归档器**(L3-3/4,修死循环 + 有界化):
  - 删除改**区间删**:`DELETE FROM node_run_events WHERE node_run_id=? AND id<=?`(走 `idx_events_node`,
    零绑定参数),单轮批量封顶(默认 5,000 行/批,批间让出事件循环),多轮推进;
  - 全表 GROUP BY/COUNT 改**高水位增量**:meta 表记录上次扫描的 `max(id)` 水位,per-run 分组只对
    水位之后的增量行做,全局总数用"上次总数 + 新增 - 已删"递推(冷启动回填一次);
  - 归档后执行 `PRAGMA wal_checkpoint(TRUNCATE)`(挂在既有 checkpoint 循环节拍上,不在删除事务内)。
- **字节水位**(L4,用户拍板保守档):新增 `eventsArchiveThresholds.globalBytes`(默认 256MB)与
  `perNodeRunBytes`(默认 8MB)。字节估算 = 最近 1,000 行 `AVG(LENGTH(payload))` 采样 × 行数
  (零写放大、单次 O(1000)),折算出有效行数阈值后与行数阈值取 min,复用同一归档管线。
- **stuck 检测**(L3-5):`max(nodeRunEvents.ts)` 改 `ORDER BY id DESC LIMIT 1`(id 自增与 ts 单调同序,
  `idx_events_node` 反向 seek O(logN));S5 分支同改。语义差异(乱序写入)不存在——事件 id 即写入序。
- **orphan/autoKill/orphans/pluginGenerationGc**(L3-6/7/8):共用新 partial 索引
  `node_runs(status, started_at) WHERE status IN ('pending','running')`。
- **lifecycleInvariants**(L3-9,修参数上限坏死):所有 `inArray` 一律 ≤500 一块分批(仓内通用
  helper `chunkedInArray`,同时治 L3-10 gc 的孤儿 inArray);boot `{all:true}` 的七条规则改按规则
  集合 JOIN(每规则一条查询,不再每任务 7 次);workflow_snapshot 只对确需形状的任务按需加载;
  reconcile 写入包单事务。
- **备份**(L3-1/2):`VACUUM INTO` 移入**子进程**——daemon spawn 自身 CLI(`agent-workflow backup`,
  已存在 `cli/backup.ts`)执行,主进程只登记状态与产物;完成后主进程做一次 checkpoint(吸收备份长读
  造成的 WAL 增量)。`pruneBackups` 从"只挂定时备份 tick"改为 boot + hourly 独立执行;pre-migration/
  manual 各加数量上限(默认 10,可配,0=不清理)。`ensureCredentialsSealed`(L3-15)加 meta 表
  "已完成"闸门,幂等迁移只跑一次。
- **taskDelete**(L3-16):大表(node_run_events/node_run_outputs)先按 nodeRunId 区间分批删,
  最后单事务删 task 行走级联;归档器(§7)复用同一实现。
- **runner 写入**(L3-17):stdout/stderr 行按 50ms 窗口攒批,单事务 `values(rows)` 批量 INSERT
  (抄 `runtime/opencode/sessionCapture.ts:345` 姿势);WS 转发时机不变(先广播后落库的既有顺序保持)。
- **mrTerminalControlWorker**(L3-11):候选查询改 `status IN (…活跃枚举)` + LIMIT;older-check 合并为
  一次 `GROUP BY` 预查。
- **RFC-310 wake/attempts/effects/claims**(L3-12/13)与 **code-capability**(L3-14)、
  **fusion boot**(L3-20)、**agent 删除守卫**(L3-21)、**codeCapabilitySupersede**(L3-22):
  按证据档 §6 索引清单补索引;dataLifetimeGc 的逐行 DELETE 改单条 `inArray` 批 + 事务。
- **subagentLiveCapture**(L3-18):读 opencode 库改按 `(sessionID, part id)` 游标增量,不再每 1.5s
  全量重读。
- **scheduledTaskScheduler**(L3-19):config.json 按 mtime 缓存。
- **sessionView**(L2-8):`ORDER BY id` 吃索引 + 行数上限;**getNodeRunStdout**(L2-7):默认尾部
  512KB 截断 + `?full=1` 逃生门。

## 6. 修复组 E:SQLite 配置层

`db/client.ts` openDb 增加(全部进 settings 可配,默认值如下):

- `PRAGMA cache_size = -131072`(128MB;单连接独占,直接对 2.2GB 库的重复页读止血);
- `PRAGMA mmap_size = 536870912`(512MB;三平台 bun:sqlite 均支持,失败静默降级);
- `PRAGMA temp_store = MEMORY`(递归 CTE/排序临时体不落盘);
- checkpoint 循环:`walCheckpointIntervalMs` 默认改 600_000(10min,TRUNCATE;原默认 0 保留为可选值);
- `PRAGMA optimize` 于 boot 完成后与每日各跑一次(SQLite 自管 ANALYZE 时机;`analysis_limit=1000` 兜底)。
- 新增**慢查询计时**:`db/` 层包一个 >50ms 记 warn 的计时点(bun:sqlite 无 hook,在 drizzle 客户端
  的 `all/run/get` 包装层实现),让未来的回归自己浮出来。

## 7. 修复组 F:数据治理

### 7.1 终态任务自动归档(用户拍板:归档到归档目录、从表删除、不可见)

- **单位**:整棵任务树(root + 全部后代)。**条件**:树内全部终态(done/failed/canceled)且
  `max(finishedAt)` 早于保留期;排除:树内任一任务被未终态 fusion/distill job 引用。
- **目录**:`~/.agent-workflow/archive/tasks/{rootTaskId}/`,内容:
  - `manifest.json`(schema 版本、导出时间、任务树 id 列表、各表行数、校验和);
  - `db/{table}.jsonl` × 任务级联族全部表(tasks、node_runs、node_run_events〔含把 logs/ 里已归档
    JSONL 合并引用〕、node_run_outputs、clarify_rounds、doc_versions、task_questions、review_comments、
    workgroup_messages/assignments、lifecycle_alerts、recovery_events、task_feedback、task_repos …
    以 FK 图为准枚举,实现时以 `schemaAdmission` 的表清单对账);
  - `runs/`:既有 `runs/{taskId}/` 目录整体 rename 挪入;`logs/{taskId}/` 同。
- **原子性**:先写 `archive/tasks/.tmp-{id}/` → 全部落盘 + manifest fsync → rename 到正式名 →
  再按 §5 的分批删除清库(复用 taskDelete 管线,跳过 runs/ 删除改为挪移)。崩溃恢复:boot 扫
  `.tmp-*` 残留,库里行还在则重做、行已删则提升为正式目录。
- **触发**:hourly sweeper(默认**关**;settings 新增 `taskArchive.{enabled, retentionDays}`);
  另有 admin API + 设置页维护区"按条件批量归档"手动入口(审计行记录操作者与数量)。
- **不可见语义**:归档即删除,所有列表/详情/搜索 404 同不存在;不提供在线回看(proposal §5 C1)。

### 7.2 其余保留期(默认值均可配,0=关)

- 三胞胎事件表:memory_distill_events(job 终态 30 天)、intent_turn_events 族(session 终态 30 天)、
  mcp_runtime_test_events 族(ended 30 天),hourly 分批删。
- `webhook_trigger_fires` 90 天、`user_access_audit` 90 天(对齐 token_audit)、`mcp_probes` 每 MCP
  保留最近 50 条;`development_*` 的 `retention_state` 接上 sweeper(decisions/fact_snapshots 保最近
  N 轮 + 终态 90 天);code_work_rounds 建 rollup 表结清 dataLifetimeGc 的"只计数不删"欠账。
- `node_runs.prompt_text` 外置(P2,可延后):新列 `prompt_path` 指向 `runs/{taskId}/{nodeRunId}/prompt.md`,
  新行写文件、旧行不回填,读点双读(实现时 `rg` 全量核对读点)。
- `opencode-stores/` 退役死数据:设置页维护区显示体积 + 一键清理(确认后删);CLI 同步提供。
- 可回收空间提示:设置页显示 `freelist_count×page_size`;新增 CLI `agent-workflow db compact`
  (停机 VACUUM,文档写明须先停 daemon)。

## 8. 修复组 G:前端十万级渲染

### 8.1 公共原语(先原语后接入,符合 §Frontend UI consistency)

- **`components/VirtualList.tsx`**:@tanstack/react-virtual 的仓内包装(依赖新增,~3KB headless,
  与既有 TanStack 栈同族)。支持:定高/动态测高(measureElement)、`overscan`、粘性加载哨兵
  (IntersectionObserver 触发 `onReachEnd`)、a11y(保留列表语义 + `aria-setsize/aria-posinset`)、
  树形数据的**拍平渲染**辅助(expanded 集合 → 可见行数组,由调用方提供 flatten 函数)。
- **`hooks/usePagedList.ts`**:统一 `{items, nextCursor}` 封套的 useInfiniteQuery 包装
  (tasks/intent/deliveries 三处现状收敛),内置 `maxPages` 与"返回列表 reset 到首页"策略。
- **`hooks/useWsInvalidation.ts` 加合并窗**:per-key 1s trailing debounce(参数化,默认开);
  高频面(memory/intent/scheduled)自动受益;tasks 的 dirty-banner 模式保持不动。
- **`RelativeTime`**:tooltip 的 `toLocaleString` 惰性化(onMouseEnter 再算);tick 订阅随虚拟化
  自然收敛到可视行(不可视行不挂载)。

### 8.2 /tasks 改造

- `TaskOperationsList` 换 VirtualList:树拍平(expanded/collapsed 集合驱动),行组件 `React.memo` +
  props 收敛为原始值/稳定回调(`onToggle(id)` 单一引用);Load more 换滚动哨兵自动翻页;
  `useTaskOperationsSync` 的 15s reset 改"保持滚动位置的定点刷新"(refetch 首页 + 已加载页按
  cursor 重放交给 react-query,不再塌回顶部)。
- 每行的 duration 计时:页面级一个 `useNowTick`,now 经 context 传入行(行内不再各自订阅);
  RelativeTime 仅可视行挂载。

### 8.3 /repos 改造(后端 + 前端)

- 后端:`GET /api/cached-repos` 增加 `q/view/submodules/autoRefresh/cursor/limit` 参数,返回
  `{items, nextCursor, facets}`(照 `/api/tasks/page` 契约形状;无参调用保持旧全量形状一个过渡版本,
  proposal §5 C7)。`referencingTaskCount` 改 3 条 `GROUP BY` 一次算齐(task_repos 按 cachedRepoId、
  tasks 按 cached_repo_id〔走新索引〕、scheduled_tasks 单遍 `json_extract` 建 map),排序/过滤下推 SQL。
- 前端:表格换 VirtualList 行渲染;搜索 350ms debounce;过滤/facets 走服务端;删除/刷新按钮行为不变。

### 8.4 顺手项

- workflows 列表投影瘦身(`definition` → `nodeCount`,proposal §5 C2);
- `/code` work-items 接上被丢弃的 `nextCursor`(证据档 L5 表,功能 bug);
- reviews/clarify 列表页 10s 轮询改 30s + 窗口聚焦刷新(徽章已 count 化,列表页本身低频);
- 其余页面(agents/memory/users/scheduled/intent…)的接入列为 plan.md"后续接入清单",不在本 RFC 范围。

## 9. 迁移

单个 migration(编号顺延):证据档 §6 全部 20 项索引 + `tasks.branch_started_at` 列与回填
(一次性递归聚合)+ meta 表(归档水位、seal 闸门、字节采样缓存)。回填在 2.2GB 库上的成本:
纯 tasks 表操作(0.7MB/190 行本机;生产数千行),秒级。**不重建任何大表**(node_run_events 不动)。

## 10. 失败模式

- `branch_started_at` 漂移(并发写/历史 bug)→ invariants 自愈规则兜底;列表最坏表现为分支排序偏旧,
  不丢行(root 集合与谓词不依赖该列)。
- 归档目录写失败(磁盘满/权限)→ 归档中止、库内不删、告警;`.tmp` 残留由 boot 恢复逻辑收敛。
- 备份子进程崩溃 → 状态标 failed,主进程不受影响;并发备份请求被既有单实例锁拒绝。
- mmap 不可用(容器/文件系统限制)→ PRAGMA 失败静默降级,cache_size 仍然生效。
- 字节采样偏差(payload 分布突变)→ 水位是防线不是精确计量,偏差以行数阈值兜底。
- 前端虚拟化下的 a11y/查找(Ctrl+F 找不到未渲染行)→ 已有服务端搜索承接;e2e 断言可视行语义。

## 11. 测试策略(Test-with-every-change)

1. **oracle 等价**:每处查询改写配"旧实现 vs 新实现随机 fixture 逐值相等"测试(count 化 9 处、
   窄投影 DTO 字节等价、tasks/page 整页序列、listCachedRepos 计数);沿用仓内
   `countCachedRepos == listCachedRepos().length` 先例形态。
2. **EXPLAIN QUERY PLAN 断言**:关键查询(徽章 count、tasks/page 段一、orphan/stuck、归档区间删、
   repos 分页)断言不出现全表 `SCAN`(RFC-261 先例);索引迁移配 `PRAGMA index_list` 验证。
3. **参数上限回归**:构造 >33,000 行场景锁 eventsArchive 区间删、lifecycleInvariants/gc 的 chunkedInArray。
4. **归档器**:字节水位触发、分批推进、幂等续跑、JSONL 读回退无缝(扩展既有 fallback 测试)、
   高水位递推正确性(增删对账)。
5. **任务归档**:manifest 完整性、原子性(kill -9 注入后 boot 恢复两分支)、排除条件、默认关、
   手动入口权限、归档后 404 同不存在、runs/ 挪移。
6. **备份子进程**:备份进行中主 loop 响应计时断言;prune 独立执行与 pre-* 上限。
7. **PRAGMA**:openDb 后逐项断言;慢查询计时点单测。
8. **前端**:VirtualList 单测(窗口渲染/动态高/哨兵/aria)、行 memo 有效性(渲染计数断言
  "tick 只重渲可视行")、usePagedList、WS 合并窗;Playwright e2e:大 seed 下 /tasks 滚动加载、
  树展开、/repos 分页搜索过滤、旧行为回归(RFC-024/RFC-244/RFC-246 既有 e2e 全绿)。
9. **性能 harness**:`scripts/perf-seed.ts`(10 万任务/300 万 runs/千万事件/10 万投递/500 仓)+
   `scripts/perf-bench.ts`(输出 proposal §6 各指标);不进 CI 门禁,README 记录手动跑法与基线数。
