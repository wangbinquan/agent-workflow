// RFC-254 T28b — `clarify-inline` mode: the port of
// `stub-opencode-clarify-inline.sh` (RFC-026 PR-B T13, inline clarify with
// session resume).
//
// Differences from `clarify`, all load-bearing for that spec:
//   1. ALWAYS pre-emits a `session.created` event so the runner captures a
//      sessionId. Round 1 echoes the SAME id round 0 minted, mirroring real
//      opencode resume, which is what lets the spec assert
//      `node_runs.opencode_session_id` is stable across rounds.
//   2. ALWAYS appends the whole argv to `$CLARIFY_INLINE_ARGV_LOG`, and the
//      PARSED `--session` value to `$CLARIFY_INLINE_SESSION_LOG`. The second log
//      exists because grepping the raw argv for `--session` is fooled by a
//      prompt whose body happens to contain that text (Codex 191bc32c).
//   3. One question, not two.

import {
  appendLine,
  emitClarifyEvent,
  emitPromptForContractTest,
  emitTextEvent,
  ensureStateDir,
  envelope,
  markCalled,
  parseFlags,
  parseInvocation,
  requireEnvelopeOpen,
  sanitizeStateKey,
} from './skeleton'

const NAME = 'stub-opencode-clarify-inline'

const QUESTIONS =
  '{"questions":[{"id":"q-db","title":"Which database should we use?","kind":"single","recommended":true,"options":["Postgres","SQLite"]}]}'

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 1.18.3\n')
    process.exit(0)
  }
  const stateDir = ensureStateDir(
    process.env.CLARIFY_STUB_STATE,
    '/tmp/aw-e2e-clarify-inline-state',
  )
  const argvLog = process.env.CLARIFY_INLINE_ARGV_LOG || `${stateDir}/argv.log`
  // Logged BEFORE the `run` token is dropped: the spec inspects the invocation
  // as the runner spelled it, flags and subcommand included.
  appendLine(argvLog, call.argv.join(' '))

  emitPromptForContractTest(call.prompt)
  const open = requireEnvelopeOpen(call.prompt, NAME)

  const rest = call.argv.slice(1)
  const flags = parseFlags(rest, ['--agent', '--session'])
  const agent = flags['--agent'] ?? 'default'
  const sessionResume = flags['--session'] ?? ''

  const sessionLog = process.env.CLARIFY_INLINE_SESSION_LOG
  if (sessionLog !== undefined && sessionLog.length > 0) appendLine(sessionLog, sessionResume)

  const agentKey = sanitizeStateKey(agent)
  emitSessionCreated(`opc_e2e_${agentKey}`)

  const alreadyCalled = markCalled(`${stateDir}/${agentKey}`)
  if (!alreadyCalled) {
    emitClarifyEvent(open.clarify, QUESTIONS)
    process.exit(0)
  }

  emitTextEvent(
    envelope(open.output, [
      ['design', `design after inline-clarify ${agent} (session=${sessionResume})`],
    ]),
  )
  process.exit(0)
}

function emitSessionCreated(sessionId: string): void {
  process.stdout.write(
    `${JSON.stringify({ type: 'session.created', sessionID: sessionId, timestamp: 0 })}\n`,
  )
}
