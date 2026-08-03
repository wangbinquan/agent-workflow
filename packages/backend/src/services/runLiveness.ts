// RFC-230 — Run 活性证据链。
//
// 病灶（事故原文 `node_run <id> is terminal ('interrupted'); refuse to
// overwrite (wrapper-finalize)` → 任务级 `scheduler error`）：周期孤儿回收器
// 把「没有 pid」当成「进程已消失」（orphanReconcile.ts 旧 runProcessGone 的
// 第一句），而 wrapper 行永远不会有 pid —— `pid` 全仓唯一写入点是
// runner.ts 的 spawn 之后那条 update。wrapper 不是进程，它是一段子图正在被
// 推进的记账行，活性由调度器协程承载。于是任何内层跑超宽限期的 wrapper 都
// 被判死，收尾时撞上 lifecycle.ts 的终态守卫，整条任务失败。
//
// 本模块把「活性」变成显式契约：每一类 run 声明自己的活性证据来自哪里，
// 证据可以向下委派，委派链最终必然落到真实进程或真实驱动上。
//
//   driver    本进程调度器正驱动该任务 —— 最强证据，短路一切
//   process   该 run 曾 spawn 过子进程 —— 由 OS 判活
//   delegated 容器行 —— 递归看它的下层 run 是否有活的
//   none      既没 spawn 过、也没有下层 —— 无驱动时即孤儿
//
// 判定顺序 driver → process → delegated → none。「没有直接进程」不再等于
// 死亡，它只意味着「去问下一层」。
//
// ⚠ 判据是**结构性**的，不是分类学的（Codex 设计门 P1-2）：容器身份由
// 「这一行有没有子行」+「定义里它是不是 wrapper」共同决定，而不是只查
// NodeKind。原因是仓里存在定义中根本不存在的 synthetic 行 —— commit-push
// 容器行（commitPush.ts 的 `commitPushNodeId`）直接 mint 成 running、自身
// 不持 pid、真进程跑在它另 mint 的 session 子行上。只按 NodeKind 分类会把
// 这类行漏成「无法归类」，而结构规则天然覆盖它们，也覆盖未来任何新增角色。
//
// ⚠ 无驱动时**不再保守判活**（Codex 设计门 P1-1）：所有瞬时空窗（wrapper 刚
// 建、loop 两次迭代之间、fanout 分片结束到聚合器起来）都只发生在驱动活着的
// 时候，driver 门已经把它们全部罩住。生产侧 `runTask` 的三个调用点
// （task.ts）全部先注册 activeTasks 再启动，所以「无驱动」意味着没有任何协程
// 会再推进这一行 —— 此时判活等于让残骸活满整个 daemon 生命周期，而不是
// 「晚一点回收」。唯一仍然保守的是**任务快照根本解析不了**：那种情况下我们
// 连分类都做不到，由 orphanReconcile 整任务跳过并告警。
//
// PURE module：零 DB、零 Bun/Node IO。进程探针由调用方注入，定义与行集由
// 调用方一次性读入。编排（读行 → 判定 → CAS 翻转 → 审计）留在
// orphanReconcile.ts。

import { isTerminalNodeRunStatus, type NodeKind, type NodeRunStatus } from '@agent-workflow/shared'
import type { WorkflowDefinition } from '@agent-workflow/shared'

import { wrapperInnerDescendants } from './dispatchFrontier'

/**
 * 判定所需的最小行投影。刻意不用 `typeof nodeRuns.$inferSelect` —— 回收器
 * 只 select 这几列，测试也只需构造这几列。
 */
export interface LivenessRunRow {
  id: string
  nodeId: string
  status: string
  pid: number | null
  spawnBinaryPath: string | null
  parentNodeRunId: string | null
  /**
   * RFC-243: the child task a call node_run launched (NULL everywhere else).
   * Optional so pre-RFC-243 callers/tests keep constructing the row shape.
   */
  childTaskId?: string | null
}

/** 一行 run 的活性证据来源。`driver` 是任务级证据，由 resolveRunLiveness 产出。 */
export type LivenessEvidence =
  | { kind: 'driver' }
  | { kind: 'process'; pid: number; spawnBinaryPath: string | null }
  | { kind: 'delegated'; innerNodeIds: ReadonlySet<string> }
  | { kind: 'none' }

/**
 * 判定理由的闭集 —— 直接进回收审计事件，让「为什么收 / 为什么不收」可追溯。
 * 拆得比 verdict 细（Codex 设计门 P3-1）：运维需要区分「正常短空窗」与
 * 「结构已不可解析」，两者的处置完全不同。
 */
export type LivenessReason =
  | 'driver-attached' // 任务仍被本进程调度器持有
  | 'process-alive' // 自己的子进程还活着
  | 'process-gone' // 自己的子进程确已消失
  | 'child-task-active' // RFC-243 委派：调用行的子任务仍非终态（跨任务证据）
  | 'inner-alive' // 委派：至少一个下层 run 还活着
  | 'inner-all-terminal' // 委派：下层全部终态 —— 真正的孤儿容器行
  | 'empty-delegation' // 容器行零下层，且无驱动 —— 没人会再造出下层
  | 'unowned-never-spawned' // 从未 spawn、无下层、无驱动
  | 'lineage-cycle' // 父指针成环的脏数据（不作为活性证据）

export interface LivenessVerdict {
  alive: boolean
  reason: LivenessReason
}

/**
 * 定义层 NodeKind 的证据来源声明。穷尽 switch —— 新增 NodeKind 不在这里
 * 声明即 typecheck 失败。
 *
 * ⚠ 这只覆盖**工作流定义里的节点**。定义外的 synthetic 行（commit-push
 * 容器、未来新增角色）由 classifyRunLiveness 的结构规则兜底 —— 那才是不会
 * 被新角色绕过的那道门（Codex 设计门 P1-2）。
 */
export function livenessSourceOfKind(kind: NodeKind): 'process' | 'delegated' {
  switch (kind) {
    case 'agent-single':
    case 'input':
    case 'output':
    case 'review':
    case 'clarify':
    case 'clarify-cross-agent':
    case 'script': // RFC-253 — see the note below
      // RFC-253: a script node spawns its own subprocess and the executor
      // writes `pid` + `spawn_binary_path` on the same update as every agent
      // run, so its liveness is direct process evidence — never delegated (it
      // owns no inner rows and no child task).
      return 'process'
    // RFC-243: a call node's liveness is carried by its independent child
    // task (the childTaskId probe in resolveRunLiveness, which outranks this
    // structural classification); structurally it is a container with zero
    // in-task inner rows — 'delegated' keeps the empty-delegation reap path
    // correct once the child settles.
    case 'wrapper-git':
    case 'wrapper-loop':
    case 'wrapper-fanout':
    case 'call-workflow':
    case 'call-workgroup':
      return 'delegated'
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

/**
 * 一行 run 自身（不含任务级 driver）的活性证据。判定次序全部是结构性的：
 *
 *   ① 有 pid ⇒ 它确实 spawn 过 —— 直接进程证据，与定义是否可解析无关
 *      （runner 在 spawn 之后的同一条 update 里写 pid + spawnBinaryPath）。
 *      wrapper 行永远没有 pid，所以这一支不会误吞容器行。
 *   ② 有子行（parentNodeRunId 指向它）或定义里是 wrapper ⇒ 容器行，委派。
 *   ③ 其余 ⇒ 无自证据。
 */
export function classifyRunLiveness(
  row: LivenessRunRow,
  definition: WorkflowDefinition,
  rows: readonly LivenessRunRow[] = [],
): Exclude<LivenessEvidence, { kind: 'driver' }> {
  if (row.pid !== null) {
    return { kind: 'process', pid: row.pid, spawnBinaryPath: row.spawnBinaryPath }
  }
  const node = definition.nodes.find((n) => n.id === row.nodeId)
  const isWrapperNode = node !== undefined && livenessSourceOfKind(node.kind) === 'delegated'
  const hasChildRows = rows.some((r) => r.id !== row.id && r.parentNodeRunId === row.id)
  if (isWrapperNode || hasChildRows) {
    return {
      kind: 'delegated',
      innerNodeIds: isWrapperNode ? wrapperInnerDescendants(row.nodeId, definition) : new Set(),
    }
  }
  // 声明由子进程承载活性、但还没 spawn（pre-spawn 窗口 / io 类瞬时行），
  // 或定义里已不存在且没有子行的行 —— 自身无证据。
  return { kind: 'none' }
}

/** 非终态即「还有未完成的工作」。与 orphanReconcile 的 running|pending 活跃判据同源，
 *  并把 awaiting_*（人工门开着）一并算作活 —— 那种行绝不该被后台判死。 */
function isNonTerminalStatus(status: string): boolean {
  return !isTerminalNodeRunStatus(status as NodeRunStatus)
}

export interface ResolveRunLivenessArgs {
  row: LivenessRunRow
  /** 同任务的全部 node_run 行（单次 tick 一并读入，避免 N+1）。 */
  rows: readonly LivenessRunRow[]
  definition: WorkflowDefinition
  /** `isTaskActive(taskId)` —— 本进程调度器是否正驱动该任务。 */
  taskHasDriver: boolean
  /** 进程探针：pid 存活且仍是我们 spawn 的那个二进制。 */
  probeProcess: (pid: number, spawnBinaryPath: string | null) => boolean
  /**
   * RFC-243 跨任务探针：调用行的子任务当下是否非终态（'active'）。终态与行
   * 缺失统一为 'settled' —— 那时子任务证据失效，判定落回结构链（对调用行即
   * 判死回收，收尾由父任务 resume 的 replay 分段完成，design §4.2 R）。
   * 缺省视为 'settled'（pre-RFC-243 调用方无需感知）。
   */
  probeChildTask?: (childTaskId: string) => 'active' | 'settled'
}

/**
 * 解析活性证据链。`alive === false` 才是孤儿。
 *
 * 终止性：委派沿两条边向下 —— 定义层的 wrapper 包含关系（`wrapperInnerDescendants`
 * 自带定义节点环保护）与数据层的父指针。父指针是无 FK 的普通列，脏数据可能成环，
 * 因此本函数另用 row-id `visited` 兜底，成环的那一支记 `lineage-cycle` 且**不**
 * 作为活性证据（否则一对互指的脏行可以永久互相保活）。
 */
export function resolveRunLiveness(args: ResolveRunLivenessArgs): LivenessVerdict {
  // ① driver —— 所有权判断，不是活性推测：只要本进程调度器正持有该任务，
  //   后台线程就无权对它的任何行下死亡判决。与 lifecycleRepair 的
  //   schedulerLivenessGate（RFC-097 audit S-23）同一道理；周期回收器至今是
  //   唯一一个绕过这道门的后台写者。
  //   它同时天然覆盖两类瞬时窗口：agent 行的 pre-spawn 窗口，以及容器行的
  //   空窗（loop 两次迭代之间 / fanout 分片结束到聚合器起来）。
  if (args.taskHasDriver) return { alive: true, reason: 'driver-attached' }
  return resolveWithoutDriver(
    args.row,
    args.rows,
    args.definition,
    args.probeProcess,
    args.probeChildTask ?? (() => 'settled'),
    new Set(),
  )
}

function resolveWithoutDriver(
  row: LivenessRunRow,
  rows: readonly LivenessRunRow[],
  definition: WorkflowDefinition,
  probeProcess: (pid: number, spawnBinaryPath: string | null) => boolean,
  probeChildTask: (childTaskId: string) => 'active' | 'settled',
  visited: Set<string>,
): LivenessVerdict {
  if (visited.has(row.id)) return { alive: false, reason: 'lineage-cycle' }
  visited.add(row.id)

  // ①.5 RFC-243 — 跨任务委派，优先于一切结构证据：调用行的活性由它发起的
  // 独立子任务承载。子任务非终态 ⇒ 活；已终态 / 行缺失 ⇒ 该证据不判活，
  // 落回下方结构链（调用行无 pid 无下层 ⇒ 判死回收；父 resume 的 R 分段
  // 负责收尾，与 replayPendingMerges 语义一致）。
  const childTaskId = row.childTaskId ?? null
  if (childTaskId !== null && probeChildTask(childTaskId) === 'active') {
    return { alive: true, reason: 'child-task-active' }
  }

  const evidence = classifyRunLiveness(row, definition, rows)
  // ② process —— 逻辑与改动前一致，只是不再兼任「类别判断」。
  if (evidence.kind === 'process') {
    return probeProcess(evidence.pid, evidence.spawnBinaryPath)
      ? { alive: true, reason: 'process-alive' }
      : { alive: false, reason: 'process-gone' }
  }
  // ③ delegated —— 容器行的子依赖就是它的下层 run。
  if (evidence.kind === 'delegated') {
    const inner = innerRunsOf(row, rows, evidence.innerNodeIds)
    if (inner.length === 0) {
      // 无驱动 + 零下层：没有任何协程会再造出下层，这不是「空窗」而是残骸。
      // （空窗只发生在驱动活着时，已被 ① 罩住。）
      return { alive: false, reason: 'empty-delegation' }
    }
    for (const child of inner) {
      // 终态下层不构成证据；非终态的 pending / awaiting_* 直接算活；
      // running 的下层继续向下解析（它可能自己就是个容器行）。
      if (isTerminalStatusRow(child)) continue
      if (child.status !== 'running') return { alive: true, reason: 'inner-alive' }
      if (
        resolveWithoutDriver(child, rows, definition, probeProcess, probeChildTask, visited).alive
      ) {
        return { alive: true, reason: 'inner-alive' }
      }
    }
    // 下层全部终态 / 全部证实已死，且无驱动 —— 这才是真正的孤儿容器行。
    // 改动前它是靠「没有 pid」这个错误理由被误打误撞收掉的。
    return { alive: false, reason: 'inner-all-terminal' }
  }
  // ④ 从未 spawn、无下层、无驱动 —— 没人会再推进它。
  return { alive: false, reason: 'unowned-never-spawned' }
}

function isTerminalStatusRow(row: LivenessRunRow): boolean {
  return !isNonTerminalStatus(row.status)
}

/**
 * 容器行的下层 run。两条既有路合并，不动数据模型（design §3）：
 *   - 定义层：`wrapperInnerDescendants` 的传递内层后代（git / loop 内层节点
 *     当普通节点跑，行上没有父指针，包含关系只存在于冻结的工作流定义里）。
 *   - 数据层：`parentNodeRunId === 本行 id` 的子行（fanout 分片 / 聚合 /
 *     merge-resolve / commit-push 的 session 子行）。
 *
 * 刻意不给 git/loop 内层行补父指针：`parentNodeRunId !== null` 在 scheduler
 * 多处被当作「这是 fan-out 子行」的判据，nodeRunMint 更把「直接 mint 成
 * running 的行必须是子行」立成了不变量，补指针等于一次性改写这些语义。
 *
 * 活性判断刻意不引入迭代窗口：`wrapperRevivalEvidence` 因「唤醒」语义需要按
 * 迭代过滤并因此带着一条 depth-1 盲区；活性不关心新鲜度 —— 任一下层当下
 * 活着就是证据，与它属于哪次迭代无关（代价见 design §5 已知边界）。
 */
function innerRunsOf(
  wrapperRow: LivenessRunRow,
  rows: readonly LivenessRunRow[],
  innerNodeIds: ReadonlySet<string>,
): LivenessRunRow[] {
  return rows.filter(
    (r) =>
      r.id !== wrapperRow.id && (r.parentNodeRunId === wrapperRow.id || innerNodeIds.has(r.nodeId)),
  )
}
