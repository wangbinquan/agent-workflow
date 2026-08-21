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
- **WS 广播的出站 fence 每帧每订阅者一次同步 SELECT**(由并发的 RFC-312 session 顺路挖出并明确让给本 RFC):
  `ws/registry.ts:1015-1035` 的 `authorityRevisionCurrent` 在 `sendJson` 里**无条件**跑
  `SELECT status, access_revision FROM users WHERE id = ?`,且走 `db.$client` 同步查询——对**所有**广播
  通道生效(tasks-list / workflows / memories / 任务详情),量级是「帧数 × 订阅者数」,随开着的 tab 数走。
  本 RFC 治的 L1/L2 是**查询形状**,这条是**常驻读频次**,同族但未覆盖。做法:由 identity-access 单写者
  维护内存镜像,整条归零。**本轮不做**——已交付面已经很大,再塞一个 WS 出站 fence 改造风险与收益不匹配。
- **WS 升级重复解析同一 token**(同上来源):`ws/server.ts:134` 的 `resolveActor` 与 `:200` 的
  `buildWsCredential` 各跑一遍 `lookupActiveSession`,每次升级 5 读 + **2 次** `UPDATE last_used_at`;
  `:196-200` 的注释自己写着「同一个 token 刚被 resolveActor 消费过」。已与 RFC-312 session 约定:
  它在其必经路径上,由该 RFC 顺手修;若它决定不做则回落本清单。
- **两处前端分页接入**(后端均已就位,只差消费端):①`/api/code/missions` 已支持 `?limit&cursor` 双形状
  (本 RFC 已交付),`routes/code.missions.tsx` 仍取全量;②`/api/code/work-items` 后端**早就返回**
  `nextCursor`,`routes/code.tsx` 的 `ActivityPanel` 取到了却丢掉、只渲染首页(RFC-310 前端批重写后
  行号已漂移到 `:392-398`,按 `ActivityPanel` 定位)。两处接入方式同 `/repos`(`usePagedList` + 滚动哨兵)。
  本轮未做的原因见下文§未完成项第 1 条——不是排期,是这两个文件在制且引用未追踪文件。
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
- [x] 全部 oracle/EXPLAIN/参数上限回归绿;exact-SHA CI 证据分两段——基准期 `822a20bf` 上 RFC-311 面全绿
      (唯一红是并发 session 的 rfc305 权限计数);收口期 `63b77e17` **32/32 全绿**,末条修复 `453022b6`
      **28 success / 0 failure**、windows 四格全绿(含此前红的 frontend shard 2/3),3 个 e2e shard 为
      `cancelled`(并发 push 取消,非失败,按仓规改看含它的 superseding commit)
- [x] **windows 回归已闭环**:T25/T27 窗口化(`99faae98`)让 `tasks-list-children` 的自动展开用例在 windows
      红了(8225ms);真因是**预算分配**——同文件手动展开那条天然分两段各吃一份全局 `asyncUtilTimeout: 5000`,
      自动展开这条却用同一份 5s 覆盖三跳链,而 windows runner 慢约 10x。`453022b6` 以「确定性锚点(等请求
      发出 + 等 `isFetching()===0`,把三跳拆回多段)+ 显式 15s 预算」修复,真机 CI 验证通过
- [x] `docs/dev-gotchas.md` 补三条:partial-index 蕴含限制、**keyset 断点行值比较**、迁移四件套定式(另加混树 e2e 二进制判据)
- [x] STATE.md / design/plan.md 收口更新
- [x] **前端无界消费全部收口**（三处：/tasks 的 10 秒轮询全量、员工产出摘要、/outcomes），
      等价性由 64 组过滤 × 逐页 oracle + 一条 `blocked` 反证锁定
- [x] **无界读全部有界化**：`getNodeRunStdout` 保尾且读取有界、会话树两段读且定根前缀不可丢
- [x] **性能防护网**（5 条确定性不变量 + 无界读棘轮），落地即抓出并修掉 4 类真缺陷
- [x] win32 视觉基线**经查非本 RFC 义务**（无任何 CI 在 Windows 上跑视觉套件），已销账并转仓级 backlog

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
- **PR-7 ✅**(G1/G2/G3 三处基准缺口全修,10 万任务库实测):
  - **G1 过滤视图快路径 68,201ms → 62.3ms**(约 1100×)。物化 `tasks.root_task_id`(migration 0183)后,
    旧管线的「向上求祖先闭包 + 向下求分支成员」两条递归 CTE 塌缩成一次 `GROUP BY`;设计与边界见
    design.md §4.1。等价性由 27 组过滤 × 3 actor 的逐页逐 id oracle 锁定(慢侧显式钉死旧管线,否则
    退化成快-vs-快恒等),两次变异检验均当场变红。**准入闸门**:库里只要有一行未落根就整条退回旧
    管线(那行会被静默挂错分支)——基准脚本第一次跑就撞到这条,日志里 66.5 秒的 db-slow 正是闸门在
    按设计工作;闸门本身也有测试 + 变异检验。回填 10 万行实测 504ms。
  - **G2 overview 46.5ms → 1.8ms、工作组徽章 10.5ms → 0.6ms**(migration 0184 两条覆盖索引)。证实了
    第一次观测记下的判断:不该合并 9 条 count(会把索引 seek 换成全表扫),根因是谓词列
    (`parent_task_id` / `workgroup_id`)不在索引里、每行为读一个字段回表。
  - **G3 归档器最长单语句 1,190ms → 76ms**(增量扫描按 id 分窗)。**过程中踩了一个更严重的坑并已修**:
    第一版分窗让整轮从 6 秒劣化到 260 秒(43×)——同一个 node_run 横跨多窗口、每窗重问一次总量,
    而 6 条单测全绿。正解是每窗只取候选集 + 分块一条分组语句 + 候选预算;判据「单测证明不了没改坏
    代价」已落 `docs/dev-gotchas.md`。
- **G4 + T20 + T21 ✅**(`dfda2d02` 及此前若干批):G4 = 备份并发计时断言 + `/repos` facets 短 TTL 缓存;
  T20 = `opencode-stores` 退役清理 / freelist 提示 / `agent-workflow db compact` CLI(拒绝在 daemon 存活时跑);
  T21 = node_run prompt 正文按 **4 KiB 阈值**外置到 `runs/{taskId}/prompts/{nodeRunId}.md` + **永久双读**(旧行不回填)。
  T21 两处落地修正:①设计里的 `runs/{taskId}/{nodeRunId}/prompt.md` 会被 runner 的 `rmSync(runRoot)` 连带删掉,改挂
  `prompts/` 同级目录;②守卫第一版做成文件级判据、变异检验证明**锁不住**(import 还在就恒绿),改成行级 +
  把已解析字段改名 `promptBody`,让「列」与「正文」在类型层分得开。

- **mission 分页 ✅ 后端 / ⛔ 前端**:`listMissionSummariesPage` + `GET /api/code/missions` 双形状(无参保持旧
  `{items}`,带 `limit`/`cursor` 才 `{items,nextCursor}`)已随 `7c542729` 落地,逐页序列 === 旧全量顺序、
  行值断点、三个 422 错误码逐条点名(`e9b8aa76` 补)。

### 收口(2026-08-20 全部完成)

1. **`/code` 与 mission 列表的前端翻页 ✅**。原受阻理由(那两个文件在制且引用未追踪文件)已随
   RFC-310 前端批落地消失。落地时形态已变,如实记账:
   - `/code work-items` 的消费点**随 RFC-310 的前端重写整个删除**(前端已无引用),该项自然消解;
   - `code.missions.tsx` 改成重定向到 `/tasks?category=digital-employee`,无请求;
   - 真正的无界消费转移到**三处**:`tasks.tsx`(10 秒一轮取全量)、`code.config.detail.tsx`、
     `code.outcomes.tsx`。三处全部处理完,见下。

2. **`/tasks` 的 mission 过滤与 facets 下推服务端 ✅**(`b9055371`)。此前取全量再前端
   `filterDigitalEmployeeMissions` + `digitalEmployeeFacets`,且**10 秒一轮**。状态映射
   `digitalEmployeeTaskStatus` 从前端搬进 shared——服务端要按同一张表反解 view/statuses,
   两边各写一份必然漂移,而漂移症状是「列表少了几条」这种没人当 bug 的东西。等价性由
   **64 组过滤 × 逐页 oracle** 锁定。写 oracle 时按记忆手抄三个视图桶导致**预言先错**
   (`ACTIVE` 漏了 awaiting_review/awaiting_human),改成复用 shared 的 `taskMatchesListView`
   ——能复用单一事实源的部分别重写。

3. **两处聚合型消费改服务端聚合 ✅**(`39440da2`)。它们不能直接接分页:统计会随翻页增长且
   永远偏小,**比慢更糟**。做法是端点补 `employeeId` 与**原始 mission 状态**过滤,并回
   `counts`(过滤集上按状态分组,行数被枚举封顶)。原始状态过滤不可用 `statuses` 代替:
   任务状态映射把 `blocked` 与 `failed` 并成同一个 `failed`,而 blocked **不是**终态——
   测试里有反证锁住这点。

4. **`getNodeRunStdout` 保尾 + 读取有界 ✅**(`63b77e17`)。此前把「全部归档 + 全部 DB 事件」
   拼成一个字符串(归档侧还传 `Number.MAX_SAFE_INTEGER`)。关键是**读取**也有界:DB 侧倒序
   累到 1 MiB 即停;尾巴被 DB 填满就不读归档(归档严格更旧);归档行数上限命中则整段标为省略,
   而不是拿最旧的一段充数(归档读取器只能从头顺读,取不到尾巴)。截断有显式标记。

5. **会话树 DB 读有界 + 定根前缀保护 ✅**(`ba9a9850`)。这里**不能只保尾**:代码里已记着一次
   真事故——前半段缺失会让 `deriveRootSessionId` 退化成拿子代理当根,整棵树渲染出**错误结构**。
   故取「最早 500 条(定根)+ 最新 20000 条(近期)」两段各自 LIMIT。上限可注入,否则测不出
   「超限时根还对不对」。变异检验:定根前缀 limit 改 0 立刻红。

6. **性能防护网 ✅**(`ed67079f` / `a05bf444` / `8424b0d7`)。见下节。

7. **win32 视觉基线 —— 经查**不是本 RFC 的义务**,已销账**。判据:仓里有 43 张 `*-win32.png`,
   但**没有任何 CI 作业在 Windows 上跑视觉套件**——`visual-regression-nightly.yml` 是
   `runs-on: ubuntu-24.04` 独跑,`windows-platform.yml` 跑的是 win32 ACL 后端测试。也就是说
   刷它们**不改变任何门禁结果**。这些基线目前是无人比对的存量产物,是否该删是**仓级问题**,
   与本 RFC 无关,登记在 `docs/audit-backlog.md` 而不是这里。

### 性能防护网(用户 2026-08-20 要求「增加全面的防护用例」)

`tests/helpers/statementRecorder.ts` + `tests/rfc311-perf-guards.test.ts`。缺口是 CI 既有的
`Perf microbenchmark gate` **只跑纯 CPU 函数、数据库面零覆盖**,而既有计划断言把 SQL 字面量
抄进测试、只锁得住抄进去那一条。做法不是枚举而是**录制**:让被测代码正常跑,把它实际执行的
每条语句连同绑定参数抓下来逐条审计,新增查询自动进入审计面。

五条确定性不变量(不看墙钟,可进每次 PR 门禁):①语句条数不随行数增长(N+1 的充要形态);
②每条读/写语句的 EXPLAIN 不含裸表 `SCAN` 或 `USE TEMP B-TREE`(**用绑定参数跑**);③绑定参数
≤900;④取回行数不随库增长 + 单条语句取回行数有上界;⑤列表不碰重列(重列按 `*_json` /
`*_snapshot` / `*_text` 等**命名派生**,113 个,新列自动纳入)。另有一条**未受保护无界读的棘轮**
(当前 40),因为注册表是主动登记的、看不见新写的 `.all()`——棘轮只许减不许增,每次上调必须
写明**为什么这一处是有界的**。

它落地即抓出并修掉:三条索引缺口(`0189`)、巡检 sweep 的裸表扫描(`0190`)、mission 列表读
`readiness_json`、**`/api/overview` 的记忆计数为了出一个数字把整张表的 markdown 正文搬了一遍**
(根因是 `listMemories` 摘要路径类型窄、SQL 宽)。两处实测校准:SQLite 把有序索引扫描也叫
SCAN(是 keyset 首页应有形态,第一版误报过);注入 `sqlite_stat1` 伪装百万行对拍,计划与小库
一致,故小库判据可信。

**仍登记的扩面项(不阻塞收口)**:注册表覆盖面(徽章/详情/webhook 列表);文本棘轮的漏检面
(裸 SQL / `.get()` / 动态构建器);`sqlite_stat1` 注入未做成常驻判据;前端渲染性能零覆盖;
同步连接阻塞时长无判据(只有墙钟能测,进门禁必 flaky)。
**归属划分记账**:development 的 `retention_state` sweeper 与 code rollup 表虽在 T18 里被点到,
但归 RFC-310 / code-capability 域,不由本 RFC 收口(此条自旧版§未完成项第 4 条移入,避免随重复段删除而丢失)。

### 收口后余项：维护循环的「第一拍」与配置热读（2026-08-21 生产对账修复）

生产（v0.18.11，**已含**字节水位 `765910a3`）实测 `node_run_events` 仍是 78.6 万行 / 1.72GB。
把开发库按同形放大到 78.6 万行 / 2.6GB 逐语句复测后，两件事分开了：

- **水位与归档器本身没问题**：一拍削 20 万行（预算上限）、4 拍收敛到 20 万行 / 389MiB，
  一拍 1151 条语句里只有 2 条 >50ms（53 / 55ms）。收敛值高于 256MiB 目标是因为字节水位按
  **最近 1000 行**采样估算行宽（该库尾部均值 1264B、全表均值 1993B），偏 1~2 倍属预期。
- **装配层有洞**：`startEventsArchiver` / `startTaskArchiveSweeper` 只挂 `setInterval(1h)`、
  没有 boot 首拍 ⇒ 重启比周期更勤的部署一次都不会执行；`startWalCheckpointLoop` 读 boot
  配置快照且 `intervalMs<=0` 时连 timer 都不建 ⇒ 把 `walCheckpointIntervalMs` 由 0 改成
  600000 后不重启永不生效。

修复：两个 sweeper 加 boot 首拍（`MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS = 30s`，`stop()`
连未触发的首拍一起撤）；checkpoint 循环改为每拍热读 `getIntervalMs()`（快照期间跳拍**不**推进
水位、失败才推进，避免 5s busy_timeout 冻结变成每拍常态）。判据 `tests/rfc311-maintenance-boot-tick.test.ts`
（红→绿：修复前 3 条「该发生」全部超时）。通用教训落 `docs/dev-gotchas.md` §dev-env / daemon。

同批实测但**未修**、留作后续（形状仍在，只是被水位掩住；建议单独立 RFC）：
`autoKill.ts` 的 `LEFT JOIN node_run_events + max(ts) + GROUP BY` 在 20 个 running run 上实测
**194.9ms 单条**（归档收敛后 34.6ms）——`stuckTaskDetector.ts:184-196` 早已换成反向 seek，
这里漏了；`sessionView.ts:138-144` 的 `ORDER BY ts` 造成 TEMP B-TREE，10.8 万事件的 run 上
实测 **461.5ms + 122.0ms**（收敛后 <50ms），改按 `id` 排即纯反向 seek，但 subagent 回灌下
ts 与 id 不严格同序，属语义取舍；事件写入无批量合并（`runner.ts:1536/1550/1610` 每行 stdout
一条 autocommit INSERT）是语句数与 -wal 增长的根，对应 proposal §3 非目标里那条「写入即落盘
JSONL、DB 只留活跃尾部」的二期。
