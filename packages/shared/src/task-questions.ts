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
import type { NodeRunStatus } from './schemas/task'

/** 承接角色：self=同节点反问的提问节点；questioner=跨节点反问者；designer=跨节点设计者。
 *  仅 designer 为「修订型」可改派；self/questioner 为「阻塞-产出型」恒自我续跑。 */
export type TaskQuestionRoleKind = 'self' | 'questioner' | 'designer'

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
  | 'awaiting_confirm' // 已处理待确认：承接 run done 且有产出
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
    if (run.status === 'done' && run.hasOutput) {
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

/** RFC-120 Codex F1：「新一轮反问触发的承接 rerun」的 cause 集合——用作 lineage
 *  窗口上界。一个条目的承接 lineage = 它的 trigger run + 其 process-retry/级联子代，
 *  止于**下一条**带这些 cause 的更新 rerun（那属于另一条目/另一轮的承接）。
 *  必须与 backend `RerunCause` 枚举对应值保持一致（drift 由 T3 集成测试用真 cause 兜）。 */
export const NEW_CLARIFY_TRIGGER_CAUSES = [
  'clarify-answer', // self 反问回答 → 提问节点续跑
  'cross-clarify-answer', // cross 设计者重跑
  'cross-clarify-questioner-rerun', // cross 反问者续跑
] as const

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
