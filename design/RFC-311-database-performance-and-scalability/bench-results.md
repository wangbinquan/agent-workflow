# RFC-311 基准实测(proposal §6 验收对照)

> 数字全部由本目录 plan.md T30 的 harness 产出,可复跑:
>
> ```sh
> bun run scripts/perf-seed.ts --db /tmp/aw-perf/agent-workflow.db   # ~93s,产出 3.6GB
> bun run scripts/perf-bench.ts --db /tmp/aw-perf/agent-workflow.db --rounds 5
> bun run scripts/perf-bench.ts --db … --only "cached-repos"          # 单项复测
> ```
>
> **必须在分离 worktree 里跑**——共享工作树上他人的在途改动会让 `createApp` 直接抛错
> (`docs/dev-gotchas.md` 已记该判据)。

## 环境

| 项          | 值                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| 机器        | Apple M1 Max / 64GB / macOS 26.5.1 / Bun 1.3.13                                                                 |
| 被测 commit | `ba4348df`(含 PR-1…PR-5 全部改动)                                                                               |
| 库规模      | 10 万 tasks / 300 万 node_runs / 980 万 node_run_events / 10 万 webhook_deliveries / 500 cached_repos,**3.6GB** |
| 口径        | `createApp` + `app.request`(与生产同一条中间件/路由/服务链),每项预热 1 次后取 5 轮                              |

**两次观测,数字必须按观测批次读**(判据本身会过期,见 `docs/dev-gotchas.md`):

| 观测批次 | 日期       | 被测 commit           | 库                                             | 覆盖                     |
| -------- | ---------- | --------------------- | ---------------------------------------------- | ------------------------ |
| 第一次   | 2026-08-18 | `ba4348df`(PR-1…PR-5) | 10 万 tasks / 980 万 events / 3.6GB             | 全部指标,发现 G1/G2/G3   |
| 第二次   | 2026-08-19 | PR-7(G1/G2/G3 修复)   | 同 seed 重建,10 万 tasks / 860 万 events / 3.6GB | G1/G2/G3 三项复测        |

同一指标在两批之间的「改前」值可能微差(如 overview 50.7ms vs 46.5ms):**库是同一脚本重新 seed 的,
不是同一份字节**,且第二批的事件表因归档基准跑过若干轮而略小。跨批比较只看**量级**,不要比小数点。

生产参照:用户报的生产库 2.2GB、数千任务、十万级 webhook 事件——本基准在**任务维度**比生产重
约 50 倍,在事件维度同量级。

## 结果

| proposal §6 | 指标                                         | 目标   | 实测(p50)               | 判定     |
| ----------- | -------------------------------------------- | ------ | ----------------------- | -------- |
| 6.1         | `/api/tasks/page` 默认视图首页               | <150ms | **30.2ms**              | ✅       |
| 6.1         | `/api/tasks/page` 翻页(keyset)               | <150ms | **29.8ms**              | ✅       |
| 6.1         | `/api/tasks/page` 切视图(`statuses=running`) | <150ms | 68,201ms → **62.3ms**   | ✅ 见 §G1 已修 |
| 6.2         | `/api/cached-repos` 分页首页                 | <100ms | **6.3ms**               | ✅       |
| 6.2         | `/api/cached-repos` referenced 视图          | <100ms | **5.8ms**               | ✅       |
| 6.3         | `reviews/pending-count`                      | <10ms  | **0.8ms**               | ✅       |
| 6.3         | `clarify/pending-count`                      | <10ms  | **0.6ms**               | ✅       |
| 6.3         | `workgroup-tasks/pending-count`              | <10ms  | 10.5ms → **0.6ms**      | ✅ 见 §G2 已修 |
| 6.3         | `/api/overview`(9 计数)                      | <10ms  | 46.5ms → **1.8ms**      | ✅ 见 §G2 已修 |
| 6.5         | 归档器单轮                                   | <1s    | 6.1s(归档 20 万行);最长单语句 1,190ms → **76ms** | ⚠️ 见 §G3 |

未由本 harness 覆盖的验收项,状态如实记载:

| §6  | 项                                  | 状态                                                                                                                             |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 6.4 | 空闲 daemon 每秒 DB 耗时 <5ms       | **未实测**。已有的 `sqliteSlowQueryMs`(默认 50ms warn)是常驻探针,生产开箱可观测;专门的空转采样留作后续。                         |
| 6.6 | 备份进行中 tasks/page 仍 <300ms     | **未实测**,但结构上已成立:VACUUM INTO 移出主线程(Worker + readonly 第二连接,PR-2 T15),主连接不再被冻结。                         |
| 6.7 | 前端首屏 <1.5s、可视区 DOM 行数恒定 | **部分实测**:窗口化本身有单测锁(`virtual-list.test.tsx`「只渲染视口 ± overscan」)与 e2e 锁;首屏计时未做大 seed Playwright 场景。 |
| 6.8 | 任务归档开启后的行为                | **不适用**:T19 未实现(列 PR-6)。                                                                                                 |
| 6.9 | oracle / EXPLAIN / 参数上限回归绿   | ✅ 全绿(`rfc311-*.test.ts` 共 7 个文件)。                                                                                        |

## 实测驱动的两处修复(基准库上发现,已落地)

1. **keyset 断点必须写行值比较**(`822a20bf`)。首轮实测翻页 **197ms**、首页 30ms;根因是断点
   写成展开式 `a < ? OR (a = ? AND id < ?)`,在**绑定参数**下 SQLite 选 `MULTI-INDEX OR` 并回落
   `USE TEMP B-TREE FOR ORDER BY`,把 9 万根行物化排序。改 `(a, id) < (?, ?)` 后落成单次有序
   SEARCH:**197.5ms → 29.8ms**。**字面量 EXPLAIN 复现不出来**(字面量下反而选对索引),plan 断言
   因此必须用 `?` 占位符——已进 `rfc311-task-page-fastpath.test.ts` 与 `docs/dev-gotchas.md`。
2. **perf-seed 的 `url_hash` 唯一性**(`d7924346`):原实现取 id 前 8 字符恒为 `perfrepo`,UNIQUE
   冲突让 500 仓只进 1 行,§6.2 的数字会失真。

## 遗留缺口

### G1 —— 过滤视图仍走穷举管线:68 秒 → **62ms(PR-7 已修)**

**问题**(2026-08-18 观测):`isDefaultView` 只放行「全可见 actor + 全默认过滤」,任何状态/来源/主体/
搜索过滤都回落旧管线,本基准库单次 **68,201ms**,而且是**一条 SQL**——单连接同步 daemon 上意味着
这段时间整站冻结。

**修法**(PR-7,2026-08-19 复测 **62.3ms**,约 1100×):物化 `tasks.root_task_id`(migration 0183)。
旧管线的分支 = `subtree(root) ∩ (匹配集 ∪ 其祖先)`,而这恰好等于「`root_task_id` = 该 root 且属于
合格集」的行——于是「向上求祖先闭包 + 向下求分支成员」两条递归 CTE 塌缩成一次 `GROUP BY`。
`qualifyingChildCount` 需要祖先信息,但只对页内 ≤limit+1 个 root 求值。设计见 design.md §4.1。

- 等价性:`rfc311-task-page-filtered-fastpath.test.ts` 27 组过滤 × 3 actor 逐页逐 id + facets 对齐,
  慢侧显式钉死旧管线;两次变异检验(排序键取子树全量 max / is_self 恒真)均当场变红。
- 边界:受限 actor 仍走旧管线(其分支聚合按可见性裁剪后的树计算,全局 root 答不了)。
- **准入闸门**:库里只要有一行 `root_task_id IS NULL`(绕过服务层的裸 SQL 插入、或迁移漏回填),
  整条退回旧管线——那行会被当成自己的根**静默挂错分支**,宁可慢不可错。基准脚本第一次跑就撞到了
  这条(perf-seed 是批量插入、当时没落根),日志里 66.5 秒那条 `db-slow` 正是闸门在按设计工作。
- 回填代价:10 万任务实测 **504ms**(递归 CTE 一次写定),0 行残留 NULL、0 行与父的根不一致。

### G2 —— overview 50.7ms / 徽章 13.2ms → **1.8ms / 0.6ms(PR-7 已修)**

第一次观测时的结论是「**不要**把 9 条 count 合成 1 条 SQL(会把索引 seek 换成全表扫描),方向是给
小基数视图补覆盖索引」。第二次观测证实了这个方向:

**根因**:首页四张卡片都带 `parent_task_id IS NULL`(子执行不上首页),而既有索引 `(status, finished_at)`
不含该列 ⇒ 命中该状态的每一行都要**回表**只为读一个指针;工作组徽章同理,为读 `workgroup_id` 回表。

**修法**(migration 0184):`(status, parent_task_id, finished_at)` 与 `(status, workgroup_id)` 两条覆盖
索引。overview **46.5ms → 1.8ms**(26×)、工作组徽章 **10.5ms → 0.6ms**(17×),两项都进 10ms 口径。

原记录里「合成数据分布放大了这两项(1.4 万个 running 任务,真实部署通常两位数)」的判断仍然成立——
覆盖索引让它对分布不再敏感,因为筛选阶段不再逐行回表。

### G3 —— 归档器最长单语句 1,190ms → **76ms(PR-7 已修)**

**问题**:增量高水位扫描 `select node_run_id, count(id) … where id > ? group by node_run_id` 上界是开的,
首轮(水位=0)等于把整张事件表扫一遍,实测**单条语句 1.19 秒**的整站冻结。

**修法**:按 id 分窗(每窗 10 万 id),单条语句降到 76ms;整轮工作量仍由 `ARCHIVE_TICK_BUDGET_ROWS`
约束,于是 backlog 变成一串可打断的短语句。

**过程中踩的坑(已落 `docs/dev-gotchas.md`)**:第一版分窗**让整轮从 6 秒劣化到 260 秒(43×)**——
同一个 `node_run` 横跨多窗口,而循环里对每个候选都发一条「问总量」的 count,分窗把这件事重复了
几十倍。小库上重复几十次仍是毫秒,**6 条单测全绿**。正解:每窗只取候选集(`SELECT DISTINCT`),
总量用分块的一条分组语句问完,再加「一轮最多考察多少候选」的预算。改完整轮 **6.1 秒**、全轮只剩
1 条超阈值语句(287ms,每小时一次的全表 `COUNT(*)`,代码里的原有取舍)。

判据:**单测能证明没改坏语义,证明不了没改坏代价**;改变语句条数或循环结构的优化,必须在有量级的
库上看**整轮墙钟**。

### G4 —— 实现门补记的两处结构性缺口

- **§6.6「备份进行中 tasks/page 仍 P95 <300ms」没有测试**。结构上现在成立(VACUUM
  INTO 在 worker 线程 + 备份快照期间 checkpoint 让路),但两条都是实现门期间才补上的
  ——**其中 checkpoint 与备份相撞会阻塞满 busy_timeout(实测 5310ms)并冻结同步主
  连接**,正是这条验收要消灭的形态,却一度被本 RFC 自己的 C5 重新引入。没有测试就
  没有护栏:建议补一条「真做一次备份、同时打 tasks/page」的计时断言。
- **/repos 的 facets 每页重算,无缓存**。design §4.3 只给 tasks 的 facets 规定了
  「独立轻查询 + 30s 内存缓存」,repos 侧没有对应机制:每翻一页跑 3 条 count,其中
  referenced 对每行做两次相关 EXISTS。500 仓下 6.3ms 照不出来,十万仓目标下滚动
  哨兵自动翻页会把它放大到每屏一次。按 tasks 同款做短 TTL 缓存即可(facets 恒为
  全量视角,缓存语义最简单)。

## 复跑清单(改性能相关代码后)

1. `scripts/perf-seed.ts --reset` 重建基准库(93 秒);
2. `scripts/perf-bench.ts --rounds 5` 全量;或 `--only "tasks/page"` 单项;
3. 关注 `[db-slow]` 行——它是 `sqliteSlowQueryMs` 探针的输出,直接指出超阈值的语句文本。
