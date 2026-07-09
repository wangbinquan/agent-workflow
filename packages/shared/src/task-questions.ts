// RFC-120 — 任务问题清单 / 任务中心：纯函数 oracle。
//
// 这三个纯函数是「问题清单」的可断言核心，不碰 IO，被 backend service
// (`services/taskQuestions.ts`) 与前端清单共用：
//
//   * reconcileDesiredEntries — 一轮 clarify_round → 该轮应有的「承接条目」身份集合。
//     条目 = (问题 × 承接角色)。self→{self}；cross→{questioner}（恒有）∪
//     {designer | 该题 scope=designer 且**该题已 seal**}。**未 seal 前不出 designer 条目**
//     （scope 是回答期的人工选择，seal 前未知；不能用 CLARIFY_QUESTION_SCOPE_DEFAULT
//     在创建时就臆造 designer 条目）。RFC-128：门控从整轮 `roundAnswered` 改为逐题
//     `questionSealed[qid]`——整轮一次答完 = 全题 seal（与旧 roundAnswered 逐字一致），
//     partial 答时只为已 seal 的题出 designer 条目。幂等：service 按唯一键 upsert、保人工覆盖层。
//
//   * deriveQuestionPhase — 条目的展示态（待处理/处理中/已处理待确认/完成/已关闭），
//     **派生**自来源轮 status + 人工确认覆盖层 + 承接 run 生命周期。执行三态不落库
//     （避免状态列漂移，契合本仓「不重算他处权威态」）。失败仍归「处理中」(D3)。
//     承接 run 由 service 的 `resolveHandlerRun` 按**精确 lineage**取（Codex F1，
//     非裸 freshest≥anchor）后传入——本函数只认「已解析的承接 run」。
//
//   * canReassign — 改派合法性。RFC-127 T4 起**任意角色**（self/questioner/designer）
//     皆可改派——self/questioner 通过「借壳顶替」让原节点续跑换用目标 agent X，不再
//     deadlock（放开 RFC-120 的 designer-only 限制）。目标仍须是工作流里 kind=agent 的
//     节点（Codex F5——io/review/clarify/wrapper 无 prompt/产出契约）。
//
// 设计与决策见 design/RFC-120-task-question-list/{proposal,design}.md。

import type { ClarifyQuestion, ClarifyQuestionScope } from './schemas/clarify'
import { CLARIFY_QUESTION_SCOPE_DEFAULT } from './schemas/clarify'
import type { NodeRunStatus, RerunCause } from './schemas/task'

/** 承接角色：self=同节点反问的提问节点；questioner=跨节点反问者；designer=跨节点设计者；
 *  echo=改派回执（RFC-134）——目标恒为提问节点的只读知会条目，生来已下发、排队等提问节点
 *  下次自然运行注入（不 mint、不进 cause 序列化守卫、不可改派/stage，confirm 任意相位可关）。
 *  仅 designer 为「修订型」可改派；self/questioner 为「阻塞-产出型」恒自我续跑（RFC-127 后
 *  亦可 move 改派，echo 即为其投递补偿）。 */
export type TaskQuestionRoleKind = 'self' | 'questioner' | 'designer' | 'echo'

/** Stored / DTO source kind. `self`/`cross` come from a clarify round (via reconcile);
 *  `manual` (RFC-120 §15) is a human-authored question inserted directly (no round). */
export type TaskQuestionSourceKind = 'self' | 'cross' | 'manual'

/** The clarify-round source kinds only — reconcile is clarify-only and never sees
 *  `manual` (manual rows bypass reconcile), so its inputs/outputs use this narrower type. */
export type TaskQuestionRoundSourceKind = 'self' | 'cross'

/** 条目展示态（RFC-120 v2 看板列）。`下发`（mint 承接 rerun）是 pending/staged→processing
 *  的边界（design §11.2/11.6）——一旦有承接 run 即「已下发=处理中」，不再以 run 是否
 *  startedAt 分界。 */
export type TaskQuestionPhase =
  | 'pending' // 待指派：未下发、未批准（handler 可能未定 / 待答）
  | 'staged' // 待下发：已批准·未下发（拖入「准许执行/待下发」、等批量下发）
  | 'processing' // 处理中：已下发（承接 run 存在，含 queued/running/failed；失败仍处理中 D3）
  | 'awaiting_confirm' // 已处理待确认：承接 run done（答案已被消费，有无产出均可——clarify-ask 续问收尾亦 done）
  | 'done' // 完成：人工确认关闭
// RFC-126: 'closed' 相位移除。来源轮取消/放弃不再产生终态条目（CR-1 退役 + migration
// un-abandon 历史行；canceled 轮在 reconcile 被跳过、不建条目）——问题永远停在自然相位。

/** 来源反问轮的状态（`clarify_rounds.status`）。 */
export type TaskQuestionRoundStatus = 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'

/** 人工确认覆盖层。 */
export type TaskQuestionConfirmation = 'open' | 'confirmed'

/** 一个「应存在的」承接条目身份（reconcile 的输出；service 据此 upsert）。 */
export interface DesiredTaskQuestionEntry {
  questionId: string
  questionTitle: string
  sourceKind: TaskQuestionRoundSourceKind
  roleKind: TaskQuestionRoleKind
  /** 图解析的默认承接节点；解析不到（边缺失/畸形）为 null。落库 default_target_node_id。 */
  defaultTargetNodeId: string | null
}

export interface ReconcileRoundInput {
  kind: TaskQuestionRoundSourceKind
  /** 本轮问题（只需 id/title；其余字段 reconcile 不关心）。 */
  questions: Pick<ClarifyQuestion, 'id' | 'title'>[]
  /** RFC-128 §4 — 逐题 seal 门控（取代 RFC-120 的整轮 `roundAnswered`）。
   *  `questionSealed[qid] === true` ⟺ 该题答案已 seal（人工锁定）——只有此时才出
   *  designer 条目（scope 是回答期人工选择，未 seal 前未知，不能臆造）。整轮一次答完
   *  时调用方把全题都标 true（= 旧 `roundAnswered=true` 逐字一致，黄金锁）；partial 答时
   *  只标已 seal 的题（答 Q1 出 Q1 designer 条目、Q2 未答不出）。缺省题按未 seal（false）。 */
  questionSealed: Record<string, boolean>
  /** RFC-120 T9 (Codex H2): 本轮 directive。`'stop'`（拒绝轮）**有意跳过设计者重跑**，
   *  故不产 designer 条目——否则 deferred 任务会在一条永不下发的 stop 轮上永久 park。
   *  缺省 / null → 按 `'continue'` 处理（向后兼容：既有调用方不传即原行为，黄金锁）。 */
  directive?: 'continue' | 'stop' | null
  /** RFC-059 逐题 scope（仅 answered 时有意义）；缺省题 → CLARIFY_QUESTION_SCOPE_DEFAULT。 */
  scopes: Record<string, ClarifyQuestionScope>
  /** 冻结工作流图解析出的角色节点 id（解析不到为 null）。 */
  graph: {
    askingNodeId: string | null // self：提问节点
    questionerNodeId: string | null // cross：反问者
    designerNodeId: string | null // cross：图设计者（默认承接，可被 override 改派）
  }
}

/** 一轮 clarify_round → 该轮应有的承接条目身份集合（确定、幂等）。 */
export function reconcileDesiredEntries(input: ReconcileRoundInput): DesiredTaskQuestionEntry[] {
  const out: DesiredTaskQuestionEntry[] = []
  for (const q of input.questions) {
    if (input.kind === 'self') {
      // self：恒一条「提问节点」承接条目（阻塞-产出型，不可改派）。
      out.push({
        questionId: q.id,
        questionTitle: q.title,
        sourceKind: 'self',
        roleKind: 'self',
        defaultTargetNodeId: input.graph.askingNodeId,
      })
      continue
    }
    // cross：反问者条目恒有（永远自我续跑，与 scope 无关）。
    out.push({
      questionId: q.id,
      questionTitle: q.title,
      sourceKind: 'cross',
      roleKind: 'questioner',
      defaultTargetNodeId: input.graph.questionerNodeId,
    })
    // designer 条目：仅当该题已 seal + directive≠stop + 该题 scope=designer 才出（未 seal 前
    // scope 未知；stop 轮有意跳过设计者重跑，不产承接条目）。RFC-128：门控从整轮
    // roundAnswered 改为逐题 questionSealed[qid]——每 seal 一题即可单独出它的 designer 条目。
    if ((input.questionSealed[q.id] ?? false) && input.directive !== 'stop') {
      const scope = input.scopes[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
      if (scope === 'designer') {
        out.push({
          questionId: q.id,
          questionTitle: q.title,
          sourceKind: 'cross',
          roleKind: 'designer',
          defaultTargetNodeId: input.graph.designerNodeId,
        })
      }
    }
  }
  return out
}

/** service 解析后传入的「承接 run」最小视图（精确 lineage 取出后的那一条）。 */
export interface HandlerRunView {
  status: NodeRunStatus
  /** mark-running 时置；null = 仍 pending（已 mint 未起跑）。 */
  startedAt: number | null
  /** 是否已落 node_run_outputs（成功产出的权威信号，同 runner「有输出行=成功」口径）。 */
  hasOutput: boolean
}

export interface DeriveQuestionPhaseInput {
  roundStatus: TaskQuestionRoundStatus
  confirmation: TaskQuestionConfirmation
  /** 是否已批准进「待下发」暂存（`task_questions.staged_at != null`），但还没下发。 */
  isStaged: boolean
  /** 已下发但承接 run 尚不可权威解析为 done（轮已答、handler 在跑、RFC-070 消费戳还没落）
   *  → 处理中。避免在缺权威 trigger 时去猜某条 run（Codex 实现 gate F1）。 */
  dispatchedInFlight: boolean
  /** 本条目权威承接 run（service 按消费戳 id 直取，含 fanout 子 run；null=未解析/未下发）。
   *  非 null ⟺ 已有权威承接 run。 */
  handlerRun: HandlerRunView | null
}

/** 条目展示态派生（纯，RFC-120 v2）。「下发」= 边界：有承接 run 即处理中。失败仍归处理中(D3)。 */
export function deriveQuestionPhase(input: DeriveQuestionPhaseInput): TaskQuestionPhase {
  // RFC-126: no 'closed' terminal. 'abandoned' is no longer produced (CR-1 retired +
  // migration un-abandons legacy) and 'canceled' rounds are skipped at reconcile (no
  // entry created), so a terminal/aborted round never reaches here. Entries derive
  // purely from confirmation + handler-run state → questions stay "in place".
  // 人工已确认 → 完成。
  if (input.confirmation === 'confirmed') {
    return 'done'
  }
  const run = input.handlerRun
  // 已有权威承接 run → 处理中 / 已处理待确认。queued(pending)/running/failed 均处理中。
  if (run !== null) {
    // done = 答案已被承接 run 消费 → 已处理待确认，无论有无 <workflow-output> 产出。
    // clarify-answer rerun 若「答完这批、又抛下一轮反问」会以 done 收尾却**无产出**
    // （runner kind==='clarify' 恒 done 无 <workflow-output>）；该 run 已终结、ledger 视其
    // 为 consumed（isDispatchedEntryConsumed：done=consumed，RFC-139），且它的 lineage 窗口
    // 被下一条 clarify-answer rerun 封顶——后续产出 run 永不进窗。旧 `done && hasOutput` 门
    // 会把这些「答完但下一轮继续问」的中间问题永久卡在处理中（实测 incident
    // 01KWDKBS9K22KB6HH4KNR3XMX6：5 条 self 问题绑在 done-无产出的 clarify-answer run 上）。
    // done 一律进 awaiting_confirm，与 ledger 的 done=consumed 同口径。
    if (run.status === 'done') {
      return 'awaiting_confirm'
    }
    return 'processing'
  }
  // 已下发、handler 在跑但消费戳未落（in-flight）→ 处理中（不去猜具体 run）。
  if (input.dispatchedInFlight) {
    return 'processing'
  }
  // 未下发：已批准进待下发 → staged；否则待指派 pending。
  return input.isStaged ? 'staged' : 'pending'
}

/** 改派合法性（RFC-127 T4）：**任意角色**条目皆可改派（self/questioner 走借壳顶替，
 *  designer/manual 仍走原换壳路径），唯一约束是目标须是工作流里的 agent 节点（Codex F5
 *  ——io/review/clarify/wrapper 无 prompt/产出契约，借壳无从顶替）。RFC-120 的 designer-only
 *  限制（self/questioner 改派必 deadlock）已被借壳机制解除。 */
export function canReassign(targetNodeId: string, agentNodeIds: ReadonlySet<string>): boolean {
  return agentNodeIds.has(targetNodeId)
}

/** RFC-120 T7（override 重跑核心）：把一轮里**设计者域**问题按「有效承接节点」分组——
 *  有效承接 = `override ?? 图设计者`。返回 `有效节点 → 该节点承接的 questionId[]`（保序）。
 *
 *  - **黄金锁**：全部无 override 时只产出一组 `{图设计者: 全部问题}`——与改派前的单设计者
 *    重跑逐字一致（override 空 = 原行为）。
 *  - **不交叉污染**：Q1 改派到 X、Q2 默认到 Y → `{X:[Q1], Y:[Q2]}`，各节点只见自己的问题；
 *    X 的重跑反馈绝不含 Q2，反之亦然（design §2.4 / T7 验收）。
 *  纯函数：入参已是「设计者域问题 + 其图设计者 + 其 override」，scope 过滤在调用方先做。 */
export function partitionDesignerQuestionsByTarget(
  questions: ReadonlyArray<{
    questionId: string
    graphDesignerNodeId: string
    overrideNodeId: string | null
  }>,
): Map<string, string[]> {
  const byTarget = new Map<string, string[]>()
  for (const q of questions) {
    const target = q.overrideNodeId ?? q.graphDesignerNodeId
    const list = byTarget.get(target)
    if (list) list.push(q.questionId)
    else byTarget.set(target, [q.questionId])
  }
  return byTarget
}

/** 一个有效承接节点是否「被改派而来」（即承接了至少一个 override 到它的问题）——
 *  用于 dispatch 决定走 override 分支还是黄金锁默认分支。 */
export function isOverrideTarget(
  targetNodeId: string,
  questions: ReadonlyArray<{ graphDesignerNodeId: string; overrideNodeId: string | null }>,
): boolean {
  return questions.some((q) => q.overrideNodeId === targetNodeId)
}

/** RFC-162 T1 — dispatch 起跑前沿 oracle（纯函数、可断言）。
 *
 *  给定一批处理节点 `handlerNodes`（已过相关性就绪 barrier 的**就绪**集），返回其中「最前沿」的
 *  子集：在 dataflow DAG 上**没有其它组内节点作为传递祖先**的那些节点。dispatch 只 mint 这个子集，
 *  其余组内节点由 RFC-074 freshness 级联重跑（design/RFC-162-clarify-unification §dispatch）。
 *
 *  - 上游关系经 `upstreamsOf(nodeId) → 直接 dataflow 上游[]`（与 `freshness.ts`
 *    `areTransitiveUpstreamsCompleted` 同形；调用方传入的是**已剔除 clarify 通道相关性边**〔
 *    `to_designer` / `__external_feedback__` 等 `dataflow='never'`〕的纯 dataflow 邻接）。
 *  - **有界防环**：上游遍历带 `seen` 集，畸形环图不死循环、结果确定（design §失败模式 F2）。
 *  - 保序去重：按 `handlerNodes` 首现序返回。
 *
 *  n ∈ frontier ⟺ `handlerNodes` 里没有**别的**节点是 n 的传递 dataflow 祖先。互不依赖的组员各自
 *  成前沿（多起跑点）；单元素/默认组（只提问节点）→ 前沿 = 它自己（黄金锁：与旧「逐个 mint 提问
 *  节点」逐字一致）。改派到上游 → 上游成前沿、提问节点级联；改派到下游 → 提问节点仍最前成前沿。 */
export function computeDispatchFrontier(
  handlerNodes: ReadonlyArray<string>,
  upstreamsOf: (nodeId: string) => ReadonlyArray<string>,
): string[] {
  const handlerSet = new Set(handlerNodes)
  // n 有「组内祖先」⟺ 它的传递上游里存在**别的** handler（找到即真、提前返回）。
  const hasHandlerAncestor = (start: string): boolean => {
    const seen = new Set<string>([start]) // start 不算自己的祖先；同时防环
    const stack = [...upstreamsOf(start)]
    while (stack.length > 0) {
      const u = stack.pop()!
      if (seen.has(u)) continue
      seen.add(u)
      if (handlerSet.has(u)) return true
      for (const p of upstreamsOf(u)) if (!seen.has(p)) stack.push(p)
    }
    return false
  }
  const out: string[] = []
  const emitted = new Set<string>()
  for (const n of handlerNodes) {
    if (emitted.has(n)) continue // 去重、保首现序
    emitted.add(n)
    if (!hasHandlerAncestor(n)) out.push(n)
  }
  return out
}

/** RFC-120 Codex F1：「新一轮反问触发的承接 rerun」的 cause 集合——用作 lineage
 *  窗口上界。一个条目的承接 lineage = 它的 trigger run + 其 process-retry/级联子代，
 *  止于**下一条**带这些 cause 的更新 rerun（那属于另一条目/另一轮的承接）。
 *  flag-audit W0：与 `RerunCause` 的一致性从 test-forced 升级为 compile-forced
 *  （satisfies；T3 集成测试继续兜真 cause 的运行时行为）。 */
export const NEW_CLARIFY_TRIGGER_CAUSES = [
  'clarify-answer', // self 反问回答 → 提问节点续跑
  'cross-clarify-answer', // cross 设计者重跑
  'cross-clarify-questioner-rerun', // cross 反问者续跑
] as const satisfies readonly RerunCause[]

/** 一条 node_run 在 lineage 解析时需要的最小视图（service 从 node_runs 投影）。 */
export interface RunLineageView {
  id: string // ULID（freshness 比较锚）
  nodeId: string
  iteration: number
  loopIter: number
  rerunCause: string | null
  status: NodeRunStatus
  startedAt: number | null
  hasOutput: boolean
  parentNodeRunId: string | null // 非 null = fanout 子 run
}

export interface ResolveHandlerInput {
  /** 有效承接节点 = override ?? default；null → 无承接（未派发）。 */
  effectiveTargetNodeId: string | null
  iteration: number
  loopIter: number
  /** 本条目锚点 rerun id；null → 未派发。 */
  triggerRunId: string | null
  /** 候选 node_runs（service 传该任务相关 runs；本函数自行按节点+迭代过滤）。 */
  runs: RunLineageView[]
}

// ---------------------------------------------------------------------------
// RFC-134 改派回执（asker echo）—— planEchoEntries 纯 oracle。
//
// 通用不变量：凡一条问题的有效承接节点 ≠ 提问节点，下发时同步把该题 Q&A 送进
// 提问节点的队列（roleKind='echo' 回执条目，生来已下发、trigger NULL 排队、不 mint）。
// 修 RFC-127/131/132 move 改派后提问节点丢答案 → 重问循环的缺口。
// 判定式、兄弟跳过（交付感知 R3-F6 + 可渲染性 R4-F8 + stampedIds 单值化 R6-F11）、
// batchTimestamp 显式入参（R7-F12）见 design/RFC-134-reassign-asker-echo/design.md §2.3。
// ---------------------------------------------------------------------------

/** 同 (originNodeRunId, questionId) 的兄弟条目快照（任意角色；判定时排除候选行自身）。 */
export interface EchoSiblingSnapshot {
  id: string
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
  dispatchedAt: number | null
  sealedAt: number | null
  sourceKind: TaskQuestionSourceKind
}

/** 本批候选行（dispatch 已选中、即将/刚被 stamp 的 task_questions 行投影）。 */
export interface EchoPlanInputRow {
  id: string
  roleKind: TaskQuestionRoleKind
  sourceKind: TaskQuestionSourceKind
  questionId: string
  questionTitle: string
  originNodeRunId: string
  iteration: number
  loopIter: number
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
  sealedAt: number | null
}

/** 应插回执的身份 + 字段快照（taskId 由调用方补；dispatched_at/by 用本批 stamp 值）。 */
export interface EchoPlan {
  originNodeRunId: string
  questionId: string
  questionTitle: string
  /** 恒为 self | cross（manual 无提问节点，规则不产出）。 */
  sourceKind: TaskQuestionRoundSourceKind
  /** 提问节点（= 源条目 defaultTargetNodeId，规则前置保证非空）。 */
  targetNodeId: string
  iteration: number
  loopIter: number
  /** 源 sealedAt ?? batchTimestamp —— 在纯函数内定值（R7-F12），保回执恒可渲染
   *  （selectAgentQueue 只认行级 sealed_at，契约 #17）。 */
  sealedAt: number
}

/** siblingsByQuestion 的 key——'\x1f'（Unit Separator）拼接，避免 id 内容碰撞。 */
export function echoSiblingKey(originNodeRunId: string, questionId: string): string {
  return `${originNodeRunId}\x1f${questionId}`
}

export interface PlanEchoEntriesInput {
  batch: ReadonlyArray<EchoPlanInputRow>
  /** 该任务同 (origin, question) 的全部条目快照（键 = {@link echoSiblingKey}）；
   *  可含本批其他行；候选行自身由本函数按 id 排除。 */
  siblingsByQuestion: ReadonlyMap<string, ReadonlyArray<EchoSiblingSnapshot>>
  /** 本批 stamp 成功的 task_questions.id。同批交付判据（R3-F6）+ 可渲染性单值化
   *  （R6-F11：本批行经 dispatch 的 seal 归一化必然 sealed，直接以此认定可渲染）。 */
  stampedIds: ReadonlySet<string>
  /** 本批 stamp 时间戳（调用方传入——纯 oracle 不取 Date.now，R7-F12）。 */
  batchTimestamp: number
}

/**
 * RFC-134：从本批下发条目推导应物化的回执条目集合（确定、幂等、纯）。
 *
 * 产出条件（全部满足）：
 *   1. roleKind ∈ {self, questioner}（designer 由既有 questioner 条目天然满足不变量；
 *      manual 无提问节点；echo 不自繁殖）；
 *   2. override 非空且 ≠ default（有效承接 ≠ 提问节点；override==default 视同未改派——黄金锁）；
 *   3. default（提问节点）非空（图解析不到则无处投递，调用方 log）；
 *   4. 无「已交付指向提问节点」的兄弟：兄弟同时满足 ①effectiveTarget==提问节点
 *      ②已下发 ∨ ∈ stampedIds ③可渲染（sealed_at 非空 ∨ manual ∨ ∈ stampedIds）。
 *      未下发的兄弟只是承诺、不算交付（R3-F6）；历史已下发但 sealedAt NULL 的懒建行
 *      永不入队渲染、同样不算交付（R4-F8）；本批行经 seal 归一化必可渲染（R6-F11）。
 *
 * 同批同 (origin, question) 只产一条（self 轮无 questioner 条目、cross 轮无 self 条目，
 * reconcile 保证互斥；此处仍防御性去重）。
 */
export function planEchoEntries(input: PlanEchoEntriesInput): EchoPlan[] {
  const out: EchoPlan[] = []
  const planned = new Set<string>()
  for (const row of input.batch) {
    if (row.roleKind !== 'self' && row.roleKind !== 'questioner') continue
    if (row.sourceKind === 'manual') continue // 防御：self/questioner 行按构造是 clarify 派生
    const asker = row.defaultTargetNodeId
    if (asker === null) continue
    if (row.overrideTargetNodeId === null || row.overrideTargetNodeId === asker) continue
    const key = echoSiblingKey(row.originNodeRunId, row.questionId)
    if (planned.has(key)) continue
    const siblings = input.siblingsByQuestion.get(key) ?? []
    const delivered = siblings.some(
      (s) =>
        s.id !== row.id &&
        (s.overrideTargetNodeId ?? s.defaultTargetNodeId) === asker &&
        (s.dispatchedAt !== null || input.stampedIds.has(s.id)) &&
        (s.sealedAt !== null || s.sourceKind === 'manual' || input.stampedIds.has(s.id)),
    )
    if (delivered) continue
    planned.add(key)
    out.push({
      originNodeRunId: row.originNodeRunId,
      questionId: row.questionId,
      questionTitle: row.questionTitle,
      sourceKind: row.sourceKind,
      targetNodeId: asker,
      iteration: row.iteration,
      loopIter: row.loopIter,
      sealedAt: row.sealedAt ?? input.batchTimestamp,
    })
  }
  return out
}

/** RFC-120 Codex F1：按**精确 lineage**取本条目的承接 run（非裸 freshest≥anchor）。
 *
 *  框窗规则：在「有效承接节点 + 同 iteration/loopIter」的 runs 里，以 triggerRunId
 *  为下界、以**下一条 NEW_CLARIFY_TRIGGER_CAUSES rerun**（id>anchor）为上界，取窗内
 *  freshest 的 **top-level**（parentNodeRunId===null）run。这样：
 *    - 后续不相关反问轮在同节点的新 rerun（带 clarify cause、id 更大）成为上界、被排除
 *      → 不会把本条目从 awaiting_confirm 误拉回 processing；
 *    - 窗内的 process-retry（cause='process-retry'）/级联仍计入（它们续的是本次承接）；
 *    - fanout：取 top-level 父 run 作代表（shard 子 run 不被误当承接代表）。
 *  v1 已知限制：多进程承接节点的子 run 聚合态以父 run 自身状态近似（design §6 注）。 */
export function resolveHandlerRun(input: ResolveHandlerInput): HandlerRunView | null {
  if (input.effectiveTargetNodeId === null || input.triggerRunId === null) return null
  const anchor = input.triggerRunId
  const triggerCauses = new Set<string>(NEW_CLARIFY_TRIGGER_CAUSES)
  const sameNode = input.runs.filter(
    (r) =>
      r.nodeId === input.effectiveTargetNodeId &&
      r.iteration === input.iteration &&
      r.loopIter === input.loopIter,
  )
  // 上界 = 下一条「新反问触发」rerun 的 id（id 严格大于 anchor），否则 +∞。
  let upperBound: string | null = null
  for (const r of sameNode) {
    if (r.id > anchor && r.rerunCause !== null && triggerCauses.has(r.rerunCause)) {
      if (upperBound === null || r.id < upperBound) upperBound = r.id
    }
  }
  // 窗内 = [anchor, upperBound) 的 top-level run。
  const lineage = sameNode.filter(
    (r) =>
      r.parentNodeRunId === null && r.id >= anchor && (upperBound === null || r.id < upperBound),
  )
  if (lineage.length === 0) return null
  // lineage is non-empty (guarded above) → reduce without seed returns an element.
  const freshest = lineage.reduce((a, b) => (b.id > a.id ? b : a))
  return { status: freshest.status, startedAt: freshest.startedAt, hasOutput: freshest.hasOutput }
}
