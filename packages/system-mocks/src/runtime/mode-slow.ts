// RFC-254 T28b — `slow` mode: the port of `stub-opencode-slow.sh` (RFC-054).
//
// A controllable variant used to hold a task in `running` long enough to
// SIGKILL the daemon (crash-recovery), and to drive the failure / no-envelope /
// non-zero-exit paths of the lifecycle spec.
//
// The sleep keeps the shell's SECOND granularity on purpose: the original
// computed `sleep_ms / 1000` with integer division, so 500 ms meant "do not
// sleep at all". Converting to true millisecond precision would silently change
// the timing every existing spec was tuned against.

import {
  emitPromptForContractTest,
  emitTextEvent,
  envelope,
  parseInvocation,
  requireOutputOpen,
  writeInventoryIfRequested,
} from './skeleton'

const NAME = 'stub-opencode-slow'

/** Byte-identical to the heredoc the shell stub wrote. */
const INVENTORY = `{
  "schemaVersion": 1,
  "capturedAt": 1700000000000,
  "agents": [
    {"name": "e2e-stub-coder", "mode": "primary", "modelProviderId": "anthropic", "modelId": "claude-opus-4-7", "readonly": true, "source": "inline"}
  ],
  "skills": [],
  "mcps": [],
  "plugins": []
}
`

export async function run(argv: readonly string[]): Promise<void> {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 0.9.0\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const open = requireOutputOpen(call.prompt, NAME)

  const sleepMs = Number(process.env.STUB_OPENCODE_SLEEP_MS ?? '0')
  const sleepSeconds = Number.isFinite(sleepMs) ? Math.floor(sleepMs / 1000) : 0
  if (sleepSeconds > 0) await Bun.sleep(sleepSeconds * 1000)

  writeInventoryIfRequested(INVENTORY)

  if ((process.env.STUB_OPENCODE_SKIP_ENVELOPE ?? '') === '') {
    emitTextEvent(envelope(open, [['answer', 'stub e2e output']]))
  }

  process.exit(Number(process.env.STUB_OPENCODE_EXIT_CODE ?? '0'))
}
