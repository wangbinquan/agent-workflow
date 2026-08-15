// RFC-304 — the code-round CONTRACT: the ids and the snapshot shape, with no
// dependency on anything that launches or runs a task.
//
// This module exists to stay a leaf. `codeRoundLaunch.ts` has to import
// `task.ts` (it calls `startTask`), and `task.ts` reaches the execution
// outcome projection — so an outcome module importing the launch service to
// get one node-id constant closes a cycle:
//
//   execution/outcome.ts → codeRoundLaunch.ts → task.ts → … → execution/outcome.ts
//
// The repo's dependency gate flags exactly that, and its stated first choice is
// to break the edge rather than accept it. Constants and pure shapes have no
// reason to sit behind a service, so they live here and both sides import the
// leaf. (`agentLaunch.ts` has the same latent shape and is on the accepted-debt
// list; this is what NOT reproducing it looks like.)

import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import type { LaunchSpaceFields } from '@agent-workflow/shared'

export const CODE_ROUND_HOST_WORKFLOW_ID = '00000000000000CODEROUND00'
export const CODE_ROUND_HOST_WORKFLOW_NAME = '__code_round_host__'

/**
 * The one node of a round's synthesized snapshot. Named like the agent host's
 * `__agent_main__` so the two read as the same family in a node_runs dump.
 */
export const CODE_ROUND_NODE_ID = '__code_round__'

/** The port a round publishes its result on. */
export const CODE_ROUND_SUMMARY_PORT = 'round_summary'

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

/**
 * Space fields ride `LaunchSpaceFields` rather than being re-listed here. That
 * interface's own comment records why: `applySpaceFields` is the single
 * assembly point precisely because a hand-copied list silently drops whatever
 * was added since it was copied (RFC-125/RFC-204 incidents). The first draft of
 * this input re-listed them and immediately proved the point — it dropped
 * `scratch`, `repoGroupId` and `sourceTaskId`, and carried `repoPath`, which is
 * a RETIRED key that `assertNoRetiredLaunchKeys` rejects.
 */
export interface StartCodeRoundInput extends LaunchSpaceFields {
  /** The round this task materializes (`tasks.code_round_id`). */
  roundId: string
  capability: string
  roundSeq: number
  /** Task name shown in lists. */
  name: string
  /** Optional base branch, same meaning as an ordinary launch. */
  baseBranch?: string
}
