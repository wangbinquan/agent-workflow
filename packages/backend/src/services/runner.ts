// Runner: spawn ONE opencode subprocess for one node_run, stream its output
// into the DB, persist the parsed envelope, and clean up.
//
// Process isolation (design/proposal.md §6.1):
//   * cwd = task worktree
//   * OPENCODE_CONFIG_DIR -> per-run dir for framework-managed skills
//   * OPENCODE_CONFIG_CONTENT -> inline JSON of the agent definition
//     (highest precedence in opencode's merge order; beats repo and $HOME)
//   * No DISABLE flags so repo .opencode/skills + $HOME/.opencode/* still load
//
// Lifecycle:
//   pending -> running    (node_runs row updated with pid + startedAt + prompt)
//   running -> done       (envelope parsed, outputs persisted)
//   running -> failed     (non-zero exit / missing envelope / timeout)
//   running -> canceled   (AbortSignal aborted)
//
// Caller (scheduler / tests) is responsible for INSERT-ing the node_runs row
// in 'pending' state before calling runNode().

import type {
  Agent,
  ClarifyPromptContext,
  ClarifyQuestion,
  ClarifyTruncationWarning,
  ReviewPromptContext,
} from '@agent-workflow/shared'
import { parseClarifyEnvelopeBody } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { cpSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns } from '@/db/schema'
import { createLogger, type Logger } from '@/util/log'
import {
  detectEnvelopeKind,
  extractClarifyEnvelopeBody,
  extractLastEnvelope,
  parseEnvelope,
} from './envelope'
import { renderUserPrompt } from './protocol'

export type SkillSource = 'managed' | 'external' | 'project'

export interface ResolvedSkill {
  name: string
  sourceKind: SkillSource
  /** Absolute path for managed/external. Unused for project. */
  sourcePath?: string
}

export interface AgentOverrides {
  model?: string
  variant?: string
  temperature?: number
}

export interface RunNodeOptions {
  taskId: string
  /** ULID of a pre-existing node_runs row in 'pending' state. */
  nodeRunId: string
  agent: Agent
  /** Resolved upstream port values (already concatenated by the scheduler). */
  inputs: Record<string, string>
  overrides?: AgentOverrides
  /** opencode subprocess cwd = task worktree. */
  worktreePath: string
  /** Template variable substitutions for {{__repo_path__}} etc. */
  templateMeta: {
    repoPath: string
    baseBranch: string
    taskId: string
    nodeId?: string
    iteration?: number
    shardKey?: string
  }
  promptTemplate?: string
  /**
   * RFC-005 review-driven re-run context. When the scheduler is re-running an
   * upstream node after a downstream review's reject/iterate decision, this
   * carries the rendered comments / rejection reason / iterate target port
   * so {{__review_rejection__}} / {{__review_comments__}} /
   * {{__iterate_target_port__}} substitute and the auto-appended sections
   * fire. Absent on first runs and on runs that aren't downstream of a
   * decided review. Built by services/review.ts:buildReviewPromptContext.
   */
  reviewContext?: ReviewPromptContext
  /**
   * RFC-023 clarify-driven re-run context. Set by the scheduler when the
   * agent is being re-spawned after the user submitted clarify answers
   * (clarifyIteration > 0). Substitutes {{__clarify_questions__}} /
   * {{__clarify_answers__}} / {{__clarify_iteration__}} / {{__clarify_remaining__}}
   * and auto-appends the Q&A sections at the user prompt tail. Absent on
   * first runs and on runs whose agent never asked back.
   */
  clarifyContext?: ClarifyPromptContext
  /**
   * RFC-023: when true (scheduler computed `agentHasClarifyChannel(definition,
   * agentNodeId)` from the workflow definition), the renderer emits a bi-modal
   * trailing block (`<workflow-output>` and `<workflow-clarify>` presented as
   * equally first-class reply envelopes) so the agent treats ask-back as
   * first-class instead of a contingency. Off by default keeps the non-clarify
   * wire format identical to pre-RFC-023.
   */
  hasClarifyChannel?: boolean
  /** Skills used by this agent. */
  skills: ResolvedSkill[]
  /**
   * RFC-022: agents resolved from the primary agent's dependsOn closure (BFS
   * order, root excluded). Each one becomes an additional entry under
   * `agent` in OPENCODE_CONFIG_CONTENT so the primary agent can invoke them
   * via opencode's task / subagent tool. Default `[]` keeps legacy callers
   * (the runner tests pre-RFC-022) at single-agent injection behavior.
   *
   * Dependents do NOT receive the per-node `overrides` block — overrides
   * (model / variant / temperature) only ever apply to the node-selected
   * primary agent.
   */
  dependents?: Agent[]
  /** Default true. */
  dangerouslySkipPermissions?: boolean
  /** Wall-clock timeout in ms. Undefined = no limit. */
  timeoutMs?: number
  /** App home dir (parent of runs/, snapshots/, worktrees/, ...). */
  appHome: string
  /**
   * Command to spawn instead of `['opencode']`. Tests pass
   * `['bun', 'run', /path/to/mock-opencode.ts]`.
   */
  opencodeCmd?: string[]
  db: DbClient
  log?: Logger
  /** When aborted, runner SIGTERMs the child and returns status='canceled'. */
  signal?: AbortSignal
  /**
   * RFC-026: when set (only ever populated by the scheduler on the
   * clarify-driven rerun path where the upstream clarify node has
   * `sessionMode: 'inline'` AND the prior agent run captured an opencode
   * session id), the runner appends `--session <id>` to the opencode CLI.
   * opencode then loads the prior session's full transcript (messages,
   * thinking, tool calls), and the rendered user prompt is reduced to a
   * small incremental message (just this round's clarify answers + a short
   * reminder — see `buildClarifyInlineReminder` in shared/prompt.ts).
   *
   * Review reject / iterate / technical retry / loop cross-iteration paths
   * MUST NOT set this — they intentionally start fresh sessions. See
   * proposal §2.1 / A12 / A13 / A7.
   */
  resumeSessionId?: string
}

export type RunFinalStatus = 'done' | 'failed' | 'canceled'

export interface RunResult {
  status: RunFinalStatus
  exitCode: number | null
  /** Resolved declared port values (missing ones present as ""). */
  outputs: Record<string, string>
  tokenUsage: {
    input: number
    output: number
    cacheCreate: number
    cacheRead: number
    total: number
  }
  errorMessage?: string
  /** The exact user prompt sent to opencode (also written to node_runs.promptText). */
  prompt: string
  /** opencode sessionID first seen in stdout events, if any. */
  sessionId?: string
  /**
   * RFC-023: present when the agent reply parsed as a `<workflow-clarify>`
   * envelope (status will still be 'done' — the agent successfully expressed
   * an ask). The scheduler reads this and forwards questions/warnings into
   * `clarify.createClarifySession`, then parks the task at `awaiting_human`.
   * `outputs` is empty in this case — clarify defers all port outputs to
   * the next round per the protocol block in the user prompt.
   */
  clarify?: {
    questions: ClarifyQuestion[]
    truncationWarnings: ClarifyTruncationWarning[]
  }
}

export async function runNode(opts: RunNodeOptions): Promise<RunResult> {
  const log = opts.log ?? createLogger('runner')
  const runRoot = join(opts.appHome, 'runs', opts.taskId, opts.nodeRunId)
  const runDir = join(runRoot, '.opencode')

  // 1. Prepare per-run config dir and inject skills.
  prepareSkills(runDir, opts.skills, log)

  // 2. Build OPENCODE_CONFIG_CONTENT inline agent JSON. RFC-022: primary
  // agent plus every closure dependent gets a `agent.<name>` entry; opencode
  // merges this after all directory scans so platform definitions win.
  const inlineConfig = buildInlineConfig(opts.agent, opts.overrides, opts.dependents ?? [])
  // RFC-022 §design B6: warn (don't fail) when the serialized config crosses
  // the soft cap. Real OS env-var ceilings are well above this; the warning
  // helps catch authors stuffing massive bodies into every dependent agent.
  const serializedInline = JSON.stringify(inlineConfig)
  if (serializedInline.length > 32 * 1024) {
    log.warn('inline-config-large', {
      bytes: serializedInline.length,
      agents: Object.keys(inlineConfig.agent),
    })
  }

  // 3. Render the user prompt. When the scheduler tells us this node has a
  // clarify channel wired in the workflow definition, the renderer rewrites
  // the trailing protocol block as a bi-modal preamble (output vs clarify
  // presented as equally first-class envelopes) and appends the clarify
  // format block immediately after — see `buildProtocolBlock` in shared.
  const prompt = renderUserPrompt({
    promptTemplate: opts.promptTemplate,
    inputs: opts.inputs,
    meta: opts.templateMeta,
    agentOutputs: opts.agent.outputs,
    ...(opts.reviewContext !== undefined ? { reviewContext: opts.reviewContext } : {}),
    ...(opts.clarifyContext !== undefined ? { clarifyContext: opts.clarifyContext } : {}),
    ...(opts.hasClarifyChannel === true ? { hasClarifyChannel: true } : {}),
  })

  await opts.db
    .update(nodeRuns)
    .set({
      promptText: prompt,
      status: 'running',
      startedAt: Date.now(),
    })
    .where(eq(nodeRuns.id, opts.nodeRunId))

  // 4. Spawn opencode.
  const cmd = buildCommand(opts, prompt)
  // Diagnostic: surface the model/variant/temperature that actually landed in
  // the inline-agent JSON. Lets operators tell "scheduler dropped the override
  // on the floor" apart from "opencode received it but ignored it" without
  // having to dump the full OPENCODE_CONFIG_CONTENT.
  const primaryInline = inlineConfig.agent[opts.agent.name] as Record<string, unknown> | undefined
  log.info('spawning opencode', {
    bin: cmd[0],
    agent: opts.agent.name,
    cwd: opts.worktreePath,
    nodeRunId: opts.nodeRunId,
    inlineModel: primaryInline?.model ?? null,
    inlineVariant: primaryInline?.variant ?? null,
    inlineTemperature: primaryInline?.temperature ?? null,
    overrides: opts.overrides ?? null,
  })

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OPENCODE_CONFIG_DIR: runDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
  }

  const child = Bun.spawn({
    cmd,
    cwd: opts.worktreePath,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  if (typeof child.pid === 'number') {
    await opts.db.update(nodeRuns).set({ pid: child.pid }).where(eq(nodeRuns.id, opts.nodeRunId))
  }

  // 5. Wire up cancellation + timeout.
  let aborted = false
  let timedOut = false

  const onAbort = (): void => {
    aborted = true
    safeKill(child, 'SIGTERM')
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort)
  }

  const timeoutHandle =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true
          safeKill(child, 'SIGTERM')
        }, opts.timeoutMs)
      : null

  // 6. Stream stdout + stderr into node_run_events.
  //    `--format json` makes opencode emit one JSON event per line; the
  //    agent's text reply (which carries the <workflow-output> envelope)
  //    is inside the `part.text` field of `text` events. We accumulate
  //    text-event payloads here and parse the envelope from that buffer.
  const agentText: string[] = []
  const tokenUsage: RunResult['tokenUsage'] = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: 0,
  }
  let sessionId: string | undefined

  const stdoutPump = pumpLines(child.stdout, async (line) => {
    let evt: Record<string, unknown> | null = null
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      // non-JSON line — store as text and ignore
    }
    if (evt) {
      if (typeof evt.sessionID === 'string' && sessionId === undefined) {
        sessionId = evt.sessionID
      }
      accumulateTokens(evt, tokenUsage)
      const text = extractTextFromEvent(evt)
      if (text !== null) agentText.push(text)
      const kind = inferEventKind(evt)
      const ts = typeof evt.timestamp === 'number' ? evt.timestamp : Date.now()
      await opts.db
        .insert(nodeRunEvents)
        .values({ nodeRunId: opts.nodeRunId, ts, kind, payload: line })
    } else {
      // Non-JSON stdout lines shouldn't happen with --format json, but record
      // them as kind=text for debugging.
      await opts.db.insert(nodeRunEvents).values({
        nodeRunId: opts.nodeRunId,
        ts: Date.now(),
        kind: 'text',
        payload: line,
      })
      agentText.push(line)
    }
  })

  const stderrPump = pumpLines(child.stderr, async (line) => {
    await opts.db.insert(nodeRunEvents).values({
      nodeRunId: opts.nodeRunId,
      ts: Date.now(),
      kind: 'stderr',
      payload: line,
    })
  })

  // 7. Wait for exit + drain streams.
  const exitCode = await child.exited
  await Promise.all([stdoutPump, stderrPump])
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  if (timeoutHandle !== null) clearTimeout(timeoutHandle)

  // 8. Resolve final status.
  let status: RunFinalStatus
  let errorMessage: string | undefined
  if (aborted) {
    status = 'canceled'
    errorMessage = 'aborted by signal'
  } else if (timedOut) {
    status = 'failed'
    errorMessage = `node-timeout: exceeded ${opts.timeoutMs ?? 0}ms`
  } else if (exitCode !== 0) {
    status = 'failed'
    errorMessage = `opencode exited with code ${exitCode}`
  } else {
    status = 'done'
  }

  // 9. Parse envelope on clean exit. RFC-023 splits this into a kind probe
  //    first so we can branch between the legacy <workflow-output> path,
  //    the new <workflow-clarify> path, and the exclusive-or hard rejects
  //    (both / neither). detectEnvelopeKind is the single source of truth
  //    for which form the reply took.
  let outputs: Record<string, string> = {}
  let clarifyResult:
    | { questions: ClarifyQuestion[]; truncationWarnings: ClarifyTruncationWarning[] }
    | undefined
  if (status === 'done') {
    const accumulatedText = agentText.join('\n')
    const kind = detectEnvelopeKind(accumulatedText)
    if (kind === 'both') {
      status = 'failed'
      errorMessage =
        'clarify-and-output-both-present: agent reply contained BOTH <workflow-output> and <workflow-clarify>; the framework requires exactly one'
    } else if (kind === 'clarify') {
      const body = extractClarifyEnvelopeBody(accumulatedText)
      const parsed = body !== null ? parseClarifyEnvelopeBody(body) : null
      if (parsed === null || parsed.body === null) {
        const firstErr = parsed?.errors[0]
        status = 'failed'
        errorMessage =
          firstErr !== undefined
            ? `${firstErr.code}: ${firstErr.detail}`
            : 'clarify-questions-malformed: empty body'
      } else {
        // Agent successfully expressed a clarify ask. Keep status=done — the
        // agent's subprocess exited cleanly with a valid envelope; the next
        // round will be a fresh node_run minted post-answer.
        clarifyResult = {
          questions: parsed.body.questions,
          truncationWarnings: parsed.warnings,
        }
        if (parsed.warnings.length > 0) {
          log.warn('clarify envelope truncated to limits', {
            nodeRunId: opts.nodeRunId,
            warnings: parsed.warnings.map((w) => w.code),
          })
        }
      }
    } else if (kind === 'none') {
      status = 'failed'
      errorMessage = 'no <workflow-output> envelope found in stdout'
    } else {
      // kind === 'output' — legacy happy path.
      const envelope = extractLastEnvelope(accumulatedText)
      // envelope is non-null here because detectEnvelopeKind matched, but
      // guard defensively for type narrowing.
      if (envelope === null) {
        status = 'failed'
        errorMessage = 'no <workflow-output> envelope found in stdout'
      } else {
        const parsed = parseEnvelope(envelope, opts.agent.outputs)
        outputs = Object.fromEntries(parsed.ports)
        for (const [name, content] of parsed.ports) {
          await opts.db
            .insert(nodeRunOutputs)
            .values({ nodeRunId: opts.nodeRunId, portName: name, content })
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content },
            })
        }
        if (parsed.missingDeclared.length > 0) {
          log.warn('agent omitted declared ports', {
            missing: parsed.missingDeclared,
            nodeRunId: opts.nodeRunId,
          })
        }
        if (parsed.undeclared.length > 0) {
          log.warn('agent emitted undeclared ports', {
            undeclared: parsed.undeclared.map((u) => u.name),
            nodeRunId: opts.nodeRunId,
          })
        }
      }
    }
  }

  // 10. Update node_runs final state.
  await opts.db
    .update(nodeRuns)
    .set({
      status,
      finishedAt: Date.now(),
      exitCode: exitCode ?? null,
      errorMessage: errorMessage ?? null,
      tokInput: tokenUsage.input,
      tokOutput: tokenUsage.output,
      tokCacheCreate: tokenUsage.cacheCreate,
      tokCacheRead: tokenUsage.cacheRead,
      tokTotal: tokenUsage.total,
    })
    .where(eq(nodeRuns.id, opts.nodeRunId))

  // 11. Clean up run dir (best-effort).
  try {
    rmSync(runRoot, { recursive: true, force: true })
  } catch {
    // Logged but non-fatal.
  }

  const result: RunResult = { status, exitCode, outputs, tokenUsage, prompt }
  if (errorMessage !== undefined) result.errorMessage = errorMessage
  if (sessionId !== undefined) result.sessionId = sessionId
  if (clarifyResult !== undefined) result.clarify = clarifyResult
  return result
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function prepareSkills(runDir: string, skills: ResolvedSkill[], log: Logger): void {
  const skillsDir = join(runDir, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  for (const skill of skills) {
    if (skill.sourceKind === 'project') continue
    if (skill.sourcePath === undefined) {
      log.warn('skill missing sourcePath; skipping injection', { name: skill.name })
      continue
    }
    const dst = join(skillsDir, skill.name)
    // Ensure parent exists (skillsDir already does, but defensive).
    mkdirSync(dirname(dst), { recursive: true })
    if (skill.sourceKind === 'managed') {
      cpSync(skill.sourcePath, dst, { recursive: true })
    } else {
      // external -> symlink for IO economy
      symlinkSync(skill.sourcePath, dst, 'dir')
    }
  }
}

/**
 * RFC-022: build the inline-agent JSON for one agent. Pulled out so the
 * primary agent and every closure dependent share one definition formula;
 * the only difference is that dependents pass `overrides = {}` so per-node
 * model/variant/temperature tweaks only apply to the selected primary.
 */
export function buildInlineAgentEntry(
  agent: Agent,
  overrides: AgentOverrides = {},
): Record<string, unknown> {
  const inlineAgent: Record<string, unknown> = {
    prompt: agent.bodyMd,
    description: agent.description,
    permission: agent.permission,
    // Platform-only fields live under `options` so opencode passes them through
    // without trying to parse. The runner doesn't read these back; they exist
    // for observability when an operator dumps `opencode debug agent`.
    options: { outputs: agent.outputs, readonly: agent.readonly },
  }
  const model = overrides.model ?? agent.model
  if (model !== undefined) inlineAgent.model = model
  const variant = overrides.variant ?? agent.variant
  if (variant !== undefined) inlineAgent.variant = variant
  const temperature = overrides.temperature ?? agent.temperature
  if (temperature !== undefined) inlineAgent.temperature = temperature
  if (agent.steps !== undefined) inlineAgent.steps = agent.steps
  return inlineAgent
}

export function buildInlineConfig(
  agent: Agent,
  overrides: AgentOverrides | undefined,
  dependents: readonly Agent[],
): { agent: Record<string, Record<string, unknown>> } {
  const map: Record<string, Record<string, unknown>> = {
    [agent.name]: buildInlineAgentEntry(agent, overrides),
  }
  for (const dep of dependents) {
    if (dep.name === agent.name) continue // root would shadow itself; defensive
    if (map[dep.name] !== undefined) continue // closure already deduped, but guard anyway
    map[dep.name] = buildInlineAgentEntry(dep)
  }
  return { agent: map }
}

export function buildCommand(opts: RunNodeOptions, prompt: string): string[] {
  const head = opts.opencodeCmd ?? ['opencode']
  const cmd = [...head, 'run', prompt, '--agent', opts.agent.name, '--format', 'json']
  if (opts.dangerouslySkipPermissions ?? true) cmd.push('--dangerously-skip-permissions')
  // RFC-026: clarify-inline rerun — resume the prior opencode session so the
  // agent has its full prior transcript + state. Only ever populated by the
  // scheduler on the clarify-driven path (review / retry / loop paths leave
  // it undefined). Empty string is treated the same as undefined.
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
    cmd.push('--session', opts.resumeSessionId)
  }
  return cmd
}

function safeKill(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    child.kill(signal)
  } catch {
    // already exited
  }
}

/**
 * Drain a ReadableStream of UTF-8 bytes, calling `onLine` for each complete
 * line. Awaits each callback so the caller's DB writes serialize naturally.
 */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.length > 0) await onLine(line)
      }
    }
    // Flush remaining tail (process emitted a line without trailing newline).
    if (buffer.length > 0) await onLine(buffer)
  } finally {
    reader.releaseLock()
  }
}

/**
 * Pull out the agent's text contribution from one opencode event, if any.
 * Different opencode versions / part kinds put it in different shapes; we
 * tolerate the common ones.
 */
function extractTextFromEvent(evt: Record<string, unknown>): string | null {
  const part = evt.part as Record<string, unknown> | undefined
  // shape: { type: 'text', part: { type: 'text', text: '...' } }
  if (part && typeof part === 'object') {
    const ptype = part.type
    const ptext = part.text
    if (ptype === 'text' && typeof ptext === 'string') return ptext
  }
  // shape: { type: 'text', text: '...' }  (older / synthetic)
  if (evt.type === 'text' && typeof evt.text === 'string') return evt.text
  return null
}

/** Map an opencode JSON event to one of our enum kinds. */
function inferEventKind(
  evt: Record<string, unknown>,
): 'tool_use' | 'text' | 'reasoning' | 'permission_asked' | 'error' | 'step_start' | 'step_finish' {
  const t = evt.type
  if (typeof t === 'string') {
    if (t === 'tool_use') return 'tool_use'
    if (t === 'text') return 'text'
    if (t === 'reasoning') return 'reasoning'
    if (t === 'permission.asked' || t === 'permission_asked') return 'permission_asked'
    if (t === 'error') return 'error'
    if (t === 'step_start') return 'step_start'
    if (t === 'step_finish') return 'step_finish'
  }
  return 'text'
}

/**
 * P-4-05: token accumulation across opencode `--format json` events.
 *
 * opencode emits step-finish events with token usage at several possible
 * paths. We probe in priority order:
 *   evt.tokens              top-level (test fixtures, some old shapes)
 *   evt.part.tokens         inside a text/step event part
 *   evt.usage               inside a step-finish summary
 *   evt.step.tokens         inside a step event
 *   evt.message.usage       message-style assistant turn
 * and within each, accept both snake_case (`input/output/cache_creation/
 * cache_read`) and camelCase. The first event with token fields wins per
 * field — we don't double-count if multiple shapes appear in one event.
 */
export function accumulateTokens(evt: Record<string, unknown>, acc: RunResult['tokenUsage']): void {
  const tokens = pickTokens([
    evt,
    evt.part as Record<string, unknown> | undefined,
    evt.usage as Record<string, unknown> | undefined,
    evt.step as Record<string, unknown> | undefined,
    evt.message as Record<string, unknown> | undefined,
  ])
  if (!tokens) return
  const input = numOrZero(tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens)
  const output = numOrZero(tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens)
  const cacheCreate = numOrZero(tokens.cache_creation ?? tokens.cacheCreation)
  const cacheRead = numOrZero(tokens.cache_read ?? tokens.cacheRead)
  acc.input += input
  acc.output += output
  acc.cacheCreate += cacheCreate
  acc.cacheRead += cacheRead
  acc.total = acc.input + acc.output + acc.cacheCreate + acc.cacheRead
}

function pickTokens(
  candidates: Array<Record<string, unknown> | undefined>,
): Record<string, unknown> | null {
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    // Direct token-bearing object.
    const t = c.tokens
    if (t && typeof t === 'object') return t as Record<string, unknown>
    // Some shapes inline input/output at the object level.
    if (
      typeof c.input_tokens === 'number' ||
      typeof c.output_tokens === 'number' ||
      typeof c.prompt_tokens === 'number' ||
      typeof c.completion_tokens === 'number'
    ) {
      return c
    }
    // Some shapes inline usage directly.
    const usage = c.usage
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>
      if (
        typeof u.input === 'number' ||
        typeof u.output === 'number' ||
        typeof u.input_tokens === 'number' ||
        typeof u.output_tokens === 'number'
      ) {
        return u
      }
    }
  }
  return null
}

function numOrZero(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
