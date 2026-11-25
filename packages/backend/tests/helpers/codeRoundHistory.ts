// RFC-594 — fixtures for historical code-round tasks: the snapshot RFC-304's (since retired) writer froze on a round's
// task, moved verbatim from `services/codeRoundContract.ts`. Production no longer synthesizes it; tests use it to seed a
// historical row, and the node id comes from task-execution's domain, the same value the outcome projection reads.

import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { CODE_ROUND_NODE_ID } from '@/modules/task-execution/domain/codeRoundHistory'

export interface CodeRoundSnapshotInput {
  /** Which capability this round runs (`mr-review` / `ci-fix` / …). */
  capability: string
  /** 1-based round number within the work item. */
  roundSeq: number
  /** Display title for the task detail page's canvas card. */
  title: string
}

/**
 * Synthesize the frozen snapshot for a round: exactly one `code-round` node,
 * no inputs, no edges.
 *
 * The node exists so the detail page has something to draw and so node_runs
 * have somewhere to anchor — NOT because the round is a one-node workflow. The
 * stage sequence lives in platform code and is versioned there (design §3.3);
 * putting it in the snapshot would invite someone to edit it, which is exactly
 * what `SYNTHESIZED_ONLY_NODE_KINDS` refuses.
 */
export function synthesizeCodeRoundSnapshot(input: CodeRoundSnapshotInput): string {
  return JSON.stringify({
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [],
    nodes: [
      {
        id: CODE_ROUND_NODE_ID,
        kind: 'code-round',
        title: input.title,
        capability: input.capability,
        roundSeq: input.roundSeq,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  })
}
