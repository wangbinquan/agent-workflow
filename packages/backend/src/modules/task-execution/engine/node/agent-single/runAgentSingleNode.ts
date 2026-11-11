import {
  agentHasClarifyChannel,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  findClarifyNodeForAgent,
  findCrossClarifyNodeForQuestioner,
  findDesignerNodeForCrossClarify,
  resolveClarifySessionMode,
  resolveCrossClarifySessionMode,
  type ClarifyCrossAgentNode,
  type ClarifyNode,
  type EnvelopeFollowupReason,
} from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import { retryAttemptCap } from '@/platform/contracts/retryAttemptCap'
import { borrowDuplicateExecutionRejection } from '../../../application/agentNodeErrors'
import { nodeRunMintIdentityForSlot } from '../../../application/nodeRunMintIdentity'
import type { AgentNodeExecutionPorts } from '../../../application/ports/agentNodeExecution'
import type { RunResult } from '../../../application/ports/taskAgentRun'
import { describeEffectError } from '../../../domain/effectErrorDescription'
import {
  decideEnvelopeFollowup,
  decideRetryShape,
  DEFAULT_SESSION_RESTART_BUDGET,
  shouldRetryNodeFailure,
  type EnvelopeFollowupDecision,
  type RetryShapeState,
} from '../../../domain/envelopeRetryPolicy'
import type { NodeStepOutcome, NodeStepRequest } from '../../../domain/nodeExecution'
import { nodeRunAttemptIndex } from '../../../domain/nodeRunAttempt'
import { pickString } from '../../../domain/nodeFields'
import { runAssembly } from '../../kernel/assembly'

// RFC-405 — the agent-single body, moved from composition/nodeMechanics.ts onto explicit ports.
// The cross-attempt state (nodeRunId, envelopeNonce, follow-up decision, retry shape, mode-flip
// observations, lastResult …) stays as closure `let`s inside one function, exactly as RFC-287 T7
// wrote it; only the receivers changed (state / opts → ports).

export async function runAgentSingleNode(
  ports: AgentNodeExecutionPorts,
  args: NodeStepRequest<'agent-single'>,
): Promise<NodeStepOutcome> {
  const {
    task,
    policy: opts,
    collaboration,
    clarifyDirectives,
    rules,
    ledger,
    history,
    workspace,
    log,
  } = ports
  const { taskId, definition } = task
  const { node, iteration } = args

  // RFC-271 T6d：解析走统一 resolver（shared `ref/runtime.ts`；RFC-460 前在 services/ref/runtimeRef.ts），但**两个错误码
  // 与归属逐字不变**——主派发是节点级失败，与 fanout hydration 的静默跳过不同。
  const agentIdRef = pickString(node, 'agentId')
  const agentName = pickString(node, 'agentName') ?? agentIdRef ?? node.id
  const agentRef = rules.agentRefOfNode(node)
  if (agentRef === null) {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing canonical agentId`,
      message: 'agent-identity-missing',
    }
  }
  if (agentRef.k !== 'id') {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }
  const injection = await ports.resources.injection(agentRef.id)
  if (injection.kind === 'failed') {
    return injection.message === 'agent-not-found'
      ? { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
      : injection
  }
  // RFC-132 ③ (借壳收官): the borrow ledgers are move-semantics (RFC-131 T4) and the immediate
  // ledger is deleted, so resolveBorrowForNode never returns an agent anymore — its remaining
  // job is the multi-ledger duplicate-execution REJECT (designer + dispatched self/q both open
  // on this home). Keep the call for that reject; the node always runs its OWN agent.
  // ConflictError surfaces as a node-level failure (don't reject the scope tick — runTask would
  // fail the WHOLE task).
  try {
    await collaboration.resolveBorrowForNode({ taskId, nodeId: node.id, iteration, definition })
  } catch (err) {
    const rejection = borrowDuplicateExecutionRejection(err)
    if (rejection !== null) {
      return { kind: 'failed', summary: rejection.summary, message: rejection.code }
    }
    throw err
  }
  const agent = injection.spec.agent

  // RFC-060 PR-E: agent-multi NodeKind was removed in favor of wrapper-fanout.
  // The agent-single path below is now the sole agent dispatch path.
  // RFC-074: resolveUpstreamInputs now also returns the provenance map of which
  // upstream run each input was read from; recorded on every row this dispatch
  // mints/reuses so read-time freshness can later tell if an upstream advanced.
  const { inputs: upstreamInputs, consumed: consumedUpstream } =
    await ports.input.resolveUpstreamInputs(node.id, {
      containerRunId: args.containerRunId,
      iteration,
    })
  const consumedUpstreamJson = ports.input.prepareConsumedInputs(consumedUpstream)
  // RFC-022: expand the agent.dependsOn closure before resolving skills so
  // closure-member skills get unioned into the same OPENCODE_CONFIG_DIR
  // staging dir. A cycle / missing-dep here is fatal — the agent.ts save
  // guard normally prevents it; hitting one at runtime implies an external
  // SQL edit or a race against another writer. Fail loudly instead of
  // silently spawning with a broken closure.
  const { dependents, material: resourceMaterial, mcps } = injection.spec
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs
  // RFC-042: retries default to 3 so recoverable failure modes (in particular
  // the model forgetting to emit a `<workflow-output>` / `<workflow-clarify>`
  // envelope after a long tool-using session) get a chance to recover via
  // same-session follow-up before the task is failed. RFC-115: the per-node
  // `retries` override is removed — the budget is the global
  // config.defaultNodeRetries (shared default only for mock/unwired callers).
  //
  // RFC-313: 预算从一个数变成两个维度——`followupBudget` 是「同一个会话内还能追问
  // 几次」，`restartBudget` 是「这个会话被判定为无可救药后还能整体换几次干净会话」。
  // `maxRetries` 由二者的乘积公式导出，且是 attempt 数量的**唯一权威**：两个预算
  // 决定的是每次重试长什么形状（见 decideFollowupForRetry），不是还能不能再来一次。
  // restartBudget=0 时 retryAttemptCap 退化成 1+followupBudget，逐字等于 RFC-313 前。
  const followupBudget = opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  const restartBudget = opts.sessionRestartBudget ?? DEFAULT_SESSION_RESTART_BUDGET
  const maxRetries = retryAttemptCap(followupBudget, restartBudget) - 1

  // RFC-005: when this node is being re-run because a downstream review node
  // was rejected/iterated, surface the rendered comments / rejection reason
  // through the {{__review_comments__}} / {{__review_rejection__}} tokens.
  // Returns undefined for first runs and for runs whose latest downstream
  // decision is approve/pending — see buildReviewPromptContext.
  const reviewContext = await collaboration.buildReviewPromptContext({
    appHome: opts.appHome,
    upstreamNodeId: node.id,
    taskId,
    iteration,
  })
  // RFC-023: when this node has a clarify channel wired AND a clarify_iteration
  // > 0, surface the last-round Q&A through {{__clarify_*}} tokens / auto-
  // appended sections. The protocol block is appended by the runner when
  // hasClarifyChannel is true, regardless of whether there's prior context
  // (the agent needs to know it MAY ask back even on the first round).
  const hasClarifyChannel = agentHasClarifyChannel(definition, node.id)
  // RFC-056: the questioner's __clarify__ port may be wired into a
  // clarify-cross-agent node instead of (or as well as) a RFC-023 clarify
  // node. When at least one cross-clarify target exists we instruct the
  // runner to disable the 5-question cap on the envelope parser.
  // RFC-165: renamed from `clarifyMode` — that name now belongs to the clarify
  // NODE field ('optional'); this local is the channel wiring FAMILY.
  const channelKind: 'self' | 'cross' =
    findCrossClarifyNodeForQuestioner(definition, node.id) !== undefined ? 'cross' : 'self'
  // RFC-132 (PR-C): the designer's External Feedback is no longer a separate context — its questions
  // ride the unified flat clarify queue (buildClarifyQueueContext), which selects by effective target
  // regardless of the `__external_feedback__` topology, so the scheduler needs no external-feedback
  // topology gate here anymore.

  // Pick up an existing pending node_run at this iteration; otherwise create
  // a fresh run with retry_index = max-existing-in-iter + 1 (or 0).
  const sameNodeIterRuns = await ledger.listNodeRuns({
    taskId,
    nodeId: node.id,
    iteration,
  })
  // RFC-287 T8：取行前奏收编到 `resolveSchedulerRunRow`（四线单一实现）。
  // RFC-074 PR-C: no clarifyIteration inheritance — freshness is pure id-order
  // and the clarify generation is derived from prior-done id-order at dispatch
  // time. A process retry's External Feedback / Prior Output / questioner Q&A
  // context all key off id-order / the RFC-070 consumed-by stamps, so nothing
  // needs to be carried forward on the row.
  const resolvedRow = await ledger.resolveSchedulerRunRow({
    taskId,
    nodeId: node.id,
    containerRunId: args.containerRunId,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => ports.status.broadcastNodeStatus(taskId, id, node.id, 'pending'),
    broadcastCanceled: (id) => ports.status.broadcastNodeStatus(taskId, id, node.id, 'canceled'),
  })
  let nodeRunId = resolvedRow.nodeRunId
  const retryIndex = resolvedRow.retryIndex
  const latestExisting = resolvedRow.latestExisting
  const inheritedReviewIteration = latestExisting?.reviewIteration ?? 0
  const inheritedShardKey = latestExisting?.shardKey ?? null
  const inheritedParentNodeRunId = latestExisting?.parentNodeRunId ?? null
  let envelopeNonce = await ledger.loadEnvelopeNonce(nodeRunId)

  // Lock order: writeSem ≺ (agentSem | scriptSem) ≺ subprocessSem (no cycles —
  // RFC-098 survey §wp5-4). RFC-266 split the old single `globalSem` into two
  // independent pools; an executor takes exactly ONE of them and never both, so
  // the split adds no new ordering edge. RFC-130 §7 SUPERSEDED the RFC-098 B1
  // "writer acquires writeSem before its global slot" model (which existed to
  // stop queued writers starving readers): there is no whole-run write lock now
  // — each node runs in its OWN isolated worktree, so writeSem is held only for
  // the brief snapshot-at-dispatch (§段①) + merge-back (§段③), never across the
  // multi-minute agent run. The pool slot is the real DAG-parallelism cap now
  // (writeSem + pool are never held together — §7.2 deadlock analysis; the merge
  // agent bypasses the pool to avoid a cycle).
  // §段①: snapshot canonical worktree(s) + branch an isolated worktree under a
  // brief writeSem window. On failure release the slot and fail the node (the
  // canonical worktree is never touched, so nothing to roll back).
  // The iso path + refs are keyed by the ORIGINAL nodeRunId (`isoKeyRunId`) — it
  // stays stable across the internal retry loop (which mints fresh node_run rows),
  // so a same-session follow-up keeps the exact same iso worktree (D17).
  const isoKeyRunId = nodeRunId
  let isoHandle: IsoHandle

  let lastResult: RunResult | null = null
  let lastError: string | null = null
  // RFC-122 (same-session follow-up fix): the PRIOR attempt's
  // effectiveHasClarifyChannel. A same-session envelope follow-up re-anchors the
  // agent on "the format previously specified in this session"; that is only
  // valid when this attempt runs in the SAME mode (clarify vs output) as the
  // prior one. A per-attempt STOP-toggle flip can switch the mode mid-loop (e.g.
  // attempt 0 clarify-only → attempt 1 output), and the prior session never
  // emitted the now-needed protocol. When the mode flips we bypass the follow-up
  // and rebuild the FULL renderUserPrompt instead. Seeded false (attempt 0 never
  // follows up). Within a retry loop only nodeStopOverride varies per attempt, so
  // a flip ⟺ a toggle change ⇒ golden-lock: no toggle ⇒ never flips.
  let priorAttemptClarifyActive = false

  // RFC-287 T7：本线迁入装配骨架（**模式 B**——一次许可 + 一棵 iso 贯穿全部 attempt，
  // 窗口内由 retryPolicy 驱动多次 spawn；D17 要求同会话续跑必须落在同一棵树上）。
  //
  // **拆分手术**：窗口只到「合并相位收束」为止，clarify 落库那段收尾**留在窗口外**。
  // 现状顺序是「先释放许可 + 按 keep 清理 iso，再建 clarify 轮次」；把收尾挪进窗口
  // 会让 daemon 级 agent 许可多握住一段 DB 写——那是行为变更，不是重构。故 TResult
  // 取判别式：窗口内已定局的直接回传，需要窗口外收尾的回 `{ kind: 'ran' }`。
  type AgentWindowOut =
    | { kind: 'settled'; out: NodeStepOutcome }
    | { kind: 'ran'; result: RunResult | null }
  // keepIf 里算出的 RFC-042 续跑决策 memo。骨架保证每轮重试的调用序是
  // keepIf →〔换树〕→ onNextAttempt → spawn（rfc287-t2 骨架单测钉死），所以
  // onNextAttempt / spawn 读到的一定是本轮的决策。
  let followupDecision: EnvelopeFollowupDecision = { followup: false }
  let followupResumeSessionId: string | undefined
  // RFC-313: 重试形状的跨 attempt 状态（只在本次 dispatch 的闭包内有意义，不持久化
  // ——daemon 重启 / 人工 retryNode 都会重新进入执行器并从零开始，与既有 attempt
  // 计数语义一致）。`pendingRestartReason` 只有 `decideFollowupForRetry` 一个写者
  // （每轮先复位再按形状赋值），spawn 侧只读——于是「上一轮的告知漏进这一轮」这个
  // 窗口从结构上就不存在。
  let retryShapeState: RetryShapeState = { followupChainLen: 0, restartsUsed: 0 }
  let pendingRestartReason: EnvelopeFollowupReason | undefined
  // RFC-313 实现门 P1-1：上一次 attempt 观察到的 STOP 开关值（undefined = 还没有过
  // attempt）。用它在 keepIf 里判断「本轮有没有待处理的模式翻转」——依据是紧邻上面
  // 那条既有不变量：**retry 循环内只有 nodeStopOverride 逐 attempt 变化，所以
  // 「翻转」⟺「开关变了」**。因此这里不是把 effectiveHasClarifyChannel 再导一遍
  // （那会是第二处导出、必然漂移），而是复用同一个 `getNodeClarifyDirectiveRow` 源。
  let priorAttemptStopOverride: boolean | undefined

  /**
   * 每次重试前奏：算 RFC-042 续跑决策。它同时**就是**「要不要留用同一棵树」的判据
   * ——续跑必须在同一棵树上恢复（D17），换新会话则丢弃重建。
   */
  const decideFollowupForRetry = async (prev: RunResult | null): Promise<boolean> => {
    followupDecision = { followup: false }
    followupResumeSessionId = undefined
    // 本函数是 pendingRestartReason 的唯一写者：每轮先复位，再按形状赋值，
    // 这样 spawn 侧只读不清，也就不存在「上一轮的告知漏进这一轮」的窗口。
    pendingRestartReason = undefined
    if (prev !== null) {
      // RFC-313 实现门 P1-2：**框架自写的审计事件也是 kind='text'**（rfc042 续跑、
      // rfc049 端口校验、rfc313 会话升级三处，都写在**新铸的那一行**上），所以不过滤
      // 的话第 1 次之后每一次 attempt 的计数恒 ≥1 —— RFC-042 那条「模型必须说过话」
      // 的判据在第 2 次起就失效了（这是 RFC-042 就有的缺陷，RFC-313 只是多加了一个
      // producer；按用户拍板在本 RFC 内一并修，因为整条形状判定正架在这个判据上）。
      // 排除判据是载荷前缀：框架审计载荷一律以 `[rfc` 开头，由 rfc313-source-locks
      // 的断言钉死。误伤面是保守的——万一模型的正文真以 `[rfc` 开头，结果只是这一轮
      // 退回 fresh（换会话重来），不会错误地续跑一个没说过话的会话。
      const agentTextCount = await history.countAgentTextEvents(nodeRunId)
      // RFC-049: read the structured port-validation failures the prior
      // attempt's runner persisted (NULL → undefined; malformed JSON →
      // null via parsePortValidationFailuresJson, then coerced to
      // undefined for the decision input). decideEnvelopeFollowup uses
      // the failures array to populate the per-port repair prompt; absent
      // / empty arrays degrade gracefully (followup still fires on the
      // outer prefix, but the prompt skips per-kind specifics).
      const priorRunRow = await ledger.read(nodeRunId)
      const priorFailures = rules.parsePortValidationFailuresJson(
        priorRunRow?.portValidationFailuresJson ?? null,
      )
      followupDecision = decideEnvelopeFollowup({
        status: prev.status,
        exitCode: prev.exitCode,
        failureCode: prev.failureCode ?? null,
        sessionId: prev.sessionId ?? null,
        agentTextCount,
        ...(priorFailures !== null ? { portValidationFailures: priorFailures } : {}),
      })
      // RFC-313: RFC-042 的五条判据（上一行）只回答「这次失败可不可以在同一个会话里
      // 改」；能改**不代表还应该继续在这个会话里改**——上下文已经打满 / 模型陷在
      // 循环里时，追问是零收益甚至负收益的自旋（每条纠错提示还在加剧根因）。形状由
      // 共享纯函数在判据之上再判一层：链未触顶 → 接续；触顶且有升级预算 → 主动换
      // 一个干净会话重来；判据落空 → 维持既有的全新会话重试（不吃升级预算）。
      // RFC-313 实现门 P1-1：升级会丢树 + 扣预算，而一次待处理的 STOP 翻转按 RFC-122
      // 应当「保树 + 走完整 prompt」。keepIf 跑在 spawn 之前，若不在这里看一眼开关，
      // 链顶恰逢翻转时升级会抢先生效，把用户的正常翻转执行成升级（AC-8 违反 + 未合并
      // 成果丢失）。只读这一个值、只在挂了 clarify 通道时读。
      const stopOverrideNow = hasClarifyChannel
        ? (await clarifyDirectives.get(taskId, node.id)) === 'stop'
        : false
      const clarifyFlipPending =
        priorAttemptStopOverride !== undefined && stopOverrideNow !== priorAttemptStopOverride
      const { shape, next } = decideRetryShape({
        followup: followupDecision,
        state: retryShapeState,
        followupBudget,
        restartBudget,
        ...(clarifyFlipPending ? { suppressRestart: true } : {}),
      })
      retryShapeState = next
      if (shape.kind === 'followup') {
        followupResumeSessionId = prev.sessionId ?? undefined
      } else {
        // 升级 / 全新会话都不发短提示：把 RFC-042 的决策收回，后续所有「followup
        // 才做」的动作（抄 envelopeNonce、带 resumeSessionId、跳过记忆注入与清单）
        // 因此自动不做——这正是本 RFC 改动面极小的原因。
        followupDecision = { followup: false }
        pendingRestartReason = shape.kind === 'restart' ? shape.reason : undefined
      }
    }
    // 续跑 ⇒ 留用同一棵树（D17）；换新会话（升级或崩溃后重来）⇒ 骨架负责丢弃 + 重建。
    return followupDecision.followup
  }

  /**
   * 每次重试的副作用（骨架在「iso 处置之后、spawn 之前」调用）：铸新行、把 iso 列
   * 抄到新行、广播、写审计事件。`attempt` 是绝对序号（retryIndex + 骨架轮次）。
   */
  const prepareRetryAttempt = async (attempt: number): Promise<void> => {
    {
      {
        // RFC-074 PR-C: a process-retry within the same clarify round surfaces
        // the answered Q&A via id-order generation derivation + the RFC-070
        // consumed-by stamps, not a carried clarifyIteration. shardKey /
        // parentNodeRunId still belong to this run-of-the-node and persist.
        nodeRunId = await ledger.mintNodeRun({
          ...nodeRunMintIdentityForSlot(
            (await ledger.read(nodeRunId))!.slot,
            { kind: 'current' },
            followupDecision.followup && envelopeNonce.length > 0 ? envelopeNonce : undefined,
          ),
          taskId,
          nodeId: node.id,
          status: 'pending',
          cause: 'process-retry',
          retryIndex: nodeRunAttemptIndex({ kind: 'explicit', attempt }),
          containerRunId: args.containerRunId,
          iteration,
          overrides: {
            identity: {
              reviewIteration: inheritedReviewIteration,
              shardKey: inheritedShardKey,
              parentNodeRunId: inheritedParentNodeRunId,
            },
            inputs: {
              consumedUpstreamRunsJson: consumedUpstreamJson,
            },
          },
        })
        envelopeNonce = await ledger.loadEnvelopeNonce(nodeRunId)
        ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
        // RFC-130: carry the iso columns onto the freshly-minted retry row so a
        // crash mid-retry can still find the iso worktree (the physical iso is
        // keyed by isoKeyRunId and shared across the invocation's attempts).
        await workspace.persistIsoBase(nodeRunId, isoHandle)

        // RFC-042 / RFC-049: surface the follow-up decision as an audit
        // event so operators can replay how a green run recovered from a
        // failed prior attempt. Written on the FRESH row (so it sits in the
        // events list for the attempt that's about to run, not the failed
        // prior attempt). reason='port-validation' uses its own tag /
        // payload shape (RFC-049 §A6) so log aggregators can filter the
        // two failure classes apart.
        if (followupDecision.followup) {
          if (followupDecision.reason === 'port-validation') {
            // One audit row per failing port — keeps the payload symmetric
            // with how runner.ts persists multiple failures in the JSON
            // column (today fail-fast → always length 1, but the schema is
            // ready for the future batch-validate path).
            const failures =
              followupDecision.failures.length > 0
                ? followupDecision.failures
                : [{ port: '', kind: '', subReason: '' }]
            for (const f of failures) {
              await ledger.appendEvent({
                nodeRunId,
                ts: Date.now(),
                kind: 'text',
                payload: `[rfc049/port-validation-followup] ${JSON.stringify({
                  rfc: 'RFC-049',
                  port: f.port,
                  kind: f.kind,
                  subReason: f.subReason,
                  retryAttempt: attempt,
                })}`,
              })
            }
          } else {
            const followupReason = followupDecision.reason
            await ledger.appendEvent({
              nodeRunId,
              ts: Date.now(),
              kind: 'text',
              payload: `[rfc042/envelope-followup] ${JSON.stringify({
                rfc: 'RFC-042',
                reason: followupReason,
                retryAttempt: attempt,
              })}`,
            })
          }
        }

        // RFC-313: 主动会话升级的审计行。写在**新铸的那一行**上（与 rfc042 的续跑
        // 事件同址同形），于是任务详情页的事件流里，「接续」与「换脑重来」是两条可
        // 区分的痕迹——用户拍板不新增 rerun cause，事件流就是唯一的区分面。
        // 与上面的 followup 分支互斥：升级时 followupDecision 已被收回成 false。
        if (pendingRestartReason !== undefined) {
          await ledger.appendEvent({
            nodeRunId,
            ts: Date.now(),
            kind: 'text',
            payload: `[rfc313/session-restart] ${JSON.stringify({
              rfc: 'RFC-313',
              reason: pendingRestartReason,
              abandonedAfterFollowups: followupBudget,
              restartsUsed: retryShapeState.restartsUsed,
              retryAttempt: attempt,
            })}`,
          })
        }
      }
    }
  }

  /**
   * 一次 attempt 的完整机身（骨架每轮调一次）。`k` 是骨架轮次（0 起），绝对 attempt
   * 序号 = retryIndex + k —— 与迁移前 `for (attempt = retryIndex; …)` 的取值逐一对应。
   * 返回本次的 RunResult；跨 attempt 的携带量（lastResult / lastError / nodeRunId /
   * isoHandle / envelopeNonce / priorAttemptClarifyActive）仍是闭包上的 let，语义不变。
   */
  const runOneAttempt = async (): Promise<RunResult | null> => {
    // RFC-130: the RFC-092/098 pre-snapshot (git stash create → pre_snapshot
    // columns) is GONE — the iso model never writes the canonical worktree, so
    // there is nothing to roll back. Retry re-branches a fresh iso from the
    // current canonical state (see the fresh-session block above). The
    // pre_snapshot columns + rollbackNodeRunWorktrees stay in the schema as
    // defense-in-depth (design.md D10) but are no longer written here.

    try {
      // RFC-023: read this row so the prompt context surfaces the prior
      // round's Q&A. The row may have been minted at any of three sites
      // (pendingExisting, retry-mint, clarify-rerun mint from clarify
      // service); reading off the DB guarantees we see whatever each path set.
      const currentRunRow = await ledger.read(nodeRunId)
      const currentShardKey = currentRunRow?.shardKey ?? null

      // RFC-074 PR-C: the clarify "generation" is derived from id-order, NOT
      // the retired `clarifyIteration` counter. The prior top-level `done`
      // rows for this node at the same (iteration, shardKey), minted before
      // this run (earlier mint seq), each represent an earlier completed clarify
      // generation; their count is the generation index the counter used to
      // hold. `done` (not canceled) so review-iterate supersede markers don't
      // inflate it, and parentNodeRunId === null so fan-out shard children
      // don't either.
      const priorDoneGenerations = currentRunRow
        ? await history.priorDoneGenerationsForRun({
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
            seq: currentRunRow.seq,
          })
        : []
      const clarifyGeneration = priorDoneGenerations.length

      // RFC-026: resolve sessionMode from the clarify node attached to this
      // agent (if any). `inline` only takes effect when the current run IS
      // a clarify-driven rerun.
      // RFC-098 WP-10 (audit S-25): "is a clarify-driven rerun" is read off
      // the row itself now — the mint factory records WHY every row exists
      // (node_runs.rerun_cause, migration 0044) and gate-2 switches on it
      // instead of the old `clarifyGeneration > 0 && retryIndex === 0`
      // proxy:
      //   - 'clarify-answer' / 'cross-clarify-questioner-rerun' → TRUE
      //     (the same logical round continues after a human answered);
      //   - 'process-retry' → FALSE (design.md §7 forbids inline resume on
      //     technical retries — deterministic retry behavior);
      //   - fresh scheduler mints ('initial' / 'stale-redispatch' /
      //     'revival') → FALSE (no prior session of the same round);
      //   - NULL (pre-0044 row dispatched across a daemon upgrade) → FALSE
      //     (documented boundary degradation — see isClarifyRerunCause).
      // The (consumerKind × cause) truth table is pinned by
      // rfc098-rerun-cause-gates.test.ts.
      const clarifyNodeForGate = hasClarifyChannel
        ? findClarifyNodeForAgent(definition, node.id)
        : undefined
      const clarifyNodeObjForGate = clarifyNodeForGate
        ? (rules.findClarifyNode(definition, clarifyNodeForGate) as ClarifyNode | undefined)
        : undefined
      // RFC-056 A16: a cross-clarify questioner rerun honors the cross-clarify
      // node's `sessionModeForQuestioner`. The self-clarify findClarifyNode
      // lookup above returns undefined for the cross node (it is not a
      // `clarify` kind), so without this the questioner would silently stay
      // isolated even when the user picked inline in the editor. Resolve the
      // cross node via the SAME helper `channelKind` itself uses
      // (findCrossClarifyNodeForQuestioner) rather than reusing
      // clarifyNodeForGate: a questioner can wire BOTH a self-clarify and a
      // cross-clarify `__clarify__` edge, and findClarifyNodeForAgent returns
      // whichever edge is first — if the self edge wins, clarifyNodeForGate
      // points at the self clarify node and the cross node's
      // sessionModeForQuestioner would be silently ignored. (Codex review #3.)
      const crossQuestionerNodeId =
        channelKind === 'cross' ? findCrossClarifyNodeForQuestioner(definition, node.id) : undefined
      const crossQuestionerNode = crossQuestionerNodeId
        ? (definition.nodes.find(
            (n) => n.id === crossQuestionerNodeId && n.kind === 'clarify-cross-agent',
          ) as ClarifyCrossAgentNode | undefined)
        : undefined
      const mindmapGate = crossQuestionerNode ?? clarifyNodeObjForGate
      const sessionMode = crossQuestionerNode
        ? resolveCrossClarifySessionMode(crossQuestionerNode)
        : clarifyNodeObjForGate
          ? resolveClarifySessionMode(clarifyNodeObjForGate)
          : 'isolated'
      const isClarifyRerun = rules.isClarifyRerunCause(currentRunRow?.rerunCause)
      const priorSessionId =
        isClarifyRerun && currentRunRow
          ? await history.readPriorAgentSessionId({
              taskId,
              agentNodeId: node.id,
              shardKey: currentShardKey,
              iteration: currentRunRow.iteration,
              before: currentRunRow,
            })
          : null
      // RFC-026 fallback reasons recorded via `recordClarifyInlineEvent`
      // below:
      //   - 'missing-session-id'           — decideResumeSessionId, pre-spawn
      //   - 'session-not-found'            — stderr inspection, post-spawn
      //   - 'session-resume-unsupported'   — reserved for an explicit
      //                                      behavior/capability probe (not
      //                                      inferred from a version string)
      const resumeDecision = rules.decideResumeSessionId({
        sessionMode: isClarifyRerun ? sessionMode : 'isolated',
        sourceSessionId: priorSessionId,
      })
      if (resumeDecision.fallbackReason !== undefined) {
        await history.recordClarifyInlineEvent(nodeRunId, {
          level: 'warning',
          reason: resumeDecision.fallbackReason,
          extra: { clarifyGeneration },
        })
      }

      // RFC-132 (PR-C): the designer's §6 update-mode prior output is no longer fetched here (the
      // cross-clarify-specific designer working-draft fetch + its dedicated prior-output block are
      // gone). A designer responding to feedback now surfaces its working draft through the SAME
      // generalized RFC-119 prior-output path every other rerun uses (`freshestPriorRunWithOutput`
      // below). RFC-141 removed the RFC-120 §18 pure-override handoff suppression that used to
      // gate it — an override target now sees its own draft too.

      // RFC-132 (PR-C): the standing continue/stop directive is read SOLELY from the per-(task,
      // asking-node) clarify state (design §7) — the per-round directive concept is gone. The flat
      // injector (buildClarifyQueueContext) carries no directive; the scheduler drives
      // effectiveHasClarifyChannel / clarifyStopped / clarifyStopNotice from nodeDirective /
      // nodeStopOverride below. So the former per-role SELECT fork + the per-round directive-override
      // plumbing (which only fed the round-grouped injectors) are gone — selectAgentQueue queries
      // every role in one shot.
      //
      // RFC-122 (H1 fix): read the node directive AT DISPATCH (parallel to RFC-056 resolveCrossNodeStopped)
      // INSIDE the retry loop so EVERY attempt's freshly-minted process-retry row reads the LATEST
      // toggle (a flip while attempt N runs is honored by attempt N+1). Gated on hasClarifyChannel
      // (self-clarify AND cross-questioner both wire the same `__clarify__` source port); every
      // other node skips the read ⇒ undefined ⇒ nodeStopOverride=false.
      // RFC-123 (B1): read the FULL directive (not just === 'stop') so an explicit 'continue' toggle
      // can re-open a stopped channel (nodeStopOverride flips false → resolveEffectiveClarifyChannel
      // re-opens). No row ⇒ undefined ⇒ byte-for-byte unchanged.
      const nodeDirectiveRow = hasClarifyChannel
        ? await clarifyDirectives.get(taskId, node.id)
        : undefined
      const nodeDirective = nodeDirectiveRow
      const nodeStopOverride = nodeDirective === 'stop'
      // RFC-132 (PR-C): the SINGLE unified deferred injector. selectAgentQueue pulls this node's
      // whole agent queue — self / questioner / designer / manual — in ONE query (design §2
      // "consumerKind 消失"), binds it to this rerun (承接 marker), and renders one flat
      // `## Clarify Q&A` block (§5). It replaces the former split self/questioner + designer
      // injectors: a designer's questions now ride the SAME block (§5 ②b), so there is no separate
      // designer External-Feedback context / `## External Feedback` section. Called for EVERY agent
      // node — an override / borrow target can hold a
      // reassigned question yet wire no clarify channel of its own (this mirrors the pre-PR-C
      // UNCONDITIONAL per-node-queue designer call). An empty queue ⇒ undefined ⇒ no injection.
      const clarifyQueue = await collaboration.buildClarifyQueueContext({
        definition,
        taskId,
        consumerNodeId: node.id,
        dispatchedRunId: nodeRunId,
        iteration,
        envelopeNonce,
        // RFC-026: an inline resume is an incremental message. Entries
        // bound to earlier clarify runs already live in that OpenCode
        // transcript; inject only the unbound/current-run delta. Isolated
        // and fallback runs still receive the complete un-aged queue.
        currentRunOnly: resumeDecision.inlineMode,
      })
      // RFC-141: the RFC-120 §18 pure-override handoff suppression (`suppressPriorOutput`) is
      // GONE by user ruling — the reassigned Q&A rides the flat block below, and the prior-output
      // sections render alongside it as the node's own background.
      const clarifyContext =
        clarifyQueue === undefined
          ? undefined
          : {
              // renderUserPrompt emits this verbatim + skips the legacy round-grouped sections.
              flatBlock: clarifyQueue.block,
              iteration: String(clarifyGeneration),
              remaining: rules.computeRemaining(definition, node.id, clarifyGeneration),
              // Inline session resume suppresses input re-injection, swaps the trailing
              // reminder, and carries only the queue delta not already in the transcript.
              ...(resumeDecision.inlineMode ? { mode: 'inline' as const } : {}),
            }
      // effectiveHasClarifyChannel is the "mandatory ask-back is ACTIVE" signal
      // threaded to the runner + renderUserPrompt (RFC-100). It is TRUE only
      // when the agent is in a genuine clarify round and must ask back:
      //   - hasClarifyChannel: the agent wired a clarify channel, AND
      //   - directive !== 'stop' (RFC-023): the user has not clicked
      //     "Stop clarifying" — a stop round finalizes with <workflow-output>;
      //     the answersBlock already carries the STOP CLARIFYING sentence. The
      //     next round walks back through scheduleAgentNode and re-derives the
      //     flag, so 'stop' naturally scopes to one rerun, AND
      //   - (reviewContext === undefined || isClarifyRerun) (RFC-100 + Codex
      //     review #1 fix): a review reject/iterate RE-PRODUCTION run is NOT a
      //     clarify round — it must produce <workflow-output> to address the
      //     reviewer's comments, so reviewContext disables mandatory ask-back for
      //     it (without this a clarify-channel designer could never satisfy a
      //     review iterate; its v2 output would be rejected as clarify-required).
      //     BUT a clarify-answer rerun that happens DURING a review-iterate cycle
      //     (the designer asked back, the user answered) IS a clarify round and
      //     must honor its directive — so isClarifyRerun re-enables the gate
      //     there. Otherwise a "Keep clarifying" answer mid-review would be
      //     bypassed and the agent could finalize before the user clicks Stop.
      //     RFC-183: on a pure iterate/reject re-production the runner now
      //     REJECTS a voluntary <workflow-clarify> (directive 'suppressed'
      //     ⇒ disposition 'reject') — output is the only accepted reply.
      //
      // RFC-122: extracted to the pure `resolveEffectiveClarifyChannel` oracle
      // and extended with the per-(task, asking-node) `nodeStopOverride` term —
      // the on-canvas "停止反问" toggle forces ask-back off here for BOTH self and
      // cross. `nodeStopOverride=false` reproduces the exact pre-RFC-122 boolean
      // (golden-lock).
      //
      // RFC-183 (Codex design-gate P2#1/P2#4): the oracle's isClarifyRerun
      // input is LINEAGE-aware, not current-cause-only. A clarify-answer /
      // cross-questioner round that dies technically continues as
      // cause='process-retry' (attempt loop) or — across a daemon restart —
      // cause='revival'; both sit outside isClarifyRerunCause BY DESIGN
      // (RFC-098 修订 #11: that gate owns inline-resume / Q&A derivation).
      // Feeding the raw cause here made those continuation rounds degrade
      // to 'suppressed' — zero clarify bytes, and post-RFC-183 a hard
      // reject — against the user's "Keep clarifying". The persisted cause
      // chain decides instead; the inline-resume gate above deliberately
      // keeps the raw `isClarifyRerun` (technical retries never resume).
      const lineageCauses = currentRunRow
        ? await history.lineageCausesNewestFirst({
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
            seq: currentRunRow.seq,
          })
        : []
      const clarifyLineageContinues = rules.continuesClarifyLineage(lineageCauses)
      const effectiveHasClarifyChannel = rules.resolveEffectiveClarifyChannel({
        hasClarifyChannel,
        // RFC-132 (PR-C): the standing directive is the node clarify state (design §7); the flat
        // context carries none. nodeStopOverride already covers `=== 'stop'`, so this is redundant
        // with it but kept explicit for the oracle's contract (golden-lock).
        contextDirective: nodeDirective,
        nodeStopOverride,
        reviewActive: reviewContext !== undefined,
        isClarifyRerun: clarifyLineageContinues,
      })
      // RFC-123 follow-up (user「强制停止」): is the node EXPLICITLY stopped? RFC-132 (PR-C): a
      // 'stop' answer already writes the per-node clarify state (clarifySeal.setNodeClarifyDirective),
      // so the node directive IS the single source — `nodeStopOverride` alone captures both the canvas
      // toggle AND a latest answered 'stop'. Threaded to the runner so a disobedient
      // <workflow-clarify> is REJECTED (no session) under an explicit stop, while review reruns
      // (reviewActive && !isClarifyRerun) keep emitting clarify.
      const clarifyStopped = hasClarifyChannel && nodeStopOverride
      // RFC-165 (F12): the wired SELF-clarify node may declare
      // clarifyMode:'optional' — the channel is offered, never enforced.
      // Precedence stopped > optional > mandatory/suppressed; every rerun
      // (initial / retry / post-answer) recomputes from the same static
      // node field, so answering a round can never re-escalate the node to
      // mandatory. Cross channels carry no clarifyMode (undefined ⇒ off).
      const clarifyOptional = hasClarifyChannel && clarifyNodeObjForGate?.clarifyMode === 'optional'
      // RFC-122 (H2 fix), RFC-132 (PR-C): inject the standalone STOP CLARIFYING trailer whenever the
      // node is stopped. The flat block NEVER carries a per-question directive trailer (§5), so —
      // unlike the round-grouped path — the trailer's ONLY source is this notice. `contextDirective:
      // undefined` makes shouldInjectStopNotice return `nodeStopOverride` (the block can never
      // already carry it), so a stopped node always gets exactly one STOP trailer (first run /
      // review-rerun / answered-stop alike).
      const clarifyStopNotice = rules.shouldInjectStopNotice({
        nodeStopOverride,
        contextDirective: undefined,
      })
      // RFC-122 (same-session follow-up fix): a same-session envelope follow-up
      // (renderEnvelopeFollowupPrompt) re-anchors on "the format previously
      // specified in this session" WITHOUT re-emitting the full protocol. If the
      // per-attempt STOP toggle flipped this attempt's clarify-vs-output mode
      // relative to the prior attempt, that format was never specified in the
      // resumed session — so bypass the follow-up and let the FULL
      // renderUserPrompt render the correct protocol (output-port list +
      // clarifyStopNotice, or the mandatory ask-back block) from scratch.
      // Bidirectional (stop→output AND output→stop). Golden-lock: with no toggle
      // the mode is stable across attempts ⇒ false ⇒ follow-up path unchanged.
      const clarifyModeFlip =
        followupDecision.followup && priorAttemptClarifyActive !== effectiveHasClarifyChannel
      priorAttemptClarifyActive = effectiveHasClarifyChannel
      // RFC-313 实现门 P1-1：与上一行同址更新——两个「上一次 attempt 的观察值」必须
      // 在同一个点写，否则它们会各自漂移到不同的 attempt 边界上。
      priorAttemptStopOverride = nodeStopOverride
      // RFC-119 / RFC-132 (PR-C) / RFC-141: generalized prior-output for ANY rerun — review
      // reject/iterate (supersede→canceled), manual retry, cascade, resume, clarify-answer,
      // mandatory ask-back rounds, override handoffs, AND the cross-clarify designer (whose
      // dedicated prior-output path was removed — a designer responding to feedback surfaces
      // its working draft through THIS single path). RFC-141 (user ruling) removed two former
      // gates:
      //   - RFC-119 D6 "mandatory ask-back suppresses" — its "nearly impossible" premise was
      //     disproved (a node with a done draft re-enters ask-back on every new answer batch;
      //     evidence: QMGP5 agent_m7p3n1 retry 17). renderUserPrompt now picks the ask-back
      //     directive variant off the same hasClarifyChannel signal that picks the trailing
      //     protocol, so the wording cannot contradict the clarify-only round.
      //   - RFC-120 §18 "pure-override handoff suppresses" — the override target now sees its
      //     own draft as background; the reassigned Q&A rides `## Clarify Q&A`.
      // Still skipped on inline session resume (the resumed session already holds the prior
      // output — re-injecting wastes tokens and re-anchors on stale text).
      // D10: on a review-ITERATE, RFC-014's `## Sibling Outputs` already carries the sibling ports;
      // restrict to the iterate-target port so the two don't duplicate. review-reject / non-review
      // reruns → all ports (onlyPorts undef).
      let priorOutputUpdate: { block: string } | undefined
      if (currentRunRow !== null && !resumeDecision.inlineMode) {
        const priorRun = await history.freshestPriorRunWithOutput({
          taskId,
          nodeId: node.id,
          iteration: currentRunRow.iteration,
          shardKey: currentShardKey,
          id: currentRunRow.id,
          seq: currentRunRow.seq,
        })
        if (priorRun !== undefined) {
          const onlyPorts =
            reviewContext?.iterateTargetPort !== undefined
              ? new Set([reviewContext.iterateTargetPort])
              : undefined
          const block = await history.composePriorOutputBlock(
            priorRun.id,
            agent.outputs ?? [],
            onlyPorts,
          )
          if (block.length > 0) priorOutputUpdate = { block }
        }
      }
      if (resumeDecision.inlineMode && resumeDecision.resumeSessionId !== undefined) {
        await history.recordClarifyInlineEvent(nodeRunId, {
          level: 'info',
          sessionIdPrefix: resumeDecision.resumeSessionId.slice(0, 8),
          extra: { clarifyGeneration },
        })
      }
      // RFC-042: follow-up attempts re-use the prior attempt's opencode
      // session id (captured above into `followupResumeSessionId`) AND swap
      // the prompt for a short re-anchor directive. The RFC-026 inline
      // clarify-rerun resume path only fires on the FIRST attempt of a
      // clarify-driven rerun (rows whose rerun_cause is in the gate-2 set;
      // follow-up attempt rows are minted cause='process-retry' and gate
      // FALSE) so the two paths cannot fight over the same
      // `resumeSessionId` slot. When both contexts are present,
      // follow-up wins because it expresses what THIS attempt is for.
      // RFC-122 (mode-flip session-clear): a STOP-toggle mode flip already
      // bypasses the same-session follow-up PROMPT (clarifyModeFlip → full
      // renderUserPrompt). Don't then resume the prior (wrong-mode) opencode
      // session for it — the prior session is clarify-only or output-only and
      // resuming it would feed the full fresh-mode prompt into a contradictory
      // conversation. On a flip we fall to resumeDecision.resumeSessionId, which
      // for a process-retry ('isolated') is undefined ⇒ a FRESH session matching
      // the full prompt. Golden-lock: no flip ⇒ `&& !clarifyModeFlip` is a no-op
      // ⇒ same-session resume byte-identical to today. (The worktree rollback +
      // pre-snapshot stay gated on followupDecision.followup — see the RFC-122
      // residual note: downgrading those needs the directive at loop top, which
      // is entangled with buildPromptContext; tracked as a follow-up.)
      // RFC-127 F1 + Codex impl-gate P2: a same-attempt envelope follow-up
      // (followupResumeSessionId is THIS attempt's own session) stays paired with
      // envelopeFollowup mode (the runner renders only the short repair prompt).
      // (RFC-132 ③: the borrowed-row special case is gone with the borrow ledger —
      // a node always runs its own agent, so the inline resume is always its own.)
      const effectiveResumeSessionId =
        followupDecision.followup && !clarifyModeFlip
          ? followupResumeSessionId
          : resumeDecision.resumeSessionId
      // RFC-132 (PR-C): the follow-up strong-bias trailer (renderEnvelopeFollowupPrompt) fires on
      // clarifyDirective==='continue'. When effectiveHasClarifyChannel is true the node IS in
      // ask-back ("keep clarifying") mode, so the directive is 'continue' by construction. Gate on a
      // non-empty flat queue (clarifyContext defined) to preserve the legacy "no trailer on a
      // first-ever run with no answered round" behavior (the per-round directive was undefined
      // there).
      const followupClarifyDirective =
        followupDecision.followup && effectiveHasClarifyChannel && clarifyContext !== undefined
          ? ('continue' as const)
          : undefined
      // RFC-111 D15: read the runtime frozen onto this node_run, or freeze it
      // now (agent.runtime ?? config.defaultRuntime) on the first dispatch.
      // resume/retry of the same row read the frozen value so a mutated
      // agent / default can't re-route a captured session to the wrong runtime.
      // RFC-112 P1: a retry / clarify-rerun mints a FRESH row but may carry a
      // prior session id — inherit that session owner's frozen (protocol,
      // binary) so the id + runtime stay a pair across the new row.
      const inheritedRuntime =
        effectiveResumeSessionId !== undefined
          ? await ports.runtime.ofSession(effectiveResumeSessionId)
          : null
      const frozenRuntime = await ports.runtime.resolve(
        nodeRunId,
        agent.runtime,
        opts.defaultRuntime,
        inheritedRuntime,
      )
      lastResult = await ports.runtime.runAgent(
        {
          taskId,
          nodeRunId,
          nodeId: node.id,
          agent,
          triggerContext: task.triggerContext,
          runtime: frozenRuntime.protocol,

          runtimeParams: frozenRuntime.params,
          runtimeConfigDir: frozenRuntime.configDir, // RFC-154: frozen config-dir profile
          runtimeObservationIdentity: frozenRuntime.observationIdentity,
          inputs: upstreamInputs,
          // RFC-130 D16: the opencode cwd + ALL path-bearing template tokens point
          // at the ISOLATED worktree, not the canonical one — otherwise the agent
          // would be told (via {{__repo_path__}} / {{__repos__}}) to edit a path
          // outside its isolation. repos[].repoPath stays the source repo (an origin
          // reference, not a cwd); repos[].worktreePath becomes the per-repo iso.

          // Trusted platform-input mounts identify a digital-employee action.
          // Its Agent may edit business files but Git lifecycle is platform-only.
          ...(task.platformInputPathsJson !== null
            ? { gitMutationPolicy: 'read-only' as const }
            : {}),
          // RFC-067: thread per-task Git commit identity through to the runner
          // so `git commit` invocations inside the agent inherit the
          // task-scoped author + committer. Both NULL → runner skips
          // injection and falls back to daemon's default git config.
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: isoHandle.repos[0]?.isoWorktreePath ?? task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: node.id,
            iteration,
            // RFC-066: per-repo metadata for the {{__repos__}} /
            // {{__repo_names__}} / {{__repo_count__}} placeholders.
            repos: isoHandle.repos.map((r) => ({
              repoPath: r.repoPath,
              worktreePath: r.isoWorktreePath,
              mountPath: r.mountPath,
              subdir: '',
              readonly: false,
              baseBranch: r.baseBranch,
            })),
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          ...(reviewContext !== undefined ? { reviewContext } : {}),
          // RFC-132 (PR-C): a single flat clarifyContext (self/questioner/designer merged, §5). No
          // separate designer External-Feedback context — the designer's Q&A rides
          // clarifyContext.flatBlock.
          ...(clarifyContext !== undefined ? { clarifyContext } : {}),
          ...(priorOutputUpdate !== undefined ? { priorOutputUpdate } : {}),
          ...(effectiveResumeSessionId !== undefined
            ? { resumeSessionId: effectiveResumeSessionId }
            : {}),
          // RFC-148: the followup quartet is ONE PromptMode value now. The
          // followup arm carries the session id (unrepresentable without one
          // — decideEnvelopeFollowup only fires when the prior attempt
          // captured a session). RFC-122: a same-session follow-up is
          // bypassed when the STOP toggle flipped this attempt's
          // clarify-vs-output mode (clarifyModeFlip) — the resumed session
          // never emitted the now-needed protocol, so the runner takes the
          // FULL renderUserPrompt path instead.
          ...(followupDecision.followup &&
          !clarifyModeFlip &&
          effectiveResumeSessionId !== undefined
            ? {
                promptMode: {
                  kind: 'followup' as const,
                  resumeSessionId: effectiveResumeSessionId,
                  reason: followupDecision.reason,
                  ...(followupClarifyDirective !== undefined
                    ? { clarifyDirective: followupClarifyDirective }
                    : {}),
                  // RFC-049: thread the structured failures through so the
                  // runner renders the per-kind repair block. Empty array
                  // (degraded mode) is fine — the followup still fires.
                  ...(followupDecision.reason === 'port-validation'
                    ? { portValidations: followupDecision.failures }
                    : {}),
                },
              }
            : {}),
          // RFC-313: 本次 attempt 是主动会话升级后的第一次运行 ⇒ 让渲染器在完整
          // prompt 的协议块之后追加一段简短告知。与 promptMode.followup 天然互斥
          // （升级时 followupDecision 已被 decideFollowupForRetry 收回成 false），
          // 所以短提示与告知永远不会同时出现。
          ...(pendingRestartReason !== undefined
            ? { priorSessionAbandonedReason: pendingRestartReason }
            : {}),
          // RFC-148: the clarify quartet is ONE ClarifyChannel value now —
          // wiring family (parser cap) × this-run directive (enforcement)
          // × stop-notice injection.
          ...(mindmapGate?.interactionMode === 'mindmap' && mindmapGate.mindmap
            ? { clarifyMindmap: mindmapGate.mindmap }
            : {}),
          clarifyChannel: !hasClarifyChannel
            ? { kind: 'none' as const }
            : {
                kind: channelKind,
                directive: clarifyStopped
                  ? ('stopped' as const)
                  : clarifyOptional
                    ? ('optional' as const)
                    : effectiveHasClarifyChannel
                      ? ('mandatory' as const)
                      : ('suppressed' as const),
                injectStopNotice: clarifyStopNotice,
              },

          dependents,
          mcps,

          log: log.child('run'),
        },
        {
          workspaceRef: isoHandle.repos[0]?.isoWorktreePath ?? task.worktreePath,
          material: resourceMaterial,
          runtimeBinding: frozenRuntime.runtimeBinding,
        },
      )

      // RFC-026: persist opencode session id captured from the JSON event
      // stream so the NEXT clarify-driven rerun on this lineage can pass
      // it back via `--session`. NULL on failed / canceled runs is fine.
      if (lastResult.sessionId !== undefined && lastResult.sessionId !== '') {
        const persistedSessionId = lastResult.sessionId
        await ledger.patch({
          nodeRunId,
          values: {
            runtime: {
              opencodeSessionId: persistedSessionId,
            },
          },
        })
      }
      // RFC-026: post-spawn fallback — opencode rejected the resume id we
      // passed. Treat the run as a fail-soft signal: leave the failure to
      // surface naturally (status will be 'failed' or have empty outputs),
      // but log a warning so operators can see WHY. The next retry within
      // this attempt loop will not carry resumeSessionId (we only set it
      // on the first attempt of a clarify rerun).
      if (resumeDecision.inlineMode && lastResult.status !== 'done') {
        const stderrText = await history.readStderrText(nodeRunId)
        // RFC-284 T15（D10）：判据下沉 driver 能力面——措辞属各 CLI 私有。
        // 无该能力的 driver 视为「无法判定」（告警可能缺失但绝不误报）。
        if (ports.runtime.detectSessionNotFound(frozenRuntime.protocol, stderrText) === true) {
          await history.recordClarifyInlineEvent(nodeRunId, {
            level: 'warning',
            reason: 'session-not-found',
            extra: { clarifyGeneration },
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMessage = `node ${node.id} threw: ${msg}`
      // runNode normally owns pending→running→terminal. Exceptions thrown
      // before it can enter that lifecycle (for example prompt-template
      // rendering) used to leave the attempt row pending. Retry minting then
      // abandoned each predecessor, while the final pending/isolating row was
      // redispatched and crashed on begin-isolation from an abandoned state.
      // Close the row before the retry policy observes the synthetic failure.
      await ledger.transitionNodeRunStatus({
        nodeRunId,
        event: { kind: 'mark-failed', reason: 'scheduler-node-threw' },
        extra: {
          identity: {
            finishedAt: Date.now(),
            errorMessage,
            exitCode: null,
          },
        },
      })
      lastResult = {
        status: 'failed',
        exitCode: null,
        outputs: {},
        tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
        prompt: '',
        errorMessage,
      }
      lastError = msg
    }

    ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, lastResult.status)
    // RFC-366 —— agent 运行结束的记忆提炼信号。
    //
    // 位置：每次 attempt 结算之后（本函数在重试循环体内），所以 loop 每轮、fanout
    // 每分片、每次重试各通知一次 —— 就是 D1 的粒度。
    //
    // 终态过滤留在这里（而不是下游）：哪些状态算「一次跑完的执行」是执行语义。
    // canceled / interrupted / exhausted / skipped 都不算（D4）。
    //
    // best-effort（D13）：通知失败绝不能影响节点结算本身，否则一个蒸馏队列的
    // 写入错误就能把一次已经成功的 agent 运行改判成失败。
    if (lastResult.status === 'done' || lastResult.status === 'failed') {
      await ports.observer
        .onAgentRunSettled({
          taskId,
          nodeRunId,
          nodeId: node.id,
          status: lastResult.status,
        })
        .catch((err: unknown) => {
          log.warn('agent-run settled observer failed', {
            nodeRunId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
    }
    return lastResult
  }

  const windowOut = await runAssembly<Record<string, never>, RunResult | null, AgentWindowOut>(
    {},
    {
      // RFC-208：许可由骨架自取自放（全五条线同一口径）。
      pools: [ports.agentSem],
      iso: {
        create: async () => {
          isoHandle = await workspace.createIsoUnderLock(isoKeyRunId)
          return isoHandle
        },
        // RFC-208: persisting the iso base must happen INSIDE the region whose
        // finally releases the permit. It used to sit between the acquire and the
        // window, and the merge_state CAS throwing there (a documented,
        // test-locked behavior — node-run-not-found / IllegalMergeStateTransition /
        // concurrent-merge-state-transition, plus any database error) leaked one
        // daemon-wide permit per occurrence with no way back short of a restart.
        persistBase: 'in-window',
        persist: async () => {
          await workspace.persistIsoBase(nodeRunId, isoHandle)
        },
      },
      onIsoSetupFailure: (err) => {
        log.warn('iso worktree setup failed', {
          nodeId: node.id,
          error: describeEffectError(err),
        })
        return {
          kind: 'settled',
          out: {
            // RFC-356 G3：分类字符串不变，summary 换成能自证的结构化诊断。
            kind: 'failed',
            summary: ports.diagnostics.describeIsoFailure('isolated worktree setup failed', err),
            message: 'iso-setup-failed',
          },
        }
      },
      // 机身不需要 attempt 序号：行已由 prepareRetryAttempt 按正确 retryIndex 铸好，
      // 机身一律读 nodeRunId（迁移前的 `attempt` 局部也只服务于重试前奏，机身里只在
      // 注释中出现过）。
      spawn: async () => await runOneAttempt(),
      retryPolicy: {
        // 迁移前的循环是 `for (attempt = retryIndex; attempt <= retryIndex + maxRetries)`
        // 配两处 break；三条判据逐字搬来，取值范围一一对应（k 为骨架轮次，0 起）。
        shouldRetry: (r, k) =>
          k < maxRetries &&
          r !== null &&
          r.status !== 'done' &&
          r.status !== 'canceled' &&
          shouldRetryNodeFailure(r.failureCode, r.processUnreaped === true),
        // D17：同会话续跑留用同一棵树，换新会话丢弃重建——判据即 RFC-042 决策本身。
        isoOnRetry: { keepIf: async (r) => await decideFollowupForRetry(r) },
        onIsoRecreateFailure: (err) => {
          log.warn('retry iso recreate failed', {
            nodeId: node.id,
            error: describeEffectError(err),
          })
          lastError = 'iso-recreate-failed'
          lastResult = {
            status: 'failed',
            exitCode: null,
            outputs: {},
            tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
            prompt: '',
            // RFC-356 G3：分类前缀不变，后面接结构化诊断（残留路径 / 最后错误 /
            // 本机进程树归属可用性）。
            errorMessage: ports.diagnostics.describeIsoFailure('iso-recreate-failed', err),
          }
          // 迁移前这里是 `break` 落到窗口外收尾；判别式回 'ran' 等价。
          return { kind: 'ran', result: lastResult }
        },
        onNextAttempt: async (k) => {
          await prepareRetryAttempt(retryIndex + k)
        },
      },
      // 第五维：旧 child 可能还活着，树不能收（正交于合并处置）。
      keepFromOutcome: (r) => r?.processUnreaped === true,
      // RFC-130 §段③: on success, merge the iso delta back into the canonical
      // worktree under a brief writeSem window. The runner already wrote
      // status='done'; downstream readiness ALSO gates on merge_state (D15,
      // deriveFrontier), so nothing dispatches off this node until 'merged'.
      // D19: a <workflow-clarify> reply is status='done' with result.clarify set but
      // has NOT produced final output — skip merge-back and KEEP the iso so the
      // answered inline resume (same opencode session) sees the files it wrote.
      mergePhase: (_c, r) => {
        if (r !== null && r.status === 'done' && r.clarify !== undefined) {
          return { skip: 'park', keep: true, then: 'settle' }
        }
        if (r === null || r.status !== 'done')
          return { skip: 'not-done', keep: false, then: 'settle' }
        if (isoHandle.passthrough) return { skip: 'passthrough', keep: false, then: 'settle' }
        return 'merge'
      },
      mergeBack: {
        // RFC-188: the ONE merge-back assembly (mergeBackAndSettle) — the §6.2
        // writeSem hold, conflict resolution and merge_state settling now live
        // in isolatedAgentRun.ts; this site keeps only its own dispositions
        // (keepIso + awaiting_human on conflict-human; merge-failed stamp on
        // throw — RFC-130 D15 keeps downstream gated, RFC-144 §5 try-variant).
        run: async (_c, r) =>
          await workspace.mergeBackAndSettle({
            handle: isoHandle,
            nodeRunId,
            via: 'live',
            // RFC-193 K1: this run's own just-emitted port files (not yet in the
            // handle's DB-aggregated roster) join the final-snapshot force list.
            extraForcedContainerPaths: workspace.portFileContainerPaths(r?.portFilePaths ?? []),
            conflictResolver: (conflicts, containerPath) =>
              ports.conflicts.resolveMergeConflicts({
                conflicts,
                containerPath,
                conflictNodeRunId: nodeRunId,
                nodeId: node.id,
                iteration,
              }),
          }),
        disposition: {
          // §6.3 — merge agent could not resolve → park human. Conflict is NEVER
          // silently lost; canonical stays clean for siblings; the resolve-iso(s)
          // are kept so the human finishes there and resume re-merges (#4).
          onConflictHuman: (detail) => ({
            keep: true,
            produce: async () => {
              log.warn('merge-back conflict unresolved by merge agent → awaiting_human', {
                nodeId: node.id,
                detail,
              })
              return {
                kind: 'settled',
                out: {
                  kind: 'awaiting_human',
                  summary: `merge conflict unresolved: ${detail}`,
                  message: 'merge-conflict',
                },
              }
            },
          }),
          // 抛出走骨架默认处置（keep + markMergeFailed + settle），故不覆写 onThrow。
        },
      },
      // RFC-130 robustness: a merge-back that THROWS (iso corrupted, .git gone,
      // a git op error) must fail the node loudly — never leave a 'done' row
      // whose delta never reached canonical.
      //
      // RFC-210 impl-gate A1-fix: KEEP the iso on a merge-back throw. The iso
      // worktree can be the ONLY copy of the node's product — most acutely
      // when the snapshot phase itself failed (submodule auto-commit rejected
      // by a hook, object publish failed): nothing has reached canonical or
      // the pool yet, and the old discard-in-finally deleted the sole copy.
      // A later fresh-session retry builds its own iso under a new run id;
      // this one stays for manual salvage until the container GC sweeps it.
      // ——keep 由骨架默认处置负责；这里只做本线私有的 warn + 结局改写。
      markMergeFailed: async (msg) => {
        log.warn('merge-back failed', { nodeId: node.id, error: msg })
        await workspace.markMergeFailed(nodeRunId, msg)
        if (lastResult !== null) {
          lastResult = {
            ...lastResult,
            status: 'failed',
            errorMessage: `merge-back-failed: ${msg}`,
          }
        }
      },
      discardIso: async (h) => {
        // Discard the iso worktree on a terminal exit; keep it when the node is
        // parked (awaiting_human / merge conflict) so the resume path (D19) + the
        // future merge agent (PR-B) can reuse the exact same worktree state.
        await workspace.discardNodeIso(h as IsoHandle)
      },
      settle: async () => ({ kind: 'ran', result: lastResult }),
      log,
    },
  )
  if (windowOut.kind === 'settled') return windowOut.out
  // 直线回填：让 TS 的控制流重新看到 `RunResult | null`（闭包内的赋值它看不见）。
  lastResult = windowOut.result

  if (lastResult === null) {
    return {
      kind: 'failed',
      summary: 'node produced no result',
      message: lastError ?? 'unknown',
    }
  }
  if (lastResult.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'node canceled',
      message: lastResult.errorMessage ?? 'canceled',
    }
  }
  if (lastResult.status !== 'done') {
    return {
      kind: 'failed',
      summary: lastResult.errorMessage ?? `node ${node.id} ${lastResult.status}`,
      message: lastResult.errorMessage ?? lastResult.status,
      ...(lastResult.processUnreaped === true ? { processUnreaped: true as const } : {}),
    }
  }
  // RFC-023: when the agent reply was a <workflow-clarify> envelope, runner
  // returns status='done' AND populates result.clarify. The scheduler is the
  // only piece with access to the workflow definition, so it owns mapping
  // the asking agent → clarify node id and parking the clarify node_run
  // awaiting_human. After this returns 'awaiting_human', the scope loop
  // bubbles up and the task transitions to status='awaiting_human' until the
  // user POSTs answers via /api/clarify.
  if (lastResult.clarify !== undefined) {
    // RFC-056: prefer the cross-clarify route if the questioner's
    // __clarify__ port is wired to a clarify-cross-agent node. The
    // shared helper short-circuits when no cross-clarify target exists,
    // falling through to the RFC-023 self-clarify path below.
    const crossClarifyNodeId = findCrossClarifyNodeForQuestioner(definition, node.id)
    if (crossClarifyNodeId !== undefined) {
      const currentRunRowXc = await ledger.read(nodeRunId)
      const designerNodeId = findDesignerNodeForCrossClarify(definition, crossClarifyNodeId)
      // Defensive: persistent stop would have been short-circuited at
      // dispatch already. If the questioner still emitted clarify, treat
      // as protocol violation. Caller's retries (RFC-042) kick in.
      await collaboration.openAgentClarify({
        kind: 'cross',
        taskId,
        intermediaryNodeId: crossClarifyNodeId,
        askingNodeId: node.id,
        askingNodeRunId: nodeRunId,
        targetConsumerNodeId: designerNodeId ?? null,
        // RFC-354: the park row lives in the asking run's frame; loopIter is
        // the round INSIDE that frame (the cross round's `loop_iter` column).
        frame: {
          containerRunId: currentRunRowXc?.containerRunId ?? null,
          iteration: currentRunRowXc?.iteration ?? 0,
        },
        loopIter: currentRunRowXc?.iteration ?? 0,
        questions: lastResult.clarify.questions,
        ...(lastResult.clarify.truncationWarnings.length > 0
          ? { truncationWarnings: lastResult.clarify.truncationWarnings }
          : {}),
      })
      return {
        kind: 'awaiting_human',
        summary: `questioner ${node.id} asked back via cross-clarify node ${crossClarifyNodeId}`,
        message: 'cross-clarify-awaiting-human',
      }
    }

    const clarifyNodeId = findClarifyNodeForAgent(definition, node.id)
    if (clarifyNodeId === undefined) {
      // Agent emitted clarify but has no clarify channel — protocol abuse.
      return {
        kind: 'failed',
        summary: `agent ${agent.name} emitted <workflow-clarify> but node ${node.id} has no clarify channel`,
        message: 'clarify-no-channel',
      }
    }
    const currentRunRow = await ledger.read(nodeRunId)
    // RFC-074 PR-C: the clarify round index is the asking run's generation —
    // the count of its prior completed generations (id-order) — not the retired
    // clarifyIteration counter. First clarify round → generation 0.
    const askingGeneration = currentRunRow
      ? (
          await history.priorDoneGenerationsForRun({
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentRunRow.shardKey ?? null,
            id: currentRunRow.id,
            seq: currentRunRow.seq,
          })
        ).length
      : 0
    await collaboration.openAgentClarify({
      kind: 'self',
      taskId,
      askingNodeId: node.id,
      askingNodeRunId: nodeRunId,
      askingShardKey: currentRunRow?.shardKey ?? null,
      // RFC-354 (PR-3 gate P1): the park row lives in the asking run's frame —
      // generation row + round. Minted at the top frame, a gate inside a loop /
      // git wrapper was invisible to the frame-scoped frontier after the answer,
      // which then visited the "empty" gate and settled it idle (`skipped`).
      frame: {
        containerRunId: currentRunRow?.containerRunId ?? null,
        iteration: currentRunRow?.iteration ?? 0,
      },
      intermediaryNodeId: clarifyNodeId,
      iteration: askingGeneration,
      questions: lastResult.clarify.questions,
      ...(lastResult.clarify.truncationWarnings.length > 0
        ? { truncationWarnings: lastResult.clarify.truncationWarnings }
        : {}),
    })
    return {
      kind: 'awaiting_human',
      summary: `agent ${node.id} asked back via clarify node ${clarifyNodeId}`,
      message: 'clarify-awaiting-human',
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}
