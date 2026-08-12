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
- **G4 配额面可配（2026-08-13 用户拍板纳入本 RFC）**：并发/配额共 6 项，设置页
  只露了 3 项。补齐缺的三项——代码平台池 `maxConcurrentCodeHostCalls`(8)、同时
  活跃子任务数 `maxActiveChildTasks`(8)、子任务嵌套深度 `maxInvocationDepth`(3)
  ——到设置页（复用 RFC-290 的 `NumberInput` 范围提示）。**独立末批 + 独立
  commit**，不与零行为变更的收敛批混提。顺带修 `processNodeConcurrency.ts` 头注
  「两个池」的过期表述（RFC-269 起是三池）。

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
| C4  | 设置页新增三个已存在但此前只能手改 config.json 的配额项（代码平台池 / 同时活跃子任务数 / 子任务嵌套深度）                                                        | **能力扩张**：管理员不必登机器改文件即可调；默认值不变，不影响存量部署          |

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
- AC-7（G4）三个配额项在设置页可读可改、保存后对**在跑任务与已排队节点**即时
  生效（`getNodePoolSemaphore` 的 resize-in-place 语义，见 design §8）；三项各有
  前后端测试；过期头注修正。
- AC-6 每批 pin worktree gate 全绿 + exact-SHA CI 绿；实现门（独立子代理）。

## 6. 决策记录（2026-08-13 用户逐问拍板）

以 use-case 为准逐条反问后落定，实现期不得再自行改动：

1. **工作组撞合并冲突 = 丢弃**（用户原话「工作组冲突了就丢弃就行了」）。不做
   「保住工作树让人来解」的能力扩张；L1 的两处处置差异按声明式覆写登记并加豁免
   锁，防后人「顺手统一」把 RFC-187 事故引回来。
2. **脚本节点合并报错照 agent 节点抄**（保留 iso + markMergeFailed + 节点失败可
   单独重试）。经核实两条线的合并是同一原语、同一合并 agent、撞冲突行为已一致，
   唯一差异是脚本线少了 try/catch——纯漂移，无产品分歧。
3. **脚本节点成功后立即删 iso**（C2）。产品界面本就看不到节点 iso（worktree-files
   只服务任务主工作树），留存的唯一效果是磁盘与 `git worktree list` 残留。
4. **完整做骨架收敛**（用户选甲，而非「只摘三处漂移的小刀」）。前提是先补行为
   夹具再动刀（T1 扩容五件）。
5. **五条线，call 节点不进骨架**（用户否掉「为一条今天没漂移的线泛化许可接口」）。
   理由链：call 节点的许可是可取消的子任务配额、形状与信号量池位不同；强行统一
   最易做丢的恰是「排队中可被取消」这一用户可感知行为。灭绝锁给它显式留缺口。
6. **配额面可配纳入本 RFC**（G4，见 §2）。
7. **登记不做**：子任务配额机制本身的重估——用户指出全局只需控制三类叶子节点
   （agent/script/代码平台）的运行；而子任务配额既非算力保护（叶子池已兜）、亦非
   硬上限（resume 回 running 直接计入，文档自认「突发超额是接受的取舍」）、也不
   公平（深树插队致浅层饥饿，>60s 只记告警），且它自身曾制造队头阻塞死锁（P0-1）
   才长出祖先豁免扫描。真正被约束的成本是**工作树棵数**。是否改成直接限工作树、
   或取消只靠叶子池+GC，另立 RFC 评估，本轮维持现状。
