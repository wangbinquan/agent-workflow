# RFC-287 — scheduler spawn 装配线收敛（proposal）

状态：Draft（2026-08-13 落档）
来源：`design/system-commons-unification-audit-2026-08-12.md` §5 决策台账 **D3**
（大件一，排 RFC-284/285/286 之后——三者已完工）。方向已拍板，本 RFC 只做工程
落地；现状测绘（2026-08-13 只读子代理，全锚）收录于 design.md §1。

## 1. 背景

审计断言「scheduler.ts 内六条同构 spawn 装配线」经测绘核实并扩展：**runNode
恰好 6 个调用点 + 3 条非 runNode 同构骨架，共 9 条装配线**（agent-single 主跑 /
workgroup host / commit-push / merge agent / fanout shard / fanout aggregator /
script / call-workflow / code-host）。每条重复「许可 → iso 物化 → 铸行 →
组装 → spawn → 结果处置 → merge-back → 清理」骨架，已产生四类实测漂移，
其中一类是 bug 级：

- **漂移 A（bug 级）**：script 线（L7）的 `mergeBackAndSettle` 裸调用无
  try/catch——merge 抛出时 iso 既不丢弃也不 `markMergeFailed`，行停在
  done+unsettled，楔死整个 scope（正是 scheduler.ts:4880 一带 RFC-276 注释
  描述过的形态）；其余三条 iso 线（L4/L5/L6）都有 keep+markMergeFailed 处置。
- 漂移 B：iso 清理守卫两种极性四个同义变量（keepIso/keepHookIso/
  keepShardIso/keepAggIso），其一还吞异常。
- 漂移 C：`persistIsoBase` passthrough 守卫两种拼法（函数自带短路，纯外观
  分叉误导读者）。
- 漂移 D：「取行前奏」（fresher 判定 + 复用/铸行 + broadcast）4 份手抄，
  overrides 各不相同。

## 2. 目标

**零产品行为变更**（例外：§4 C 表——漂移 A 修复 + iso 清理时机统一）。
三层交付：

- **G1 骨架抽取**：新 `services/scheduler/assembly.ts`（或同级文件）
  `runAssembly(spec)`——收编五个逐字同构段：许可获取/释放配对、iso 物化
  窗口（createIsoUnderLock+persistIsoBase+失败释放）、merge-back **默认三态
  处置 + 逐线声明式覆写**（设计门 P1-1 修订：L1 的 throw→replay 与
  conflict→abandon 是测试锁定的合法 per-site 差异，走 disposition 覆写 +
  豁免锁，详 design §2）、finally 单一 keep 域清理（含 clarify-park 第四
  处置的表达）、DB-先写-再广播时序。per-line 差异走显式钩子：
  `resolveRunRow` / `buildSpawnArgs` / `retryPolicy` / `settle` / 可选
  `beforeSpawn`（L5 的 T14 undo）。
- **G2 五条迁移线**（设计门 P2-3 修订：L8 定性为第六条 iso 线但**不迁**，
  归 G3 挖洞）：L1(workgroup host)/L4(agent-single)/L5(shard)/
  L6(aggregator)/L7(script) 全部改走骨架。窗口契约为**双模式**（design
  §4）：L5/L6 = per-attempt 窗口（外层 driver 重入）；L4/L7 = 跨 attempt
  窗口（iso 稳定，D17 same-session 依赖）——**禁止**把 L4 改成 per-attempt
  形态。取行前奏 4 份收敛为参数化 `resolveSchedulerRunRow`。
- **G3 刻意豁免显式化**：L2(commit-push)/L3(merge agent)/L8(call 整线，
  含其 iso 五段与可取消 childBudget hold)/L9(code-host) 不硬塞骨架，改为
  spec 字段/源注 + 豁免测试锁 + 灭绝锁显式挖洞（L8/wrapper 便车/replay 段），
  防止后来者「顺手补齐」反而改变死锁性质。

## 3. 非目标

- 不动 fanout 内层旁路小引擎（RFC-289/WP-6b 专属）。
- 不动 task↔scheduler 环（RFC-288/WP-5）。
- 不动 wrapper-iso 路径（createOrRebuildWrapperIso/runGitWrapperNode——
  非 spawn 装配线）。
- 不改任何池语义/锁序（writeSem ≺ agent|script ≺ subprocess 契约原样）。

## 4. 能力影响清单

| #   | 变化                                                                                                                                                             | 影响                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| C1  | 漂移 A 修复：script merge-back 抛出改为 keep-iso + markMergeFailed（与 L4/L5/L6 同语义）                                                                         | 原「楔死 scope」变「节点 merge-failed 可修复」——纯 bug 修复；成功路径逐字节不变 |
| C2  | 第五漂移统一（设计门 P2-4 新发现）：L7 成功+可写 merge 后 iso 现状**不 discard**（:4592 条件为假跳过，滞留待 GC），L4/L5/L6 成功即时 discard——统一为即时 discard | 磁盘占用更早回收；对用户不可见（该 iso 此后无人读），但属清理时机变化，列此存照 |
| C3  | iso discard 失败由静默吞（≥2 处：L1 :1394-1398、L6 :8236 全静默 vs L5 :7808 记 warn）统一为记 warn                                                               | 日志新增 warn 行；无功能变化                                                    |

**对拍豁免声明**（P2-4）：「零行为差异」判定不含**日志措辞**与上表 C2/C3 的
清理时机/日志级别；广播序列的两种既有形态（L4 逐 attempt failed→pending vs
L5/L6 单点）按线保持、不跨线统一。

## 5. 验收标准

- AC-1 骨架唯一（**限定五条迁移线**，P2-3 收窄）：L1/L4/L5/L6/L7 函数体内
  五段同构逻辑仅存 assembly 单点；散写 grep 锁按 design §5 挖洞清单执行
  （L8/wrapper 便车/replay 段显式豁免）。
- AC-2 五条迁移线各自全家测试套件绿（scheduler-\* 家族 + rfc253-script +
  fanout 家族 + workgroup 家族），对拍零行为差异（§4 C 表及豁免声明除外）。
- AC-3 漂移 A 红→绿对：merge 抛出场景先复现楔死（红）再断言 keep+
  markMergeFailed（绿）；以**行为夹具**落地（替掉 rfc210 的源码文本兜底）。
- AC-4 豁免锁：L2/L3/L8/L9 的刻意省略各有测试/源锁，注明设计依据锚；L1 的
  两个 disposition 覆写同等带豁免锁。
- AC-5 L4 拆分后 envelope-followup / clarify-mode-flip / session 继承三机器
  行为逐字节保持（P2-6 勘误后的真实套件：scheduler-envelope-followup-branch /
  scheduler-port-validation-followup-decide / rfc092-followup-chain-rollback /
  rfc122-clarify-directive-\* / rfc123 / rfc131 / rfc161 + 新增拆分对拍）。
- AC-6 每批 pin worktree gate 全绿 + exact-SHA CI 绿；实现门（独立子代理）。
