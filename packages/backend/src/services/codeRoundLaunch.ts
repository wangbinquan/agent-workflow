// RFC-304 PR-0 (T0b) — the `code-round` execution kind.
//
// A code capability runs a STAGE SEQUENCE, not a node graph: most stages are
// plain program code (parse a webhook payload, shard a diff, arbitrate
// priorities), and program stages have no workflow node kind to compile into.
// So one round = one task, whose frozen snapshot holds a single synthesized
// `code-round` node, and whose execution is driven by the stage engine rather
// than by the DAG walker.
//
// Everything else about the task is deliberately ordinary. It gets a real
// worktree, a real row, real node_runs; cancel, retry, interrupted-repair,
// resource limits and the detail page all work through the paths they already
// work through. That reuse is the entire reason the RFC put rounds on the task
// engine instead of calling `runSystemAgent` directly (design §D5).
//
// Structure mirrors `agentLaunch.ts` step for step — the builtin FK anchor, the
// lazy idempotent seed, the synthesized snapshot, the StartTaskSchema funnel —
// because "a task whose subject is not a user-authored workflow" is a shape
// this repo already has twice (agent host, workgroup host), and a third one
// that looked different would be a third thing to reason about.

import {
  applySpaceFields,
  serializeWorkflowDefinitionStorageV1,
  StartTaskSchema,
  WORKFLOW_SCHEMA_VERSION,
} from '@agent-workflow/shared'
import type { Task } from '@agent-workflow/shared'
import {
  CODE_ROUND_HOST_WORKFLOW_ID,
  CODE_ROUND_HOST_WORKFLOW_NAME,
  synthesizeCodeRoundSnapshot,
  type StartCodeRoundInput,
} from '@/services/codeRoundContract'
import { initialBuiltinResourceAcl } from '@/services/resourceAcl'
import { workflows } from '@/db/schema'
import type { DbClient } from '@/db/client'
import { ValidationError } from '@/util/errors'
import { startTask, type StartTaskDeps } from '@/services/task'

/**
 * Lazily seed the builtin host workflow row (FK anchor for code-round tasks).
 * NOT a migration seed — a migration-seeded row would surface in every fresh
 * DB and break empty-fixture expectations; idempotent via onConflictDoNothing
 * (mirrors ensureAgentHostWorkflow / ensureWorkgroupHostWorkflow).
 */
export async function ensureCodeRoundHostWorkflow(db: DbClient): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: CODE_ROUND_HOST_WORKFLOW_ID,
      name: CODE_ROUND_HOST_WORKFLOW_NAME,
      description: 'RFC-304 code-capability round anchor — do not launch directly',
      definition: serializeWorkflowDefinitionStorageV1({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      ...initialBuiltinResourceAcl(null),
      builtin: true,
    })
    .onConflictDoNothing({ target: workflows.id })
}

/**
 * Start one round as a task.
 *
 * Deliberately thin: it seeds the anchor, synthesizes the snapshot, and hands
 * the rest to `startTask`. Anything a round needs that ordinary tasks do not
 * have belongs in the stage engine, not here — this function's job is only to
 * make a round look like a task to everything downstream.
 */
export async function startCodeRoundTask(
  input: StartCodeRoundInput,
  deps: StartTaskDeps & { db: DbClient },
): Promise<Task> {
  if (input.roundId.trim() === '') {
    throw new ValidationError('code-round-launch-invalid', 'roundId is required')
  }
  if (input.capability.trim() === '') {
    throw new ValidationError('code-round-launch-invalid', 'capability is required')
  }
  if (!Number.isInteger(input.roundSeq) || input.roundSeq < 1) {
    throw new ValidationError('code-round-launch-invalid', 'roundSeq must be a positive integer')
  }
  await ensureCodeRoundHostWorkflow(deps.db)

  const candidate = applySpaceFields(
    {
      workflowId: CODE_ROUND_HOST_WORKFLOW_ID,
      name: input.name,
      inputs: {},
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    },
    input,
  )
  const parsed = StartTaskSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new ValidationError('code-round-launch-invalid', 'invalid code-round launch payload', {
      issues: parsed.error.issues,
    })
  }

  return await startTask(parsed.data, {
    ...deps,
    codeRoundLaunch: {
      roundId: input.roundId,
      capability: input.capability,
      snapshotJson: synthesizeCodeRoundSnapshot({
        capability: input.capability,
        roundSeq: input.roundSeq,
        title: input.name,
      }),
    },
  })
}

// Re-exported so callers that already think in terms of "the code-round launch
// service" do not need to know the contract was split out for the dependency
// gate. The split is a layering fact, not an API change.
export {
  CODE_ROUND_HOST_WORKFLOW_ID,
  CODE_ROUND_HOST_WORKFLOW_NAME,
  CODE_ROUND_NODE_ID,
  CODE_ROUND_SUMMARY_PORT,
  synthesizeCodeRoundSnapshot,
  type CodeRoundSnapshotInput,
  type StartCodeRoundInput,
} from '@/services/codeRoundContract'
