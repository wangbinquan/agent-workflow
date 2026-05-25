// RFC-061 PR-B T9 (final) — runner-v2 subprocess loop.
//
// Composes prepareRunnerV2Invocation (env/argv/cwd) + Bun.spawn +
// pumpLines (reused from services/runner) + aggregateStdout (post-exit
// parser) into a complete event-driven opencode attempt runner.
//
// Returns a RunOpencodeAttemptResult that the ProductionRunnerAdapter
// converts into RFC-061 events (attempt-output-captured +
// attempt-finished-*).
//
// NO node_runs writes, NO node_run_events writes — purely event-driven.

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

import type { Agent, Mcp, Plugin, Scope } from '@agent-workflow/shared'
import { createLogger, type Logger } from '@/util/log'

import {
  pumpLines,
  prepareSkills,
  type AgentOverrides,
  type ResolvedSkill,
  type RunResult,
} from './runnerUtils'
import { prepareRunnerV2Invocation } from './runnerV2Invocation'
import { aggregateStdout, type AggregatedStdout } from './runnerV2StdoutAggregator'

export interface LiveSubagentEvent {
  kind: 'subagent-output' | 'subagent-tool-use'
  sessionId: string
  /** For 'subagent-output': textual content of the assistant message. */
  content?: string
  /** For 'subagent-tool-use': name of the invoked tool. */
  toolName?: string
  /** Raw event detail forwarded to the typed payload. */
  detail?: unknown
}

export interface RunOpencodeAttemptOptions {
  appHome: string
  taskId: string
  attemptId: string
  scope: Scope
  worktreePath: string
  agent: Agent
  overrides?: AgentOverrides
  dependents?: readonly Agent[]
  mcps?: readonly Mcp[]
  plugins?: readonly Plugin[]
  skills?: readonly ResolvedSkill[]
  prompt: string
  resumeSessionId?: string
  /** Soft timeout in ms; killed via SIGTERM. Default 10 minutes. */
  timeoutMs?: number
  log?: Logger
  /** Override the opencode CLI head (tests inject stubOpencode). */
  opencodeCmd?: readonly string[]
  /**
   * RFC-061 follow-up P2-3 — fired per stdout line that parses as a
   * subagent text / tool-use event. When provided, the post-exit
   * aggregator path SKIPS re-emitting those events (the caller already
   * persisted them live). Pure stream — no dedup; the runner emits a
   * subagent event exactly once.
   */
  onLiveSubagentEvent?: (event: LiveSubagentEvent) => void
}

export interface RunOpencodeAttemptResult {
  outcome: 'success' | 'envelope-fail' | 'crash' | 'timeout' | 'canceled'
  exitCode: number | null
  outputs: Record<string, string>
  sessionId?: string
  tokenUsage: RunResult['tokenUsage']
  errorMessage?: string
  /** Subagent observations for emitting attempt-subagent-* events. */
  subagentToolUses: AggregatedStdout['subagentToolUses']
  subagentOutputs: AggregatedStdout['subagentOutputs']
  /** Parsed clarify body when the agent emitted a clarify envelope. */
  clarifyBody: string | null
  /** Process pid (for cancellation lookups; populated soon after spawn). */
  pid?: number
}

/**
 * Spawn an opencode subprocess for one RFC-061 attempt, wait for exit,
 * parse stdout into structured outputs / clarify / subagent telemetry.
 *
 * Pure with respect to RFC-061 state — NO db writes happen here. The
 * caller (ProductionRunnerAdapter.spawn) is responsible for translating
 * the result into events via writeEvents.
 */
export async function runOpencodeAttempt(
  opts: RunOpencodeAttemptOptions,
): Promise<RunOpencodeAttemptResult> {
  const log = opts.log ?? createLogger('runner-v2')

  // 1. Build invocation (env / argv / cwd).
  const invocation = prepareRunnerV2Invocation({
    appHome: opts.appHome,
    taskId: opts.taskId,
    attemptId: opts.attemptId,
    scope: opts.scope,
    worktreePath: opts.worktreePath,
    agent: opts.agent,
    ...(opts.overrides !== undefined ? { overrides: opts.overrides } : {}),
    ...(opts.dependents !== undefined ? { dependents: opts.dependents } : {}),
    ...(opts.mcps !== undefined ? { mcps: opts.mcps } : {}),
    ...(opts.plugins !== undefined ? { plugins: opts.plugins } : {}),
    prompt: opts.prompt,
    ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
    ...(opts.opencodeCmd !== undefined ? { opencodeCmd: opts.opencodeCmd } : {}),
  })

  // 2. Prepare disk: mkdir runRoot + configDir, copy skills into configDir.
  // Real opencode bootstrap writes <configDir>/.gitignore on startup,
  // so configDir must exist before spawn even when no skills declared.
  try {
    mkdirSync(invocation.runRoot, { recursive: true })
    mkdirSync(invocation.configDir, { recursive: true })
    prepareSkills(invocation.configDir, [...(opts.skills ?? [])], log)
  } catch (err) {
    return {
      outcome: 'crash',
      exitCode: null,
      outputs: {},
      tokenUsage: zeroTokens(),
      errorMessage: `runner-v2-prepare-failed: ${err instanceof Error ? err.message : String(err)}`,
      subagentToolUses: [],
      subagentOutputs: [],
      clarifyBody: null,
    }
  }

  // 3. Spawn subprocess.
  const [head, ...args] = invocation.command
  if (head === undefined) {
    return {
      outcome: 'crash',
      exitCode: null,
      outputs: {},
      tokenUsage: zeroTokens(),
      errorMessage: 'runner-v2-empty-command',
      subagentToolUses: [],
      subagentOutputs: [],
      clarifyBody: null,
    }
  }

  const child = spawn(head, args, {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // 4. Collect stdout JSON events.
  const events: Array<Record<string, unknown>> = []
  let stderrBuf = ''
  const stderrCollector = pumpLines(streamFromReadable(child.stderr), (line) => {
    stderrBuf += line + '\n'
  })
  const stdoutCollector = pumpLines(streamFromReadable(child.stdout), (line) => {
    try {
      const evt = JSON.parse(line)
      if (evt !== null && typeof evt === 'object') {
        events.push(evt as Record<string, unknown>)
        // RFC-061 follow-up P2-3 — fire live subagent callback. The
        // post-exit aggregator skips re-emit when this is set.
        if (opts.onLiveSubagentEvent !== undefined) {
          tryEmitLiveSubagent(evt as Record<string, unknown>, opts.onLiveSubagentEvent)
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  })

  // 5. Wait for exit (or timeout).
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000
  let didTimeout = false

  const exitCode = await new Promise<number | null>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      didTimeout = true
      try {
        child.kill('SIGTERM')
      } catch {
        // process already dead
      }
      // Force-resolve so we don't hang forever if exit/error never fire.
      resolve(null)
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timeoutHandle)
      resolve(code)
    })
    child.once('error', () => {
      clearTimeout(timeoutHandle)
      resolve(null)
    })
  })
  // pumpLines collectors may still be running; race against a short
  // budget so a slow-closing stream doesn't pin the test.
  await Promise.race([
    Promise.all([stdoutCollector, stderrCollector]),
    new Promise<void>((r) => setTimeout(r, 200)),
  ])

  // 6. Aggregate post-exit.
  const declared = pickDeclaredOutputs(opts.agent)
  const agg = aggregateStdout({ events, declaredOutputs: declared })

  // 7. Branch on envelope + exit code.
  if (didTimeout) {
    return {
      outcome: 'timeout',
      exitCode: exitCode ?? null,
      outputs: {},
      tokenUsage: agg.tokenUsage,
      ...(agg.sessionId !== undefined ? { sessionId: agg.sessionId } : {}),
      errorMessage: `runner-v2-timeout after ${timeoutMs}ms`,
      subagentToolUses: agg.subagentToolUses,
      subagentOutputs: agg.subagentOutputs,
      clarifyBody: null,
    }
  }
  if (exitCode === null || exitCode !== 0) {
    return {
      outcome: 'crash',
      exitCode,
      outputs: {},
      tokenUsage: agg.tokenUsage,
      ...(agg.sessionId !== undefined ? { sessionId: agg.sessionId } : {}),
      errorMessage: stderrBuf.length > 0 ? stderrBuf.slice(-1024) : 'runner-v2-nonzero-exit',
      subagentToolUses: agg.subagentToolUses,
      subagentOutputs: agg.subagentOutputs,
      clarifyBody: null,
    }
  }

  // exit 0 — branch on envelope.
  if (agg.envelopeKind === 'both') {
    return {
      outcome: 'envelope-fail',
      exitCode: 0,
      outputs: {},
      tokenUsage: agg.tokenUsage,
      ...(agg.sessionId !== undefined ? { sessionId: agg.sessionId } : {}),
      errorMessage: 'clarify-and-output-both-present',
      subagentToolUses: agg.subagentToolUses,
      subagentOutputs: agg.subagentOutputs,
      clarifyBody: agg.clarifyBody,
    }
  }
  if (agg.envelopeKind === 'clarify') {
    // Clarify envelope is NOT envelope-fail — it's a successful
    // expression of an ask. The actor's NodeKindHandler returns
    // suspend(self-clarify) on success when clarifyBody is set.
    return {
      outcome: 'success',
      exitCode: 0,
      outputs: {},
      tokenUsage: agg.tokenUsage,
      ...(agg.sessionId !== undefined ? { sessionId: agg.sessionId } : {}),
      subagentToolUses: agg.subagentToolUses,
      subagentOutputs: agg.subagentOutputs,
      clarifyBody: agg.clarifyBody,
    }
  }
  if (agg.envelopeKind === 'none') {
    return {
      outcome: 'envelope-fail',
      exitCode: 0,
      outputs: {},
      tokenUsage: agg.tokenUsage,
      ...(agg.sessionId !== undefined ? { sessionId: agg.sessionId } : {}),
      errorMessage: 'no <workflow-output> envelope found in stdout',
      subagentToolUses: agg.subagentToolUses,
      subagentOutputs: agg.subagentOutputs,
      clarifyBody: null,
    }
  }
  // envelopeKind === 'output' — happy path or missing-declared error.
  if (agg.outputParseError !== null) {
    return {
      outcome: 'envelope-fail',
      exitCode: 0,
      outputs: {},
      tokenUsage: agg.tokenUsage,
      ...(agg.sessionId !== undefined ? { sessionId: agg.sessionId } : {}),
      errorMessage: agg.outputParseError,
      subagentToolUses: agg.subagentToolUses,
      subagentOutputs: agg.subagentOutputs,
      clarifyBody: null,
    }
  }
  return {
    outcome: 'success',
    exitCode: 0,
    outputs: agg.parsedOutputs,
    tokenUsage: agg.tokenUsage,
    ...(agg.sessionId !== undefined ? { sessionId: agg.sessionId } : {}),
    subagentToolUses: agg.subagentToolUses,
    subagentOutputs: agg.subagentOutputs,
    clarifyBody: null,
  }
}

/* ============================================================
 *  Helpers
 * ============================================================ */

function zeroTokens(): RunResult['tokenUsage'] {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }
}

function pickDeclaredOutputs(agent: Agent): string[] {
  const outputs = (agent as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return []
  const names: string[] = []
  for (const o of outputs) {
    if (typeof o === 'string') {
      names.push(o)
    } else if (
      typeof o === 'object' &&
      o !== null &&
      typeof (o as { name?: unknown }).name === 'string'
    ) {
      names.push((o as { name: string }).name)
    }
  }
  return names
}

/**
 * Convert a Node Readable stream to a Web ReadableStream<Uint8Array> so
 * the existing pumpLines (Web-Streams-based) can consume it. Bun's
 * Bun.spawn returns Web streams directly, but node:child_process returns
 * Node streams.
 */
function streamFromReadable(readable: NodeJS.ReadableStream | null): ReadableStream<Uint8Array> {
  if (readable === null) {
    return new ReadableStream<Uint8Array>({ start: (c) => c.close() })
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      readable.on('data', (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
        )
      })
      readable.on('end', () => controller.close())
      readable.on('error', (err) => controller.error(err))
    },
    cancel() {
      try {
        ;(readable as { destroy?: () => void }).destroy?.()
      } catch {
        // ignore
      }
    },
  })
}

// Re-export for callers building events from result.
export type { AggregatedStdout }

/**
 * Mirror of aggregateStdout's subagent extraction, applied to a single
 * stdout event for live streaming. Fires the caller's callback when
 * the event matches the subagent text / tool-use pattern; silent
 * otherwise. Failures are swallowed — live streaming is best-effort.
 */
function tryEmitLiveSubagent(
  evt: Record<string, unknown>,
  emit: (event: LiveSubagentEvent) => void,
): void {
  try {
    const type = typeof evt.type === 'string' ? evt.type : null
    const sessionId = typeof evt.sessionID === 'string' ? evt.sessionID : null
    if (sessionId === null) return
    const part = evt.part as Record<string, unknown> | null
    if (part === null || typeof part !== 'object') return
    const partType = typeof part.type === 'string' ? part.type : null

    if (type === 'text' && partType === 'text') {
      const text = typeof part.text === 'string' ? part.text : ''
      if (text === '') return
      emit({ kind: 'subagent-output', sessionId, content: text, detail: part })
      return
    }
    if (type === 'tool' && partType === 'tool') {
      const toolName = typeof part.tool === 'string' ? part.tool : null
      if (toolName === null) return
      emit({ kind: 'subagent-tool-use', sessionId, toolName, detail: part })
      return
    }
  } catch {
    // best-effort live streaming; never break the attempt loop.
  }
}
