# RFC-287 — 技术设计（design）

> 现状测绘（2026-08-13 只读子代理）全文收录于 §1；行号锚以 83088a83 为基线，
> 实现期每批第一子任务=逐锚复核（RFC-285 v1 教训沿用）。

## 1. 现状地图（测绘交付物摘要）

九条装配线（L1-L9）、骨架步骤 A-J、公共原语位置、四类漂移、参数化自然缝——
详见落档时的测绘报告，关键锚：

- 派发口 if-链 scheduler.ts:5161-5184（call→script→code-host→agent 兜底）。
- L1 workgroup host :974-1527（runNode@:1082）；L2 commit-push :1920-2209
  （@:2030，无池无 iso，try/catch 降级 {message:null}）；L3 merge agent
  :2880-3034（@:2943，**刻意绕池**——§7 死锁：运行于 writeSem 内部）；
  L4 agent-single :4905-6348（@:5966，唯一内联 retry 循环 :5417-6125）；
  L5 shard :7539-7993（@:7825，双许可 + T14 undo :7787-7803）；L6 aggregator
  :8017-8404（@:8256，与 L5 逐字同构少 undo 多 prior-output）；L7 script
  :4360-4904（runScriptProcess@:4711，scriptSem，readonly 分岔，
  **merge-back 无 try/catch——漂移 A**）；L8 call :3051-3728（executor
  facade@:3286，childBudget 配额，领养 RFC-243-LOCK :3132-3167）；L9
  code-host :4167-4359（**无 retry**——D18，HTTP 层幂等重试）。
- 公共原语：runNode=runner.ts:466；mintNodeRun/nextRetryIndex/
  resolveFrozenRuntime=nodeRunMint.ts；createIsoUnderLock/persistIsoBase
  （:97 自带 passthrough 短路）/mergeBackAndSettle/markMergeFailed=
  isolatedAgentRun.ts；三池=processNodeConcurrency.ts；锁序契约
  scheduler.ts:5354-5364。
- 漂移 A/B/C/D 锚详见测绘 §4（A：script :4564-4588 对照 L4 :6186-6194）。

## 2. 骨架契约（G1）

新 `services/scheduler/assembly.ts`：

```ts
interface AssemblySpec<TResult> {
  pools: Semaphore[] // 顺序=获取序；释放恒逆序、finally 保证
  iso: {
    create: () => Promise<IsoHandle> // createIsoUnderLock 参数化闭包
    persistBase: boolean // false = L2/L3 无 iso 线不进本骨架
  } | null
  beforeSpawn?: (ctx) => Promise<void> // L5 T14 undo 唯一消费方
  spawn: (ctx) => Promise<SpawnOutcome> // runNode / runScriptProcess 包装
  mergeBack: {
    run: (ctx) => Promise<MergeOutcome>
    // 三态处置是骨架不可绕过部分（漂移 A 根治点）：
    // ok → settle；conflict-human → keep + awaiting_human；
    // throw → keep + markMergeFailed（吞掉后按失败 settle）
  } | null
  settle: (ctx, outcome) => Promise<TResult>
}
```

- **keep 状态单一化**：骨架内部唯一 `keep` 布尔（漂移 B 根治）；finally
  `if (!keep) discardNodeIso(...)`——不吞异常（`.catch(()=>{})` 形态废除，
  失败记 warn）。
- **persistIsoBase 恒裸调**（漂移 C）：函数自带 passthrough 短路，外部守卫
  两种拼法全删。
- 广播时序：spec 不接管 broadcast 内容，只保证「DB 写落地后才触发」的顺序
  （:4698-4708 注释语义制度化）。

## 3. 取行前奏参数化（G2 之一）

`resolveSchedulerRunRow(tx/db, ctx, overrides)` 收编 4 份手抄
（L4 :5282-5352 / L7 :4386-4431 / L8 :3108-3200 / L9 :4206-4250）：
sameNodeIterRuns → isFresherNodeRun → pendingExisting 复用 ∨
mintNodeRun(schedulerMintCause, nextRetryIndex) → broadcast pending。
overrides：reviewIteration / agentOverrideName / consumedUpstreamRunsJson /
追不追 retryIndex（L9 false）。**L8 的领养分支不进收编**（RFC-243-LOCK
标记的不可铸行区），以 `preResolved` 短路入参绕过；L1 行外部传入同理。

## 4. L4 拆分（唯一真手术）

内联 retry 循环 :5417-6125 拆 `runAgentSingleNode(outer)` +
`runOneAgentAttempt(inner=assembly)`，对齐 L5/L6/L7 的既有 outer/inner 形状。
三台既有机器逐字节保持：envelope-followup（decideEnvelopeFollowup :1527 +
followupResumeSessionId :6104）、clarify-mode-flip 绕行（:6103）、
session 继承（frozenRuntimeOfSession :6125）。retryPolicy 策略对象承载
attempt 间状态（priorAttemptClarifyActive :5410 / keepIso 三态 :6132/:6170/
:6191）。**先落对拍测试再动刀**：现有 rfc119/123/131/161/193 套件 + 新增
「拆分前后 OneNodeResult 序列等价」夹具。

## 5. 豁免显式化（G3）

| 线  | 刻意省略              | 依据锚                                        | 锁形态                                           |
| --- | --------------------- | --------------------------------------------- | ------------------------------------------------ |
| L3  | 绕过节点池            | :2941 注释 + §7 死锁分析（writeSem 内运行）   | 源注升级 + 测试断言「merge agent 不取 agentSem」 |
| L8  | 不取池位              | :5163（子任务节点自行竞争池）                 | 同上                                             |
| L9  | 无节点级 retry        | :4160-4165（HTTP 幂等重试，重跑重发评论）     | 测试断言单 attempt                               |
| L2  | 无池无 iso + 降级回退 | canonical worktree 直跑 + {message:null} 容错 | 现有 commit-push 套件已锁，补源注                |

设计门 F6（:4142-4151「script cannot SHARE」）正面推翻：其理由是 agent 的
sem/iso/retry 块物理位置在 kind 守卫之后——骨架抽取后该前提消失；注释随
迁移改写并引用本 RFC。

## 6. 迁移顺序与回退

L6（最小同构对照）→ L5（+undo 钩子）→ L7（+漂移 A 修复红→绿）→ L1
（行外部传入变体）→ L4（拆分手术，单独一批）→ G3 豁免锁批。每批独立
commit + pin gate + 全家套件；任何一批红→绿对拍不过即整批回退重做，不带病
前进。

## 7. 测试策略

- 骨架单元：pools 逆序释放/异常路径释放、keep 三态、merge-throw →
  markMergeFailed（漂移 A 红→绿对在 L7 批）。
- 每迁移批：对应家族全套件 + 源锁改锚（散写段 grep 归零推进式收紧）。
- 终局灭绝锁：scheduler.ts 内 `createIsoUnderLock(` 直调=0（全经骨架）、
  keep 同义变量族归零、persistIsoBase 守卫拼法归零。
- 实现门：双路独立子代理（契约核实 + 对抗破坏），pin HEAD 只读。
