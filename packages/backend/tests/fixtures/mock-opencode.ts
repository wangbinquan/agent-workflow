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

import process from 'node:process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

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
