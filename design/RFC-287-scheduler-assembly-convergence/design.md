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
  HTTP)，互不排队；**峰值子进程 = agent + script 两池之和**（code-host 不产生
  子进程，只是在途 HTTP 并发上限——`config.ts:561` 注释与 `processNodeConcurrency.ts:15`
  的现有表述都是对的，G4 改头注时**不得**动那一句）（`processNodeConcurrency.ts`；其头注
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

## 9. G5/G6/G7 —— 启动路径（独立批次，可单独回退）

**边界声明**：本组与 §2-§7 的骨架收敛**无实现耦合**，共处一个 RFC 仅因决策同源
（均出自 2026-08-13 的逐问拍板）。各自独立 commit、独立 gate，回退互不牵连。

### 9.1 G5 `file://` 公开面下线

- 拒绝点：launcher 提交、`POST /api/tasks` 族、定时任务配置保存。判据复用
  `shared/git-url.ts` 的既有解析（`parsed.kind === 'file'`），**不新写解析**。
- 内部通道保留：服务层 `internalSource`（RFC-165 设计门 F4/F19 既定的非公开面）
  与测试夹具不受影响。加一条源码锁：公开面 schema 必须拒绝、内部面必须仍接受。
- **存量不 grandfather**（proposal §7）：拒绝发生在**启动校验**而非注册时，所以
  存量仓行、历史任务、列表展示全部保留，只是不可再启动。定时/webhook 触发同样
  拒绝并留失败记录。
- **e2e 连带代价（T11 前置子任务）**：`e2e/commit-push.spec.ts` 现在是**经公开
  API、用 `file://` 指向一个裸仓**来模拟远端的——公开面一拒，这条 e2e 即断。
  替代方案按优先级：①本地起 `git daemon` 用 `git://127.0.0.1:<port>/repo`
  （git 自带、真远端协议、仍走公开面，最贴真实）；②本地 HTTP git 服务；
  ③退而求其次给 e2e 走服务层 `internalSource`（**不推荐**：绕开公开面就失去了
  端到端的意义）。**不引入「测试专用后门」开关**——生产代码里的 bypass 开关
  迟早会被当成正经能力使用。

### 9.2 G6 窗口化重试与硬失败

- 位置：`gitRepoCache.ts` warm path 的 fetch 失败分支（现 :501-518 的
  「warning + 陈旧镜像」）。
- 分类器（纯函数、直测）：网络类（超时/连接重置/DNS/临时不可达）→ 可重试；
  鉴权、仓库不存在、无权限、分支不存在 → 立即失败。**分类必须保守**：无法归类
  的错误按不可重试处理（避免把「配置写错」拖满整个窗口）。
- 窗口语义：`repoPrepRetryWindowMs`（新配置，默认 60_000）约束的是**失败之后还
  愿意再试多久**；单次 git 操作自身的超时仍走既有预算，正在推进的克隆不被打断。
- 冷克隆路径同样适用（首次 clone 失败也按此重试）。

### 9.3 G7 准备异步化

- 顺序倒置：现 `materializeWorktree`(task.ts:1402/1751) → `insert(tasks)`(:2255)
  改为 先 insert(pending) → 后台准备 → 成功写 `worktreePath` 并进入调度 /
  失败 `setTaskStatus(failed)` 且 `errorMessage` 可读。
- **不变量破坏面**：「有任务行就有工作树」。`worktreePath` 在 backend 有 519 个
  引用文件，T13 第一子任务是**全面清点 + 分类**（读工作树 / 读 DB 字段 / 仅传递），
  逐处决定「空值早退 + 明确提示」还是「等待准备完成」。既有先例：`gc.ts:124` 已有
  `worktreePath === ''` 分支。
- 状态：复用 `pending`（用户拍板不新增状态）。准备阶段的可见性经既有 lifecycle
  面表达（准备中/已重试 N 次），不新增状态机节点。
- 重试语义：`retryTask` 按任务当前阶段分派——处于准备阶段则重跑准备；已有工作树
  的任务维持既有节点级重试语义。

## 10. 第二轮设计门修订（2026-08-13，两半场并行评审）

本节**取代** §2/§4/§8/§9 中与之冲突的表述；实现以本节为准。

### 10.1 merge 处置改为「逐线实测矩阵」，唯一真默认只有 throw（骨架 P1-1）

原 §2 把 L4 的处置当成四线共同默认，实测**不成立**：

| 线              | ok                                                 | conflict-human                                                                                                                                 | throw                                    |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| L4 agent-single | merge→done                                         | `keepIso` + `awaiting_human`（:6162-6175）                                                                                                     | keep + markMergeFailed（:6177-6194）     |
| L5 shard        | merge→done                                         | **不 keep** + `failed`，finally 照常 discard（:7925-7932 / :7954；源注 :7899-7904 明说「FAILS the shard loudly」，per-shard 挂起是 follow-up） | keep + markMergeFailed                   |
| L6 aggregator   | 同 L5（:8350-8357 / :8387）                        | 同 L5                                                                                                                                          | 同 L4                                    |
| L7 script       | merge→done（成功后 iso 现状不 discard，C2 改即时） | `awaiting_human`，因 `succeeded && !isReadonly` 使 :4592 谓词为假而**碰巧** keep                                                               | 漂移 A：无 try/catch（C1 修为同 L4）     |
| L1 wg host      | done                                               | **abandon + failed**（RFC-187 T8）                                                                                                             | `keepHookIso` + **重抛**（entry replay） |

⇒ **唯一可作默认的是 `throw → keep + markMergeFailed`**。conflict-human 的三种
形态全部走声明式登记 + 豁免锁。**C8 决策**：L5/L6 的「记 conflict-human 却
discard iso」是孤儿承诺 bug，改为 `abandon`（不改 fail-all 语义、不引入 per-shard
挂起）。⚠️ 现有测试**无一能拦**这类翻转（`merge-back-conflict` 只命中 rfc187
两个文件；s18/s19 套件里 conflict/awaiting_human/keep 一字未出现）——AC-12 的
红→绿对必须新建。

### 10.2 spec 增「合并相位」与两个缺失钩子（骨架 P1-2 / P2-5 / P3-5）

```ts
interface AssemblySpec<TResult> {
  pools: Semaphore[]
  iso: { create(): Promise<IsoHandle> } | null // 删死字段 persistBase（五线全调）
  resolveRunRow(ctx): Promise<RunRow>
  buildSpawnArgs(ctx, row): SpawnArgs
  beforeSpawn?(ctx): Promise<void> // 钉在 iso 物化的同一个 try 内
  // （L5 T14 undo 现状：未兜住的抛出
  // → releaseSub/releaseGlobal + warn +
  // failed 'iso-setup-failed'，行留 pending
  // 不 settle；保持同形，见 P2-6）
  spawn(ctx): Promise<SpawnOutcome>
  /** 合并相位判定——**四种**「跳合并」都要有名字。**`SpawnOutcome.park` 字段
   *  就此作废**（§2 那句以 park 布尔短路 mergeBack 的规定被本节取代）。
   *  **判定序写死**：`passthrough` **先于**一切其它判定（五线全部以
   *  `!handle.passthrough` 门控 merge :1327/:6133/:7897/:8325/:4564，且 L1 的
   *  discardWrites 也被同一个 passthrough 包着 :1311——passthrough 时**不**
   *  abandon，保 RFC-130 golden-lock：persistIsoBase:97 早退、merge_state 恒 NULL）。
   *  keep 由各线自填：L4 clarify-park **keep**（:6131-6132，D19 同 session 续跑要
   *  原 worktree）；L1 clarify-awaiting **不 keep**（:1294-1298 直接 return、
   *  finally 无条件 discard）。 */
  mergePhase(
    ctx,
    outcome,
  ):
    | 'merge'
    | {
        skip: 'passthrough' | 'park' | 'abandon' | 'readonly'
        keep: boolean
        onSkip?(ctx): Promise<void>
      }
  /** 线级 catch-all——**逐线载荷不同，不得统一**（第三轮门 P1-1）：
   *  L1 :1381-1384（log.error + failed）；L5 :7941-7950 / L6 :8374-8383
   *  （broadcastNodeStatus(failed) + `retry:{retryIndex, failureCode:null}`，而
   *  `shouldRetryNodeFailure(null)` 返回 **true** :1543-1549 ⇒ **今天「分片体内抛
   *  异常」会重试 maxRetries 次**，外层 dispatchFanoutShard:7521-7535 再入）；
   *  L4 :5415/:6196 与 L7 :4495/:4590 是 try/finally **无 catch**，抛出直穿到 scope
   *  循环（返回 'rethrow' 保持该语义）。
   *  ⚠️ §2 那句「未兜住的抛出=装配失败」**只对 beforeSpawn 成立**，不得当通用规则
   *  ——否则 L5/L6 的抛出重试被静默取消、L4/L7 的传播语义被改。 */
  onUnhandledThrow?(err): TResult | 'rethrow'
  mergeBack: { run(ctx): Promise<MergeOutcome>; disposition?: Disposition } | null
  onIsoSetupFailure(err): TResult // 五线 message/summary 各不相同，
  // 属产品可见面、不吃「日志措辞」豁免
  retryPolicy?: {
    // 模式 B 专用
    shouldRetry(outcome, attempt): boolean
    isoOnRetry: 'always-recreate' | { keepIf(ctx): boolean } // L7 无条件重建
    // （:4502-4525「what makes retrying a
    // file-writing script safe」）；
    // L4 仅 !followup 时重建（:5472-5504）
    onNextAttempt(ctx): Promise<void>
    onIsoRecreateFailure(err): TResult
  }
  settle(ctx, outcome): Promise<TResult>
}
// **settle 相位写死**（P2-3）：settle 在 finally **之后**，不得收进许可窗口
// （L4 的 settle 段 :6204-6319 含 DB 写 createClarifyRound :6261-6312；L7 的
// `if (succeeded) return ok` 亦在 finally 之后 :4597。收进窗口 = 跨 clarify-round
// 的 DB 写持有 daemon 级 permit，与刚入契约的 RFC-208 关注面同源）。
// **persistIsoBase 相位定音**（P1-2）：归**主 try（许可保护区）内、setup try 之外**，
// 抛出经 finally 释放后继续向外传播——采用 L4/L7 现状（:5415-5422 / :4495-4496；
// L4 :5416-5421 注释逐字写明它曾裸露在 acquire 与 try 之间、一抛就漏 permit）。
// L1/L5/L6 今天在 setup try 内（抛出→释放许可+返回结构化 iso-setup-failed），
// 迁移后结果形态改变 ⇒ **进 C 表（C10）配红→绿**，不得静默统一。
// ctx 必须显式携带：nodeRunId（模式 B 下逐 attempt 变）与 isoKeyRunId（恒定，:5372）
// ——merge/keep/discard 各 key 在哪个上是 D17 与 crash-replay 的命门。
```

**新增契约条款**：`finally` 中**许可释放必须先于 iso 清理**（五线现状一致：
L1 :1393-1395 带 RFC-208 事故注释、L4 :6197-6201、L5 :7952-7954、L6 :8385-8387、
L7 :4591-4593）——这是 RFC-208 修过的真事故，入契约并加锁。

**L1 第三处置补登**（决策 1 的「两处」实为三处）：`discardWrites`（:1311-1326，
RFC-167）→ `abandon('discard-writes')` + **done** + finally discard，与 park 完全
相反；`rfc167-dynamic-workflow-engine.test.ts` 有锁。

### 10.3 取行前奏改为四线×五项矩阵（骨架 P2-4 / P2-3）

`resolveSchedulerRunRow` 的 overrides 必须覆盖：`reviewIteration`（仅 L4/L8）、
`agentOverrideName`（仅 L4/L8）、`consumedUpstreamRunsJson`、`追 retryIndex`
（L9 false）、**`broadcastPending`（L9 false——L9 mint 完直接转 running :4249-4264，
收编若统一广播会新增一条 WS 事件）**。
**重试期铸行是第五、六份手抄**（L4 :5516-5522 带 reviewIteration/shardKey/
parentNodeRunId/consumed(+nonce)；L7 :4533 只带 consumed，而其初次铸行 :4425-4426
是带 shardKey/parentNodeRunId 的）——本 RFC **逐线保持原样**，`onNextAttempt`
不得统一，否则静默改 script 行的 shard/parent 归属。

### 10.4 灭绝锁与挖洞按「每条锁各一份」重写（骨架 P3-2 / P3-3）

原 §5 的挖洞清单把「replay 段 :2756/:2780/:2854」列为 `createIsoUnderLock` /
`persistIsoBase` 的豁免区，实测那三处分别是 `mergeBackAndSettle`(:2756) 与
`discardNodeIso`(:2780/:2854)——两个原语在该段根本不出现。改为每条灭绝锁各写
自己的豁免区。漂移 C 是**三种**拼法不是两种，第三种 `if (isoHandle !== null)`
（:4496/:4536）是 TS narrowing 产物、删不掉，锁的措辞要容纳。

### 10.5 文件落位（骨架 P3-7）

`services/scheduler.ts` 是平铺文件，若新建 `services/scheduler/assembly.ts` 会
形成同名目录与同名文件并存。**本 RFC 落 `services/schedulerAssembly.ts` 平铺**，
目录化留给 RFC-288（D18：随下一个 RFC 顺带迁入 + 留 facade）。

### 10.6 G4 后端修复清单（骨架 P1-3 / P2-7 → C9）

1. `ensureChildTaskBudget` 单例（childBudget.ts:228）**首次闭包被永久保留** ⇒
   capacity 改读 live config，或 PUT 后 rebind；
2. PUT 保存后必须触发 `scan()`（今天 `routes/config.ts` 只调 `resizeAllNodePools`），
   否则「调大配额立刻放行排队中的 call 节点」不成立；
3. `maxInvocationDepth`（scheduler.ts:3204）读任务级快照且被子任务继承 ⇒ 改读
   live config，或在设置页写明「下次**根任务**启动生效」；
4. **既存 bug**：scheduler.ts:762-766 每次任务启动用该任务冻结的 `opts` 重新
   resize 三池 ⇒ 继承旧快照的子任务一启动就把管理员刚调大的 daemon 级池改回旧值
   （`launchRuntimeConfig.ts:122-124` 注释自陈该失败模式）；
5. 前端 `settings-drafts.ts:62-72` 的 `limits` 最小写入白名单**必须登记新三项**
   （注释自陈：漏登记 = 保存被静默丢弃）；`rangeHint` 只在 `max !== undefined`
   时渲染，而三项 schema 只有 `.positive()` 无 max ⇒ 需先定 max 来源。

### 10.7 启动路径半场修订（G5/G6/G7）

- **G5 拒绝两面**（第二轮门 P1-1 定音）：① 启动面收口 `resolveRepoSourceSingle`；
  ② `POST /api/cached-repos/:id/refresh`（routes/cached-repos.ts:62 →
  gitRepoCache.ts:865 `refreshCachedRepo`）同拒。**注册面（批量导入
  repoBatchImport.ts:460 / 仓库组 repoGroup.ts:397）不拒**——那两条直达镜像层、
  绕过 `resolveRepoSourceSingle`，本轮有意不动（存量可见不可运行）。
  全仓**无任何 schema 做协议白名单**（StartTask/StartAgentTask/StartWorkgroupTask/
  RepoAttachmentInput 的 repoUrl 与 batch-import 的 urls[] 全部只 `.min(1)`），
  故拒绝只能落在服务层这两点，不能指望 schema。
  另：`task.ts:1700-1701` 的 `deps.preResolvedSource` 短路是一条旁路缝（当前无生产
  调用方），落地时加源码锁钉死。
- **G5 拒绝点收口**（P1-2）：公开面自 RFC-204 起不传 URL、传 `cachedRepoId`，
  故 schema 层拦 `file://` 对存量**一个都拦不住**。拒绝点放
  `resolveRepoSourceSingle`（task.ts:658）解析出 `sourceUrl` 之后、
  `resolveCachedRepo` 之前——一处同时覆盖 URL 直填 / id 反查 / 仓库组成员 / 多仓
  循环；schema 层拒绝只作「早报错」附加层。另需覆盖 MCP `launch_task`
  （mcp/tools.ts:112-194）、multipart、agentLaunch、workgroups、webhook dispatch。
- **G5 e2e 替代方案改序**（P1-3）：`git daemon` + `git://` **不可用**——
  `parseGitUrl`（git-url.ts:41-143）不认 `git://`，会 `repo-url-invalid`。改用
  本地 `git http-backend` 起 `http://127.0.0.1:<port>/repo.git`（公开面天然接受）。
  e2e 依赖面不止 commit-push.spec.ts：还有 main.spec.ts 三处 + backend 10 个经
  公开 HTTP 面用 `file://` 的测试文件（AC-8 的「118 文件」口径作废）。
- **旧 boot healer 必须同步退役**（P2-5）：`scheduledTasks.ts:807` 的
  `healScheduledLaunchPayloads` 每次 boot 都用 `pathToFileURL` 把遗留 path payload
  **生产成 `file://`**，G5 后等于「出厂即死」；且它对已是 v2-clean 的 payload 早退
  （:875），而 `file://` 行正是 v2-clean ⇒ 新的一次性禁用 healer 不能沿用那段控制流。
- **G5 存量定时任务**（P2-1）：不是「每次触发失败留记录」——连续失败达
  `maxFailures` 会**自动熔断静默停发**（scheduledTaskScheduler.ts:141-142，webhook
  同形）。改为复用 boot healer 模式（scheduledTasks.ts:806-885）做**一次性显式
  禁用 + 可读 lastError**。
- **G6 落点改在启动调用点、并锁 locale**（第二轮门 P2-4/P2-9）：窗口若落在
  `gitRepoCache.ts` 库层，会打红一批以「不可达 URL」为夹具的现有用例（bun 默认
  5s/用例，而 `git-repo-cache.test.ts:230-262` 正是拿 `https://127.0.0.1:1/…` 当
  网络失败夹具），且 `withTimeout` 包住 `withUrlLock` 会让同 URL 排队 N×window，
  还会连带仓库组导入/批量导入 ⇒ **窗口落在启动调用点（task.ts:722 一带）**，经
  deps 可注入（测试置 0）。另：`nonInteractiveGitEnv()`（util/git.ts:35-47）
  **不设 `LC_ALL=C`**，非英文 locale 下 git stderr 会本地化 ⇒ 分类器全部落进
  「无法归类=不重试」的保守分支、G6 静默空转 ⇒ 分类器必须强制 `LC_ALL=C` 或改用
  退出码 + 结构化探测。
- **G6 定性与前提**：见 proposal §2 与 C6。另需明确 `repoGroup.ts:397` /
  `repoBatchImport.ts:464`（唯二容忍 fetch 失败的消费者）是否纳入；窗口在
  `withUrlLock` **锁内还是锁外**必须写死（P2-6：`withTimeout` 只 reject caller
  不取消底层，同 URL 排队会 N×window）；建议 per-urlHash 记「最近一次失败结论」
  供窗口内后来者直接复用。`gitCloneTimeoutMs` 在启动路径**未接线**（task.ts:722/747
  不传，落硬编码 30min）——顺带接线（P2-7）。冷克隆失败（:651-665）分类器也要覆盖。
- **G7 重写（2026-08-13 用户定音：「下载仓库本来就是任务的一部分」）**——第二轮门
  的两条设计级矛盾（复活门互斥 P1-2、取消/停机失效 P1-3）**由这次重构消解**：

  **概念**：仓库准备不是任务的**前置条件**，而是任务的**第一个执行步骤**。据此：
  1. **任务落库即 `running`**（不经「存在但没开始」的 pending 限中态），
     `AbortController` 在准备开始**之前**注册进 `activeTasks` ⇒ 取消 / 优雅停机
     （`abortAllActiveTasks`）/ 删除的 `task-active` 闸**自然生效**；回写
     `worktreePath` 与 kick scheduler 之前做一次状态 CAS 复检，杜绝「已取消的任务
     被准备完成拉起来执行」（P1-3 关闭）。
  2. **准备产生一条合成 node_run**，保留 nodeId `__repo_prep__`——与
     `__commit_push__`（`shared/lifecycle.ts:217` `COMMIT_PUSH_NODE_PREFIX`、
     `services/commitPush.ts:71` `commitPushNodeId`）**同族先例**。隔离机制已验证：
     调度 frontier 由**工作流定义**驱动（`scopeNodeById` / `topLevelIds`），定义里
     没有该 id 的行天然进不了图、也不污染 workflowSnapshot / 校验 / 导出；前端时间线
     按行展示故**天然可见**（用户拍板：要能看到「正在准备仓库」、失败看得到 git
     报错原文、能单独重试）。
  3. **失败** ⇒ 该行 failed + 任务 failed，git stderr 原文进可读错误面。
  4. **重试 = 现有节点重试机制**（`retryNode`），**不是任务复活** ⇒ 第二轮门 P1-2
     的死结消失：不必改 `lifecycle.ts:407`、不必依赖「prunedAt 为 NULL」这个被自己
     抹掉的判别式、不必新增状态或转移。AC-11 相应改写为「对 `__repo_prep__` 失败行
     点重试 = 重跑准备」。
  5. **不变量改写**：「有任务行就有工作树」→「**`__repo_prep__` 行 done 之后才有
     工作树**」。判别式是该行状态，与墓碑/prunedAt 正交。
  6. **仍需逐处处理**（判别式已明确，工作量不变）：worktreePath 空窗口内的消费点
     ——后端四扇读洞（`routes/worktree-files.ts:99`、`services/worktreeFileContent.ts:181`、
     `services/codeIntel/fileSymbols.ts:30-51`、`routes/port-artifacts.ts:121`；
     `routes/tasks.ts:1159/:1186` 两条同族**已有** `=== ''` 守卫可抄）与**全部前端
     消费点**（`tasks.detail.tsx:1919-1924` 的 `resumeStatus()` 把空路径**写死**成
     `worktree-missing`、渲染「重新发起」提示且不出恢复按钮 ⇒ 不改则 AC-11 在 UI 上
     点不到；连带 `lib/task-detail-tabs.ts:94/:119-121`、`tasks.detail.tsx:754/:1037`）。
     AC-10 必须含前端项。
  7. **boot reap / auto-resume**：准备中的任务是 `running` ⇒ 重启后落 `interrupted`
     并进 auto-resume；`resumeTask` 需识别「`__repo_prep__` 未 done」并**重跑准备**，
     而不是 `assertWorktreePresentForResume`（task.ts:2571）直接 410。
  8. **仍未解、须在 T13 给出设计**：`task.ts:2255-2437` 单事务里随物化一起落库的
     其余字段（`repoPath`/`repoUrl`/`cachedRepoId`/`baseBranch`/`branch`/`baseCommit`/
     `repoCount`/`spaceKind` 与 **`task_repos` 全表**、`task_space_nodes`）的占位与
     回填时序；以及所有权/清理协议（`taskRowCommitted` :2439、
     `space.cleanup.state='committed'` :2440、`materializingSpaces`、
     `workflowLaunchCommitHook` :2453）在倒置后的新形态。另：
     `TaskStatusUpdateExtra` 白名单（lifecycle.ts:288-300）**不含 `worktreePath`**，
     回填要么扩白名单、要么接受与状态写撕裂——T13 须定。
  9. **适用边界**（P2-9）：`multipartTaskStart.ts:200` 与 `agentLaunch.ts:459`（有
     上传时）都**先物化再写上传物**，天然保持同步；`deps.materializedSpace` /
     `preCreatedWorktree` / `callLaunch` 三条 handoff 绕过 `materializeSpace`。
     ⇒ C7 显式限定：**无上传的 JSON-body 分支走异步准备，有上传的分支保持同步**，
     两种语义并存是有意为之。
  10. `stuckTaskDetector` 的 pending 阈值（:68-70，子任务已放宽到 30min :73）与
      `childBudget` 的 `COUNTED_STATUSES` 含 pending、`workgroup/room.ts:350`、
      `worktreeBackup.ts:103-112` 均需按「准备中 = running」复核。

### 10.8 锚点勘误（两半场合计）

函数区间普遍向后溢出到相邻注释块：L4 实际 4905-**6320**、L6 实际 8017-**8389**、
L4 内联 retry 循环 **5423-6122**、L1 装配线实为 `runHostNode` **976-1400**
（`buildWorkgroupHooks` 974-1526 的后段是 hooks 对象）；L5 :7539-7956 精确。
`config.ts` 完整路径是 `packages/shared/src/schemas/config.ts`。
「`worktreePath` 519 个引用文件」口径错——**src 内 49 个文件 / 519 处出现**
（含测试 447 文件）。「118 个测试文件依赖 file://」口径错——全仓含 `file://`
的 93 个文件且大量是插件用途；真正经公开面的是 e2e 4 处 + backend 10 个文件。

### 10.9 第三轮门补录（骨架半场，全部为补文字不改方向）

- **C10 新增**：`persistIsoBase` 相位统一到 L4/L7 形态后，L1/L5/L6 的抛出结果形态
  由「释放许可 + 返回结构化 `iso-setup-failed`」变为「经 finally 释放后继续传播」
  ——行为变更，配红→绿。
- **rfc208 两条 oracle 进 T1 重锚清单**：`POOL_RELEASE_NAMES` 释放序 + 「持有 permit
  期间 try-depth 0 上不得有可拒绝的 await」的**扫描器**（:177-199 按「离开持有 permit
  的函数即停止扫描」）——骨架抽走 acquire/release 后该扫描器**结构性失效**，必须
  重定基到 `schedulerAssembly.ts`。
- **§10.5 理由订正**：「同名目录与文件并存」在本仓**已是既定形态**
  （`services/lifecycleRepair.ts` 与 `services/lifecycleRepair/` 并存，子目录无
  index.ts、import 走显式路径）。结论（落平铺 `schedulerAssembly.ts`）不变，真正的
  硬约束是：①`SchedulerState`（scheduler.ts:451）**未 export** ⇒ 新模块须定义结构化
  最小切片（同 `isolatedAgentRun.ts:47` 的 `WriteSemLike`）；②新模块**不得 import
  scheduler.ts**（模块环禁令 + 二进制构建事故）⇒ `resolveMergeConflicts`(:2880) 与
  `broadcastNodeStatus`(:9112) 必须注入；③depcheck 的 KNOWN_VIOLATIONS 按
  (rule,from,to) 精确匹配、停止命中即 fail gate ⇒ 迁移不得让已登记环意外消失或改形。
- **§10.6 补两条**：⑤`scan()` 是 private 且唯一外部入口是**惰性创建器**（从
  routes/config.ts 调会提前建单例并 rebuildFromDb，推翻「无 call 节点零记账开销」）
  ⇒ 需 peek-only 访问器 + 公开 `notifyCapacityChanged()`；capacity 改读盘则
  `scan()` 的授权循环是 O(n²) 次调用（:167-181 每授权一个就 i=0 重扫）⇒ 必须缓存。
  ⑥与 `rfc284-t20-child-inheritance.test.ts` 的**编译期穷尽处置表**冲突（三个池键与
  两个子任务配额键全钉 `'inherit'`）⇒ registry 与快照表两处同步改。
- **空 cwd 护栏形态写死**（P2-7）：`runGit` 走 `git -C cwd`（util/git.ts:136-148），
  `git -C ""` 是 no-op 正是要堵的洞；但它有 **201 个调用点**且调用方普遍只看
  `exitCode`，实现成 throw 会给 best-effort 清理路径（nodeIsolation.ts:1284-1312、
  gc）造出新抛出面——而 C3b 刚把那些改成「吞+warn」⇒ \*\*返回合成 `exitCode !== 0`
  - 可读 stderr**；managedProcess 侧复用既有 `outcome:'spawn-failed'`（:262-278）。
    已核实**零存量误伤\*\*（全仓无一处向 runGit 传字面空 cwd）。
- `resolveSchedulerRunRow` 返回类型**必须带 `retryIndex`**（L4 :5319 / L7 :4409 复用
  pendingExisting 时回读它驱动后续循环，L9 不回读）。
- `iso: {...} | null` 的 `null` 分支本 RFC 内无消费方，注明为预留或删。
- §4「attempt 体进模式 B assembly」与 §10.2「窗口含循环」措辞打架（L4 窗口实为
  :5365-6202）——以 §10.2 为准。
- §10.6-3 的「或写明下次根任务生效」退路**作废**（AC-7/C9 已写死即时生效）。
- **C8 落法指定**：由**调用方补第二次转移**（`conflict-human → abandon`，合法性见
  shared/lifecycle.ts:536-540），不改 `mergeBackAndSettle` 签名。
- 路径勘误：`childBudget.ts` 实为 `services/execution/childBudget.ts`；「五线
  iso-setup message 各不相同」是夸大（L4/L7 逐字相同、L5/L6 同形，仅 L1 拼原始
  message）——钩子保留、理由改。
