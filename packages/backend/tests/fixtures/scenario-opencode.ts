// Plan-driven mock opencode for COMBINATION SCENARIO tests (agent × review ×
// clarify). Unlike the env-driven mock-opencode.ts (one static behavior per
// process) this stub varies behavior per (agent, invocation-index) by reading
// a JSON plan + per-agent on-disk counters. That lets one task drive a
// multi-phase flow like designer: [output-v1, clarify, output-after-answer,
// clarify, output-v2] across many runTask/resume cycles.
//
// Invoked by the runner as:
//   bun run scenario-opencode.ts run "<prompt>" --agent NAME --format json ...
// and as `... --version` at daemon/runtime probe time.
//
// Env contract:
//   SCENARIO_PLAN_FILE   path to JSON: { "<agentName>": Step[] }
//       Step =
//         | { "output": { "<port>": "<content>" } }      // emit <workflow-output>
//         | { "clarify": <bodyObject> }                  // emit <workflow-clarify>
//         | { "skipEnvelope": true }                     // emit text, no envelope
//         | { "crash": true }                            // exit 1, no envelope
//       When an agent is invoked MORE times than its plan has steps, the LAST
//       step repeats (so "always output v2 from now on" = just leave v2 last).
//   SCENARIO_STATE_DIR   dir for per-agent counter files (created by test).
//   SCENARIO_DEFAULT_OUTPUT  optional JSON {port:content}; used when an agent
//       has no plan entry at all (e.g. a plain downstream agent we don't script).

import process from 'node:process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function fail(msg: string, code = 2): never {
  process.stderr.write(`scenario-opencode: ${msg}\n`)
  process.exit(code)
}

const argv = process.argv.slice(2)

if (argv[0] === '--version' || argv.includes('--version')) {
  process.stdout.write('scenario-opencode 1.14.99\n')
  process.exit(0)
}
if (argv[0] !== 'run') fail(`expected 'run', got '${argv[0]}'`)
const prompt = argv[1] ?? ''
const envelopeNonce = [...prompt.matchAll(/\bnonce="([^"]+)"/g)].at(-1)?.[1]
const openEnvelope = (kind: 'output' | 'clarify'): string =>
  envelopeNonce === undefined ? `<workflow-${kind}>` : `<workflow-${kind} nonce="${envelopeNonce}">`

const env = process.env
if (!env.OPENCODE_CONFIG_DIR) fail('OPENCODE_CONFIG_DIR not set')
if (!env.OPENCODE_CONFIG_CONTENT) fail('OPENCODE_CONFIG_CONTENT not set')

const agentFlagIdx = argv.indexOf('--agent')
const agentName = agentFlagIdx >= 0 ? (argv[agentFlagIdx + 1] ?? '') : ''
if (!agentName) fail('missing --agent <name>')

// RFC-122: any step may carry `waitFile` — the stub busy-waits (Bun.sleepSync
// poll, generous timeout) until `<stateDir>/<waitFile>` exists before executing
// the step's normal behavior. Lets a test deterministically pause an attempt
// (e.g. attempt 0 before it crashes) so it can mutate state the NEXT attempt's
// prompt build must pick up (the per-attempt clarify-directive read). Absent ⇒
// no wait (every existing plan is unaffected).
//
// `sessionId` (opt-in) makes the step pre-emit a `{type:'session.created',
// sessionID}` event so the runner captures a sessionId — the precondition for a
// same-session envelope FOLLOW-UP (decideEnvelopeFollowup needs sessionId !==
// null). Absent ⇒ no session event (so existing crash/skip plans keep failing
// into the FRESH-session retry path, unchanged).
interface WaitMixin {
  waitFile?: string
  sessionId?: string
  /** RFC-187 §4-2 e2e: relative paths written into the process CWD (the run's
   *  iso worktree) BEFORE the step's normal behavior — lets a scripted member
   *  actually produce worktree deltas so merge-back / salvage paths run for
   *  real. Absent ⇒ no writes (every existing plan unaffected). */
  writeFiles?: Record<string, string>
}
interface OutputStep extends WaitMixin {
  output: Record<string, string>
}
interface ClarifyStep extends WaitMixin {
  clarify: unknown
}
interface SkipStep extends WaitMixin {
  skipEnvelope: true
}
interface CrashStep extends WaitMixin {
  crash: true
}
type Step = OutputStep | ClarifyStep | SkipStep | CrashStep

const planFile = env.SCENARIO_PLAN_FILE
const stateDir = env.SCENARIO_STATE_DIR
if (!planFile || !stateDir) fail('SCENARIO_PLAN_FILE and SCENARIO_STATE_DIR required')
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

let plan: Record<string, Step[]> = {}
try {
  plan = JSON.parse(readFileSync(planFile, 'utf-8')) as Record<string, Step[]>
} catch (e) {
  fail(`SCENARIO_PLAN_FILE parse: ${(e as Error).message}`)
}

// Per-(agent) invocation counter — increments each spawn so we can step the plan.
const counterFile = join(stateDir, `count-${agentName}`)
let n = 0
if (existsSync(counterFile)) n = Number(readFileSync(counterFile, 'utf-8').trim()) || 0
const callIndex = n // 0-based for this invocation
writeFileSync(counterFile, String(n + 1))

// Trace each invocation so the test can assert how many times each agent ran.
// RFC-122: also record the `--session <id>` arg (null when absent) so a test can
// distinguish a same-session RESUME (follow-up) from a FRESH session (mode-flip
// downgrade) per attempt.
const sessionFlagIdx = argv.indexOf('--session')
const sessionArg = sessionFlagIdx >= 0 ? (argv[sessionFlagIdx + 1] ?? null) : null
const traceFile = join(stateDir, 'trace.jsonl')
appendFileSync(
  traceFile,
  JSON.stringify({ agent: agentName, callIndex, session: sessionArg }) + '\n',
)

const steps = plan[agentName]
let step: Step
if (steps && steps.length > 0) {
  step = steps[Math.min(callIndex, steps.length - 1)]!
} else if (env.SCENARIO_DEFAULT_OUTPUT) {
  step = { output: JSON.parse(env.SCENARIO_DEFAULT_OUTPUT) as Record<string, string> }
} else {
  step = { output: { out: `default-${agentName}-${callIndex}` } }
}

function emitText(text: string): void {
  process.stdout.write(
    JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text } }) + '\n',
  )
}

// RFC-122: optionally pre-emit a session.created event (real opencode emits an
// event carrying `sessionID`; the runner grabs the first one) so this attempt is
// eligible for a same-session envelope follow-up.
const sessionId = (step as { sessionId?: unknown }).sessionId
if (typeof sessionId === 'string' && sessionId.length > 0) {
  process.stdout.write(
    JSON.stringify({ type: 'session.created', sessionID: sessionId, timestamp: Date.now() }) + '\n',
  )
}

// RFC-122: optional deterministic pause — block this attempt until the test
// touches the sentinel, so the test can flip per-attempt state in between.
const waitFile = (step as { waitFile?: unknown }).waitFile
if (typeof waitFile === 'string' && waitFile.length > 0) {
  const target = join(stateDir, waitFile)
  const deadline = Date.now() + 30_000
  while (!existsSync(target)) {
    if (Date.now() > deadline) fail(`waitFile '${waitFile}' never appeared`, 3)
    Bun.sleepSync(20)
  }
}

// RFC-187 §4-2: write scripted worktree deltas (relative to cwd = the run's iso
// worktree) before the envelope/crash behavior — the real merge-back then runs.
const writeFiles = (step as { writeFiles?: unknown }).writeFiles
if (writeFiles !== undefined && writeFiles !== null && typeof writeFiles === 'object') {
  for (const [rel, content] of Object.entries(writeFiles as Record<string, string>)) {
    const abs = join(process.cwd(), rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
}

if ('crash' in step && step.crash) {
  emitText('(scenario: agent crashed)')
  process.exit(1)
}
if ('skipEnvelope' in step && step.skipEnvelope) {
  emitText('(scenario: agent produced text without an envelope)')
  process.exit(0)
}
if ('clarify' in step) {
  emitText(`${openEnvelope('clarify')}${JSON.stringify(step.clarify)}</workflow-clarify>`)
  process.exit(0)
}
if ('output' in step) {
  let env2 = `${openEnvelope('output')}\n`
  for (const [port, content] of Object.entries(step.output)) {
    env2 += `  <port name="${port}">${content}</port>\n`
  }
  env2 += '</workflow-output>'
  emitText(env2)
  process.exit(0)
}
fail(`unrecognized plan step for ${agentName}@${callIndex}: ${JSON.stringify(step)}`)
