// Mock opencode binary for runner tests.
// Invoked as: bun run mock-opencode.ts run "<prompt>" --agent NAME --format json [--dangerously-skip-permissions]
//
// Behavior driven by env vars (so tests can inject without parsing argv):
//   MOCK_OPENCODE_EVENTS         JSON array of objects, emitted one-per-line on stdout
//   MOCK_OPENCODE_OUTPUTS        JSON object port -> content; rendered into the
//                                trailing <workflow-output> envelope
//   MOCK_OPENCODE_SKIP_ENVELOPE  '1' to suppress the envelope (simulates a broken agent)
//   MOCK_OPENCODE_EXIT_CODE      number; default 0
//   MOCK_OPENCODE_DELAY_MS       sleep this long before exiting (for timeout tests)
//   MOCK_OPENCODE_STDERR         emit this string on stderr (line by line)
//   MOCK_OPENCODE_REQUIRE_TOKEN  '1' to assert OPENCODE_CONFIG_CONTENT contains a marker
//   MOCK_OPENCODE_FAIL_COUNTER   path to a file holding an integer attempt counter
//   MOCK_OPENCODE_FAIL_UNTIL     fail (exit 1, skip envelope) while counter < this number
//   MOCK_OPENCODE_CLARIFY_BODY   JSON for the <workflow-clarify> envelope body
//                                (e.g. {"questions":[{"id":"q1",...}]}); when set,
//                                the mock emits a <workflow-clarify> envelope INSTEAD
//                                of <workflow-output>. To exercise the both-envelope
//                                rejection path, set this alongside MOCK_OPENCODE_OUTPUTS.
//   MOCK_OPENCODE_CAPTURE_CONFIG_TO  path; if set, the mock appends one JSON line
//                                    per invocation containing { agent, model, variant,
//                                    temperature } pulled from OPENCODE_CONFIG_CONTENT.
//                                    Lets tests assert per-node overrides survived the
//                                    scheduler → runner → env-var → subprocess hop.
//   MOCK_OPENCODE_CAPTURE_ARGV_TO    path; if set, the mock appends one JSON line per
//                                    invocation containing the full argv array. RFC-026
//                                    tests use this to assert that `--session <id>` (or
//                                    its absence) reaches the spawned subprocess.
//   MOCK_OPENCODE_EMIT_SESSION_ID    when set, the mock prefixes its JSON event stream
//                                    with `{"type":"session.created","sessionID":"<id>"}`
//                                    so the runner captures it into RunResult.sessionId.
//                                    Default ULID-style synthetic id when set to '1';
//                                    any other value is treated as the literal id.

import process from 'node:process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

function fail(msg: string, code = 2): never {
  process.stderr.write(`mock-opencode: ${msg}\n`)
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv[0] !== 'run') {
  fail(`expected first positional arg 'run', got '${argv[0]}'`)
}

// Validate critical env vars set by runner.
const env = process.env
if (!env.OPENCODE_CONFIG_DIR) fail('OPENCODE_CONFIG_DIR is not set')
if (!env.OPENCODE_CONFIG_CONTENT) fail('OPENCODE_CONFIG_CONTENT is not set')
try {
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { agent?: Record<string, unknown> }
  if (!cfg.agent || Object.keys(cfg.agent).length === 0) {
    fail('OPENCODE_CONFIG_CONTENT.agent is empty')
  }
} catch {
  fail('OPENCODE_CONFIG_CONTENT is not valid JSON')
}

// Verify --agent was provided.
const agentFlagIdx = argv.indexOf('--agent')
if (agentFlagIdx < 0 || !argv[agentFlagIdx + 1]) fail('missing --agent <name>')

if (env.MOCK_OPENCODE_REQUIRE_TOKEN === '1') {
  if (!env.OPENCODE_CONFIG_CONTENT.includes('"prompt"')) {
    fail('OPENCODE_CONFIG_CONTENT does not contain inline agent prompt')
  }
}

// Per-agent env overrides. When MOCK_OPENCODE_CLARIFY_BODY_FOR_<agent> or
// MOCK_OPENCODE_CRASH_FOR_<agent> is set, the matching agent takes that
// branch while sibling agents in the same task fall back to the global
// MOCK_OPENCODE_* env. Lets parallel-branch tests (RFC-023 bug 13) wire
// one agent to "ask clarify" and another to "crash" inside one runTask.
const mockedAgentName = argv[agentFlagIdx + 1] ?? ''
{
  const perAgentClarify = env[`MOCK_OPENCODE_CLARIFY_BODY_FOR_${mockedAgentName}`]
  if (perAgentClarify !== undefined) env.MOCK_OPENCODE_CLARIFY_BODY = perAgentClarify
  if (env[`MOCK_OPENCODE_CRASH_FOR_${mockedAgentName}`] === '1') {
    env.MOCK_OPENCODE_SKIP_ENVELOPE = '1'
  }
}

// Append one JSON line per invocation so tests can inspect what model /
// variant / temperature actually reached the subprocess. Guards the
// scheduler → runner → env hop end-to-end.
// RFC-026: capture full argv array for inline-session tests. Appended as one
// JSON line per invocation: { agent, argv: [...] }.
if (env.MOCK_OPENCODE_CAPTURE_ARGV_TO) {
  try {
    const agentName = argv[agentFlagIdx + 1] ?? ''
    appendFileSync(
      env.MOCK_OPENCODE_CAPTURE_ARGV_TO,
      JSON.stringify({ agent: agentName, argv }) + '\n',
    )
  } catch (e) {
    fail(`MOCK_OPENCODE_CAPTURE_ARGV_TO write failed: ${(e as Error).message}`)
  }
}

if (env.MOCK_OPENCODE_CAPTURE_CONFIG_TO) {
  try {
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      agent?: Record<string, Record<string, unknown>>
    }
    const agentName = argv[agentFlagIdx + 1] ?? ''
    const entry = cfg.agent?.[agentName] ?? {}
    const row = {
      agent: agentName,
      model: entry.model ?? null,
      variant: entry.variant ?? null,
      temperature: entry.temperature ?? null,
    }
    appendFileSync(env.MOCK_OPENCODE_CAPTURE_CONFIG_TO, JSON.stringify(row) + '\n')
  } catch (e) {
    fail(`MOCK_OPENCODE_CAPTURE_CONFIG_TO write failed: ${(e as Error).message}`)
  }
}

// Fail-N-times-then-succeed: increment a counter on disk; exit non-zero
// without emitting the envelope while counter <= MOCK_OPENCODE_FAIL_UNTIL.
let forceFail = false
const counterFile = env.MOCK_OPENCODE_FAIL_COUNTER
const failUntil = Number(env.MOCK_OPENCODE_FAIL_UNTIL ?? '0')
if (counterFile !== undefined && Number.isFinite(failUntil) && failUntil > 0) {
  let n = 0
  if (existsSync(counterFile)) {
    n = Number(readFileSync(counterFile, 'utf-8').trim()) || 0
  }
  n += 1
  writeFileSync(counterFile, String(n))
  if (n <= failUntil) forceFail = true
}

// RFC-026: optionally pre-emit a session.created event so the runner captures
// a sessionId into RunResult.sessionId. Real opencode emits an event with
// `sessionID` somewhere in the stream; the runner grabs the first one it
// sees. We synthesize that here for inline-mode tests. `1` produces a stable
// fake id; any other string is used verbatim.
if (env.MOCK_OPENCODE_EMIT_SESSION_ID) {
  const sessionID =
    env.MOCK_OPENCODE_EMIT_SESSION_ID === '1'
      ? 'opc_mock_session_01'
      : env.MOCK_OPENCODE_EMIT_SESSION_ID
  process.stdout.write(
    JSON.stringify({ type: 'session.created', sessionID, timestamp: Date.now() }) + '\n',
  )
}

// Emit stdout events.
try {
  const events = JSON.parse(env.MOCK_OPENCODE_EVENTS ?? '[]') as unknown[]
  for (const evt of events) {
    process.stdout.write(JSON.stringify(evt) + '\n')
  }
} catch (e) {
  fail(`MOCK_OPENCODE_EVENTS is not valid JSON: ${(e as Error).message}`)
}

// Emit stderr lines (split on \n).
const stderr = env.MOCK_OPENCODE_STDERR
if (stderr) {
  for (const line of stderr.split('\n')) {
    if (line.length > 0) process.stderr.write(line + '\n')
  }
}

// Emit envelope unless suppressed.
//
// Real opencode with `--format json` puts the agent's text reply (which
// carries the <workflow-output> envelope) inside a `text` event's
// `part.text` field. Mirror that shape so the runner can find it.
//
// RFC-023: when MOCK_OPENCODE_CLARIFY_BODY is set, emit a <workflow-clarify>
// envelope (alone, or combined with <workflow-output> when both env vars
// are present — used to exercise the exclusive-or hard reject).
if (env.MOCK_OPENCODE_SKIP_ENVELOPE !== '1' && !forceFail) {
  const blocks: string[] = []
  const wantOutput =
    env.MOCK_OPENCODE_OUTPUTS !== undefined || env.MOCK_OPENCODE_CLARIFY_BODY === undefined
  if (wantOutput) {
    let outputs: Record<string, string> = {}
    try {
      outputs = JSON.parse(env.MOCK_OPENCODE_OUTPUTS ?? '{}') as Record<string, string>
    } catch (e) {
      fail(`MOCK_OPENCODE_OUTPUTS is not valid JSON: ${(e as Error).message}`)
    }
    let envelope = '<workflow-output>\n'
    for (const [name, content] of Object.entries(outputs)) {
      envelope += `  <port name="${name}">${content}</port>\n`
    }
    envelope += '</workflow-output>'
    blocks.push(envelope)
  }
  if (env.MOCK_OPENCODE_CLARIFY_BODY !== undefined) {
    // Just embed the body string verbatim; tests are responsible for shape.
    blocks.push(`<workflow-clarify>${env.MOCK_OPENCODE_CLARIFY_BODY}</workflow-clarify>`)
  }
  if (blocks.length > 0) {
    const textEvent = {
      type: 'text',
      timestamp: Date.now(),
      part: { type: 'text', text: blocks.join('\n') },
    }
    process.stdout.write(JSON.stringify(textEvent) + '\n')
  }
}

// Optional delay (for timeout tests).
const delay = Number(env.MOCK_OPENCODE_DELAY_MS ?? '0')
if (Number.isFinite(delay) && delay > 0) {
  await Bun.sleep(delay)
}

const exitCode = forceFail ? 1 : Number(env.MOCK_OPENCODE_EXIT_CODE ?? '0')
process.exit(Number.isFinite(exitCode) ? exitCode : 0)
