// RFC-293 — one dispatcher for HTTP-triggered turns and queued boot recovery.

import type { IntentSystemAgentRunFamily as SystemAgentRunFamily } from './ports/intentSystemAgent'
import type { Actor } from '@/auth/actor'
import type {
  IntentDumpAuxiliaryQueries,
  IntentTurnRuntimeResolver,
} from '@/modules/intent/application/ports/intentAuxiliaryQueries'
import type { IntentPersistence } from '@/modules/intent/application/ports/intentPersistence'
import type { IntentWorkflowGraphValidationPort } from '@/modules/intent/application/ports/intentWorkflowGraphValidation'
import {
  actorOfDirectAuthority,
  admitDurableWorkOwner,
  type DirectAuthorityAdmissionRuntime,
} from '@/auth/session'
import type { Config } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'
import type { IntentSessionEventPublisher } from '../ports/intentSessionEvents'
import {
  resolveIntentTurnConfig,
  runIntentTurn,
  settleReservedIntentTurnStartFailure,
} from './turnEngine'
import type { ReservedIntentTurn } from './session'
import { activateIntentWorkingSetChange } from './workingSet'
import { intentResourceVisibility, type IntentResourceCatalogBinding } from './resourceCatalog'
import type {
  IntentExecutionCheckpoint,
  IntentExecutionControl,
  IntentTurnExecutionLifecycle,
} from './ports/intentExecution'
import { IntentExecutionDeferredError } from './executionLifecycle'

const log = createLogger('intentDispatcher')

export interface IntentDispatchDeps {
  persistence: IntentPersistence
  /** Boot recovery re-admits each session's owner through this seam; see
   *  `admitDurableWorkOwner`. */
  identityAccess: DirectAuthorityAdmissionRuntime
  appHome: string
  configSnapshot: Config
  runtimeResolver: IntentTurnRuntimeResolver
  dumpAuxiliary: IntentDumpAuxiliaryQueries
  /** RFC-358 —— 工作流图校验端口（resource-catalog public 合同）。 */
  graphValidation: IntentWorkflowGraphValidationPort
  /** Bootstrap-selected Resource Catalog query/context for this exact actor. */
  resourceCatalogFor(actor: Actor): IntentResourceCatalogBinding
  readonly systemAgents: SystemAgentRunFamily
  /** RFC-355 T4b：会话动静的播报面由 bootstrap 注入，intent 不认识传输层。 */
  readonly events: IntentSessionEventPublisher
  readonly execution?: IntentTurnExecutionLifecycle
}

function emitSessionUpdated(
  events: IntentSessionEventPublisher,
  sessionId: string,
  ownerUserId: string,
): void {
  events.publish({ type: 'intent.session.updated', sessionId, ownerUserId })
}

/** Launch a previously persisted reservation. Completion always checks for a
 * queued working-context successor, so response loss and browser closure do
 * not affect handoff. */
export async function dispatchIntentTurn(
  deps: IntentDispatchDeps,
  sessionId: string,
  actor: Actor,
  reservation: ReservedIntentTurn,
): Promise<void> {
  if (deps.execution) {
    await deps.execution
      .dispatch(reservation.turnId, (control) =>
        dispatchOwnedIntentTurn(deps, sessionId, actor, reservation, control),
      )
      .catch((error: unknown) => {
        log.warn('intent-original-owner-pending', {
          sessionId,
          turnId: reservation.turnId,
          err: error instanceof Error ? error.message : String(error),
        })
      })
    return
  }
  await dispatchOwnedIntentTurn(deps, sessionId, actor, reservation)
}

/** Bootstrap uses this exact dispatcher for cold result recovery as well. */
export async function recoverOwnedIntentTurn(
  deps: Omit<IntentDispatchDeps, 'configSnapshot'>,
  checkpoint: IntentExecutionCheckpoint,
  control: IntentExecutionControl,
): Promise<void> {
  const owner = await admitDurableWorkOwner(
    deps.identityAccess,
    checkpoint.reservation.launchSession.ownerUserId,
  )
  if (!owner) throw new Error('intent-original-owner-unavailable')
  await dispatchOwnedIntentTurn(
    { ...deps, configSnapshot: checkpoint.configSnapshot },
    checkpoint.sessionId,
    actorOfDirectAuthority(owner),
    checkpoint.reservation,
    control,
    checkpoint,
  )
}

async function dispatchOwnedIntentTurn(
  deps: IntentDispatchDeps,
  sessionId: string,
  actor: Actor,
  reservation: ReservedIntentTurn,
  control?: IntentExecutionControl,
  original?: IntentExecutionCheckpoint,
): Promise<void> {
  // RFC-359 —— 这个函数的**全部** 13 个调用点都是 fire-and-forget（应答先回、回合在后台跑），
  // 所以它必须自己保证**永不 reject**。
  //
  // 下面那层 try/catch/finally 是原有的，但**它的 catch 与 finally 里也在写库**
  // （`settleReservedIntentTurnStartFailure` / `activateIntentWorkingSetChange`）：连接池一关，
  // 处理块自己就抛，异常于是**越过**它逃出来，`void` 掉之后就是一条进程级 unhandled rejection。
  //
  // PostgreSQL 上这条路径真实可达——回合在后台跑、进程（或测试作用域）收尾时把池关掉，
  // 在飞的查询拿到 `ERR_POSTGRES_CONNECTION_CLOSED`（2026-09-12 CI 实撞 ubuntu shard 6/8）。
  // 那种红**看起来像绿的**：bun 印 `# Unhandled error between tests`，计数行照样
  // `N pass / 0 fail`，只把退出码变成 1。SQLite 是同步单写者，没有「池关了但活还在跑」这个窗口。
  //
  // 兜住并记一条 warn 就够：该回合要么已被下面的 catch 结算过，要么本进程正在收尾、
  // 下次启动由恢复路径重新认领。
  try {
    let checkpoint = original
    if (control) {
      const read = deps.persistence.readExecutionCheckpoint.bind(deps.persistence)
      checkpoint ??= (await control.checkpoint(() => read(reservation.turnId))) ?? undefined
      if (checkpoint?.phase === 'closed') return
      if (!checkpoint) {
        const reserved: IntentExecutionCheckpoint = {
          version: 1,
          revision: 0,
          phase: 'reserved',
          sessionId,
          reservation,
          configSnapshot: deps.configSnapshot,
        }
        const write = deps.persistence.writeExecutionCheckpoint.bind(deps.persistence)
        await control.checkpoint(() => write({ checkpoint: reserved, expectedRevision: null }))
        checkpoint = reserved
      }
      if (checkpoint.phase === 'reserved' && !control.current())
        throw new IntentExecutionDeferredError()
    }
    const EXECUTION_BROADCAST_THROTTLE_MS = 500
    let lastExecutionBroadcastAt = 0
    let pendingExecution: { sessionId: string; turnId: string; eventSeq: number } | undefined
    let executionTimer: ReturnType<typeof setTimeout> | undefined
    const flushExecution = (): void => {
      if (pendingExecution === undefined) return
      const event = pendingExecution
      pendingExecution = undefined
      lastExecutionBroadcastAt = Date.now()
      deps.events.publish({
        type: 'intent.turn.execution.updated',
        sessionId: event.sessionId,
        turnId: event.turnId,
        eventSeq: event.eventSeq,
        ownerUserId: actor.user.id,
      })
    }
    const queueExecution = (event: {
      sessionId: string
      turnId: string
      eventSeq: number
    }): void => {
      if (pendingExecution === undefined || event.eventSeq >= pendingExecution.eventSeq) {
        pendingExecution = event
      }
      const remaining = EXECUTION_BROADCAST_THROTTLE_MS - (Date.now() - lastExecutionBroadcastAt)
      if (remaining <= 0) {
        if (executionTimer !== undefined) clearTimeout(executionTimer)
        executionTimer = undefined
        flushExecution()
        return
      }
      if (executionTimer !== undefined) return
      executionTimer = setTimeout(() => {
        executionTimer = undefined
        flushExecution()
      }, remaining)
      executionTimer.unref?.()
    }

    let outcome: Awaited<ReturnType<typeof runIntentTurn>> | undefined
    try {
      const config =
        checkpoint?.snapshot?.config ??
        (await resolveIntentTurnConfig(deps.runtimeResolver, deps.configSnapshot))
      outcome = await runIntentTurn(
        {
          persistence: deps.persistence,
          appHome: deps.appHome,
          config,
          resourceCatalog: deps.resourceCatalogFor(actor),
          dumpAuxiliary: deps.dumpAuxiliary,
          graphValidation: deps.graphValidation,
          onSessionEvent: (event) => {
            if (
              event.type === 'intent.turn.execution.updated' &&
              event.turnId !== undefined &&
              event.eventSeq !== undefined
            ) {
              queueExecution({
                sessionId: event.sessionId,
                turnId: event.turnId,
                eventSeq: event.eventSeq,
              })
              return
            }
            if (event.type === 'intent.turn.started' || event.type === 'intent.turn.finished') {
              if (event.type === 'intent.turn.finished') flushExecution()
              deps.events.publish({
                type: event.type,
                sessionId: event.sessionId,
                turnId: event.turnId ?? '',
                ownerUserId: actor.user.id,
              })
            }
          },
          systemAgents: deps.systemAgents,
          ...(control && checkpoint ? { execution: { control, checkpoint } } : {}),
        },
        { sessionId, actor, reservation },
      )
    } catch (error) {
      if (error instanceof IntentExecutionDeferredError) throw error
      // Issued facts belong to the original turn tail. Never replace them with
      // the reservation-only error path if a selected producer failed.
      if (control && (await deps.persistence.readExecutionCheckpoint(reservation.turnId))?.receipt)
        throw error
      const detail = error instanceof Error ? error.message : String(error)
      const settleStartFailure = () =>
        settleReservedIntentTurnStartFailure(deps.persistence, {
          sessionId,
          actor,
          reservation,
          detail,
        })
      const settled = control
        ? await control.checkpoint(settleStartFailure)
        : await settleStartFailure()
      if (control && checkpoint) {
        const write = deps.persistence.writeExecutionCheckpoint.bind(deps.persistence)
        const closed: IntentExecutionCheckpoint = {
          ...checkpoint,
          revision: checkpoint.revision + 1,
          phase: 'closed',
          outcome: {
            turnId: reservation.turnId,
            kind: 'error',
            errorCode: 'intent-turn-start-failed',
          },
        }
        await control.checkpoint(() =>
          write({ checkpoint: closed, expectedRevision: checkpoint!.revision }),
        )
      }
      log.warn('intent-turn-fire-failed', { sessionId, err: detail, settled })
      if (settled) {
        deps.events.publish({
          type: 'intent.turn.finished',
          sessionId,
          turnId: reservation.turnId,
          ownerUserId: actor.user.id,
        })
      }
    } finally {
      if (executionTimer !== undefined) clearTimeout(executionTimer)
      flushExecution()
      if (!control || control.current()) {
        const activate = () =>
          activateIntentWorkingSetChange(
            deps.persistence,
            intentResourceVisibility(deps.resourceCatalogFor(actor)),
            actor,
            sessionId,
            deps.configSnapshot.intentBuilderMaxGenerateRounds ?? 50,
          )
        const next = control ? await control.checkpoint(activate) : await activate()
        if (next.reservation !== null) {
          emitSessionUpdated(deps.events, sessionId, actor.user.id)
          void dispatchIntentTurn(deps, sessionId, actor, next.reservation)
        } else if (outcome?.graphRepair !== undefined) {
          // RFC-358 T6（决策 D2）—— 图校验红了，自动再开一轮让模型自己修。
          //
          // 预约已经在 settle 的**同一个事务**里铸好（没有 in-flight 空窗），这里只负责
          // 把它跑起来。「只修一轮」的判据也在那个事务里：修复轮自己的 turn 行带标记，
          // 它再红一次就不会有第三轮。
          //
          // 用户提交的 working-set 变更优先——那是人的新输入，比自动修复重要，所以这条
          // 挂在 `next.reservation === null` 的分支上。
          log.info('intent-graph-repair-turn', {
            sessionId,
            afterTurnId: outcome.turnId,
            blockingErrors: outcome.blockingErrors ?? 0,
          })
          emitSessionUpdated(deps.events, sessionId, actor.user.id)
          void dispatchIntentTurn(deps, sessionId, actor, outcome.graphRepair)
        }
      } else if (outcome?.graphRepair) {
        // The durable reservation was minted with the original result. Let
        // the same owner retain it without authorizing a new invocation.
        void dispatchIntentTurn(deps, sessionId, actor, outcome.graphRepair)
      }
    }
  } catch (escaped) {
    if (control) {
      const read = deps.persistence.readExecutionCheckpoint.bind(deps.persistence)
      const primary = await control.checkpoint(() => read(reservation.turnId))
      // Auxiliary notifications cannot replace an already acknowledged
      // business outcome. Unclosed original facts still belong to the owner.
      if (primary?.phase !== 'closed') throw escaped
    }
    log.warn('intent-turn-dispatch-escaped', {
      sessionId,
      turnId: reservation.turnId,
      err: escaped instanceof Error ? escaped.message : String(escaped),
    })
  }
}

/** Claim queued rows left by a dead process or a lost completion wake-up. */
export async function listQueuedIntentWorkingSetSessionIds(
  persistence: IntentPersistence,
): Promise<readonly string[]> {
  return await persistence.listQueuedWorkingSetSessionIds()
}

export async function resumeQueuedIntentWorkingSets(
  deps: IntentDispatchDeps,
  sessionIds?: readonly string[],
): Promise<number> {
  const queuedIds = sessionIds ?? (await listQueuedIntentWorkingSetSessionIds(deps.persistence))
  const queued = queuedIds.map((sessionId) => ({ sessionId }))
  let resumed = 0
  for (const { sessionId } of queued) {
    const session = await deps.persistence.findSession(sessionId)
    if (session === null) continue
    // The owner has to be re-admitted, not hand-projected: `resourceCatalogFor`
    // resolves the actor back to its registered authority (RFC-345), and a
    // projection the registry never minted throws `foreign-legacy-actor-projection`
    // — which is exactly how every queued successor silently died after a crash.
    const admitted = await admitDurableWorkOwner(deps.identityAccess, session.ownerUserId)
    if (admitted === null) continue
    const actor = actorOfDirectAuthority(admitted)
    const next = await activateIntentWorkingSetChange(
      deps.persistence,
      intentResourceVisibility(deps.resourceCatalogFor(actor)),
      actor,
      sessionId,
      deps.configSnapshot.intentBuilderMaxGenerateRounds ?? 50,
    )
    if (next.reservation === null) continue
    resumed += 1
    emitSessionUpdated(deps.events, sessionId, actor.user.id)
    void dispatchIntentTurn(deps, sessionId, actor, next.reservation)
  }
  return resumed
}
