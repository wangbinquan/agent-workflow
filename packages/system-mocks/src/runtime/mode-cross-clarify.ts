// RFC-254 T28b — `cross-clarify` mode: the port of
// `stub-opencode-cross-clarify.sh` (RFC-056, updated for RFC-162).
//
// Keys purely on (agent, invocation-count) and deliberately does NOT encode a
// fixed round ORDER, which is what let it survive RFC-162's change from
// "rerun the designer" to "rerun the questioner" untouched. Under RFC-162:
//
//   designer  round 1   → <workflow-output> "design v1" (runs once)
//   questioner round 1  → <workflow-clarify>            (task pauses)
//   questioner round 2  → <workflow-clarify> again      (RFC-100 makes the
//                         ask-back mandatory: a `continue` answer may not
//                         finalise, only `stop` may)
//   questioner round 3  → <workflow-output> "questioner v3"

import {
  appendLine,
  bumpCounter,
  emitClarifyEvent,
  emitPromptForContractTest,
  emitTextEvent,
  ensureStateDir,
  envelope,
  parseFlags,
  parseInvocation,
  requireEnvelopeOpen,
  sanitizeStateKey,
} from './skeleton'

const NAME = 'stub-opencode-cross-clarify'

const QUESTIONS =
  '{"questions":[{"id":"q-redis","title":"Should we use Redis for caching?","kind":"single","recommended":true,"options":["Yes","No","Maybe"]}]}'

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 1.18.4\n')
    process.exit(0)
  }
  const stateDir = ensureStateDir(
    process.env.CROSS_CLARIFY_STUB_STATE,
    '/tmp/aw-e2e-cross-clarify-state',
  )
  emitPromptForContractTest(call.prompt)
  const open = requireEnvelopeOpen(call.prompt, NAME)

  const rest = call.argv.slice(1)
  const agent = parseFlags(rest, ['--agent'])['--agent'] ?? 'default'
  const count = bumpCounter(`${stateDir}/${sanitizeStateKey(agent)}.count`)

  // The prompt log is how the spec proves the runner injected the flat
  // `## Clarify Q&A` block into the ASKER's rerun (RFC-132 PR-C).
  const promptLog = process.env.CROSS_CLARIFY_PROMPT_LOG
  if (promptLog !== undefined && promptLog.length > 0) {
    appendLine(promptLog, `=== ${agent} round ${count} ===`)
    appendLine(promptLog, call.prompt)
    appendLine(promptLog, `=== END ${agent} round ${count} ===`)
  }

  if (agent === 'questioner' && count <= 2) {
    emitClarifyEvent(open.clarify, QUESTIONS)
    process.exit(0)
  }

  const final =
    agent === 'designer'
      ? { port: 'design', text: `design v${count}` }
      : agent === 'questioner'
        ? { port: 'main', text: `questioner v${count}: all good` }
        : { port: 'design', text: `other v${count}` }
  emitTextEvent(envelope(open.output, [[final.port, final.text]]))
  process.exit(0)
}
