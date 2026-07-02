# RFC-133 — dispatch in-flight 守卫改「run 义务」判定（修 queued 假阳性死锁）+ 看板子集下发

状态:Draft
日期:2026-07-02
触发:实测任务 `01KWFZRQFPZFQQEM8JTCHQMGP5`(QMGP5)第 5 轮反问答案永久无法下发,任务卡死 `awaiting_human`。
关联:RFC-128 P5-BC(in-flight 守卫谱系)、RFC-131(平铺队列/派生老化)、RFC-132(统一注入,进行中,本 RFC 与其相邻但独立)、RFC-120 §18(下发守卫)/§11.1(批量下发全下拍板,本 RFC 部分推翻)。

## 1. 背景(实测事故走查)

任务 QMGP5 是一条 `agent_m7p3n1`(写文档)→ `rev_5h9xpz`(评审)→ `agent_1k2ftd`(写用例)
的工作流。`agent_m7p3n1` 连续 5 轮 self-clarify(每轮 done-无-output 只反问),`agent_1k2ftd`
在下游、**从未运行**(评审通过前不会被调度)。

- 第 4 轮:用户把 `grid-spec` 问题**改派**给 `agent_1k2ftd` 并批量下发成功。因为它非
  frontier,下发只盖 `dispatched_at` 戳、不在其上 mint rerun;答案进队列等它首跑时注入,
  `trigger_run_id` 一直是 NULL(排队中)。
- 第 5 轮:又有一条 `powerup-stacking-duration` 改派给 `agent_1k2ftd`。批量下发的 affected
  集合 = {`agent_m7p3n1`, `agent_1k2ftd`}。
- 守卫 `assertNoInFlightDispatch`(`taskQuestionDispatch.ts:800` →
  `findOpenDispatchTarget`:766 → `isDispatchedEntryConsumed`,`clarifyRerunLedger.ts:248`)
  把 `trigger_run_id=NULL` 无条件判为「未消费/open」→ `agent_1k2ftd` 上有已下发未消费的
  grid-spec → **整批 fail-fast 409**(`task-question-node-dispatch-in-flight`),连 4 条给
  `agent_m7p3n1` 的也一起拒。
- 但 `agent_1k2ftd` 要等 `agent_m7p3n1` 出产物+评审通过才会首跑;`agent_m7p3n1` 又在等第 5
  批答案才能出产物 → **环形等待,守卫给出的解锁条件("等该节点 rerun done+output")永远无法
  满足**。任务永久卡死。

根因定性:**in-flight 守卫把「queued(`trigger_run_id=NULL`)的已下发问题」无条件视为阻塞,
但对一个没有任何未终结 run 的目标节点,并不存在守卫要防的危害**(double-mint / lineage-window
覆盖都以「该节点存在或即将存在一个 open rerun」为前提)。RFC-131 的平铺队列本来就支持多条
queued entry 在目标首跑时一起绑定注入(`bindTriggerRun`,`clarifyQueue.ts:212`)。

两类假阳性死锁:

1. **never-run 下游节点**(本次实测):改派到从未运行的下游节点 × 两轮,第二轮起永久 409。
   RFC-120 §18 明确祝福「改派到 never-run 目标」流程(`taskQuestions.ts:1041` 注释:改派记录
   意图、dispatch 的 `assertSafeFrontierTarget` 只拒 never-run **frontier**),但该流程走第二遍
   就被 in-flight 守卫卡死——两个守卫的语义没有对齐。
2. **idle 已完节点**:问题下发到一个所有 run 都已 done 的节点(下发时非 frontier、未 mint),
   entry queued;之后任何再次以该节点为 affected 的下发同样被永久 409(唯一能绑定它的 mint
   恰恰是被拒的那次 dispatch)。

同一 oracle(`isDispatchedEntryConsumed` 'in-flight' 模式)还被 quick 提交路径的 mint 守卫
`hasOpenDispatchedEntryOnHome` 共享(`clarify.ts:629/745`、`crossClarify.ts:669`、
`clarifyAutoDispatch.ts:184`)——同样的 queued 假阳性会 409 用户的 quick 答案提交。

伴生的两个产品问题(本次一并修):

- **报错不可行动**:409 文案(`taskQuestions.dispatchInFlight`)是静态的("该节点正在重跑,
  请等其完成后再下发"),不含 blocker 节点名,且在死锁场景里指引本身就是错的。
- **一条中毒 entry 拖死整批**:RFC-128 §11.1 拍板「进待下发=已确定,批量下发=全下」删掉了
  per-card 勾选;整批 fail-fast 语义下,任何一条被拒都导致全部无法下发(本次用户唯一的 UI
  出路是碰巧用节点 filter 缩小范围,不可发现)。

## 2. 目标

1. **修死锁(后端根因)**:in-flight 口径下,queued(`trigger_run_id=NULL`)entry 仅当其
   effective target 节点**存在未终结(status ≠ 'done')的 top-level run** 时才阻塞;目标节点
   零 run 或全部 done → 不阻塞。与 `openImmediateRounds` 的 in-flight 口径
   (`status !== 'done'`,2026-07-01 死锁修复)完全统一成「**run 义务**」判定。附加
   **cause 序列化守卫**(Codex 设计 gate P2 fold):当本次会在该目标 mint rerun 且 queued
   entry 的 cause class 与 mint cause 不同,仍阻塞——保住 RFC-128 §5.2.12「一个 run 一个
   cause、异类分 rerun 串行」契约(同 cause 搭车合法;非 mint 目标的纯排队不受影响)。
2. **共享 oracle 一处修**:直接改 `isDispatchedEntryConsumed` 的 in-flight NULL 分支,
   dispatch 守卫(异步预检+in-tx 复检)与 quick 提交路径的 mint 守卫五个消费点统一受益;
   `'revivable'`(RFC-127 borrow oracle)模式行为**不变**。
3. **报错可行动**:两个 in-flight 409 携带结构化 `details`(blocker 节点等),前端 i18n 插值
   展示节点名;文案改为 run 义务语义。
4. **看板子集下发**:staged 卡恢复 per-card 勾选(默认全选、尊重节点 filter),按钮改
   「下发所选 (N)」;**显式推翻 RFC-128 §11.1 的「批量下发=全下、无逐卡勾选」拍板**
   (用户 2026-07-02 拍板反转)。

## 3. 非目标

- 不动 `'revivable'`(borrow)口径:queued → open 恒成立,RFC-127 借壳/borrow 语义零变化。
- 不动 RFC-131/132 的注入、平铺渲染、派生老化模型;不预支 RFC-132 后续 PR 的任何内容。
- 不改 API 形状:`POST /api/tasks/:id/questions/dispatch` 仍收 `entryIds`;错误 `code` 不变
  (`task-question-node-dispatch-in-flight`),`details` 为**新增可选**字段(封套 §4.2.1 本就
  支持)。
- 不引入「按问题逐条下发到任意节点」等新调度语义;frontier mint / auto-split / 多目标拒绝等
  其余守卫全部原样。
- 不做 stage/unstage 交互重构;unstage(移出待下发)保留,勾选只作用于本次下发请求。

## 4. 用户故事

- US-1(死锁解除):作为任务 owner,我在多轮反问中把部分问题改派给尚未运行的下游节点后,
  仍能继续答题并下发后续轮次;被改派的答案在下游节点首跑时自动注入,不丢失。
- US-2(quick 路径):作为任务成员,我在 quick 面板提交某节点的反问答案时,不会因为该节点
  挂着一条「排队等首跑」的改派问题而被 409。
- US-3(可行动报错):下发真被在途 rerun 阻塞时,我能从报错里看到是哪个节点、处于什么状态,
  从而知道等什么。
- US-4(子集下发):待下发列表里我可以只勾选一部分问题下发,其余留在待下发;默认全选保持
  旧的一键全下体验。

## 5. 验收标准

1. QMGP5 实测解锁:修复部署(dev daemon `--watch` 热加载)后,原样重试第 5 批批量下发
   (含改派给 `agent_1k2ftd` 的 1 条)成功:5 条 entry 全部 `dispatched_at` 落戳、仅
   `agent_m7p3n1` mint 1 个 rerun、任务离开 `awaiting_human`;`agent_1k2ftd` 的 2 条 queued
   entry 在其首跑时一起注入。
2. 后端单元矩阵(见 design §7)全绿,`clarify-rerun-ledger-deadlock.test.ts:272` 的
   「queued 恒 open」锁**改写**为条件化新契约(附本 RFC 链接)。
3. 集成:never-run 与 idle 两类死锁场景的 dispatch 通过;「同 home 在途 rerun(pending/
   running/failed)」场景仍 409(double-mint 防护不回归);「异 cause queued entry + 本次
   mint」场景仍 409(§5.2.12 串行化不回归);quick-finalize 在「home 挂同 cause queued
   entry 且无 open run」时放行、「异 cause queued / 有 pending continuation」时仍拒。
4. 409 响应携带 `details.nodeId`;前端展示含节点名的本地化文案;无 `details` 时回退静态文案。
5. 看板:staged 卡有勾选框,默认全选;「下发所选 (N)」只发所选 id;0 选禁用;勾选尊重节点
   filter;refetch 后勾选集合收敛到仍 staged 的 entry。
6. 全门槛:`bun run typecheck && bun run test && bun run format:check` + 前端 vitest +
   `bun run build:binary` smoke 全绿;push 后 GitHub Actions 绿。
