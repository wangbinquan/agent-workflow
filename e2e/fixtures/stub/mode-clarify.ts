// RFC-254 T28b — `clarify` mode: the port of `stub-opencode-clarify.sh`
// (RFC-023 PR-D, T28 + T29).
//
// Round-driven: a per-(agent, shard) marker file decides whether this call asks
// a question or finalises.
//   round 1  → <workflow-clarify> with 2 questions, the first `recommended`
//              (the UI must render the chip on Q1 and gate submit on Q1);
//   round 2+ → <workflow-output> with the declared `design` port.
//
// `CLARIFY_STUB_ASK_SHARDS` narrows round 1 to a named set of shards so the
// fan-out sub-case (T29) can have exactly 1 of 3 shards ask back.

import {
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

const NAME = 'stub-opencode-clarify'

const QUESTIONS =
  '{"questions":[{"id":"q-db","title":"Which database should we use?","kind":"single","recommended":true,"options":["Postgres","SQLite"]},{"id":"q-lang","title":"Pick languages","kind":"multi","recommended":false,"options":["TypeScript","Python"]}]}'

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 1.17.9\n')
    process.exit(0)
  }
  const stateDir = ensureStateDir(process.env.CLARIFY_STUB_STATE, '/tmp/aw-e2e-clarify-state')
  emitPromptForContractTest(call.prompt)
  const open = requireEnvelopeOpen(call.prompt, NAME)

  // The shell dropped the leading `run` before walking flags; the same slice is
  // used here so an `--agent`-shaped prompt cannot shift the parse by one.
  const rest = call.argv.slice(1)
  const agent = parseFlags(rest, ['--agent'])['--agent'] ?? 'default'
  let shard = process.env.MOCK_OPENCODE_SHARD_KEY ?? '_none_'

  // The runner does NOT forward MOCK_OPENCODE_SHARD_KEY into the subprocess
  // env, so the shard is recovered from the prompt body instead: the fan-out
  // spec's template renders `Audit <shard_key>.`, and a shard named in
  // CLARIFY_STUB_ASK_SHARDS whose text appears there is the one asking.
  const askList = (process.env.CLARIFY_STUB_ASK_SHARDS ?? '').split(/\s+/).filter((s) => s !== '')
  let shouldAsk = true
  if (askList.length > 0) {
    shouldAsk = false
    const matched = askList.find((candidate) => call.prompt.includes(`Audit ${candidate}`))
    if (matched !== undefined) {
      shouldAsk = true
      shard = matched
    }
  }

  const alreadyCalled = markCalled(`${stateDir}/${sanitizeStateKey(`${agent}.${shard}`)}`)

  if (!alreadyCalled && shouldAsk) {
    emitClarifyEvent(open.clarify, QUESTIONS)
    process.exit(0)
  }

  emitTextEvent(envelope(open.output, [['design', `design after clarify ${agent} ${shard}`]]))
  process.exit(0)
}
