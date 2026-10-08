import { maskDiagnosticsText, type DeclaredInjectionManifest } from '@agent-workflow/shared'
import type { AgentInvocationBinding } from './ports/agentInvocation'
import type { ExecutionStartReceipt } from './ports/executionEffect'
import type {
  PreparedSystemAgentRunResult,
  SessionCaptureIncompleteReason,
  SystemAgentCompiledInvocation,
  SystemAgentCoreInvocation,
  SystemAgentRunPolicy,
  SystemAgentRunStatus,
} from './ports/systemAgentRun'
import type {
  StartupInventory,
  SystemAgentEventSinkV1,
  SystemAgentOutputEvidence,
} from '@/modules/runtime-management/public/participants'
import type { Logger } from '@/util/log'

export const DEFAULT_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_EVENT_TEXT_BYTES = 8 * 1024 * 1024
const STDERR_TAIL_CAP = 8 * 1024
const CHILD_TERM_GRACE_MS = 2_000

/**
 * Why a run produced no parseable envelope, read off the evidence the pump
 * collected. Lives next to `SystemAgentOutputEvidence`'s only producer
 * (`runSystemAgent`) so every system agent can classify a missing envelope the
 * same way.
 *
 * RFC-367 moved it here from `modules/intent/application/turnEngine.ts`: it
 * never touched anything intent-specific, and the memory distiller needs the
 * same answer to tell "the model wrote the wrong format" apart from "the reply
 * outgrew `maxEventTextBytes` and the envelope was dropped with it". A bounded
 * context may not import another's internals, so the choice was relocate or
 * fork — and a forked copy of a classifier drifts. Behavior is byte-identical
 * to the intent original; its assertions moved with it.
 */
// RFC-370: the same pure classifier is shared with consumer-owned demand ports;
// retain the original compatibility exports without a cross-owner dependency.
export { classifyMissingEnvelope } from '@agent-workflow/shared'
export type { MissingEnvelopeReason } from '@agent-workflow/shared'

export function emptySystemAgentOutputEvidence(): SystemAgentOutputEvidence {
  return {
    assistantTextSeen: false,
    observedAssistantTextBytes: 0,
    retainedAssistantTextBytes: 0,
    eventTextCapHit: false,
    unparsedStdoutSeen: false,
    lastNormalizedEventKind: null,
    lastRuntimeEventType: null,
    terminalResult: 'not-observed',
  }
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

export async function runSystemAgentCore(
  opts: SystemAgentRunPolicy,
  input: {
    readonly log: Logger
    readonly timeoutMs: number
    readonly maxEventTextBytes: number
    readonly startedAt: number
    readonly invocation: SystemAgentCoreInvocation
    readonly retainedRef: string
  },
): Promise<PreparedSystemAgentRunResult> {
  const { log, timeoutMs, maxEventTextBytes, startedAt } = input
  const retainedRef = input.retainedRef

  const outputEvidence = emptySystemAgentOutputEvidence()
  const fail = (
    status: SystemAgentRunStatus,
    extra: Partial<PreparedSystemAgentRunResult> = {},
  ): PreparedSystemAgentRunResult => ({
    status,
    exitCode: null,
    eventText: '',
    stderrTail: '',
    durationMs: Date.now() - startedAt,
    retainedRef,
    scratchRetained: false,
    outputEvidence: { ...outputEvidence },
    ...extra,
  })

  // ── scratch layout + seed files (platform-side; agent never fetches) ──
  try {
    await input.invocation.prepareWorkspace()
  } catch (err) {
    await input.invocation.workspace.discard()
    return fail('spawn-failed', {
      stderrTail: maskDiagnosticsText(
        `scratch setup failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    })
  }

  let preparedMaterial: SystemAgentCompiledInvocation | null = null
  let invocation: AgentInvocationBinding | undefined
  // RFC-282 B1b — declared manifest from the unified assembly (absent on
  // testPlanOverride fixtures); threaded onto the result for settle-time
  // verification so no consumer re-renders it (§2.1b-2).
  let declaredForResult: DeclaredInjectionManifest | undefined
  let result: PreparedSystemAgentRunResult | undefined
  let sinkTerminal = false
  let sinkFailed = false
  let sinkFailureReason: SessionCaptureIncompleteReason | undefined
  let sinkTerminalIntent:
    | { state: 'complete' | 'incomplete'; reason?: SessionCaptureIncompleteReason }
    | undefined

  const markSinkTerminal = async (
    state: 'complete' | 'incomplete',
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> => {
    if (opts.eventSink === undefined || sinkTerminal) return
    if (
      sinkTerminalIntent === undefined ||
      (state === 'incomplete' && sinkTerminalIntent.state === 'complete')
    ) {
      sinkTerminalIntent = {
        state,
        ...(state === 'incomplete' && reason !== undefined ? { reason } : {}),
      }
    }
    const terminal = sinkTerminalIntent
    try {
      await opts.eventSink.markTerminal(terminal.state, terminal.reason)
      sinkTerminal = true
    } catch (error) {
      log.warn('system-agent-session-terminal-persist-failed', {
        feature: opts.feature,
        err: maskDiagnosticsText(error instanceof Error ? error.message : String(error)),
      })
    }
  }
  const failSink = async (
    reason: SessionCaptureIncompleteReason,
    error: unknown,
  ): Promise<void> => {
    if (!sinkFailed) {
      sinkFailed = true
      sinkFailureReason = reason
      log.warn('system-agent-session-event-persist-failed', {
        feature: opts.feature,
        reason,
        err: maskDiagnosticsText(error instanceof Error ? error.message : String(error)),
      })
    }
    await markSinkTerminal('incomplete', reason)
  }
  const appendSink = async (
    event: Parameters<SystemAgentEventSinkV1['append']>[0],
  ): Promise<void> => {
    if (opts.eventSink === undefined || sinkFailed) return
    try {
      await opts.eventSink.append(event)
    } catch (error) {
      await failSink('stream-persist-failed', error)
    }
  }
  const setSinkRoot = async (sessionId: string, previousSessionId?: string): Promise<void> => {
    if (opts.eventSink === undefined) return
    if (sinkFailed && opts.nativeIdentityAuthoritative !== true) return
    try {
      await opts.eventSink.setRootSessionId(sessionId, previousSessionId)
    } catch (error) {
      await failSink('stream-persist-failed', error)
      // This hook owns native-session claim/rotation for MCP. Continuing the
      // child after a collision would violate the single-writer lease.
      if (opts.nativeIdentityAuthoritative === true) throw error
    }
  }
  const markSinkResetPending = async (sessionId: string): Promise<void> => {
    if (opts.eventSink === undefined) return
    if (sinkFailed && opts.nativeIdentityAuthoritative !== true) return
    if (opts.eventSink.markRootSessionResetPending === undefined) {
      if (opts.nativeIdentityAuthoritative === true) {
        throw new Error('authoritative native-session sink cannot persist reset boundaries')
      }
      return
    }
    try {
      await opts.eventSink.markRootSessionResetPending(sessionId)
    } catch (error) {
      await failSink('stream-persist-failed', error)
      if (opts.nativeIdentityAuthoritative === true) throw error
    }
  }

  try {
    result = await (async (): Promise<PreparedSystemAgentRunResult> => {
      try {
        preparedMaterial = await input.invocation.compile()
        declaredForResult = preparedMaterial.declared
      } catch (err) {
        return fail('spawn-failed', {
          stderrTail: maskDiagnosticsText(
            `failed to prepare spawn: ${err instanceof Error ? err.message : String(err)}`,
          ),
        })
      }

      invocation = preparedMaterial!.bind()
      const materialEvidence = invocation.evidence
      const protocol = invocation.protocol

      // RFC-280 T4 — the child's whole lifecycle (spawn / stdin / timers /
      // TERM→KILL / reap / bounded drain) lives in the unified agent executor;
      // this function keeps only what is system-agent-specific: the event
      // sink, output evidence, and the result-domain mapping.
      let sessionId: string | undefined
      let pendingConversationReset:
        | { outgoingSessionId: string; newConversationId: string }
        | undefined
      let nativeSessionIntegrityFailed = false
      let eventText = ''
      let eventTextBytes = 0
      let stderrText = ''
      // RFC-237 (P2-4): terminal application error reported on a clean-exit
      // stdout line (claude `result` is_error). Last one wins.
      let resultError: string | undefined
      let receiptError: unknown
      let capturedStartupInventory: StartupInventory | null = null

      const localExecution = invocation.bindExecution()
      const run = await localExecution.effect.submit({
        executionRef: localExecution.executionRef,
        materialRef: localExecution.materialRef,
        workspaceRef: localExecution.workspaceRef,
        timeoutMs,
        termGraceMs: CHILD_TERM_GRACE_MS,
        ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
        ...(invocation.lifecycle.beforeStart !== undefined
          ? { beforeStart: invocation.lifecycle.beforeStart }
          : {}),
        ...(input.invocation.acknowledgeStart()
          ? {
              onStarted: async (receipt: ExecutionStartReceipt) => {
                try {
                  await localExecution.acknowledgeOwner(receipt)
                } catch (err) {
                  // Historical contract: a failed spawn receipt is a SPAWN
                  // failure (mcp playground admission fence) — remember the
                  // cause and let the executor abort the child.
                  receiptError = err
                  throw err
                }
              },
            }
          : {}),
        capture: {
          onStdoutLine: async (line) => {
            const observation = protocol.observeSystemEvent?.(line)
            if (observation !== undefined) {
              if (observation.runtimeEventType !== null) {
                outputEvidence.lastRuntimeEventType = observation.runtimeEventType
              }
              if (observation.terminalResult === 'error') {
                outputEvidence.terminalResult = 'error'
              } else if (
                observation.terminalResult === 'success' &&
                outputEvidence.terminalResult !== 'error'
              ) {
                outputEvidence.terminalResult = 'success'
              }
            }
            const terminalError = protocol.parseTerminalResultError?.(line)
            if (terminalError != null) resultError = terminalError
            const ev = protocol.parseEvent(line)
            // RFC-280 T6 / RFC-297 T14 —— 一次性启动报告。改为消费 driver 在
            // **同一次解析**里挂上的事件载荷，不再对同一行二次 JSON.parse。
            if (capturedStartupInventory === null && ev !== null) {
              const faces = ev.data?.inventory?.faces
              if (faces !== undefined) {
                capturedStartupInventory = {
                  ...(faces.tools === undefined ? {} : { tools: faces.tools.map((t) => t.key) }),
                  ...(faces.agents === undefined ? {} : { agents: faces.agents.map((a) => a.key) }),
                  ...(faces.skills === undefined ? {} : { skills: faces.skills.map((s) => s.key) }),
                  ...(faces.mcps === undefined
                    ? {}
                    : {
                        mcpServers: faces.mcps.map((m) => ({
                          name: m.key,
                          status: m.status ?? '',
                        })),
                      }),
                }
              }
            }
            if (ev === null) {
              outputEvidence.unparsedStdoutSeen = true
              await appendSink({
                ts: Date.now(),
                kind: 'text',
                payload: line,
                sessionId: sessionId ?? null,
                parentSessionId: null,
                source: 'stream',
              })
              return
            }
            outputEvidence.lastNormalizedEventKind = ev.kind
            if (ev.sessionId !== undefined) {
              if (sessionId === undefined) {
                sessionId = ev.sessionId
                try {
                  await setSinkRoot(ev.sessionId)
                } catch {
                  nativeSessionIntegrityFailed = true
                  throw new Error('runtime native session claim failed')
                }
              } else if (sessionId !== ev.sessionId) {
                if (
                  pendingConversationReset === undefined ||
                  pendingConversationReset.outgoingSessionId !== sessionId
                ) {
                  nativeSessionIntegrityFailed = true
                  throw new Error('runtime changed native session id without a conversation reset')
                }
                const previousSessionId = sessionId
                sessionId = ev.sessionId
                pendingConversationReset = undefined
                try {
                  await setSinkRoot(sessionId, previousSessionId)
                } catch {
                  nativeSessionIntegrityFailed = true
                  throw new Error('runtime native session rotation failed')
                }
              }
            }
            if (ev.conversationReset !== undefined) {
              if (
                sessionId === undefined ||
                ev.conversationReset.outgoingSessionId !== sessionId ||
                pendingConversationReset !== undefined
              ) {
                nativeSessionIntegrityFailed = true
                throw new Error('runtime reported an invalid conversation reset boundary')
              }
              pendingConversationReset = ev.conversationReset
              try {
                await markSinkResetPending(sessionId)
              } catch {
                nativeSessionIntegrityFailed = true
                throw new Error('runtime native session reset fence failed')
              }
            }
            if (typeof ev.text === 'string' && ev.text.length > 0) {
              const bytes = Buffer.byteLength(ev.text, 'utf8')
              outputEvidence.assistantTextSeen = true
              outputEvidence.observedAssistantTextBytes = saturatingAdd(
                outputEvidence.observedAssistantTextBytes,
                bytes,
              )
              if (eventTextBytes + bytes <= maxEventTextBytes) {
                eventText += ev.text
                eventTextBytes += bytes
                outputEvidence.retainedAssistantTextBytes = saturatingAdd(
                  outputEvidence.retainedAssistantTextBytes,
                  bytes,
                )
              } else {
                outputEvidence.eventTextCapHit = true
              }
            }
            await appendSink({
              ts: ev.timestamp ?? Date.now(),
              kind: ev.kind,
              payload: ev.rawLine,
              sessionId: ev.sessionId ?? sessionId ?? null,
              parentSessionId: null,
              source: 'stream',
            })
          },
          onStderrLine: async (line) => {
            const remaining = STDERR_TAIL_CAP - Buffer.byteLength(stderrText, 'utf8')
            if (remaining > 0) {
              stderrText += Buffer.from(`${line}\n`, 'utf8').subarray(0, remaining).toString('utf8')
            }
            await appendSink({
              ts: Date.now(),
              kind: 'stderr',
              payload: maskDiagnosticsText(line),
              sessionId: sessionId ?? null,
              parentSessionId: null,
              source: 'stream',
            })
          },
          // A clipped frame stored as if whole would lie to the session view —
          // mark the capture incomplete exactly like the historical
          // frame-limit path did.
          onLineTruncated: () =>
            failSink(
              'stream-frame-limit-exceeded',
              new Error('stream line exceeded the executor line cap'),
            ),
        },
        log,
      })

      if (run.outcome === 'spawn-failed' || receiptError !== undefined) {
        const message =
          receiptError !== undefined
            ? receiptError instanceof Error
              ? receiptError.message
              : String(receiptError)
            : (run.spawnError ?? 'unknown spawn failure')
        return fail('spawn-failed', {
          stderrTail: maskDiagnosticsText(`binary failed to start: ${message}`),
        })
      }
      if (run.outcome === 'unreaped') {
        return fail('unreaped')
      }
      if (run.pumpError !== undefined) {
        await failSink('stream-persist-failed', new Error(run.pumpError))
        return fail('exit-nonzero', {
          stderrTail: maskDiagnosticsText(run.pumpError).slice(0, STDERR_TAIL_CAP),
          ...(nativeSessionIntegrityFailed || pendingConversationReset !== undefined
            ? { nativeSessionIntegrityFailed: true }
            : {}),
        })
      }
      if (pendingConversationReset !== undefined) {
        await failSink(
          'stream-persist-failed',
          new Error(
            'runtime ended before reporting the replacement native session id after conversation reset',
          ),
        )
        return fail('exit-nonzero', {
          stderrTail:
            'runtime ended before reporting the replacement native session id after conversation reset',
          nativeSessionIntegrityFailed: true,
        })
      }
      const exitCode = run.exitCode
      if (run.drainTimedOut === true) {
        // Bounded post-exit flush expired — evidence loss, not completion.
        await failSink(
          'post-exit-flush-timeout',
          new Error('stdout/stderr did not reach EOF after child exit'),
        )
      }

      const stderrTail = maskDiagnosticsText(stderrText.slice(0, STDERR_TAIL_CAP))
      // RFC-237 — post-exit child-session sweep is a driver capability now
      // (opencode: private-store SQLite walk; claude omits it — the full main
      // session already streamed through parseEvent into the sink).
      if (
        !sinkFailed &&
        opts.eventSink !== undefined &&
        sessionId !== undefined &&
        materialEvidence.captureSessionsToSink !== undefined
      ) {
        const captured = await materialEvidence.captureSessionsToSink({
          rootSessionId: sessionId,
          sink: opts.eventSink,
          log,
        })
        if (captured.failed) {
          await failSink('child-capture-failed', captured.failureReason)
        }
      }
      if (!sinkFailed) await markSinkTerminal('complete')

      const base = {
        exitCode,
        eventText,
        stderrTail,
        durationMs: Date.now() - startedAt,
        ...(sessionId === undefined ? {} : { capturedSessionId: sessionId }),
        retainedRef,
        scratchRetained: false,
        outputEvidence: { ...outputEvidence },
        ...(capturedStartupInventory === null
          ? {}
          : { startupInventory: capturedStartupInventory }),
        ...(declaredForResult === undefined ? {} : { declared: declaredForResult }),
      }
      if (run.outcome === 'aborted') return { status: 'aborted', ...base }
      if (run.outcome === 'timeout') return { status: 'timeout', ...base }
      if (exitCode !== 0) return { status: 'exit-nonzero', ...base }
      // RFC-237 (P2-4): clean exit but a terminal is_error result — fail the
      // run with the masked error text instead of letting the caller chase a
      // phantom missing envelope. Impl-gate P2: the text must reach the
      // caller's PERSISTED diagnostics — stderr is commonly empty in this
      // shape, so it doubles as the stderr tail when there was none.
      if (resultError !== undefined) {
        const masked = maskDiagnosticsText(resultError).slice(0, STDERR_TAIL_CAP)
        return {
          status: 'result-error',
          ...base,
          ...(base.stderrTail.length === 0 ? { stderrTail: masked } : {}),
          resultError: masked,
        }
      }
      return { status: 'ok', ...base }
    })()
  } finally {
    if (!sinkTerminal) {
      await markSinkTerminal(
        sinkFailed || result?.status === 'unreaped' ? 'incomplete' : 'complete',
        sinkFailed
          ? sinkFailureReason
          : result?.status === 'unreaped'
            ? 'post-exit-flush-timeout'
            : undefined,
      )
    }
    // RFC-280 T4: the child's kill/reap lifecycle lives in the unified
    // executor; what remains here are the two ordered barriers that must run
    // AFTER the post-exit capture sweep — plan cleanup, then scratch disposal.
    const prepared = preparedMaterial as SystemAgentCompiledInvocation | null
    if (result?.status === 'unreaped') {
      // The child (or a descendant) may still own files under scratch — no
      // cleanup, retain everything for recovery.
      result = { ...result, scratchRetained: true }
    } else {
      let cleanupOk = true
      try {
        if (invocation === undefined) await prepared?.cleanup?.()
        else await invocation.lifecycle.cleanup?.()
      } catch {
        cleanupOk = false
      }
      if (!cleanupOk) {
        result = {
          ...(result ?? fail('spawn-failed')),
          status: 'spawn-failed',
          stderrTail: 'runtime cleanup failed',
          scratchRetained: true,
        }
      } else {
        const wantScratchRemoved =
          result !== undefined && result.status === 'ok' && opts.retainScratchOnSuccess !== true
        let scratchRemoved = false
        if (wantScratchRemoved) {
          try {
            await invocation!.workspace.discard()
            scratchRemoved = true
          } catch {
            // Retained deliberately — recovery + GC own it now.
          }
        }
        if (result !== undefined) {
          result = { ...result, scratchRetained: !scratchRemoved }
          if (result.status === 'ok' && !scratchRemoved && opts.retainScratchOnSuccess !== true) {
            // Cleanup barrier failed on a success path: surface it — the store
            // may still be locked; retaining scratch is deliberate.
            log.warn('system-agent-scratch-retained', {
              feature: opts.feature,
              retainedRef,
            })
          }
        }
      }
    }
  }
  return result ?? fail('spawn-failed', { scratchRetained: true })
}
