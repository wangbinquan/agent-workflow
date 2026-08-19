# RFC-311:数据库性能治理与十万级列表渲染(plan)

> 用户拍板"合一个大 RFC";按仓规第 5 条在此说明 PR 拆分:五个 PR 按风险与依赖分层,
> 每个独立可交付、独立跑全量门禁(`bun run gate:local`)+ exact-SHA CI,主干直推。

## PR-1 速效批 I:索引 + 配置层 + count 化(零行为变化,先止血)

| 任务 | 内容                                                                                                | 证据档        |
| ---- | --------------------------------------------------------------------------------------------------- | ------------- |
| T1   | migration:§6 索引清单 20 项 + `tasks.branch_started_at` 列与回填 + meta 表(水位/闸门/采样)          | §6            |
| T2   | `db/client.ts` PRAGMA 组(cache_size/mmap/temp_store)+ settings 项 + openDb 断言测试                 | L0            |
| T3   | checkpoint 循环默认 10min TRUNCATE(settings 默认值变更,C5)                                          | L3            |
| T4   | 慢查询计时包装(>50ms warn)+ 单测                                                                    | §6            |
| T5   | 三徽章端点 count 化(reviews/clarify/workgroup)+ 批量可见性原语 `visibleTaskIdsOf` + oracle 等价测试 | L1-1..5,L1-10 |
| T6   | `/api/overview` 9 计数 count 化 + oracle                                                            | L1-6/7        |
| T7   | `listClarifyRoundSummaries` 下推 + 两 helper inArray/投影                                           | L1-3/4        |
| T8   | EXPLAIN QUERY PLAN 断言基建(helper + 首批断言)                                                      | §11.2         |

依赖:无。验收:徽章/overview 单次 <10ms(本机);全部 oracle 绿。

## PR-2 速效批 II:窄投影 + 热路径 + 周期任务(零 wire 变化,唯一例外 outputs 预览)

| 任务 | 内容                                                                                                                                                                                                  | 证据档                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| T9   | listTasks/limits/visibility 中间件/scheduler tick/taskQuestionDispatch/branchTrace/resolveNodeActivation/gc/worktreeBackup/memoryInject/autoDispatch 窄投影 + DTO 字节等价测试                        | L1-8/9,L2-2..5/9,L3-10 |
| T10  | getTaskNodeRuns 投影 + outputs 改 `length+预览` 懒加载(前端 diff/端口面板同步改)                                                                                                                      | L2-2                   |
| T11  | listCachedRepos 聚合化(3 条 GROUP BY + scheduled_tasks 单遍)+ oracle                                                                                                                                  | L2-6                   |
| T12  | eventsArchive 重构:区间删 + 批量封顶 + 高水位增量 + 删后 checkpoint;>33k 行回归测试                                                                                                                   | L3-3/4                 |
| T13  | stuck 检测 `max(id)` 化;sessionView `ORDER BY id`+上限;getNodeRunStdout 尾部截断                                                                                                                      | L3-5,L2-7/8            |
| T14  | lifecycleInvariants 分块(chunkedInArray helper)+ 按规则集合化 + reconcile 事务化                                                                                                                      | L3-9                   |
| T15  | 备份子进程化 + prune 独立执行 + pre-\*/manual 保留上限(C4)+ seal 闸门                                                                                                                                 | L3-1/2/15              |
| T16  | taskDelete 大表分批;runner 写入 50ms 攒批;subagentLiveCapture 游标化;mr worker IN+LIMIT;dataLifetimeGc 批量事务化;scheduledTaskScheduler config 缓存;fusion 列表去内联 reconcile;agent 删除守卫预过滤 | L3-11..22,L2-10        |

依赖:T1(索引)。验收:proposal §6.5/§6.6;备份期间 API 响应计时断言。

## PR-3 数据治理批(行为变化集中在此,对应 C1/C3/C6)

| 任务 | 内容                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T17  | 字节水位(globalBytes/perNodeRunBytes + 采样折算)+ settings + 测试                                                                                                   |
| T18  | 三胞胎事件表 + trigger*fires/user_access_audit/mcp_probes/development*\* retention sweeper + code_work_rounds rollup                                                |
| T19  | **终态任务自动归档**:taskArchive service(manifest/JSONL 导出/runs 挪移/原子性/boot 恢复)+ hourly sweeper(默认关)+ settings + admin 手动批量入口(API+设置页)+ 审计行 |
| T20  | opencode-stores 清理入口(设置页维护区 + CLI);freelist 提示;`db compact` CLI                                                                                         |
| T21  | prompt_text 外置(prompt_path 双读)——**可延后项**,若周期紧张转 backlog 不阻塞收口                                                                                    |

依赖:PR-2(T19 复用分批删除)。验收:proposal §6.5/§6.8;归档 kill -9 注入两分支恢复测试。

## PR-4 `/api/tasks/page` O(页) 重构

| 任务 | 内容                                                                                 |
| ---- | ------------------------------------------------------------------------------------ |
| T22  | branch_started_at 维护点(创建/启动向上更新)+ invariants 自愈规则                     |
| T23  | 查询两段化(keyset 取页 + 页内富化)+ facets 独立缓存端点/内存缓存                     |
| T24  | 新旧整页序列 oracle(随机树 fixture,含 context-match/翻页边界/子树计数)+ EXPLAIN 断言 |

依赖:T1。验收:proposal §6.1(十万任务 P95 <150ms)。

## PR-5 前端十万级渲染批

| 任务 | 内容                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| T25  | 引入 @tanstack/react-virtual;`components/VirtualList.tsx` 公共组件 + 单测(窗口/动态高/哨兵/aria)                              |
| T26  | `hooks/usePagedList.ts` 统一封套;`useWsInvalidation` 合并窗(默认 1s);RelativeTime tooltip 惰性化                              |
| T27  | /tasks 接入:树拍平虚拟化 + 行 memo/稳定回调 + 滚动哨兵翻页 + tick 收敛(页级 now context)+ sync 定点刷新;渲染计数断言          |
| T28  | /repos 后端分页(`{items,nextCursor,facets}`,无参兼容,C7)+ 前端虚拟表 + debounce + facets 下推;oracle + e2e                    |
| T29  | workflows 列表投影瘦身(C2)+ 前端消费点改造;/code work-items 接 nextCursor(bug 修复);reviews/clarify 列表轮询 10s→30s+聚焦刷新 |
| T30  | `scripts/perf-seed.ts` + `scripts/perf-bench.ts` + 基线数记录;Playwright 大 seed e2e(/tasks 滚动、树展开、/repos 搜索过滤)    |

依赖:PR-4(tasks 页指标)、PR-2 T11(repos 聚合)。验收:proposal §6.7 + 既有 RFC-024/244/246 e2e 全绿。

## 后续接入清单(本 RFC 不做,登记以免丢)

- agents/skills/mcps/plugins/workgroups/memory/users/scheduled/intent/code-missions 各页接入
  VirtualList + 端点分页(数据千级前非必需;memory 审批队列 body 惰性加载优先级最高);
- 事件"写入即落盘"二期;FTS5 搜索;归档任务恢复工具;T21 若延后在此销账。
- **`listMissionSummaries`(development-automation 的 mission 列表读模型)目前是全表无分页 `.all()`**
  ——RFC-310 PR-2 的既有实现,其 RFC 范围内无分页要求,由该 session 移交本性能治理面登记;mission
  表长起来会复刻 /tasks 的卡顿形态,接入方式与 /repos 同款(keyset + 页内富化 + facets)。

## 实现门(三路错开视角)findings 与处置

按 `docs/dev-gotchas.md` 的定式,本轮改动跨了他人提交,故以三路**刻意错开视角**的
独立子代理替代 codex `--base`:①正确性;②不在 diff 里的连带面(不看 diff,按契约
反查消费方);③测试有效性(20 组变异实验)。产出与处置:

- **两个 P0(均已修)**:①`bun build --compile` 只打包 mainEntry,worker 不被
  bundler 追踪 ⇒ **发布版单二进制里备份 100% 不可用**(dev 与测试都走不到)——构建
  脚本加额外入口 + 任何 worker 失败回退同线程 VACUUM INTO;②C5 把 checkpoint 默认
  打开后,它与备份的只读快照相撞会阻塞满 busy_timeout(实测 5310ms)且跑在同步主
  连接上 ⇒ 全站冻结 5 秒,正是 §6.6 要消灭的事——快照期间跳过该拍。
- **用户可见的真回归(已修)**:tooltip 惰性化存了格式化字符串 ⇒ 虚拟化复用实例后
  显示过期时间;字节水位使归档常态化而归档 JSONL 丢了 session 列 ⇒ 会话树以子代理
  为根**渲染出错误结构**;webhook supersede 的唯一事实源被 90 天保留期删掉 ⇒ 同一
  MR 两个活任务互相踩;事件流水按行时间戳删而宿主计数还在 ⇒ 界面正面宣称
  「complete · N events」而面板空白、蒸馏「抓取失败」被反转成「没有抓取问题」;
  /repos 网格化后表头/单元格错位与窄屏 Actions 被裁;branch_started_at 在删除子
  任务后永久漂移。
- **8 组变异后测试仍全绿的锁不住点(已补锁)**:快路径可被静默关闭、参数上限锁前提
  不成立(实测 SQLite 3.51 到 10 万参数才抛)、高水位断言不看值、C6 三条腿可整体
  关闭、HTTP 层三个过滤参数零覆盖、workgroup 徽章 ACL 零防护(可越权计数泄漏)、
  config 缓存别名断言打错对象、一条永不匹配的死正则。
- **一条经实测证伪的 finding**:第 2 路预测「/tasks 视觉基线随虚拟化必红」——分离
  worktree 上跑完整视觉套件(45 场景)结果**全绿**,像素差落在 `maxDiffPixelRatio:
0.002` 之内(根行 border-top 与尾注位置在截图视角下不构成可见差)。只有 /repos
  真的需要刷基线(darwin `7ceb819a` / linux `efe781c3` 已刷)。记下来是因为「预测
  会红」与「实际红」之间必须由实跑裁决,不能凭结构推断就去改基线。

- **登记不修(与用户/后续 RFC 相关)**:repos facets 每页重算无缓存(500 仓 6.3ms,
  十万仓需按 tasks 同款做短 TTL 缓存);`getNodeRunStdout` 尾部截断仍未做;
  §6.6「备份进行中 tasks/page P95 <300ms」缺真做备份的计时断言(结构上已由
  worker + checkpoint 让路成立,但没有测试)。

## 验收清单(收口对照)

- [x] proposal §6 验收实测,数字与**逐项判定**记入 `bench-results.md`(6.1 首页/翻页、6.2、6.3 两条徽章 ✅;**三处缺口 G1/G2/G3 如实记账并给出建议**,详见该文件)
- [x] proposal §5 能力影响 C1–C7 逐项有测试覆盖(C1 随 PR-6/T19 补齐:`rfc311-task-archive.test.ts`
      11 条锁默认关 / 整树判据 / 原子性两分支 / 有界扫描 / 手动入口 dry-run 与审计行;
      此前 C1 一行曾被整体勾上属记账错误,实现门第 3 路指出后更正,现按实交付)
- [x] 全部 oracle/EXPLAIN/参数上限回归绿;exact-SHA CI:`822a20bf` 上 RFC-311 面全绿(唯一红是并发 session 的 rfc305 权限计数)
- [x] `docs/dev-gotchas.md` 补三条:partial-index 蕴含限制、**keyset 断点行值比较**、迁移四件套定式(另加混树 e2e 二进制判据)
- [x] STATE.md / design/plan.md 收口更新

## 交付注记(实现期滚动更新)

- **PR-1 ✅**(`b8688851` + 格式/lint 补丁 `a606bcd3`/`2cbfdf7a`,CI 绿证 `2cbfdf7a` 31 checks):T1-T8 全交付。落地修正:`idx_node_runs_status_active` 因 SQLite partial-index 蕴含限制(`= ⊄ IN`,实测)改普通复合索引,判据进 dev-gotchas 与 foundation plan 断言。
- **PR-2 ✅**(`60a84f2f`→rebase `e8ba3bc1`)+ **PR-2b ✅**(`7f1fd5fe`):T9-T16 主体。取舍:limits 的 token SUM 不降频(避免取消延迟的行为变化,投影后成本已可控);**T15 的 seal 闸门延后**(400 行凭据擦洗函数,改错代价>>收益;安全检查段本就须每次执行);invariants 七规则集合化延后(分块+让出已消坏死与长冻结)。
- **PR-3a ✅**:T17 字节水位(采样折算,行数阈值取 min)+ T18 保留 sweeper。**两处审计误报经落地检验修正并以测试锁定**:`user_access_audit` 带 append-only 触发器(RFC-305 防篡改),不清理;`mcp_probes` 是 UNIQUE(mcp_id) 的 upsert 单行表,非流水。proposal §5 C6 按此勘误(其余四表照批生效)。
- **PR-4 ✅**:T22-T24。**范围修正(oracle 实测驱动)**:fast path 仅服务 `tasks:read:all` + 全默认过滤——受限 actor 的分支聚合(含排序键)按可见性裁剪树计算,共享物化列无法回答其排序;受限 actor 默认视图 = O(自身可见集),旧管线即可。admin 默认视图(生产 2000 任务卡顿主场景)O(页)。维护点挂唯一铸行点(task.ts)同事务向上传播;invariants 自愈规则与真启动路径集成断言列遗留(oracle 已锁回填算法=快路径假设)。
- **PR-5 ✅**(`f64f0db3` + `99faae98` + `b8bc7d02` + `1c4d5432`;另 `8ee9fc8d` 补 T17 settings 控件与 bounds parity):T25-T30 主体交付——
  - T25 `components/VirtualList.tsx`(@tanstack/react-virtual 包装;两处 jsdom/塌陷防御都包装官方实现:observeElementRect 丢弃 0×0 测量〔core 挂载时同步 getBoundingClientRect 覆盖 initialRect〕、measureElement 量 0 回退 estimateSize〔否则超视口列表塌缩〕;rowRole/tail/scrollResetKey/onReachEnd 哨兵)+ 6 条单测含 jsdom 零矩阵回归锁;
  - T27 /tasks 顶层接入(行从 ol/li 改 role 化 div——sizer div 不能作 ol 子元素;三个测试文件锚点 tag→role);
  - T28 /repos:后端 `listCachedReposPage`(SQL 下推 + keyset〔migration 0181 复合索引替换单列〕+ 页内三源 refCount + facets 恒全量;C7 无参兼容)+ 180 组合逐页 oracle/EXPLAIN/C7 双形状锁;前端表格→operations 网格 + VirtualList + 350ms 去抖 + keepPreviousData(RFC-035 data-table 锁随之更新锚点);
  - T26 `usePagedList`(+keepPreviousData)/`useDebouncedValue` 公共原语、useWsInvalidation leading+trailing 合并窗(1s)、RelativeTime tooltip 惰性化、workflows 投影瘦身(C2)、reviews/clarify 轮询 10s→30s+focus;
  - T30 `scripts/perf-seed.ts`(§6 基准库,全量实测 93 秒 / 3.6GB)+ `scripts/perf-bench.ts`(§6.1/6.2/6.3/6.5 HTTP p50/p95,分档轮次 + `--only`;不进 CI 门禁)。**基准实测结果见 `bench-results.md`**。
- **基准实测驱动的两处修复**:①`822a20bf` keyset 断点改**行值比较**——展开式 `a < ? OR (a = ? AND id < ?)` 在绑定参数下让 SQLite 选 MULTI-INDEX OR + TEMP B-TREE 全排序,翻页 197.5ms → 29.8ms(字面量 EXPLAIN 复现不出,plan 断言必须用 `?`);②`d7924346` perf-seed 的 url_hash 唯一化。
- **实现门(仓规双门之二)**:因本轮跨他人提交,按 `docs/dev-gotchas.md` 的定式改用三路**刻意错开视角**的独立子代理(正确性 / 不在 diff 里的连带面 / 测试有效性变异检验)替代 codex `--base`。
  - **PR-5 遗留**:/tasks 的 tick 收敛(页级 now context)与 useTaskOperationsSync 定点刷新维持现状(虚拟化后不可视行不挂载已消大头);Playwright 大 seed e2e 未做(bench-results.md 收口时一并);/code work-items nextCursor 修复继续避让(RFC-310 前端批在制)。
- **实测遗留缺口(bench-results.md 详列,均已登记不隐瞒)**:**G1 过滤视图仍走旧穷举管线**——10 万任务下单次 68 秒且是一条 SQL(同步单连接 ⇒ 期间整站冻结);生产数千任务量级约 1~2 秒。建议下一个 RFC 把快路径扩到纯 tasks 列过滤(难点是 context-ancestor 语义),可立即做的缓解是给旧管线加查询预算保护。**G2** overview 50.7ms / workgroup 徽章 13.2ms 未达 §6.3 的 10ms(比改造前的 15 秒低三个数量级,但如实记账;可选优化:9 计数合成 1 条 SQL)。**G3** 归档器首轮清 980 万行 backlog 需多轮 tick(单轮预算 20 万行 = 72 秒可打断工作量,稳态后高水位生效近乎无事)。
- **PR-6 ✅**(T19 终态任务归档,proposal §5 C1 的实现):`services/taskArchive.ts`(整树判据 / manifest+JSONL 导出 / runs·logs **挪移** / 先落盘后删库的原子性 / boot 扫 `.tmp-*` 两分支恢复 / 有界 sweeper,默认**关**)+ `POST /api/tasks/archive`(`settings:write`,**dry-run 是默认**,`dryRun:false` 才执行)+ 设置页维护入口(预览→ConfirmDialog 二次确认)+ `task_archive_audit`(migration 0182;刻意**不进任务级联族**——被记录的任务行马上就没了,审计必须活得比它们久;sweeper 空转不写行以免每小时一条噪音)。
  - **落地修正(测试驱动,两条都是真 bug)**:①手动入口不能把 `retentionDays=0`(配置语义 = 关)当 cutoff 用——那会把**每一棵终态树**立刻不可逆删掉,现返回 422 `task-archive-retention-unset`;②`SETTINGS_CONFIG_SCOPE_KEYS.gc` **漏登记 4 个键**(`taskArchive` + 实现门 P1-5 的三个保留旋钮),后果是界面能改、点保存无报错、值被静默丢弃。补齐白名单并新增 `tests/settings-scope-coverage.test.ts` 自动对账(扫每个 tab 片段真实读写的 `state.<key>`),已按仓规做变异检验:摘掉任一键即变红。教训进 `docs/dev-gotchas.md` §前端。
  - **CI 绿证**:`54d1109a` 32/32 全绿(PR-6 三批:`6bcd59ca` 主体 + `03de004c` 收两格红 + `54d1109a` 换 `/repos` linux 视觉基线)。`6bcd59ca` 暴露的两条记账:①`route-error-code-coverage` 红在 `task-archive-invalid` 漏测——**本地三轮 gate 全绿而一提交就红**,因为该守卫用 `git ls-files` 枚举路由文件、看不见 untracked 的新文件(定式与同族另两种「空洞绿」已落 `docs/dev-gotchas.md` §测试/CI 头一条);②`/repos` 视觉基线间歇红,定位为 PR-5 虚拟化的**真实布局抖动**(滚动条时有时无 ⇒ 行内容整体左移 15px;macOS overlay 滚动条不占位,所以本地 45/45 恒绿、复现不了),修的是产品——`VirtualList` 常驻 `scrollbar-gutter: stable`,用户侧筛选/加载时的列宽跳动一并消除。
  - 顺带修 `tests/nav-memory-tab.test.tsx` 的 20ms 固定睡眠竞态(d916451c 上 Windows frontend shard 3/3 唯一红,其余 8 shard 绿),改等「请求已发出 + QueryClient 空闲」的确定性锚点。
- **遗留(不阻塞收口,记账)**:T20 维护入口(opencode-stores 清理 / freelist 提示 / `db compact` CLI);T21 prompt_text 外置;/code work-items nextCursor 修复(T29 余项;与 RFC-310 session 明确交接:其 PR-10 只做删除波不塞功能增强,`ActivityPanel`/`WorkItemRounds` 与 `api.get<{items,nextCursor}>` 原样保留、后端 cursor 语义未动,**待 PR-10 落地后由本 RFC 侧按 /repos 同款做法接翻页**);sessionView 上限、getNodeRunStdout 截断;development retention_state sweeper 与 code rollup 表(归属 RFC-310/code-capability 域)。
