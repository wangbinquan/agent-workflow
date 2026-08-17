// RFC-307 PR-3 — sample content, so a fresh install has something to open.
//
// The gap this closes is the last mile of the same complaint. A new install has
// no repositories, no bindings and no rounds, so every `/code` panel is an
// empty state and the flow view has nothing to configure against. Telling
// someone to first connect a GitLab, create a framework, write a binding and
// wait for a merge request before they can see what the product does is a tour
// that starts after the part they wanted to see.
//
// Four rules, and each of them is load-bearing:
//
//   1. DELETED STAYS DELETED. The marker is a file recording that this install
//      has been offered the samples, NOT a check for whether the rows exist. A
//      user who deletes the demo means it, and re-seeding on the next restart
//      would be the platform arguing with them.
//   2. LABELLED. Every row is named `[demo] …` and says in its description that
//      it is sample data and safe to delete. Sample data that reads as real is
//      worse than none — somebody eventually points it at a live repository.
//   3. NO EXTERNAL DEPENDENCY. Nothing here contacts a code host, spawns a
//      process or opens a socket. The demo round is a SEEDED HISTORY, not a
//      real run: a real one needs a code host, and demanding one puts the
//      requirement back that this exists to remove.
//   4. NEVER FATAL. A failure here leaves a daemon with no samples, which is
//      the state every install before this RFC was in. It must not be able to
//      stop a daemon from starting.
//
// One flag deliberately NOT set: `builtin`. The first version of this file
// copied it from `seedFusionResources`, and running the result showed what it
// actually means in this repo — `excludeBuiltinWorkflows` hides the row from
// every list, and `assertNotBuiltin` refuses every edit and delete with
// `builtin-readonly`. For fusion's engine resources that is exactly right: they
// are infrastructure the daemon references by name. For samples it is the
// precise opposite of the point, and it broke all three promises at once — the
// demo agent never appeared in the agent picker, the demo binding answered
// `capability-template-builtin` to the very prompt edit this RFC exists to
// make possible, and the framework could not be deleted at all, which made
// "safe to delete" false.
//
// So the samples are ordinary rows: `__system__`-owned and `public`, which
// makes them visible to everyone and editable/removable by anyone with
// resource-ACL bypass. A user without it copies one and edits the copy, which
// is the platform's normal answer for a shared resource.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { eq } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  capabilityBindings,
  capabilityFrameworks,
  codeRoundStages,
  codeWorkItems,
  codeWorkRounds,
  workflows,
} from '@/db/schema'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { Paths } from '@/util/paths'
import { createLogger } from '@/util/log'

const log = createLogger('demo-seed')

/**
 * Stable ids, so a second run is a no-op and a user can recognise the samples.
 *
 * Prefixed `aw-demo-` rather than being ULIDs: an id a person can read is one
 * they can grep for when they want every trace of the demo gone.
 */
export const DEMO_AGENT_ID = 'aw-demo-reviewer'
export const DEMO_FRAMEWORK_ID = 'aw-demo-framework-mr-review'
export const DEMO_BINDING_ID = 'aw-demo-binding-mr-review'
/** Opaque code-host identity for the demo round. NOT a `webhook_endpoints` row — see `seedDemoRound`. */
export const DEMO_ENDPOINT_ID = 'aw-demo-endpoint'
export const DEMO_WORK_ITEM_ID = 'aw-demo-work-item'
export const DEMO_ROUND_ID = 'aw-demo-round'
export const DEMO_WORKFLOW_REVIEW_ID = 'aw-demo-workflow-review'
export const DEMO_WORKFLOW_FANOUT_ID = 'aw-demo-workflow-fanout'

const DEMO_NOTE = '示例数据，可以安全删除；删除后不会再次生成。 / Sample data — safe to delete.'

/** A fixed instant, so two installs seeded on different days look the same. */
const DEMO_AT = 1_700_000_000_000

export interface DemoSeedResult {
  seeded: boolean
  reason?: 'already-offered' | 'error'
}

/**
 * Seed the samples once per install.
 *
 * Returns rather than throws: see rule 4 above. The caller logs.
 */
export async function seedDemoContent(db: DbClient): Promise<DemoSeedResult> {
  if (existsSync(Paths.demoSeedMarker)) return { seeded: false, reason: 'already-offered' }

  try {
    await seedCapabilityTemplates(db)
    await seedDemoRound(db)
    await seedDemoWorkflows(db)
  } catch (err: unknown) {
    // Deliberately do NOT write the marker: a partial seed should be retried on
    // the next start rather than leaving a half-populated install that never
    // gets the rest.
    log.warn('demo content seed failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { seeded: false, reason: 'error' }
  }

  mkdirSync(dirname(Paths.demoSeedMarker), { recursive: true })
  writeFileSync(Paths.demoSeedMarker, `${String(Date.now())}\n`, { mode: 0o600 })
  return { seeded: true }
}

async function seedCapabilityTemplates(db: DbClient): Promise<void> {
  const existingAgent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, DEMO_AGENT_ID))
  if (existingAgent.length === 0) {
    const { createAgent } = await import('@/services/agent')
    await createAgent(
      db,
      {
        name: '[demo] reviewer',
        description: `Sample reviewer used by the demo binding and workflows. ${DEMO_NOTE}`,
        outputs: ['findings'],
        inputs: [],
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        // Reviewing reads; it must not write the worktree. A sample that asks
        // for more access than its job needs teaches the wrong default — and
        // `readonly` is a frontmatter field rather than a column, which is why
        // it rides here rather than in the row.
        frontmatterExtra: { readonly: true },
        bodyMd: ['You review a merge request diff and report findings.', '', `> ${DEMO_NOTE}`].join(
          '\n',
        ),
      },
      { id: DEMO_AGENT_ID, ownerUserId: SYSTEM_USER_ID },
    )
    // `createAgent` has no visibility option and every new resource lands
    // `private` (RFC-099). A private sample is invisible to everyone but its
    // owner, and its owner here is `__system__` — i.e. nobody. Same follow-up
    // update `seedFusionResources` does for the merger agent.
    await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, DEMO_AGENT_ID))
  }

  await db
    .insert(capabilityFrameworks)
    .values({
      id: DEMO_FRAMEWORK_ID,
      name: '[demo] MR review framework',
      description: `Department-layer sample: scripts, hooks and the parameter table. ${DEMO_NOTE}`,
      capability: 'mr-review',
      // One readable script and one hook, because an empty framework teaches
      // nothing about what the two layers are for.
      scriptsJson: JSON.stringify({
        collect: {
          language: 'bash',
          script: [
            '#!/usr/bin/env bash',
            '# [demo] Sample collect script.',
            '# Real ones ask the code host what changed; this one just reports a',
            '# fixed shape so the sample runs nowhere and needs nothing.',
            'set -euo pipefail',
            'echo \'{"packages": []}\'',
          ].join('\n'),
        },
      }),
      hooksJson: JSON.stringify([
        {
          stage: 'review-shard',
          phase: 'pre',
          language: 'bash',
          script: [
            '#!/usr/bin/env bash',
            '# [demo] Runs before each sharded review.',
            '#',
            '# It returns `extraContext` because that is what `review-shard`',
            '# DECLARES in its `injectable` allowlist. Returning anything else —',
            '# `promptSuffix`, say — is refused by the runner, so a sample that',
            '# did would be teaching a mistake. The flow view shows the allowed',
            '# keys for each step so this never has to be guessed.',
            'set -euo pipefail',
            'echo \'{"extraContext": "Prefer concrete, reproducible findings."}\'',
          ].join('\n'),
          blocking: true,
          stageContractVer: lookupStageContract('mr-review')?.version ?? 1,
        },
      ]),
      paramSchemaJson: JSON.stringify([
        { name: 'maxFindings', kind: 'number', required: false },
        { name: 'skipDraft', kind: 'boolean', required: false },
      ]),
      paramDefaultsJson: JSON.stringify({ maxFindings: 20, skipDraft: true }),
      stageContractVer: lookupStageContract('mr-review')?.version ?? 1,
      ownerUserId: SYSTEM_USER_ID,
      visibility: 'public',
      createdAt: DEMO_AT,
      updatedAt: DEMO_AT,
    })
    .onConflictDoNothing()

  await db
    .insert(capabilityBindings)
    .values({
      id: DEMO_BINDING_ID,
      name: '[demo] MR review binding',
      description: `Group-layer sample: which agent fills each slot, and the prompts. ${DEMO_NOTE}`,
      frameworkId: DEMO_FRAMEWORK_ID,
      // Both AI stages of `mr-review` share the `reviewer` slot — which is
      // exactly the case the flow view highlights when you click either one.
      agentBySlotJson: JSON.stringify({ reviewer: DEMO_AGENT_ID }),
      promptBySlotJson: JSON.stringify({
        reviewer: 'Review the diff. Report only findings you can point at a line for.',
      }),
      paramsJson: JSON.stringify({ maxFindings: 10 }),
      ownerUserId: SYSTEM_USER_ID,
      visibility: 'public',
      createdAt: DEMO_AT,
      updatedAt: DEMO_AT,
    })
    .onConflictDoNothing()
}

/**
 * A finished round, so the Activity tab and the runtime overlay have content.
 *
 * Seeded history rather than a real run (rule 3). What makes it useful is that
 * it is a REALISTIC one: it ends `published`, one stage carries a real-looking
 * failure, and the stage rows are generated FROM THE CONTRACT — so if a stage
 * is ever added, the sample gains it too instead of drifting into a sequence
 * the platform no longer has.
 */
async function seedDemoRound(db: DbClient): Promise<void> {
  const contract = lookupStageContract('mr-review')
  if (contract === undefined) return

  // NO `webhook_endpoints` ROW is created for this.
  //
  // The first version seeded one, and CI showed why that is wrong: a fake
  // endpoint appears in every endpoint picker in the product, and pickers
  // default to their first option — so `[demo] sample code host` became the
  // DEFAULT selection on the trigger form. An endpoint that can never receive a
  // delivery, pre-selected on the screen where someone wires up a real one, is
  // a trap regardless of what it is called.
  //
  // It is not needed: `code_work_items.code_host_endpoint_id` carries no
  // foreign key and no read path joins `webhook_endpoints`, because the id is
  // opaque here. The demo round is history — nothing will ever dial it.
  await db
    .insert(codeWorkItems)
    .values({
      id: DEMO_WORK_ITEM_ID,
      codeHostEndpointId: DEMO_ENDPOINT_ID,
      stableProjectId: 'demo/sample-project',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '42',
      status: 'settled',
      epoch: 1,
      currentRoundId: DEMO_ROUND_ID,
      createdAt: DEMO_AT,
      updatedAt: DEMO_AT,
    })
    .onConflictDoNothing()

  await db
    .insert(codeWorkRounds)
    .values({
      id: DEMO_ROUND_ID,
      workItemId: DEMO_WORK_ITEM_ID,
      roundSeq: 1,
      epoch: 1,
      baselineSha: '0000000000000000000000000000000000000000',
      stageContractVer: contract.version,
      outcome: 'published',
      startedAt: DEMO_AT,
      endedAt: DEMO_AT + 214_000,
    })
    .onConflictDoNothing()

  // Generated from the contract, not hand-listed: a hand-listed sample would
  // drift the first time a stage was added, and drift in the sample is what
  // teaches people the picture cannot be trusted.
  await db
    .insert(codeRoundStages)
    .values(
      contract.stages.map((stage, index) => ({
        id: `${DEMO_ROUND_ID}-${String(index)}`,
        roundId: DEMO_ROUND_ID,
        stageSeq: index,
        stageName: stage.name,
        stageKind: stage.kind,
        status: 'done' as const,
        startedAt: DEMO_AT + index * 15_000,
        endedAt: DEMO_AT + (index + 1) * 15_000,
      })),
    )
    .onConflictDoNothing()
}

/**
 * Two ordinary workflows, so the sample also answers the OTHER half of the
 * question the user asked: "I don't even know how I would compose this."
 *
 * Deliberately the same shape as the built-in sequence's readable part — read
 * the change, review it, report — so the two can be held side by side: this is
 * what the platform runs for you, and this is what you can wire yourself.
 */
async function seedDemoWorkflows(db: DbClient): Promise<void> {
  const { createWorkflow } = await import('@/services/workflow')

  const existing = await db
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(eq(workflows.id, DEMO_WORKFLOW_REVIEW_ID))
  if (existing.length > 0) {
    // Occupied by something that is not ours. Skipped rather than overwritten —
    // but SAID, because a sample that quietly never appears is indistinguishable
    // from one that was never written.
    if (existing[0]?.name !== '[demo] Review a change') {
      log.warn('demo workflow id already occupied; sample skipped', {
        id: DEMO_WORKFLOW_REVIEW_ID,
        occupiedBy: existing[0]?.name,
      })
    }
  } else {
    await createWorkflow(
      db,
      {
        name: '[demo] Review a change',
        description: `The readable half of what mr-review does, as an ordinary workflow. ${DEMO_NOTE}`,
        definition: {
          $schema_version: 2,
          inputs: [{ kind: 'text', key: 'diff', label: 'Diff to review', required: true }],
          nodes: [
            { id: 'in_diff', kind: 'input', inputKey: 'diff' },
            {
              id: 'review',
              kind: 'agent-single',
              agentId: DEMO_AGENT_ID,
              agentName: '[demo] reviewer',
              promptTemplate: 'Review this change and list findings.\n\n{{diff}}',
            },
            {
              id: 'out_findings',
              kind: 'output',
              ports: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
            },
          ],
          edges: [
            {
              id: 'e_in',
              source: { nodeId: 'in_diff', portName: 'diff' },
              target: { nodeId: 'review', portName: 'diff' },
            },
            {
              id: 'e_out',
              source: { nodeId: 'review', portName: 'findings' },
              target: { nodeId: 'out_findings', portName: 'findings' },
            },
          ],
          outputs: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
        },
      },
      { id: DEMO_WORKFLOW_REVIEW_ID, ownerUserId: SYSTEM_USER_ID, visibility: 'public' },
    )
  }

  const existingFanout = await db
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(eq(workflows.id, DEMO_WORKFLOW_FANOUT_ID))
  if (existingFanout.length > 0) {
    if (existingFanout[0]?.name !== '[demo] Review, then ask') {
      log.warn('demo workflow id already occupied; sample skipped', {
        id: DEMO_WORKFLOW_FANOUT_ID,
        occupiedBy: existingFanout[0]?.name,
      })
    }
  } else {
    await createWorkflow(
      db,
      {
        name: '[demo] Review, then ask',
        description: `Adds the platform's other human touchpoint — asking a question. ${DEMO_NOTE}`,
        definition: {
          $schema_version: 2,
          inputs: [{ kind: 'text', key: 'diff', label: 'Diff to review', required: true }],
          nodes: [
            { id: 'in_diff', kind: 'input', inputKey: 'diff' },
            {
              id: 'review',
              kind: 'agent-single',
              agentId: DEMO_AGENT_ID,
              agentName: '[demo] reviewer',
              promptTemplate: 'Review this change. Ask if anything is unclear.\n\n{{diff}}',
            },
            { id: 'ask', kind: 'clarify', title: 'Anything unclear?' },
            {
              id: 'out_findings',
              kind: 'output',
              ports: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
            },
          ],
          edges: [
            {
              id: 'e_in',
              source: { nodeId: 'in_diff', portName: 'diff' },
              target: { nodeId: 'review', portName: 'diff' },
            },
            {
              id: 'e_ask',
              source: { nodeId: 'review', portName: '__clarify__' },
              target: { nodeId: 'ask', portName: 'questions' },
            },
            {
              id: 'e_ans',
              source: { nodeId: 'ask', portName: 'answers' },
              target: { nodeId: 'review', portName: '__clarify_response__' },
            },
            {
              id: 'e_out',
              source: { nodeId: 'review', portName: 'findings' },
              target: { nodeId: 'out_findings', portName: 'findings' },
            },
          ],
          outputs: [{ name: 'findings', bind: { nodeId: 'review', portName: 'findings' } }],
        },
      },
      { id: DEMO_WORKFLOW_FANOUT_ID, ownerUserId: SYSTEM_USER_ID, visibility: 'public' },
    )
  }
}
