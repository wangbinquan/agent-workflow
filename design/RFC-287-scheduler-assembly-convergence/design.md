# RFC-287 — 技术设计（design）

> 现状测绘（2026-08-13 只读子代理）全文收录于 §1；行号锚以 83088a83 为基线，
> 实现期每批第一子任务=逐锚复核（RFC-285 v1 教训沿用）。
> 2026-08-13 设计门（独立对抗评审，pin da706b19 逐锚复核 20+）后修订版：
> §2 三态改「默认处置 + 逐线声明式覆写」（P1-1）、§4 改双模式窗口契约
> （P1-2）、L8 定位/第五漂移/T1 扩容/锚勘误一并落（P2-3..7）。

## 1. 现状地图（测绘交付物摘要）

九条装配线（L1-L9）、骨架步骤 A-J、公共原语位置、四类漂移、参数化自然缝——
详见落档时的测绘报告，关键锚：

- 派发口 if-链 scheduler.ts:5161-5184（call→script→code-host→agent 兜底）。
- L1 workgroup host :974-1527（runNode@:1082）；L2 commit-push :1920-2209
  （@:2030，无池无 iso，try/catch 降级 {message:null}）；L3 merge agent
  :2880-3034（@:2943，**刻意绕池**——§7 死锁：运行于 writeSem 内部）；
  L4 agent-single :4905-6348（@:5966，唯一内联 retry 循环 :5417-6125）；
  L5 shard :7539-7956（@:7825，双许可 + T14 undo :7776-7804）；L6 aggregator
  :8017-8404（@:8256，与 L5 逐字同构少 undo 多 prior-output）；L7 script
  :4360-4904（runScriptProcess@:4710，scriptSem，readonly 分岔，
  **merge-back 无 try/catch——漂移 A**）；L8 call :3051-3728（executor
  facade@:3286，childBudget 配额，领养 RFC-243-LOCK :3132-3167。设计门
  P2-3 定性：L8 实为**第六条 iso 线**——iso :3257 / persist :3283 / merge
  :3684 / markMergeFailed :3657,:3715 / discard :3324,:3723 / 许可=可取消的
  childBudget hold :3240-3251，本 RFC **不迁**，见 §5 挖洞）；L9
  code-host :4167-4359（**无 retry**——D18，HTTP 层幂等重试）。
- **配额/并发面实测（2026-08-13，G4 依据）**：三个**全局独立**进程池——agent
  `maxConcurrentNodes`(4，含 agent 节点/工作组主机/fanout 分片与聚合)、script
  `maxConcurrentScriptNodes`(4)、code-host `maxConcurrentCodeHostCalls`(8，在途
  HTTP)，互不排队故峰值子进程=三者之和（`processNodeConcurrency.ts`；其头注
  「two independent pools」是 RFC-269 加第三池后**未更新的过期表述**，G4 顺带修）。
  另有**每任务**二级池 `multiProcessSubprocessConcurrency`(4)：fanout 分片需
  **双许可**（全局 agent 池位 + 本任务二级池位，scheduler.ts:775/:7759）。call
  节点与合并 agent 不占任何池位。子任务侧另有 `maxActiveChildTasks`(8) 与
  `maxInvocationDepth`(3)。设置页现仅露前两池 + 二级池，缺后三项。
  **等待人工/等待评审/中断三态两层都不占用**：子任务配额计数口径只含
  pending/running（childBudget.ts `COUNTED_STATUSES`），池位在 finally 释放
  （L4 `releaseGlobal` / L7 `releaseScript`）——现状即正确，本 RFC 不动。
- 公共原语：runNode=runner.ts:466；mintNodeRun/nextRetryIndex/
  resolveFrozenRuntime=nodeRunMint.ts；createIsoUnderLock/persistIsoBase
  （:97 自带 passthrough 短路）/mergeBackAndSettle/markMergeFailed=
  isolatedAgentRun.ts；三池=processNodeConcurrency.ts；锁序契约
  scheduler.ts:5354-5364。
- 漂移 A/B/C/D 锚详见测绘 §4（A：script :4564-4588 对照 L4 :6186-6194）。

## 2. 骨架契约（G1）

新 `services/scheduler/assembly.ts`。设计门 P1-1 修订：merge-back 处置**不是
「三态不可绕过」**——L1 有两个**故意的、测试锁定的** per-site 差异（throw →
keepHookIso+**重抛**供 entry replay，:1327-1357 注释明说 unlike the DAG sites'
markMergeFailed；conflict-human → abandon+failed，RFC-187 T8，
`rfc187-wg-merge-conflict-abandon.test.ts` 锁定），且原语头注自declare per-site
（isolatedAgentRun.ts:206-211）。契约改为**默认处置 + 逐线声明式覆写**：

```ts
interface AssemblySpec<TResult> {
  pools: Semaphore[] // 顺序=获取序；释放恒逆序、finally 保证
  iso: {
    create: () => Promise<IsoHandle> // createIsoUnderLock 参数化闭包
    persistBase: boolean // false = L2/L3 无 iso 线不进本骨架
  } | null
  resolveRunRow: (ctx) => Promise<RunRow> // §3 前奏；L8 领养/L1 外部行以 preResolved 短路
  buildSpawnArgs: (ctx, row) => SpawnArgs // 各线私有拼参（prompt/ports/env）
  beforeSpawn?: (ctx) => Promise<void> // L5 T14 undo 唯一消费方；hook 内自兜
  // 异常（现状 fail-open 逐仓自吞 :7784-7802 保持）；**未兜住的抛出=装配失败**
  // （响亮 settle failed，不静默）——P3-8 定音。
  spawn: (ctx) => Promise<SpawnOutcome> // runNode / runScriptProcess 包装
  mergeBack: {
    run: (ctx) => Promise<MergeOutcome>
    // 默认处置（L4/L5/L6/L7 收敛目标；漂移 A 根治=L7 收敛到默认）：
    //   ok → settle；conflict-human → keep + awaiting_human；
    //   throw → keep + markMergeFailed（吞掉后按失败 settle）
    // 覆写（声明式，凡覆写必须带豁免锁）：
    //   L1 onThrow: keepHookIso + rethrow（pending-merge 留给 entry replay）
    //   L1 onConflictHuman: abandon + failed（RFC-187 T8）
    disposition?: { onThrow?: ...; onConflictHuman?: ... }
  } | null
  settle: (ctx, outcome) => Promise<TResult>
  // 第四处置（P1-2 附带）：clarify-park——spawn 结果自身决定 keep + 跳过
  // merge（:6131-6132）。以 SpawnOutcome.park: boolean 表达，骨架据此短路
  // mergeBack 并保 keep；不新增 keep 旁路变量。
}
```

- **keep 状态单一化**：骨架内部唯一 `keep` 域（漂移 B 根治；含 park 与
  disposition 覆写的写入都经它）；finally `if (!keep) discardNodeIso(...)`
  ——不吞异常（`.catch(()=>{})` 形态废除，失败记 warn；见 §5 C3）。
- **persistIsoBase 恒裸调**（漂移 C）：函数自带 passthrough 短路，外部守卫
  两种拼法全删。
- 广播时序：spec 不接管 broadcast 内容，只保证「DB 写落地后才触发」的顺序
  （:4698-4708 注释语义制度化）。
- L7 readonly 的 `discard-readonly` settle 发生在 attempt 内部、**done 写之
  前**（:4880 块「Settled BEFORE the done write」）——相位模型允许 settle
  先于终态写，灭绝 grep 不得把它拉出 spawn 段（P3-9）。

## 3. 取行前奏参数化（G2 之一）

`resolveSchedulerRunRow(tx/db, ctx, overrides)` 收编 4 份手抄
（L4 :5282-5352 / L7 :4386-4431 / L8 :3108-3200 / L9 :4206-4250）：
sameNodeIterRuns → isFresherNodeRun → pendingExisting 复用 ∨
mintNodeRun(schedulerMintCause, nextRetryIndex) → broadcast pending。
overrides：reviewIteration / agentOverrideName / consumedUpstreamRunsJson /
追不追 retryIndex（L9 false）。**L8 的领养分支不进收编**（RFC-243-LOCK
标记的不可铸行区），以 `preResolved` 短路入参绕过；L1 行外部传入同理。

## 4. 双模式窗口契约与 L4 拆分（唯一真手术）

设计门 P1-2 修订：现存**两种因式分解不同构**，字面「inner=assembly 与
L5/L6/L7 同构」不成立——

- **模式 A（per-attempt 窗口）**：L5/L6 的 attempt 函数内含全套装配，许可+iso
  按 attempt 生命周期（:7758-7775）；重试=外层 driver 循环**重入 assembly**。
- **模式 B（跨 attempt 窗口）**：L4/L7 外层**跨 attempt 持有**许可+iso
  （L4 agentSem :5365、iso keyed by isoKeyRunId 跨 attempt 稳定
  :5369-5372——D17 same-session envelope-followup 必须在**同一** worktree
  恢复 session，否则 session 记忆与磁盘错配）；循环内条件 discard+recreate
  :5466-5503、逐 attempt 铸行 :5509、persistIsoBase 重盖新行 :5529。

钉死契约：**assembly=单次许可+iso 窗口**。窗口内由 retryPolicy 驱动 1..N 次
spawn（模式 B），或窗口即单 attempt、由外层 driver 循环重入（模式 A）。两种
模式共用同一 spec；把 L4 改成模式 A 属**重大行为变更，禁止**。

retryPolicy 界面（模式 B 专用，承载 attempt **间**驱动，不承载 keep）：
`shouldRetry(outcome, attempt)` / `onNextAttempt`（中途 iso 条件换手
:5466-5503；逐 attempt 铸行+persist+broadcast :5509/:5529/:6119——per-attempt
failed→pending 广播序列保持）/ `onIsoRecreateFailure`（合成 failed+break
:5488-5502——与初始 iso 失败的 release+return 是**两种处置**，都要表达）。
勘误（P1-2③）：keepIso 三态赋值 :6132/:6170/:6191 全在循环**之后**的处置段，
属 §2 的 keep 域，**不是** retryPolicy 的 attempt 间状态。

L4 拆分 = 内联 retry 循环 :5417-6125 拆 `runAgentSingleNode(outer)` +
attempt 体进模式 B assembly。三台既有机器逐字节保持（P2-7 勘误锚）：
envelope-followup（decideEnvelopeFollowup + followupResumeSessionId
:5432/:5908-5935）、clarify-mode-flip 绕行（:5440-5464 + :5905-5935）、
session 继承（frozenRuntimeOfSession :5956）。**先落对拍测试再动刀**（P2-6
勘误：无 rfc119 套件）：scheduler-envelope-followup-branch /
scheduler-port-validation-followup-decide / rfc092-followup-chain-rollback /
rfc122-clarify-directive-\* / rfc123 / rfc131 / rfc161 / rfc193 套件 + 新增
「拆分前后 OneNodeResult 序列等价」夹具。

## 5. 豁免显式化（G3）

| 线  | 刻意省略                                          | 依据锚                                                                                                                                                                                                                            | 锁形态                                                                                                       |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| L3  | 绕过节点池                                        | :2941 注释 + §7 死锁分析（writeSem 内运行）                                                                                                                                                                                       | 源注升级 + 测试断言「merge agent 不取 agentSem」                                                             |
| L8  | **整线不迁**（不止不取池位；2026-08-13 用户拍板） | 第六条 iso 线（§1）；其许可是**可取消的**子任务配额 hold（`budget.acquire(ancestors,{signal})`，排队中被取消→标 canceled，childBudget.ts:92-114）与信号量池位不同型；RFC-243-LOCK 领养区；且该配额机制本身待重估（proposal §6-7） | 灭绝锁显式挖洞（见下）+ 源注登记「未来批候选」+ **保住「排队中可被取消」的行为夹具**（统一最易做丢的正是它） |
| L9  | 无节点级 retry                                    | :4160-4165（HTTP 幂等重试，重跑重发评论）                                                                                                                                                                                         | 测试断言单 attempt                                                                                           |
| L2  | 无池无 iso + 降级回退                             | canonical worktree 直跑 + {message:null} 容错                                                                                                                                                                                     | 现有 commit-push 套件已锁，补源注                                                                            |

**灭绝锁挖洞清单（P2-3）**：`createIsoUnderLock` 直调与 persistIsoBase 守卫
拼法的「归零」断言均**限定五条迁移线（L1/L4/L5/L6/L7）的函数体区间**，显式
豁免三个存续区：L8（:3051-3728）、wrapper 便车（:8642/:8651）、恢复 replay
段（:2756/:2780/:2854）。AC-1 措辞同步收窄（proposal 已改）。

设计门 F6（:4142-4151「script cannot SHARE」）正面推翻：其理由是 agent 的
sem/iso/retry 块物理位置在 kind 守卫之后——骨架抽取后该前提消失；注释随
迁移改写并引用本 RFC。

## 6. 迁移顺序与回退

L6（最小同构对照）→ L5（+undo 钩子）→ L7（+漂移 A 修复红→绿）→ L1
（行外部传入变体）→ L4（拆分手术，单独一批）→ G3 豁免锁批。每批独立
commit + pin gate + 全家套件；任何一批红→绿对拍不过即整批回退重做，不带病
前进。

## 7. 测试策略

- **T1 扩容（P2-5）**：「全家套件绿」不构成充分对拍——≥20 个测试文件对
  scheduler.ts 做**源码文本锁**，骨架抽取必然大面积红且改锚后失去独立预言力
  （实例：process-node-concurrency :131-132 锁 script 分支体内含
  scriptSem.acquire；rfc130 :129-131 锁 undo 调用在体内；rfc098 :131 锁
  finally-gc 形态；**rfc210 的 L4 merge-throw keepIso 只有源码文本兜底**）。
  T1 交付五件：①源码锁全量清单+逐条改锚方案；②L4/L7 merge-throw **行为**
  夹具（兼作 AC-3 的红，替掉 rfc210 的文本兜底）；③L1 双处置行为夹具
  （throw→replay 可续 / conflict→abandon+failed）；④广播序列快照（L4 逐
  attempt failed→pending :6119/:5525 与 L5/L6 :7748/:7943 两形态）；⑤iso
  discard 失败 warn 路径用例。
- 骨架单元：pools 逆序释放/异常路径释放、keep 域（含 park 短路 + disposition
  覆写）、merge-throw → markMergeFailed 默认（漂移 A 红→绿对在 L7 批）。
- 每迁移批：对应家族全套件 + 源锁改锚（散写段 grep 归零推进式收紧）。
- 终局灭绝锁（带 §5 挖洞）：五条迁移线内 `createIsoUnderLock(` 直调=0、
  keep 同义变量族归零、persistIsoBase 守卫拼法归零。
- 实现门：双路独立子代理（契约核实 + 对抗破坏），pin HEAD 只读。

## 8. G4 配额面可配（末批，独立 commit）

- 后端零改动：三项 schema 已存在（`config.ts:96/:181/:184`，各带 default）。
- 前端设置页补三个 `NumberInput`（复用 RFC-290 `rangeHint`）+ zh/en i18n；分组
  沿用现有并发区块，不新起 chrome（前端统一风格强制原则）。
- 生效语义（AC-7）：三池经 `getNodePoolSemaphore` 的 **resize-in-place**，
  PUT /api/config 保存即对在跑任务与**已排队**节点生效；`maxActiveChildTasks`
  经 capacity 闭包同样即时；`maxInvocationDepth` 于下次 call 节点启动生效。
- 测试：前端三项渲染+改值+范围提示各一；后端 config round-trip；一条源码锁断言
  设置页覆盖全部 6 项并发配额（防再漏）。
