// RFC-254 T28b — `commit` mode: the port of `stub-opencode-commit.sh` (RFC-075).
//
// Two roles switched on the prompt:
//   * commit agent (prompt mentions `commit_message`) → emit a commit message
//     and write NOTHING;
//   * worker agent (anything else) → DIRTY THE WORKTREE so the framework's
//     diff-driven commit trigger fires, then emit its output port.
//
// Note the envelope here is inline — no newlines between ports — unlike the
// `basic` mode's multi-line layout. That difference is behavioural (the runner
// buffers and regex-extracts, so both parse) but it is preserved verbatim
// because the differential guard compares stdout byte-for-byte.

import {
  emitPromptForContractTest,
  emitTextEvent,
  parseInvocation,
  requireOutputOpen,
} from './skeleton'

const NAME = 'stub-opencode-commit'

export function run(argv: readonly string[]): void {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 999.0.0\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)
  const open = requireOutputOpen(call.prompt, NAME)

  if (call.prompt.includes('commit_message')) {
    emitTextEvent(
      `${open}<port name="commit_message">feat: e2e stub commit</port></workflow-output>`,
    )
    process.exit(0)
  }

  // cwd is the task worktree; a dirty file is what makes a commit warranted.
  Bun.write('e2e-change.txt', `e2e change ${process.pid}\n`)
  emitTextEvent(`${open}<port name="answer">stub e2e output</port></workflow-output>`)
  process.exit(0)
}
