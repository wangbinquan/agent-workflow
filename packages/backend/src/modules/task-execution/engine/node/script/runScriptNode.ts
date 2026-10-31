import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  readScriptLanguage,
  resolveScriptReadonly,
  SCRIPT_PERMANENT_FAILURE_CODES,
} from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { ScriptNodeExecutionPorts } from '../../../application/ports/scriptNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import { nodeRunAttemptIndex } from '../../../domain/nodeRunAttempt'
import { describeEffectError } from '../../../domain/effectErrorDescription'
import { runAssembly, type IsoLike } from '../../kernel/assembly'
import { runOneScriptAttempt } from './runOneScriptAttempt'
import type { ScriptAttemptOutcome } from './types'

export async function runScriptNode(
  ports: ScriptNodeExecutionPorts,
  args: NodeStepRequest<'script'>,
): Promise<NodeStepOutcome> {
  // RFC-266: the SCRIPT pool, not the agent pool — a second-scale script must
  // not queue behind multi-minute agent runs (and cannot starve them either).
  const {
    task: { taskId },
    policy: opts,
    log,
    scriptSem,
  } = ports
  const signal = args.execution.signal
  const { node, iteration } = args

  const language = readScriptLanguage(node)
  if (language === undefined) {
    return { kind: 'failed', summary: `script node ${node.id} has no language`, message: 'invalid' }
  }
  const isReadonly = resolveScriptReadonly(node)

  const { inputs: upstreamInputs, consumed: consumedUpstream } =
    await ports.input.resolveUpstreamInputs(node.id, {
      containerRunId: args.containerRunId,
      iteration,
    })
  const consumedUpstreamJson = ports.input.prepareConsumedInputs(consumedUpstream)

  // Row selection mirrors the agent branch: adopt a pending row if one exists,
  // otherwise mint the next retry index.
  const sameNodeIterRuns = await ports.ledger.listNodeRuns({
    taskId,
    nodeId: node.id,
    iteration,
  })
  // RFC-287 T8：取行前奏收编（脚本线不继承 reviewIteration、不写 agentOverrideName
  // ——它没有评审轮次也没有代理借用；其余四维与 agent 线同）。
  const resolvedRow = await ports.ledger.resolveSchedulerRunRow({
    taskId,
    nodeId: node.id,
    containerRunId: args.containerRunId,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: false,
    clearAgentOverride: false,
    trackRetryIndex: true,
    broadcastPending: (id) => ports.status.broadcastNodeStatus(taskId, id, node.id, 'pending'),
    broadcastCanceled: (id) => ports.status.broadcastNodeStatus(taskId, id, node.id, 'canceled'),
  })
  let nodeRunId = resolvedRow.nodeRunId
  const retryIndex = resolvedRow.retryIndex

  const interpreter = await ports.process.resolveInterpreter(
    language,
    opts.scriptInterpreters ?? {},
  )
  if (interpreter === null) {
    await ports.ledger.setNodeRunStatus({
      nodeRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'script-interpreter-missing',
      extra: {
        identity: {
          finishedAt: Date.now(),
          // 带上解析链的逐环结果，而不是只报结论——四环（which / 推导 / 存在 / 探测）
          // 失败时长得一模一样，光看结论排不了障（RFC-253 T41 的 Windows 首红实证）。
          errorMessage:
            `no ${language} interpreter available on this host: ` +
            ports.process.describeInterpreterResolution(language, opts.scriptInterpreters ?? {}),
          failureCode: 'script-interpreter-missing',
        },
      },
    })
    ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: `script node ${node.id}: ${language} interpreter not found`,
      message: 'script-interpreter-missing',
    }
  }

  const maxRetries = opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET

  // RFC-287 T5c：本线改走 `runAssembly` 骨架的**模式 B**（跨 attempt 窗口）。
  // 一次 scriptSem 许可 + 一棵 iso 的窗口内由 retryPolicy 驱动多次 attempt；
  // 与 agent 线相反，脚本线**每次重试都换新树**（D24：否则上一次的文件写入会与
  // 这一次叠加）。四处逐 attempt 语义逐字保住：信号取消早退、永久失败中断、
  // 逐次铸行+广播+落基线、succeeded 驱动合并。
  let isoHandle: IsoHandle | null = null
  const isoKeyRunId = nodeRunId
  let succeeded = false
  let lastFailure: { code: string; message: string } | null = null
  let canceledMsg: string | null = null

  const createScriptIso = async (): Promise<IsoHandle> => {
    isoHandle = await ports.workspace.createIsoUnderLock(isoKeyRunId)
    return isoHandle
  }

  return await runAssembly<Record<string, never>, ScriptAttemptOutcome, NodeStepOutcome>(
    {},
    {
      pools: [scriptSem],
      iso: {
        create: createScriptIso,
        // 落基线在许可保护的主 try 内（与 agent 线同档；抛出经 finally 释放后继续
        // 传播——design §10.10 的按线声明）。
        persistBase: 'in-window',
        persist: async () => {
          if (isoHandle !== null) await ports.workspace.persistIsoBase(nodeRunId, isoHandle)
        },
      },
      onIsoSetupFailure: (err) => {
        log.warn('script iso worktree setup failed', {
          nodeId: node.id,
          error: describeEffectError(err),
        })
        return {
          kind: 'failed',
          // failure code 逐字保持——它是**对外**的失败分类，改名等于让既有按
          // `iso-setup-failed` 归类的消费方静默失配（T14 实现门抓到的漂移）。
          // RFC-356 G3 只把 summary 换成能自证的结构化诊断。
          summary: ports.diagnostics.describeIsoFailure('isolated worktree setup failed', err),
          message: 'iso-setup-failed',
        }
      },
      spawn: async (_c, attempt) => {
        // **只有 attempt 0** 在这里短路。理由是它与迁移前逐字同位：那时循环顶的
        // 取消检查发生在铸行**之前**，所以直接返回不会遗留任何未终结的行。
        //
        // attempt ≥ 1 绝不能在这里短路（二轮实现门 A-1）：那时 `onNextAttempt` 已经
        // 铸出一条 pending 行并把它标成 isolating。迁移前的代码在换树/铸行之后是
        // **无条件**进入 `runOneScriptAttempt` 的，由它把新行终结为 canceled；在这里
        // 提前返回会跳过那一步，于是留下永不运行也永不终结的孤儿行——正是 preAttempt
        // 想消灭的形态，只是触发点从「取消发生在轮顶之前」挪到了「取消发生在
        // discardIso / iso.create / onNextAttempt 的某个 await 里」。preAttempt 只能
        // 覆盖轮顶那一瞬，覆盖不了这段异步窗口，所以两者缺一不可。
        if (attempt === 0 && signal?.aborted === true) {
          canceledMsg = 'signal aborted'
          return { kind: 'canceled' as const, summary: 'task canceled', message: 'signal aborted' }
        }
        const outcome = await runOneScriptAttempt(ports, {
          signal,
          node,
          nodeRunId,
          iteration,
          retryIndex: nodeRunAttemptIndex({ kind: 'offset', base: retryIndex, offset: attempt }),
          inputs: upstreamInputs,
          interpreter,
          isoHandle,
          isReadonly,
          language,
        })
        if (outcome.kind === 'done') succeeded = true
        else if (outcome.kind === 'canceled') canceledMsg = outcome.message
        else lastFailure = { code: outcome.message, message: outcome.summary }
        return outcome
      },
      retryPolicy: {
        shouldRetry: (outcome, attempt) => {
          if (outcome.kind === 'done' || outcome.kind === 'canceled') return false
          // Permanent failures gain nothing from another attempt.
          if ((SCRIPT_PERMANENT_FAILURE_CODES as readonly string[]).includes(outcome.message)) {
            return false
          }
          return attempt < maxRetries
        },
        // 换树 / 铸行 / 落基线之前先看取消——迁移前这一检查在循环最顶上，落进
        // 骨架时只剩 spawn 入口一处，于是取消若落在换树窗口里会留下一条永不运行
        // 的孤儿 pending 行（T14 实现门抓到的回归，见骨架 preAttempt 的注释）。
        preAttempt: () => {
          if (signal?.aborted !== true) return null
          canceledMsg = 'signal aborted'
          return { kind: 'canceled' as const, summary: 'task canceled', message: 'signal aborted' }
        },
        // D24：每次重试换新树——这正是让重跑一个写文件的脚本变安全的原因。
        isoOnRetry: 'always-recreate',
        onIsoRecreateFailure: (err) => {
          lastFailure = {
            code: 'iso-recreate-failed',
            message: ports.diagnostics.describeIsoFailure('iso-recreate-failed', err),
          }
          return {
            kind: 'failed',
            summary: lastFailure.message,
            message: lastFailure.code,
          }
        },
        onNextAttempt: async (attempt) => {
          nodeRunId = await ports.ledger.mintNodeRun({
            ...ports.ledger.nodeRunMintIdentityForSlot(
              {
                kind: 'node',
                nodeId: node.id,
                frame: { containerRunId: args.containerRunId, iteration: iteration },
              },
              { kind: 'current' },
            ),
            taskId,
            nodeId: node.id,
            status: 'pending',
            cause: 'process-retry',
            retryIndex: nodeRunAttemptIndex({ kind: 'offset', base: retryIndex, offset: attempt }),
            containerRunId: args.containerRunId,
            iteration,
            overrides: {
              inputs: {
                consumedUpstreamRunsJson: consumedUpstreamJson,
              },
            },
          })
          ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
          if (isoHandle !== null) await ports.workspace.persistIsoBase(nodeRunId, isoHandle)
        },
      },
      mergePhase: (_c, outcome) => {
        if (outcome.kind === 'canceled') {
          return {
            skip: 'not-done',
            keep: false,
            then: {
              produce: async () => ({
                kind: 'canceled' as const,
                summary: 'task canceled',
                message: canceledMsg ?? 'signal aborted',
              }),
            },
          }
        }
        // readonly 的产物永不合回主干（一次性副本），且 settle 先于 done 写。
        if (!succeeded || isReadonly) return { skip: 'not-done', keep: false, then: 'settle' }
        if (isoHandle === null || isoHandle.passthrough) {
          return { skip: 'passthrough', keep: false, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        run: async () => {
          const iso = isoHandle as IsoHandle
          const merge = await ports.workspace.mergeBackAndSettle({
            handle: iso,
            nodeRunId,
            via: 'live',
            conflictResolver: (conflicts, containerPath) =>
              ports.conflicts.resolveMergeConflicts({
                conflicts,
                containerPath,
                conflictNodeRunId: nodeRunId,
                nodeId: node.id,
                iteration,
              }),
          })
          return merge
        },
        disposition: {
          onConflictHuman: (detail) => ({
            // 显式保留（T5a 起不再依赖 finally 谓词碰巧为假）。
            keep: true,
            produce: async () => ({
              kind: 'awaiting_human' as const,
              summary: `merge conflict unresolved: ${detail}`,
              message: 'merge-conflict',
            }),
          }),
          onThrow: (err) => ({
            keep: true,
            then: {
              produce: async () => {
                const msg = describeEffectError(err)
                await ports.workspace.markMergeFailed(nodeRunId, msg)
                return {
                  kind: 'failed' as const,
                  summary: `script node ${node.id} merge failed`,
                  message: `merge-back-failed: ${msg}`,
                }
              },
            },
          }),
        },
      },
      // 不要在这里 `.catch(() => {})`：骨架自己会 catch 并 `log.warn('iso discard
      // failed')`，本地先吞掉等于把那条约定好的告警变成永不可达，残留工作树 / ref
      // 的清理失败就彻底没了痕迹（T14 实现门）。
      discardIso: async (h: IsoLike) => {
        await ports.workspace.discardNodeIso(h as IsoHandle)
      },
      settle: async () => {
        if (succeeded) return { kind: 'ok', summary: '', message: '' }
        return {
          kind: 'failed',
          summary: lastFailure?.message ?? `script node ${node.id} failed`,
          message: lastFailure?.code ?? 'script-nonzero-exit',
        }
      },
      log,
    },
  )
}
