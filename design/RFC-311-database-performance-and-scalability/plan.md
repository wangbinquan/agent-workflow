# RFC-311:数据库性能治理与十万级列表渲染(plan)

> 用户拍板"合一个大 RFC";按仓规第 5 条在此说明 PR 拆分:五个 PR 按风险与依赖分层,
> 每个独立可交付、独立跑全量门禁(`bun run gate:local`)+ exact-SHA CI,主干直推。

## PR-1 速效批 I:索引 + 配置层 + count 化(零行为变化,先止血)

| 任务 | 内容 | 证据档 |
|---|---|---|
| T1 | migration:§6 索引清单 20 项 + `tasks.branch_started_at` 列与回填 + meta 表(水位/闸门/采样) | §6 |
| T2 | `db/client.ts` PRAGMA 组(cache_size/mmap/temp_store)+ settings 项 + openDb 断言测试 | L0 |
| T3 | checkpoint 循环默认 10min TRUNCATE(settings 默认值变更,C5) | L3 |
| T4 | 慢查询计时包装(>50ms warn)+ 单测 | §6 |
| T5 | 三徽章端点 count 化(reviews/clarify/workgroup)+ 批量可见性原语 `visibleTaskIdsOf` + oracle 等价测试 | L1-1..5,L1-10 |
| T6 | `/api/overview` 9 计数 count 化 + oracle | L1-6/7 |
| T7 | `listClarifyRoundSummaries` 下推 + 两 helper inArray/投影 | L1-3/4 |
| T8 | EXPLAIN QUERY PLAN 断言基建(helper + 首批断言) | §11.2 |

依赖:无。验收:徽章/overview 单次 <10ms(本机);全部 oracle 绿。

## PR-2 速效批 II:窄投影 + 热路径 + 周期任务(零 wire 变化,唯一例外 outputs 预览)

| 任务 | 内容 | 证据档 |
|---|---|---|
| T9 | listTasks/limits/visibility 中间件/scheduler tick/taskQuestionDispatch/branchTrace/resolveNodeActivation/gc/worktreeBackup/memoryInject/autoDispatch 窄投影 + DTO 字节等价测试 | L1-8/9,L2-2..5/9,L3-10 |
| T10 | getTaskNodeRuns 投影 + outputs 改 `length+预览` 懒加载(前端 diff/端口面板同步改) | L2-2 |
| T11 | listCachedRepos 聚合化(3 条 GROUP BY + scheduled_tasks 单遍)+ oracle | L2-6 |
| T12 | eventsArchive 重构:区间删 + 批量封顶 + 高水位增量 + 删后 checkpoint;>33k 行回归测试 | L3-3/4 |
| T13 | stuck 检测 `max(id)` 化;sessionView `ORDER BY id`+上限;getNodeRunStdout 尾部截断 | L3-5,L2-7/8 |
| T14 | lifecycleInvariants 分块(chunkedInArray helper)+ 按规则集合化 + reconcile 事务化 | L3-9 |
| T15 | 备份子进程化 + prune 独立执行 + pre-*/manual 保留上限(C4)+ seal 闸门 | L3-1/2/15 |
| T16 | taskDelete 大表分批;runner 写入 50ms 攒批;subagentLiveCapture 游标化;mr worker IN+LIMIT;dataLifetimeGc 批量事务化;scheduledTaskScheduler config 缓存;fusion 列表去内联 reconcile;agent 删除守卫预过滤 | L3-11..22,L2-10 |

依赖:T1(索引)。验收:proposal §6.5/§6.6;备份期间 API 响应计时断言。

## PR-3 数据治理批(行为变化集中在此,对应 C1/C3/C6)

| 任务 | 内容 |
|---|---|
| T17 | 字节水位(globalBytes/perNodeRunBytes + 采样折算)+ settings + 测试 |
| T18 | 三胞胎事件表 + trigger_fires/user_access_audit/mcp_probes/development_* retention sweeper + code_work_rounds rollup |
| T19 | **终态任务自动归档**:taskArchive service(manifest/JSONL 导出/runs 挪移/原子性/boot 恢复)+ hourly sweeper(默认关)+ settings + admin 手动批量入口(API+设置页)+ 审计行 |
| T20 | opencode-stores 清理入口(设置页维护区 + CLI);freelist 提示;`db compact` CLI |
| T21 | prompt_text 外置(prompt_path 双读)——**可延后项**,若周期紧张转 backlog 不阻塞收口 |

依赖:PR-2(T19 复用分批删除)。验收:proposal §6.5/§6.8;归档 kill -9 注入两分支恢复测试。

## PR-4 `/api/tasks/page` O(页) 重构

| 任务 | 内容 |
|---|---|
| T22 | branch_started_at 维护点(创建/启动向上更新)+ invariants 自愈规则 |
| T23 | 查询两段化(keyset 取页 + 页内富化)+ facets 独立缓存端点/内存缓存 |
| T24 | 新旧整页序列 oracle(随机树 fixture,含 context-match/翻页边界/子树计数)+ EXPLAIN 断言 |

依赖:T1。验收:proposal §6.1(十万任务 P95 <150ms)。

## PR-5 前端十万级渲染批

| 任务 | 内容 |
|---|---|
| T25 | 引入 @tanstack/react-virtual;`components/VirtualList.tsx` 公共组件 + 单测(窗口/动态高/哨兵/aria) |
| T26 | `hooks/usePagedList.ts` 统一封套;`useWsInvalidation` 合并窗(默认 1s);RelativeTime tooltip 惰性化 |
| T27 | /tasks 接入:树拍平虚拟化 + 行 memo/稳定回调 + 滚动哨兵翻页 + tick 收敛(页级 now context)+ sync 定点刷新;渲染计数断言 |
| T28 | /repos 后端分页(`{items,nextCursor,facets}`,无参兼容,C7)+ 前端虚拟表 + debounce + facets 下推;oracle + e2e |
| T29 | workflows 列表投影瘦身(C2)+ 前端消费点改造;/code work-items 接 nextCursor(bug 修复);reviews/clarify 列表轮询 10s→30s+聚焦刷新 |
| T30 | `scripts/perf-seed.ts` + `scripts/perf-bench.ts` + 基线数记录;Playwright 大 seed e2e(/tasks 滚动、树展开、/repos 搜索过滤) |

依赖:PR-4(tasks 页指标)、PR-2 T11(repos 聚合)。验收:proposal §6.7 + 既有 RFC-024/244/246 e2e 全绿。

## 后续接入清单(本 RFC 不做,登记以免丢)

- agents/skills/mcps/plugins/workgroups/memory/users/scheduled/intent/code-missions 各页接入
  VirtualList + 端点分页(数据千级前非必需;memory 审批队列 body 惰性加载优先级最高);
- 事件"写入即落盘"二期;FTS5 搜索;归档任务恢复工具;T21 若延后在此销账。

## 验收清单(收口对照)

- [ ] proposal §6 九项验收全过(基准数字记录进本目录 `bench-results.md`)
- [ ] proposal §5 能力影响 C1-C7 逐项有测试覆盖(禁用分支与正向同等对待)
- [ ] 全部 oracle/EXPLAIN/参数上限回归绿;`bun run gate:local` 全绿;exact-SHA CI 36 作业绿
- [ ] `docs/dev-gotchas.md` 补"同步 SQLite 连接上的查询预算"与"count 化/窄投影"定式
- [ ] STATE.md / design/plan.md 收口更新
