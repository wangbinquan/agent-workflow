// Runtime-neutral, plan-driven model stand-in for durable task scenarios.
//
// One ScenarioPlan drives BOTH production runtime protocols:
//   - OpenCode: prompt is the single positional after `--`; events use the
//     OpenCode JSON stream shape.
//   - Claude Code: prompt arrives on stdin; events use Claude's stream-json
//     system/assistant/result shape.
//
// This is deliberately data-driven. A historical task becomes a permanent
// regression by distilling its observable turns into a plan (output, clarify,
// malformed/missing envelope, crash, delay, worktree writes) instead of adding
// another hand-written executable. The daemon, DB, scheduler, worktrees,
// retries, human gates and recovery remain production code.

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { emitPromptForContractTest } from './skeleton'

type StubProtocol = 'opencode' | 'claude-code'

interface ScenarioStep {
  /** Every string must be present in the rendered user prompt. */
  requirePrompt?: string[]
  /** Every string must be present in the runtime's native system/persona prompt. */
  requireSystemPrompt?: string[]
  /** Emit a valid workflow output envelope. */
  output?: Record<string, string>
  /** Emit a valid workflow clarify envelope; the value is JSON encoded. */
  clarify?: unknown
  /** Emit assistant text without an envelope. */
  rawText?: string
  /** Relative worktree paths written before the response is emitted. */
  writeFiles?: Record<string, string>
  /** Optional deterministic barrier relative to SCENARIO_STATE_DIR. */
  waitForFile?: string
  /** Delay before emitting/terminating. */
  delayMs?: number
  /**
   * POSIX-only cancellation fixture: keep the process alive for this many
   * milliseconds after SIGTERM before exiting.  This gives crash/recovery
   * scenarios a deterministic window in which the daemon has durably fenced
   * the task but is still waiting for the runtime owner to release.
   */
  terminationDelayMs?: number
  /** Optional state-dir barrier that releases the delayed SIGTERM immediately. */
  terminationReleaseFile?: string
  /** Text sent to stderr before the response. */
  stderr?: string
  /** Exit 0 after trace/delay/stderr without emitting any native stdout event. */
  silentExit?: boolean
  /** Session id exposed by the runtime event stream. */
  sessionId?: string
  /** Non-zero simulates a runtime process crash. */
  exitCode?: number
  /** Terminal runtime error, including the real Claude clean-exit error shape. */
  terminalError?: string
  /** Deterministic accounting carried by the emitted terminal event. */
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheCreate?: number
  }
}

interface ScenarioPlan {
  version: 1
  agents: Record<string, ScenarioStep[]>
}

interface Invocation {
  protocol: StubProtocol
  prompt: string
  systemPrompt: string
  agent: string
  resumeSessionId: string | null
}

interface ScenarioScope {
  key: string
  task: string
  node: string
}

const NAME = 'stub-runtime-scenario'
const AGENT_MARKER = /\[AW_SCENARIO_AGENT:([A-Za-z0-9._-]+)\]/
const TASK_MARKER = /\bAW_SCENARIO_TASK=([A-Za-z0-9._-]+)/
const NODE_MARKER = /\bAW_SCENARIO_NODE=([A-Za-z0-9._-]+)/
const TEMPLATE_MARKER = /\{\{(protocol|agent|task|node|callIndex)\}\}/g

function fail(message: string, code = 2): never {
  process.stderr.write(`${NAME}: ${message}\n`)
  process.exit(code)
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  return index >= 0 ? (argv[index + 1] ?? null) : null
}

function isVersionInvocation(argv: readonly string[]): boolean {
  return argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version'
}

async function parseInvocation(argv: readonly string[]): Promise<Invocation> {
  if (argv[0] === 'run') {
    const separator = argv.indexOf('--')
    const prompt = separator >= 0 ? (argv[separator + 1] ?? '') : ''
    const agent = flagValue(argv, '--agent') ?? ''
    if (prompt.length === 0) fail('OpenCode invocation is missing the trailing prompt')
    if (agent.length === 0) fail('OpenCode invocation is missing --agent')
    let systemPrompt = ''
    const inlineConfig = process.env.OPENCODE_CONFIG_CONTENT
    if (inlineConfig !== undefined) {
      try {
        const config = JSON.parse(inlineConfig) as {
          agent?: Record<string, { prompt?: unknown }>
        }
        const candidate = config.agent?.[agent]?.prompt
        if (typeof candidate === 'string') systemPrompt = candidate
      } catch (error) {
        fail(`OpenCode invocation has invalid OPENCODE_CONFIG_CONTENT: ${String(error)}`)
      }
    }
    return {
      protocol: 'opencode',
      prompt,
      systemPrompt,
      agent,
      resumeSessionId: flagValue(argv, '--session'),
    }
  }

  if (argv.includes('-p') || argv.includes('--print')) {
    const prompt = await Bun.stdin.text()
    const systemPromptFile = flagValue(argv, '--append-system-prompt-file')
    if (prompt.length === 0) fail('Claude Code invocation delivered an empty stdin prompt')
    if (systemPromptFile === null) {
      fail('Claude Code invocation is missing --append-system-prompt-file')
    }
    let systemPrompt = ''
    try {
      systemPrompt = readFileSync(systemPromptFile, 'utf8')
    } catch (error) {
      fail(`cannot read Claude Code system prompt: ${String(error)}`)
    }
    const agent = AGENT_MARKER.exec(systemPrompt)?.[1] ?? ''
    if (agent.length === 0) {
      fail(`Claude Code system prompt is missing ${AGENT_MARKER.source}`)
    }
    return {
      protocol: 'claude-code',
      prompt,
      systemPrompt,
      agent,
      resumeSessionId: flagValue(argv, '--resume'),
    }
  }

  fail(`unsupported argv: ${argv.join(' ') || '<none>'}`)
}

function parsePlan(path: string): ScenarioPlan {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read SCENARIO_PLAN_FILE: ${String(error)}`)
  }
  if (value === null || typeof value !== 'object') fail('scenario plan must be an object')
  const candidate = value as { version?: unknown; agents?: unknown }
  if (candidate.version !== 1) fail('scenario plan version must be 1')
  if (candidate.agents === null || typeof candidate.agents !== 'object') {
    fail('scenario plan agents must be an object')
  }
  for (const [agent, steps] of Object.entries(candidate.agents as Record<string, unknown>)) {
    if (!Array.isArray(steps) || steps.length === 0) {
      fail(`scenario plan agent '${agent}' must have at least one step`)
    }
  }
  return { version: 1, agents: candidate.agents as Record<string, ScenarioStep[]> }
}

function stateHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readScope(path: string): ScenarioScope | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ScenarioScope>
    if (
      typeof parsed.key === 'string' &&
      typeof parsed.task === 'string' &&
      typeof parsed.node === 'string'
    ) {
      return { key: parsed.key, task: parsed.task, node: parsed.node }
    }
  } catch {
    // Missing or partial mappings fall through to a deterministic fallback.
  }
  return null
}

function resolveScope(stateDir: string, invocation: Invocation): ScenarioScope {
  mkdirSync(stateDir, { recursive: true })
  const explicitTask = TASK_MARKER.exec(invocation.prompt)?.[1]
  const explicitNode = NODE_MARKER.exec(invocation.prompt)?.[1]
  if (explicitTask !== undefined && explicitNode !== undefined) {
    const scope = {
      key: stateHash(`${explicitTask}\0${explicitNode}\0${invocation.agent}`),
      task: explicitTask,
      node: explicitNode,
    }
    writeFileSync(join(stateDir, `scope-${scope.key}.json`), JSON.stringify(scope))
    return scope
  }

  if (invocation.resumeSessionId !== null) {
    const resumed = readScope(
      join(stateDir, `session-${stateHash(invocation.resumeSessionId)}.json`),
    )
    if (resumed !== null) return resumed
  }

  const key = stateHash(`${resolve(process.cwd())}\0${invocation.agent}`)
  return (
    readScope(join(stateDir, `scope-${key}.json`)) ?? {
      key,
      task: explicitTask ?? 'unscoped-task',
      node: explicitNode ?? 'unscoped-node',
    }
  )
}

function nextCallIndex(stateDir: string, scopeKey: string): number {
  mkdirSync(stateDir, { recursive: true })
  for (let current = 0; current < 1_000_000; current += 1) {
    try {
      writeFileSync(join(stateDir, `call-${scopeKey}-${current}`), '', { flag: 'wx' })
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  fail(`scenario scope '${scopeKey}' exceeded one million calls`)
}

function rememberSessionScope(stateDir: string, sessionId: string, scope: ScenarioScope): void {
  writeFileSync(join(stateDir, `session-${stateHash(sessionId)}.json`), JSON.stringify(scope))
}

function render(
  value: string,
  ctx: {
    protocol: StubProtocol
    agent: string
    task: string
    node: string
    callIndex: number
  },
): string {
  return value.replace(TEMPLATE_MARKER, (_whole, key: keyof typeof ctx) => String(ctx[key]))
}

function writeScenarioFiles(
  files: Record<string, string> | undefined,
  ctx: Parameters<typeof render>[1],
): void {
  for (const [path, content] of Object.entries(files ?? {})) {
    if (isAbsolute(path)) fail(`writeFiles path must be relative: ${path}`)
    const root = resolve(process.cwd())
    const target = resolve(root, path)
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      fail(`writeFiles path escapes the worktree: ${path}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, render(content, ctx))
  }
}

function outputEnvelope(
  nonce: string,
  output: Record<string, string>,
  ctx: Parameters<typeof render>[1],
): string {
  const ports = Object.entries(output)
    .map(([name, value]) => `<port name="${name}">${render(value, ctx)}</port>`)
    .join('\n')
  return `<workflow-output nonce="${nonce}">\n${ports}\n</workflow-output>`
}

function clarifyEnvelope(nonce: string, body: unknown): string {
  return `<workflow-clarify nonce="${nonce}">${JSON.stringify(body)}</workflow-clarify>`
}

function usageOf(step: ScenarioStep): {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
} {
  return {
    input: step.tokens?.input ?? 11,
    output: step.tokens?.output ?? 7,
    cacheRead: step.tokens?.cacheRead ?? 3,
    cacheCreate: step.tokens?.cacheCreate ?? 2,
  }
}

function emitOpenCode(text: string, sessionId: string, step: ScenarioStep): void {
  process.stdout.write(`${JSON.stringify({ type: 'session.created', sessionID: sessionId })}\n`)
  if (text.length > 0) {
    process.stdout.write(
      `${JSON.stringify({ type: 'text', timestamp: 0, part: { type: 'text', text } })}\n`,
    )
  }
  const usage = usageOf(step)
  process.stdout.write(
    `${JSON.stringify({
      type: step.terminalError === undefined ? 'step_finish' : 'error',
      ...(step.terminalError === undefined ? {} : { error: step.terminalError }),
      tokens: {
        input: usage.input,
        output: usage.output,
        cache: { read: usage.cacheRead, write: usage.cacheCreate },
      },
    })}\n`,
  )
}

function emitClaude(text: string, sessionId: string, step: ScenarioStep): void {
  const usage = usageOf(step)
  const claudeUsage = {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheCreate,
  }
  process.stdout.write(
    `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: 'stub-runtime-scenario',
      apiKeySource: 'none',
    })}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: text.length === 0 ? [] : [{ type: 'text', text }],
        usage: claudeUsage,
      },
    })}\n`,
  )
  const isError = step.terminalError !== undefined
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: isError ? 'error' : 'success',
      is_error: isError,
      result: isError ? step.terminalError : text,
      session_id: sessionId,
      total_cost_usd: 0,
      num_turns: 1,
      usage: claudeUsage,
    })}\n`,
  )
}

async function waitForBarrier(stateDir: string, relativePath: string | undefined): Promise<void> {
  if (relativePath === undefined) return
  const root = resolve(stateDir)
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`waitForFile must stay inside SCENARIO_STATE_DIR: ${relativePath}`)
  }
  const deadline = Date.now() + 30_000
  while (!existsSync(target)) {
    if (Date.now() >= deadline) fail(`waitForFile '${relativePath}' timed out`, 3)
    await Bun.sleep(20)
  }
}

export async function run(argv: readonly string[]): Promise<void> {
  if (isVersionInvocation(argv)) {
    process.stdout.write('stub-runtime-scenario 1.0.0\n')
    return
  }

  const invocation = await parseInvocation(argv)
  emitPromptForContractTest(invocation.prompt)
  const nonce = [...invocation.prompt.matchAll(/\bnonce="([^"]+)"/g)].at(-1)?.[1]
  if (nonce === undefined || nonce.length === 0) fail('prompt is missing the workflow nonce', 3)

  const planFile = process.env.SCENARIO_PLAN_FILE
  const stateDir = process.env.SCENARIO_STATE_DIR
  if (planFile === undefined || planFile.length === 0) fail('SCENARIO_PLAN_FILE is required')
  if (stateDir === undefined || stateDir.length === 0) fail('SCENARIO_STATE_DIR is required')

  const scope = resolveScope(stateDir, invocation)
  const { task, node } = scope
  const callIndex = nextCallIndex(stateDir, scope.key)
  const plan = parsePlan(planFile)
  const steps = plan.agents[invocation.agent]
  if (steps === undefined || steps.length === 0) {
    fail(`scenario plan has no steps for agent '${invocation.agent}'`)
  }
  const step = steps[Math.min(callIndex, steps.length - 1)]!
  const ctx = { protocol: invocation.protocol, agent: invocation.agent, task, node, callIndex }

  // Install the cancellation fixture before prompt checks or trace I/O.  A
  // node deadline is measured from process spawn, so registering after those
  // operations leaves a small cold-start window in which SIGTERM takes the
  // default immediate-exit path instead of the deterministic delayed path.
  if ((step.terminationDelayMs ?? 0) > 0 && process.platform !== 'win32') {
    const terminationDelayMs = step.terminationDelayMs!
    const terminationReleaseFile = step.terminationReleaseFile
    let terminationRequested = false
    process.once('SIGTERM', () => {
      if (terminationRequested) return
      terminationRequested = true
      appendFileSync(
        join(stateDir, 'signals.jsonl'),
        `${JSON.stringify({
          protocol: invocation.protocol,
          agent: invocation.agent,
          task,
          node,
          signal: 'SIGTERM',
          terminationDelayMs,
        })}\n`,
      )
      if (terminationReleaseFile !== undefined) {
        void waitForBarrier(stateDir, terminationReleaseFile).then(() => process.exit(143))
      }
      setTimeout(() => process.exit(143), terminationDelayMs)
    })
  }

  for (const needle of step.requirePrompt ?? []) {
    if (!invocation.prompt.includes(needle)) {
      fail(`${invocation.agent}@${callIndex} prompt is missing ${JSON.stringify(needle)}`, 10)
    }
  }
  for (const needle of step.requireSystemPrompt ?? []) {
    if (!invocation.systemPrompt.includes(needle)) {
      fail(
        `${invocation.agent}@${callIndex} system prompt is missing ${JSON.stringify(needle)}`,
        10,
      )
    }
  }

  appendFileSync(
    join(stateDir, 'trace.jsonl'),
    `${JSON.stringify({
      protocol: invocation.protocol,
      agent: invocation.agent,
      task,
      node,
      callIndex,
      resumeSessionId: invocation.resumeSessionId,
      prompt: invocation.prompt,
    })}\n`,
  )

  if (process.env.OPENCODE_AW_INVENTORY_OUT !== undefined) {
    writeFileSync(
      process.env.OPENCODE_AW_INVENTORY_OUT,
      '{"schemaVersion":1,"capturedAt":1700000000000,"agents":[],"skills":[],"mcps":[],"plugins":[]}\n',
    )
  }

  await waitForBarrier(stateDir, step.waitForFile)
  writeScenarioFiles(step.writeFiles, ctx)
  if (step.stderr !== undefined) process.stderr.write(`${render(step.stderr, ctx)}\n`)
  const delayMs = step.delayMs ?? 0
  if (delayMs > 0) await Bun.sleep(delayMs)
  if (step.silentExit === true) return

  // A process crash intentionally emits no protocol terminal event.
  if (
    (step.exitCode ?? 0) !== 0 &&
    step.output === undefined &&
    step.clarify === undefined &&
    step.rawText === undefined
  ) {
    process.exit(step.exitCode)
  }

  let text = ''
  const responseKinds =
    Number(step.output !== undefined) +
    Number(step.clarify !== undefined) +
    Number(step.rawText !== undefined)
  if (responseKinds > 1) fail(`${invocation.agent}@${callIndex} declares multiple response kinds`)
  if (step.output !== undefined) text = outputEnvelope(nonce, step.output, ctx)
  if (step.clarify !== undefined) text = clarifyEnvelope(nonce, step.clarify)
  if (step.rawText !== undefined) text = render(step.rawText, ctx)

  const sessionId = render(
    step.sessionId ?? `stub-{{protocol}}-{{task}}-{{node}}-{{callIndex}}`,
    ctx,
  )
  rememberSessionScope(stateDir, sessionId, scope)
  if (invocation.protocol === 'opencode') emitOpenCode(text, sessionId, step)
  else emitClaude(text, sessionId, step)

  if ((step.exitCode ?? 0) !== 0) process.exit(step.exitCode)
}
