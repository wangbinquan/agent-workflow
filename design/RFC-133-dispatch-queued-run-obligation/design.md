# RFC-133 设计 — in-flight「run 义务」判定 + 报错 details + 看板子集下发

对应 proposal:`./proposal.md`。本文只写技术契约与实现;产品动机见 proposal §1。

## 1. 现状:oracle 谱系与消费点矩阵

`isDispatchedEntryConsumed(entry, runs, lineageViews, mode)`(`clarifyRerunLedger.ts:242`)
是「已下发 entry 是否已消费」的单一 oracle,现行为:

| entry 状态 | `'in-flight'`(守卫) | `'revivable'`(borrow) |
| --- | --- | --- |
| `triggerRunId=NULL`(queued) | **open(阻塞)← 本 RFC 改这里** | open(不变) |
| anchor run 被 GC | open(保守,不变) | open(不变) |
| handler 非 done(pending/running/failed/canceled/interrupted) | open(不变) | open(不变) |
| handler done 无 output | consumed(2026-07-01 死锁修复) | open(不变) |
| handler done + output | consumed(不变) | consumed(不变) |

消费点(五处 'in-flight' + 三处 'revivable'):

| 消费点 | 模式 | 场景 |
| --- | --- | --- |
| `findOpenDispatchTarget`(`taskQuestionDispatch.ts:786`) | in-flight | dispatch 异步预检(:826)**与** in-tx 复检(:637)共用 |
| `hasOpenDispatchedEntryOnHome`(`clarifyRerunLedger.ts:312`) | in-flight | clarify quick-finalize 预检+in-tx(`clarify.ts:629/745`)、crossClarify questioner 提交(`crossClarify.ts:669`)、autodispatch mint 守卫(`clarifyAutoDispatch.ts:184`) |
| `taskQuestionDispatch.ts:1083/1165/1232` | revivable | RFC-127/131 borrow 归属 oracle,**本 RFC 不动** |

被锁定的现契约:`clarify-rerun-ledger-deadlock.test.ts:272`
(`queued (triggerRunId null) / GC-d anchor: NOT consumed (open) — unchanged`)。本 RFC 是对
该锁的**有意识修订**(拆开 queued 与 GC-anchor:后者不变,前者条件化)。

守卫要防的真实危害(RFC-128 P5-BC ship-gate / Codex impl-gate 注释归纳):

- **double-mint**:同 (node, iteration) 出现第二个 open rerun(两个 pending/running 互相
  冲突,ULID freshness 只认新的)。
- **lineage-window 覆盖**:在旧问题未消费时 mint 更新的 rerun,使旧问题绑定的 failed run
  复活后不再渲染其反馈(RFC-131 平铺队列后此危害仅剩 failed-revivable 一族)。

两者的前提都是**目标节点上存在(或本次会产生)一个 open rerun**。一个零 run 或全 done 节点
上的 queued entry 不满足前提——阻塞它是纯假阳性(proposal §1 两类死锁)。

## 2. 新契约:in-flight queued 分支改「run 义务」判定

### 2.1 谓词定义

```
in-flight 模式,triggerRunId === null 时:
  open(阻塞) ⟺
      ∃ r ∈ runs:                            // (a) run 义务
          r.nodeId === effectiveTarget(entry)   // override ?? default
       && r.parentNodeRunId === null            // top-level(与 openImmediateRounds 扫描一致)
       && r.status !== 'done'                   // 未终结 run 义务
   ∨ (mintCause !== undefined                 // (b) cause 序列化(Codex 设计 gate P2)
       && causeClassForEntry(entry) !== mintCause)
  否则 consumed(放行)。
revivable 模式,triggerRunId === null 时:open,恒成立(不变;不接受 mintCause)。
```

`mintCause` = **本次调用方将在该目标上 mint 的 rerun 的 cause class**;undefined = 本次不在
该目标 mint(纯排队)。(b) 是 Codex 设计 gate P2 的 fold:若无此项,idle 目标上挂一条
cause A(如 designer `cross-clarify-answer`)的 queued entry 时,以 cause B(如 self
`clarify-answer`)为由在该目标 mint 的 rerun 会在注入时把 A 也一并 `bindTriggerRun` 绑进来
——异类 cause 塌缩进单个 run,违反 §5.2.12「一个 node_run 一个 rerun_cause、异类分 rerun
串行」契约。加 (b) 后:同 cause 的 queued entry 合法搭车(与单批内 q1+q2 共享一个 mint
plan 同语义),异 cause 的阻塞本次下发、等其自身义务先行解决。

签名变化:`entry` 的 Pick 从 `'triggerRunId'` 加宽为
`'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind'`
(`causeClassForEntry` 需 roleKind);新增可选参 `mintCause?: CauseClass`(仅 in-flight
分支读取)。`causeClassForEntry` 从 `taskQuestionDispatch.ts:151`(私有)**迁移导出**到
`clarifyRerunLedger.ts`(oracle 同模块;dispatch 已 import ledger,方向无环),dispatch 侧
改 import——单定义不 fork。两个 in-flight 调用点的既有行对象均含以上列,revivable 调用点
传整行,零额外取数。effective target 为 NULL(数据异常)→ 保守 open(维持现状路径)。

### 2.2 口径对齐论证

- **`status !== 'done'` 而非 `!isTerminalNodeRunStatus`**:与 `openImmediateRounds` in-flight
  分支(`clarifyRerunLedger.ts:178-180`)逐字同口径。failed/canceled/interrupted 是可复活
  (retry/resume)的 open rerun,放行会引入 double-mint / lineage-window 危害——继续阻塞。
  只有 `done`(成功终结、永不重跑)可安全放行。
- **top-level only(`parentNodeRunId === null`)**:同 `openImmediateRounds`:172-176 的
  continuation 扫描。wrapper 子 run 不构成节点级 rerun 义务;dispatch 的 mint 也只发生在
  top-level。
- **iteration 无关(全节点扫)**:`openImmediateRounds` 按 (node, iteration) 扫是因为轮次
  绑定 asking run 的 iteration;而 queued entry 没有 anchor run、无迭代锚点。全节点扫是
  **保守方向**(只可能多拦、不可能误放),且对本 RFC 要修的两类死锁(零 run / 全 done)
  判定完全一致。loop 场景里旧 iteration 残留 failed run 会多拦一次下发——该 run 本就该先
  resume/retry 清理,不构成新死锁(run 终结后守卫即开)。
- **cause 守卫只作用于「本次会 mint 的目标」**((b) 项 `mintCause` 由调用方给):
  dispatch 只在 frontier mint,非 frontier affected 目标传 undefined——其 entry 纯排队,
  等目标**自然 run**(initial / 级联)时才绑定,而自然 run 混绑任意 cause 的 queued entry
  本就是 RFC-131 平铺队列的既有设计(QMGP5 的 grid-spec 正是走这条路);§5.2.12 的
  cause 串行化边界只覆盖 **dispatch/quick mint 出来的 clarify-cause rerun**。quick-finalize
  的三个 mint 守卫恒传其 continuation 的 cause(self→`clarify-answer` /
  questioner→`cross-clarify-questioner-rerun`)。
- **GC-anchor 分支不变**:anchor 曾存在说明曾有绑定 run,信息丢失时保守 open 合理。

### 2.3 并发安全矩阵(double-mint 防护不回归)

dispatch 的 stamp+mint 在单个 `dbTxSync` 内原子提交(`taskQuestionDispatch.ts:547-706`),
in-tx 复检与异步预检共用同一 oracle。逐态核对新谓词:

| 目标节点状态 × cause | queued entry 判定 | 说明 |
| --- | --- | --- |
| 零 run(never-run 下游)+ 本次不 mint(非 frontier) | 放行 | 本 RFC 主修:该节点无 mint、无危害;entry 等首跑 `bindTriggerRun` |
| 全部 top-level run done(idle)+ 同 cause mint | 放行 | 本 RFC 主修:mint 的 rerun 绑定同 cause 的全部 queued entry(与单批共享 mint plan 同语义) |
| 全部 done / 零 run + **异 cause** mint | **阻塞** | Codex 设计 gate P2:异类塌缩违反 §5.2.12,谓词 (b) 项拦住;等 queued entry 自身义务先解决 |
| 存在 pending run(mint 未 spawn) | 阻塞 | 批 1 tx 已提交 mint,批 2 预检/复检都看得到 → 序列化保持 |
| 存在 running run | 阻塞 | 同上;运行中 run spawn 时已 bind 的 entry 走 handler 分支,本分支管未 bind 的 |
| 存在 failed/canceled/interrupted | 阻塞 | 可复活,放行会与复活 run 冲突(§2.2) |
| done-无-output(又反问) | 放行((b) 仍适用) | 与 handler 分支的 2026-07-01 死锁修复语义一致 |

并发窗口:两个 dispatch 同时过异步预检 → `getTaskQuestionWriteSem` 串行 → 后者 in-tx 复检
看到前者**同 tx 提交**的 pending mint run(`tx.insert(nodeRuns)`)→ `NodeDispatchInFlight`
回滚。新谓词只依赖 txRuns(复检已读),**无新增 tx 读**。

quick 路径(`hasOpenDispatchedEntryOnHome`)同理:它是 mint 守卫,home 即将被 mint quick
continuation;新谓词下「home 挂 queued entry 但无 open run」放行后,quick continuation 成为
home 的第一个 open rerun,spawn 注入时平铺队列一并 bind 该 queued entry(RFC-131 T2/T3
渲染契约)——无 double-mint、无丢答案。`roundHasDispatchedSelfQuestioner`(数据丢失守卫,
keyed `dispatched_at` 含已消费)在其之前运行,不受影响。

### 2.4 QMGP5 修复后走查

第 5 批原样重试:affected={`agent_m7p3n1`,`agent_1k2ftd`}。grid-spec queued、
`agent_1k2ftd` 零 run 且非 frontier(本次不 mint,`mintCause`=undefined;即便按 frontier
评估也是同 cause self)→ (a)(b) 均不命中 → 放行;`agent_m7p3n1` 的 19 条 bound entry →
handler retry-4 done → consumed(不变)。frontier={`agent_m7p3n1`} mint 1 rerun;5 条 entry 全落 `dispatched_at`;
powerup(→`agent_1k2ftd`)queued 加入 grid-spec 行列。`agent_m7p3n1` rerun 注入 5 答案 →
最终产出 → 评审 → `agent_1k2ftd` 首跑 `bindTriggerRun` 双条一起注入。零数据丢失。

## 3. 报错 details + 文案

- `findOpenDispatchTarget` 入参加 `mintCauseByTarget: ReadonlyMap<string, CauseClass>`
  (= 本批 frontier 的 `byTarget` cause 选择;非 frontier affected 不入 map → 谓词收到
  undefined)。异步预检与 in-tx 复检传同一份(均在 tx 前算好,无新增 tx 读)。
  `hasOpenDispatchedEntryOnHome` 加必传参 `mintCause: CauseClass`(三个 quick 调用点都
  静态知道自己 continuation 的 cause)。
- `findOpenDispatchTarget` 返回值从 `string | null` 改为
  `{ nodeId: string; runId?: string; runStatus?: string } | null`(run 义务阻塞带命中的
  blocker run;cause 序列化阻塞只带 nodeId)。`NodeDispatchInFlight` 同步携带。
- 三处 `task-question-node-dispatch-in-flight` ConflictError(`taskQuestionDispatch.ts:711/
  828/868`)统一挂 `details: { nodeId, runId?, runStatus? }`——`DomainError` 封套本就支持
  `details`(`util/errors.ts` §4.2.1),**纯新增字段、无 API 破坏**。message 文本同步改为
  run 义务语义("node 'X' has an unfinished rerun (status)…")。
- 前端 `TaskQuestionList.tsx` 的 `DISPATCH_ERROR_KEYS` 命中时改为
  `t(key, { node })`,`node` = `details.nodeId` 经 `nodeOptions` 映射 label、缺省回退原 id;
  `details` 缺失(旧 daemon / 其他路径)回退现静态文案(key 提供 `_noNode` 变体或
  i18next defaultValue 兜底,实现取其一,测试锁行为)。
- zh/en 文案(`zh-CN.ts:5110`、`en-US.ts:2714`)更新为含 `{{node}}` 插值的 run 义务表述。

## 4. 看板子集下发(推翻 RFC-128 §11.1 全下拍板)

`TaskQuestionList.tsx`:

- 新增 `selected: Set<string>` 局部 state,**默认全选语义用「反选集」实现**:存
  `excluded: Set<string>`,staged 卡勾选框 `checked = !excluded.has(id)`。理由:refetch /
  新一轮问题进入 staged 时默认被选中(与旧「全下」体验一致),无需 effect 同步全集。
- staged 卡片(`phase === 'staged'`)标题行内加原生 `<input type="checkbox">`(复用
  `FilesPicker.tsx:178` / `MemoryRow.tsx:47` 的 inline 模式,不新造组件),带
  `data-testid={`tq-select-${e.id}`}`、`aria-label` 取问题标题。
- `stagedSelected = stagedShown.filter((e) => !excluded.has(e.id))`;按钮文案
  `taskQuestions.batchDispatchCount` 改传 `count: stagedSelected.length`(全选时与旧文案
  等值);`disabled = dispatchM.isPending || stagedSelected.length === 0`;点击只发
  `stagedSelected` 的 id。
- 勾选尊重节点 filter(基于 `stagedShown` 派生,与现状一致);`excluded` 在 dispatch 成功后
  清空;其余相位卡片无勾选框。
- RFC-128 §11.1 的「无逐卡勾选」注释块改写为指向本 RFC 的新拍板记录(2026-07-02 用户反转)。

## 5. 失败模式与兼容性

- **无 schema migration、无 API 形状变化**;`details` 纯增量。回滚 = revert 单 commit。
- 行为变化面**只有三处放行**(queued × {零 run, 全 done} × {dispatch, quick-finalize}),
  其余守卫判定逐态不变(§2.3 矩阵);全选下发 = 旧全下行为 golden-lock。
- 旧数据兼容:存量 queued entry(如 QMGP5 的 grid-spec)无需修复脚本——判定是读时派生。
- dev daemon `bun --watch` 热加载即生效;单二进制发布走常规 release。

## 6. 与进行中 RFC-132 的边界

本 RFC 只动 `isDispatchedEntryConsumed` 的 in-flight NULL 分支、两个守卫的报错载荷、看板
交互;不触碰 RFC-132 的注入器(`buildClarifyQueueContext`)、老化派生(`isTargetNodeConsumed`)、
`openImmediateRounds` 本体。若 RFC-132 后续 PR 统一收编守卫,以本 RFC 落地后的语义为基线。

## 7. 测试策略(必写清单)

后端单元(新文件 `rfc133-queued-run-obligation.test.ts`,顶注链接本 RFC + QMGP5 事故):

1. queued + 目标零 run(无 mintCause)→ in-flight consumed(放行)、revivable open(不变)。
2. queued + 目标全 top-level done(有/无 output 两种,无 mintCause)→ in-flight 放行。
3. queued + 目标存在 pending / running run → 阻塞(mintCause 有无均然)。
4. queued + 目标存在 failed / canceled / interrupted run → 阻塞。
5. queued + 目标仅有 wrapper 子 run(parent 非 null)非 done → 放行(top-level only)。
6. effective target NULL → open(保守,现状)。
7. **cause 序列化(Codex P2)**:queued(designer)+ 目标无义务 + `mintCause='clarify-answer'`
   → 阻塞;queued(self)+ `mintCause='clarify-answer'` → 放行;同两例 revivable 模式忽略
   mintCause 恒 open。
8. bound 分支(handler done±output / failed / GC-anchor)逐态回归断言(不变;bound 分支
   不读 mintCause)。

锁定测试修订:`clarify-rerun-ledger-deadlock.test.ts:272` 拆分——GC-anchor 恒 open 保留;
queued 改为条件化断言并注明本 RFC。

后端集成(`dispatchTaskQuestions` / quick 路径):

9. QMGP5 复现 e2e:self-clarify 两轮、各改派 1 条到 never-run 下游节点,第二轮批量下发
   **成功**(修复前 409,红→绿),断言:全部 entry 落戳、仅 frontier mint、queued entry
   保持 NULL、目标首跑 `bindTriggerRun` 双条绑定注入。
10. idle 变体:目标节点全 done 后再次下发(同 cause)通过。
11. **异 cause 仍串行(Codex P2)**:idle 目标挂 queued designer entry,self 批下发以该目标
    为 frontier → 仍 409;同场景改为同 cause → 通过且 mint 的 rerun 绑定两条。
12. 反例回归:同 home 存在 pending/running rerun 时二批下发仍 409(in-tx 复检路径沿用既有
    并发测试)。
13. quick-finalize:home 挂**同 cause** queued entry 且无 open run → 提交成功并 mint
    continuation;home 挂**异 cause**(designer)queued entry → 仍拒;home 有 pending
    continuation → 仍拒(`clarify.ts` 与 `crossClarify.ts` 各一)。
14. 409 载荷:`details.nodeId` 存在且正确。

前端 vitest:

15. staged 卡渲染勾选框、默认全选;取消 2 条后按钮计数与请求体 `entryIds` 只含所选。
16. 0 选 → 按钮 disabled;dispatch 成功后 excluded 清空。
17. 节点 filter 下勾选集合跟随 `stagedShown`。
18. `dispatchInFlight` 带 `details.nodeId` → 文案含节点 label;无 details → 回退静态文案。

门槛:`bun run typecheck && bun run test && bun run format:check` + 前端 vitest +
`bun run build:binary` smoke;push 后查 GitHub Actions。
