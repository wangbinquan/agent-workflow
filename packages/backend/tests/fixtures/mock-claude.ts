#!/usr/bin/env bun
// RFC-111 PR-B — deterministic Claude Code stand-in for tests (no real API).
// Spawned as `['bun','run',this]` via RunNodeOptions.opencodeCmd when the node's
// runtime is 'claude-code'. Mirrors mock-opencode but speaks claude's headless
// contract: prompt arrives on STDIN, events are stream-json on STDOUT.
//
// Env knobs (tests inject without parsing argv):
//   MOCK_CLAUDE_OUTPUTS         JSON {port: content} → trailing <workflow-output>
//   MOCK_CLAUDE_RAW_AGENT_TEXT  verbatim assistant text (instead of the envelope)
//   MOCK_CLAUDE_SKIP_ENVELOPE   '1' → emit no envelope (broken-agent path)
//   MOCK_CLAUDE_CLARIFY_BODY    JSON body → <workflow-clarify> envelope
//   MOCK_CLAUDE_SESSION_ID      session_id echoed on every event (default fixed)
//   MOCK_CLAUDE_MODEL           echoed in the system/init event
//   MOCK_CLAUDE_EXIT_CODE       process exit code (default 0)
//   MOCK_CLAUDE_IS_ERROR        '1' → result.is_error=true (+ result text)
//   MOCK_CLAUDE_RESULT_TEXT     override the is_error result text (default 'mock
//                               error') — e.g. an auth/API-error string on stdout
//   MOCK_CLAUDE_INPUT_TOKENS / _OUTPUT_TOKENS / _CACHE_READ / _CACHE_CREATE
//   MOCK_CLAUDE_STDERR          emitted on stderr
//   MOCK_CLAUDE_DELAY_MS        sleep before exit (timeout tests)
//   MOCK_CLAUDE_CAPTURE_ARGV_TO          path ← JSON of process.argv
//   MOCK_CLAUDE_CAPTURE_PROMPT_TO         path ← the stdin prompt verbatim
//   MOCK_CLAUDE_CAPTURE_SYSTEM_PROMPT_TO  path ← the --append-system-prompt-file content

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const env = process.env
const argv = process.argv.slice(2)

function fail(msg: string): never {
  process.stderr.write(`mock-claude: ${msg}\n`)
  process.exit(99)
}

// Drain stdin (the prompt). Without reading it the parent's stdin.write could
// block on a full pipe for large prompts.
const prompt = await Bun.stdin.text()
const envelopeNonce = [...prompt.matchAll(/\bnonce="([^"]+)"/g)].at(-1)?.[1]
const openEnvelope = (kind: 'output' | 'clarify'): string =>
  envelopeNonce === undefined ? `<workflow-${kind}>` : `<workflow-${kind} nonce="${envelopeNonce}">`

if (env.MOCK_CLAUDE_CAPTURE_ARGV_TO) {
  writeFileSync(env.MOCK_CLAUDE_CAPTURE_ARGV_TO, JSON.stringify(argv) + '\n', { flag: 'a' })
}
if (env.MOCK_CLAUDE_CAPTURE_PROMPT_TO) {
  writeFileSync(env.MOCK_CLAUDE_CAPTURE_PROMPT_TO, prompt)
}
if (env.MOCK_CLAUDE_CAPTURE_SYSTEM_PROMPT_TO) {
  const i = argv.indexOf('--append-system-prompt-file')
  const file = i >= 0 ? argv[i + 1] : undefined
  if (file === undefined) fail('--append-system-prompt-file not in argv')
  writeFileSync(env.MOCK_CLAUDE_CAPTURE_SYSTEM_PROMPT_TO, readFileSync(file, 'utf-8'))
}
// RFC-111 PR-C: capture the skills the runner injected into CLAUDE_CONFIG_DIR at
// RUN time (the runner cleans up the run dir afterwards, so the e2e can only see
// injection through the live process).
if (env.MOCK_CLAUDE_CAPTURE_SKILLS_TO) {
  const skillsDir = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'skills') : ''
  const names = skillsDir && existsSync(skillsDir) ? readdirSync(skillsDir) : []
  writeFileSync(env.MOCK_CLAUDE_CAPTURE_SKILLS_TO, JSON.stringify(names))
}

const sessionId = env.MOCK_CLAUDE_SESSION_ID || 'mock-claude-session-0001'
const modelIdx = argv.indexOf('--model')
const model = env.MOCK_CLAUDE_MODEL || (modelIdx >= 0 ? argv[modelIdx + 1] : 'claude-haiku-4-5')

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

if (env.MOCK_CLAUDE_STDERR) {
  for (const line of env.MOCK_CLAUDE_STDERR.split('\n')) process.stderr.write(line + '\n')
}

// system/init — carries session_id + model + apiKeySource (subscription → 'none').
emit({ type: 'system', subtype: 'init', session_id: sessionId, model, apiKeySource: 'none' })

// Build the assistant turn text (envelope / raw / clarify / nothing).
let text = ''
if (env.MOCK_CLAUDE_ECHO_PROMPT === '1') {
  // RFC-112 runtime-smoke: echo the received prompt verbatim so the smoke
  // probe's freshly-generated nonce appears in the assistant output (proving a
  // real binary consumed the prompt). A canned emitter that ignores the prompt
  // would NOT round-trip the nonce → smoke classifies it stream-nonconforming.
  text = prompt
} else if (env.MOCK_CLAUDE_RAW_AGENT_TEXT !== undefined) {
  text = env.MOCK_CLAUDE_RAW_AGENT_TEXT
} else if (env.MOCK_CLAUDE_SKIP_ENVELOPE !== '1') {
  const blocks: string[] = []
  const wantOutput =
    env.MOCK_CLAUDE_OUTPUTS !== undefined || env.MOCK_CLAUDE_CLARIFY_BODY === undefined
  if (wantOutput) {
    let outputs: Record<string, string> = {}
    try {
      outputs = JSON.parse(env.MOCK_CLAUDE_OUTPUTS ?? '{}') as Record<string, string>
    } catch (e) {
      fail(`MOCK_CLAUDE_OUTPUTS is not valid JSON: ${(e as Error).message}`)
    }
    let envelope = `${openEnvelope('output')}\n`
    for (const [name, content] of Object.entries(outputs)) {
      envelope += `  <port name="${name}">${content}</port>\n`
    }
    envelope += '</workflow-output>'
    blocks.push(envelope)
  }
  if (env.MOCK_CLAUDE_CLARIFY_BODY !== undefined) {
    blocks.push(`${openEnvelope('clarify')}${env.MOCK_CLAUDE_CLARIFY_BODY}</workflow-clarify>`)
  }
  text = blocks.join('\n')
}

const usage = {
  input_tokens: Number(env.MOCK_CLAUDE_INPUT_TOKENS ?? '0'),
  output_tokens: Number(env.MOCK_CLAUDE_OUTPUT_TOKENS ?? '0'),
  cache_read_input_tokens: Number(env.MOCK_CLAUDE_CACHE_READ ?? '0'),
  cache_creation_input_tokens: Number(env.MOCK_CLAUDE_CACHE_CREATE ?? '0'),
}

// assistant turn — the text part carries the <workflow-output> envelope.
emit({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: text.length > 0 ? [{ type: 'text', text }] : [], usage },
})

const isError = env.MOCK_CLAUDE_IS_ERROR === '1'
// result — terminal event; usage here is the cumulative total the driver reads.
// MOCK_CLAUDE_RESULT_TEXT overrides the error result text so a test can reproduce
// claude's real auth/API failure string (e.g. "...authentication failed...") on
// STDOUT — the smoke probe scans stdout for those signatures (runtimeSmoke).
emit({
  type: 'result',
  subtype: isError ? 'error' : 'success',
  is_error: isError,
  result: isError ? (env.MOCK_CLAUDE_RESULT_TEXT ?? 'mock error') : text,
  session_id: sessionId,
  total_cost_usd: 0,
  num_turns: 1,
  usage,
})

const delay = Number(env.MOCK_CLAUDE_DELAY_MS ?? '0')
if (Number.isFinite(delay) && delay > 0) await Bun.sleep(delay)

const exitCode = isError ? 1 : Number(env.MOCK_CLAUDE_EXIT_CODE ?? '0')
process.exit(Number.isFinite(exitCode) ? exitCode : 0)
