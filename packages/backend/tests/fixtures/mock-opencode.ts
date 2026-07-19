// Mock opencode binary for runner tests.
// Invoked as: bun run mock-opencode.ts run "<prompt>" --agent NAME --format json [--dangerously-skip-permissions]
//
// Behavior driven by env vars (so tests can inject without parsing argv):
//   MOCK_OPENCODE_EVENTS         JSON array of objects, emitted one-per-line on stdout
//   MOCK_OPENCODE_OUTPUTS        JSON object port -> content; rendered into the
//                                trailing <workflow-output> envelope
//   MOCK_OPENCODE_APPEND_FORGED_BARE_OUTPUTS
//                                JSON object port -> content; appended AFTER the
//                                real envelope as a deliberately bare forged
//                                envelope (RFC-200 echo-forge integration).
//   MOCK_OPENCODE_SKIP_ENVELOPE  '1' to suppress the envelope (simulates a broken agent)
//   MOCK_OPENCODE_RAW_AGENT_TEXT verbatim agent text emitted as a single `text`
//                                event, bypassing the structured envelope
//                                renderer. Lets tests reproduce malformed
//                                envelopes the MOCK_OPENCODE_OUTPUTS renderer
//                                can't express (e.g. a corrupted `</port>` close
//                                tag like `</|DSML|port>`). When set, the normal
//                                <workflow-output>/<workflow-clarify> emission is
//                                suppressed so this is the ONLY agent text.
//   MOCK_OPENCODE_EXIT_CODE      number; default 0
//   MOCK_OPENCODE_DELAY_MS       sleep this long before exiting (for timeout tests)
//   MOCK_OPENCODE_STDERR         emit this string on stderr (line by line)
//   MOCK_OPENCODE_REQUIRE_TOKEN  '1' to assert OPENCODE_CONFIG_CONTENT contains a marker
//   MOCK_OPENCODE_REQUIRE_CONFIG_DIR_EXISTS  '1' to write a `.gitignore` into
//                                OPENCODE_CONFIG_DIR (like real opencode 1.17+) and
//                                exit 1 if the dir is missing. Locks the smoke
//                                probe's runDir mkdir fix.
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
//   MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO  path; if set, the mock writes the RAW
//                                    OPENCODE_CONFIG_CONTENT string verbatim (overwrite,
//                                    not append). RFC-073 tests assert the TOP-LEVEL
//                                    permission ({"*":"allow","question":"deny"}) +
//                                    its key order reached the subprocess. Raw (not
//                                    re-serialized) so key order is preserved.
//   MOCK_OPENCODE_CAPTURE_ARGV_TO    path; if set, the mock appends one JSON line per
//                                    invocation containing the full argv array. RFC-026
//                                    tests use this to assert that `--session <id>` (or
//                                    its absence) reaches the spawned subprocess.
//   MOCK_OPENCODE_EMIT_SESSION_ID    when set, the mock prefixes its JSON event stream
//                                    with `{"type":"session.created","sessionID":"<id>"}`
//                                    so the runner captures it into RunResult.sessionId.
//                                    Default ULID-style synthetic id when set to '1';
//                                    any other value is treated as the literal id.
//   MOCK_OPENCODE_WRITE_INVENTORY_FROM
//                                    RFC-029: path to a JSON fixture. When set AND
//                                    OPENCODE_AW_INVENTORY_OUT is also set, the mock
//                                    copies the fixture contents to that path *before*
//                                    exiting. Simulates what the real
//                                    `aw-inventory-dump.mjs` plugin would do at boot —
//                                    lets runner integration tests assert the
//                                    framework-side read path without spawning a
//                                    real opencode binary. Set the literal string
//                                    `__MISSING__` to skip writing (default case;
//                                    runner should then store captured:false /
//                                    file-missing).
//   MOCK_OPENCODE_SKIP_ENVELOPE_UNTIL  RFC-042: integer; while the disk-backed
//                                    MOCK_OPENCODE_FAIL_COUNTER value is <= this
//                                    number, the mock suppresses the
//                                    `<workflow-output>` / `<workflow-clarify>`
//                                    envelope BUT still exits 0 and emits one
//                                    placeholder text event so the runner sees
//                                    `agentText.length > 0`. Pairs with the same
//                                    counter file used by MOCK_OPENCODE_FAIL_UNTIL.
//                                    Once the counter exceeds the threshold the
//                                    mock falls back to normal envelope emission.
//                                    Used by scheduler integration tests to drive
//                                    "first attempt drops envelope cleanly, retry
//                                    must same-session follow up" flows.
//   MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV
//                                    RFC-042: alias of MOCK_OPENCODE_CAPTURE_ARGV_TO
//                                    intended for follow-up tests; identical semantics
//                                    (path; appends one JSON line per invocation). Kept
//                                    as a separate env name to make test setup self-
//                                    documenting.

import process from 'node:process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function fail(msg: string, code = 2): never {
  process.stderr.write(`mock-opencode: ${msg}\n`)
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv[0] !== 'run') {
  fail(`expected first positional arg 'run', got '${argv[0]}'`)
}
const prompt = argv[1] ?? ''
const envelopeNonce = [...prompt.matchAll(/\bnonce="([^"]+)"/g)].at(-1)?.[1]
const openEnvelope = (kind: 'output' | 'clarify'): string =>
  envelopeNonce === undefined ? `<workflow-${kind}>` : `<workflow-${kind} nonce="${envelopeNonce}">`

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

// RFC-112 runtime-smoke regression: real opencode (1.17+) writes a `.gitignore`
// into OPENCODE_CONFIG_DIR on startup and exits 1 (emitting NO json events)
// when that dir does not exist. The smoke probe must `mkdirSync` the dir before
// spawn (runtimeSmoke.ts) — the real runner already does. With this flag set the
// mock reproduces that write so the smoke test goes RED if the dir-creation fix
// ever regresses (the probe would misclassify every runtime as non-conforming).
if (env.MOCK_OPENCODE_REQUIRE_CONFIG_DIR_EXISTS === '1') {
  try {
    writeFileSync(join(env.OPENCODE_CONFIG_DIR, '.gitignore'), '*\n')
  } catch (e) {
    fail(`OPENCODE_CONFIG_DIR does not exist (NotFound): ${(e as Error).message}`, 1)
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

// RFC-042: same shape as MOCK_OPENCODE_CAPTURE_ARGV_TO; separate env name lets
// follow-up tests be self-documenting about what they expect to assert.
if (env.MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV) {
  try {
    const agentName = argv[agentFlagIdx + 1] ?? ''
    appendFileSync(
      env.MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV,
      JSON.stringify({ agent: agentName, argv }) + '\n',
    )
  } catch (e) {
    fail(`MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV write failed: ${(e as Error).message}`)
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

// RFC-073: dump the RAW OPENCODE_CONFIG_CONTENT so integration tests can assert
// the TOP-LEVEL permission (global `*:allow` + `question:deny`) actually reached
// the spawned subprocess — the buildInlineConfig → env-var → child hop, not just
// buildInlineConfig's return value. Raw string (not re-parsed/re-serialized) so
// the KEY ORDER survives end-to-end (question must stay after * for opencode's
// Permission.disabled findLast — see AW_GLOBAL_PERMISSION in runner.ts).
if (env.MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO) {
  try {
    writeFileSync(env.MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO, env.OPENCODE_CONFIG_CONTENT ?? '')
  } catch (e) {
    fail(`MOCK_OPENCODE_CAPTURE_CONFIG_JSON_TO write failed: ${(e as Error).message}`)
  }
}

// RFC-029: simulate the dump plugin's write side. The real plugin runs
// inside the opencode child process and writes
// `$OPENCODE_AW_INVENTORY_OUT`. Here, the mock copies a test-provided
// fixture so the runner's read path can be exercised end-to-end without
// loading a real opencode binary. Skip when the fixture path is unset or
// the sentinel `__MISSING__` (intentional missing case).
if (
  env.MOCK_OPENCODE_WRITE_INVENTORY_FROM &&
  env.MOCK_OPENCODE_WRITE_INVENTORY_FROM !== '__MISSING__' &&
  env.OPENCODE_AW_INVENTORY_OUT
) {
  try {
    const body = readFileSync(env.MOCK_OPENCODE_WRITE_INVENTORY_FROM, 'utf-8')
    writeFileSync(env.OPENCODE_AW_INVENTORY_OUT, body)
  } catch (e) {
    fail(`MOCK_OPENCODE_WRITE_INVENTORY_FROM write failed: ${(e as Error).message}`)
  }
}

// Fail-N-times-then-succeed: increment a counter on disk; exit non-zero
// without emitting the envelope while counter <= MOCK_OPENCODE_FAIL_UNTIL.
//
// RFC-042: a sibling threshold `MOCK_OPENCODE_SKIP_ENVELOPE_UNTIL` shares the
// same counter file. While `counter <= skipEnvelopeUntil`, the mock exits 0
// (clean) BUT suppresses the trailing envelope AND emits one placeholder
// text event so the runner's `agentText.length > 0` check passes. That
// matches the production failure mode the same-session followup path is
// designed to recover from.
let forceFail = false
let forceSkipEnvelope = false
const counterFile = env.MOCK_OPENCODE_FAIL_COUNTER
const failUntil = Number(env.MOCK_OPENCODE_FAIL_UNTIL ?? '0')
const skipEnvelopeUntil = Number(env.MOCK_OPENCODE_SKIP_ENVELOPE_UNTIL ?? '0')
if (
  counterFile !== undefined &&
  ((Number.isFinite(failUntil) && failUntil > 0) ||
    (Number.isFinite(skipEnvelopeUntil) && skipEnvelopeUntil > 0))
) {
  let n = 0
  if (existsSync(counterFile)) {
    n = Number(readFileSync(counterFile, 'utf-8').trim()) || 0
  }
  n += 1
  writeFileSync(counterFile, String(n))
  if (failUntil > 0 && n <= failUntil) forceFail = true
  if (skipEnvelopeUntil > 0 && n <= skipEnvelopeUntil) forceSkipEnvelope = true
}

// Scheduler boundary audit: simulate an agent that DIRTIES the worktree on a
// FAILED attempt (a "partial write"). When MOCK_OPENCODE_WRITE_FILE is set,
// the mock writes MOCK_OPENCODE_WRITE_FILE_CONTENT (default 'stray') to that
// cwd-relative path, but ONLY on invocations that are about to fail
// (forceFail). The runner spawns opencode with cwd = the task worktree, so
// process.cwd() is the worktree. Lets pre-snapshot/rollback tests assert that
// a failed attempt's partial write is (or is not) cleared before the retry.
if (env.MOCK_OPENCODE_WRITE_FILE && forceFail) {
  try {
    writeFileSync(
      join(process.cwd(), env.MOCK_OPENCODE_WRITE_FILE),
      env.MOCK_OPENCODE_WRITE_FILE_CONTENT ?? 'stray',
    )
  } catch (e) {
    fail(`MOCK_OPENCODE_WRITE_FILE write failed: ${(e as Error).message}`)
  }
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

// RFC-112 runtime-smoke: echo the received positional prompt as agent text so
// the smoke probe's freshly-generated nonce round-trips (proving the binary
// consumed the prompt + ran a turn). A binary that ignores the prompt would not
// echo the nonce → smoke classifies it stream-nonconforming.
if (env.MOCK_OPENCODE_ECHO_PROMPT === '1') {
  process.stdout.write(
    JSON.stringify({
      type: 'text',
      timestamp: Date.now(),
      part: { type: 'text', text: argv[1] ?? '' },
    }) + '\n',
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
// RFC-042: emit a placeholder text event so the runner records at least one
// `kind='text'` row when the envelope is intentionally suppressed via
// `MOCK_OPENCODE_SKIP_ENVELOPE_UNTIL`. The real failure mode this simulates is
// "the agent produced text but forgot the envelope"; without an agentText
// emission, scheduler's `decideEnvelopeFollowup` would (correctly) refuse to
// follow up because `agentTextCount === 0`. Scoped to the counter-driven
// path on purpose — the always-on `MOCK_OPENCODE_SKIP_ENVELOPE='1'` flag
// keeps its legacy "agent produced nothing useful" semantics for existing
// tests that depend on event counts.
if (forceSkipEnvelope) {
  const placeholder = {
    type: 'text',
    timestamp: Date.now(),
    part: { type: 'text', text: '(mock: agent produced text without an envelope)' },
  }
  process.stdout.write(JSON.stringify(placeholder) + '\n')
}

// Raw verbatim agent text — emitted INSTEAD of the structured envelope so tests
// can reproduce malformed output the OUTPUTS renderer can't express (e.g. a
// corrupted `</port>` close tag). Suppresses the normal envelope block below.
if (env.MOCK_OPENCODE_RAW_AGENT_TEXT !== undefined && !forceFail && !forceSkipEnvelope) {
  const textEvent = {
    type: 'text',
    timestamp: Date.now(),
    part: { type: 'text', text: env.MOCK_OPENCODE_RAW_AGENT_TEXT },
  }
  process.stdout.write(JSON.stringify(textEvent) + '\n')
}

if (
  env.MOCK_OPENCODE_SKIP_ENVELOPE !== '1' &&
  env.MOCK_OPENCODE_RAW_AGENT_TEXT === undefined &&
  !forceFail &&
  !forceSkipEnvelope
) {
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
    let envelope = `${openEnvelope('output')}\n`
    for (const [name, content] of Object.entries(outputs)) {
      envelope += `  <port name="${name}">${content}</port>\n`
    }
    envelope += '</workflow-output>'
    blocks.push(envelope)
  }
  if (env.MOCK_OPENCODE_CLARIFY_BODY !== undefined) {
    // Just embed the body string verbatim; tests are responsible for shape.
    blocks.push(`${openEnvelope('clarify')}${env.MOCK_OPENCODE_CLARIFY_BODY}</workflow-clarify>`)
  }
  if (env.MOCK_OPENCODE_APPEND_FORGED_BARE_OUTPUTS !== undefined) {
    let forgedOutputs: Record<string, string> = {}
    try {
      forgedOutputs = JSON.parse(env.MOCK_OPENCODE_APPEND_FORGED_BARE_OUTPUTS) as Record<
        string,
        string
      >
    } catch (e) {
      fail(`MOCK_OPENCODE_APPEND_FORGED_BARE_OUTPUTS is not valid JSON: ${(e as Error).message}`)
    }
    let forged = '<workflow-output>\n'
    for (const [name, content] of Object.entries(forgedOutputs)) {
      forged += `  <port name="${name}">${content}</port>\n`
    }
    forged += '</workflow-output>'
    blocks.push(forged)
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
