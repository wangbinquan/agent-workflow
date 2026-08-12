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

**零产品行为变更**（例外：§4 C1——漂移 A 的 bug 修复）。三层交付：

- **G1 骨架抽取**：新 `services/scheduler/assembly.ts`（或同级文件）
  `runAssembly(spec)`——收编五个逐字同构段：许可获取/释放配对、iso 物化
  窗口（createIsoUnderLock+persistIsoBase+失败释放）、merge-back 三态处置
  （ok / conflict-human→keep+awaiting_human / throw→keep+markMergeFailed）、
  finally 单一 keep 标志清理、DB-先写-再广播时序。per-line 差异走显式钩子：
  `resolveRunRow` / `buildSpawnArgs` / `retryPolicy` / `settle` / 可选
  `beforeSpawn`（L5 的 T14 undo）。
- **G2 六条 iso 线迁移**：L1(workgroup host)/L4(agent-single)/L5(shard)/
  L6(aggregator)/L7(script) 全部改走骨架；L4 的内联 retry 循环拆成
  outer-driver + inner-attempt（与 L5/L6/L7 同构——唯一真手术）。取行前奏
  4 份收敛为参数化 `resolveSchedulerRunRow`。
- **G3 刻意豁免显式化**：L2(commit-push)/L3(merge agent)/L8(call)/
  L9(code-host) 的「缺池位/缺 iso/缺 retry」全是设计结论（死锁分析 §7 /
  design §6.1 / D18）——不硬塞骨架，改为 spec 字段/源注 + 豁免测试锁，
  防止后来者「顺手补齐」反而改变死锁性质。

## 3. 非目标

- 不动 fanout 内层旁路小引擎（RFC-289/WP-6b 专属）。
- 不动 task↔scheduler 环（RFC-288/WP-5）。
- 不动 wrapper-iso 路径（createOrRebuildWrapperIso/runGitWrapperNode——
  非 spawn 装配线）。
- 不改任何池语义/锁序（writeSem ≺ agent|script ≺ subprocess 契约原样）。

## 4. 能力影响清单

| #   | 变化                                                                                     | 影响                                                                            |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| C1  | 漂移 A 修复：script merge-back 抛出改为 keep-iso + markMergeFailed（与 L4/L5/L6 同语义） | 原「楔死 scope」变「节点 merge-failed 可修复」——纯 bug 修复；成功路径逐字节不变 |

## 5. 验收标准

- AC-1 骨架唯一：五段同构逻辑仅存 assembly 单点；旧散写 grep 锁归零。
- AC-2 六条迁移线各自全家测试套件绿（scheduler-\* 家族 + rfc253-script +
  fanout 家族 + workgroup 家族），对拍零行为差异（C1 除外）。
- AC-3 漂移 A 红→绿对：merge 抛出场景先复现楔死（红）再断言 keep+
  markMergeFailed（绿）。
- AC-4 豁免锁：L2/L3/L8/L9 的四条刻意省略各有测试/源锁，注明设计依据锚。
- AC-5 L4 拆分后 envelope-followup / clarify-mode-flip / session 继承三机器
  行为逐字节保持（现有 rfc119/123/131/161 套件 + 新增拆分对拍）。
- AC-6 每批 pin worktree gate 全绿 + exact-SHA CI 绿；实现门（独立子代理）。
