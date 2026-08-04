// RFC-254 T28b — `basic` mode: the port of `stub-opencode.sh`.
//
// Behaviour is byte-for-byte the shell script's, including the deliberately
// non-semver version string (a telemetry-normalisation case depends on it).

import {
  emitPromptForContractTest,
  emitTextEvent,
  envelope,
  parseInvocation,
  requireOutputOpen,
  writeInventoryIfRequested,
} from './skeleton'

const NAME = 'stub-opencode'

/** Byte-identical to the heredoc the shell stub wrote. */
const INVENTORY = `{
  "schemaVersion": 1,
  "capturedAt": 1700000000000,
  "agents": [
    {"name": "e2e-stub-coder", "mode": "primary", "modelProviderId": "anthropic", "modelId": "claude-opus-4-7", "readonly": true, "source": "inline"}
  ],
  "skills": [
    {"name": "fixture-skill", "source": "managed", "path": "/tmp/skills/fixture-skill", "description": "stub e2e skill"}
  ],
  "mcps": [
    {"name": "fixture-mcp-ok", "type": "local", "status": "connected", "hint": null},
    {"name": "fixture-mcp-warn", "type": "remote", "status": "needs_auth", "hint": "token missing"}
  ],
  "plugins": [
    {"specifier": "file:///tmp/plugins/aw-inventory-dump.mjs", "source": "inline"}
  ]
}
`

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode custom-build\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const open = requireOutputOpen(call.prompt, NAME)

  // RFC-187 T11 (audit TRAP-3) — be WORKGROUP-AWARE.
  //
  // A workgroup host run is fed the wg protocol block and projected onto wg_*
  // ports only, so the fixed "answer" envelope below would parse to ZERO
  // declared ports, fail the turn, and end the group task `failed` — while the
  // Playwright spec still "passed". That is exactly how production once ran ten
  // tasks with zero done and no red test.
  //
  // The role is detected from the protocol block's own port DECLARATIONS
  // (`<port name="wg_decision">`) rather than a bare token: a leader's ledger
  // quotes member results and would otherwise be misread.
  if (call.prompt.includes('name="wg_decision"')) {
    // Leader: close the group immediately (empty assignments = no new work).
    emitTextEvent(
      envelope(open, [
        ['wg_assignments', '[]'],
        ['wg_decision', '{"action":"done","summary":"stub e2e leader done"}'],
      ]),
    )
    process.exit(0)
  }
  if (call.prompt.includes('name="wg_task_results"')) {
    // RFC-215 fc TASK-BATCH run: one entry per Task number (1..N). Matched
    // BEFORE wg_result so the batch protocol's prose mention of wg_result can
    // never shadow this branch.
    // LAST match, like the shell's `sed 's/.*batch of \([0-9]*\).*/\1/'` whose
    // greedy prefix reached the final occurrence. A retry turn can legitimately
    // carry two: `prompts.ts` renders `## Your assignments (batch of N)` and
    // `freeCollab.ts` quotes `batch of N task(s) for @X failed` into the
    // blackboard above it — the same "prompt quotes upstream content" hazard the
    // nonce and the wg_result branch already guard for.
    const batch = [...call.prompt.matchAll(/batch of (\d+)/g)].at(-1)
    const n = batch === undefined ? 1 : Number(batch[1])
    const entries = Array.from(
      { length: n },
      (_, i) => `{"task":${i + 1},"summary":"stub e2e batch task ${i + 1} done"}`,
    ).join(',')
    emitTextEvent(
      envelope(open, [
        ['wg_task_results', `[${entries}]`],
        ['wg_tasks_add', '[]'],
      ]),
    )
    process.exit(0)
  }
  if (call.prompt.includes('name="wg_result"')) {
    // lw worker / fc message turn: report done, add no follow-up tasks
    // (wg_tasks_add is fc-only; a worker never declares it, so the projection
    // just drops it).
    emitTextEvent(
      envelope(open, [
        ['wg_result', '{"summary":"stub e2e member result"}'],
        ['wg_tasks_add', '[]'],
      ]),
    )
    process.exit(0)
  }

  writeInventoryIfRequested(INVENTORY)
  emitTextEvent(envelope(open, [['answer', 'stub e2e output']]))
  process.exit(0)
}
