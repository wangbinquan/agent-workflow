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

生产参照:用户报的生产库 2.2GB、数千任务、十万级 webhook 事件——本基准在**任务维度**比生产重
约 50 倍,在事件维度同量级。

## 结果

| proposal §6 | 指标                                         | 目标   | 实测(p50)               | 判定     |
| ----------- | -------------------------------------------- | ------ | ----------------------- | -------- |
| 6.1         | `/api/tasks/page` 默认视图首页               | <150ms | **30.2ms**              | ✅       |
| 6.1         | `/api/tasks/page` 翻页(keyset)               | <150ms | **29.8ms**              | ✅       |
| 6.1         | `/api/tasks/page` 切视图(`statuses=running`) | <150ms | **68,201ms**            | ❌ 见 G1 |
| 6.2         | `/api/cached-repos` 分页首页                 | <100ms | **6.3ms**               | ✅       |
| 6.2         | `/api/cached-repos` referenced 视图          | <100ms | **5.8ms**               | ✅       |
| 6.3         | `reviews/pending-count`                      | <10ms  | **0.8ms**               | ✅       |
| 6.3         | `clarify/pending-count`                      | <10ms  | **0.6ms**               | ✅       |
| 6.3         | `workgroup-tasks/pending-count`              | <10ms  | **13.2ms**              | ⚠️ 见 G2 |
| 6.3         | `/api/overview`(9 计数)                      | <10ms  | **50.7ms**              | ⚠️ 见 G2 |
| 6.5         | 归档器单轮                                   | <1s    | **72.1s**(归档 20 万行) | ⚠️ 见 G3 |

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

### G1 —— 过滤视图仍走穷举管线:10 万任务下 68 秒(最大缺口)

`isDefaultView` 只放行 `tasks:read:all` + 全默认过滤的视角(PR-4 的 oracle 证明受限 actor 的分支
聚合必须按可见性裁剪树计算,共享物化列答不了)。因此**任何状态/来源/搜索过滤都回落旧管线**,在本
基准库上单次 68 秒——而且它是**一条 SQL**,在单连接同步 daemon 上意味着这段时间**整站冻结**。

- 生产影响估计:生产是数千任务(比本基准小 ~50 倍),同一条路径量级约 1~2 秒/次——与用户最初报的
  「所有操作都挺慢」相符,但不再是分钟级。
- 建议(下一个 RFC):把快路径扩到 `statuses`/`origin`/`subject` 这类**纯 tasks 列**过滤——难点不在
  过滤本身,而在 context-ancestor 语义(匹配行的可见祖先要作为上下文出现),需要单独设计 + oracle。
- 缓解(可立即做,不改语义):给过滤视图的旧管线加**查询预算保护**,超时即返回明确错误而不是拖死
  daemon。

### G2 —— overview 50.7ms / workgroup 徽章 13.2ms 超 10ms 目标

count 化后这两项在本机小库上是亚毫秒级;在 10 万任务 + 980 万事件库上分别 50.7ms / 13.2ms。目标
本身按「三徽章 15s 一轮 × 多 tab」的常驻负载定的:50ms 的绝对值不构成冻结风险(比改造前的 15 秒
全表物化低三个数量级),但没达到写下的口径,如实记账。

**一条重要的口径修正**:这个数字有相当部分是**合成数据分布的产物**,不宜直接外推到生产。
seed 的状态分布是 done 42858 / canceled 14286 / failed 14286 / pending 14285 / **running 14285**
——即「1.4 万个任务同时在跑」,任何真实部署都不是这个形状(生产的 running 通常是两位数)。
overview 的四条任务计数各自走索引、成本随**命中行数**走,所以合成分布把它们放大了。
基于此,**不建议**做「9 计数合成 1 条 SQL」的改写:那会把四次索引 seek 换成一次全表扫描
(本库实测全表扫 ≈ 30ms),在真实分布下反而更慢。真要再压,方向是给 running/awaiting 这类
小基数视图做覆盖索引,而不是合并语句。

### G3 —— 归档器首轮清 backlog 72 秒

单轮上限 `ARCHIVE_TICK_BUDGET_ROWS = 200_000` 行,实测正好归档 20 万行、耗时 72 秒;980 万行积压
需多个小时 tick 才清完。其中最长的**单条语句**是 1.24 秒(增量高水位扫描
`select node_run_id, count(id) … where id > ? group by node_run_id`);其余是 5000 行一批的删除/落盘,
批间让出。也就是说 72 秒是**可打断的累计工作量**而非一次冻结,但仍建议:①稳态后每轮几乎无事可做
(高水位生效),首轮成本只付一次;②如需更平滑,把 tick 预算调小(配置项已在,阈值可配)。

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
