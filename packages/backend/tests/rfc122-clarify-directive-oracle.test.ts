// RFC-122 — pure / oracle coverage for the per-(task, asking-node) clarify
// directive override ("继续反问 / 停止反问" canvas toggle).
//
// Locks the three pure seams the scheduler stitches at dispatch:
//   1. resolveEffectiveClarifyChannel — the STOP override forces mandatory
//      ask-back OFF for BOTH self-clarify AND cross-questioner (both are
//      hasClarifyChannel=true), and golden-locks the no-override boolean.
//   2. renderUserPrompt — clarifyStopNotice injects the `### User directive:
//      STOP CLARIFYING` trailer on a first-run STOP (no answersBlock), keeps the
//      output protocol, and is suppressed when ask-back is still active.
//   3. buildPromptContext directiveOverride — the toggle rebuilds the LAST
//      round's trailer to STOP CLARIFYING even when the user's last answer
//      clicked "keep clarifying" (the Case-B conflict), for self + cross.
//
// Plus isClarifyAskingNode (the API + canvas display predicate).

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildPromptContext,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '../src/services/clarifyRounds'
import {
  isClarifyAskingNode,
  renderUserPrompt,
  type WorkflowDefinition,
  type ClarifyQuestion,
  type ClarifyAnswer,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const MANDATORY = 'MANDATORY ASK-BACK (clarify) mode'
const STOP_TRAILER = '### User directive: STOP CLARIFYING'
const KEEP_TRAILER = '### User directive: KEEP CLARIFYING'
const OUTPUT_PROTO = 'You MUST end your reply with a'

function renderMinimal(extra: Partial<Parameters<typeof renderUserPrompt>[0]>): string {
  return renderUserPrompt({
    inputs: {},
    meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
    agentOutputs: ['result'],
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// 1. resolveEffectiveClarifyChannel
// ---------------------------------------------------------------------------
describe('RFC-122 resolveEffectiveClarifyChannel', () => {
  test('golden-lock: nodeStopOverride=false reproduces the pre-RFC-122 boolean', () => {
    // The exact expression it replaced:
    //   hasClarifyChannel && contextDirective !== 'stop' && (!reviewActive || isClarifyRerun)
    for (const hasClarifyChannel of [true, false]) {
      for (const contextDirective of ['continue', 'stop', undefined] as const) {
        for (const reviewActive of [true, false]) {
          for (const isClarifyRerun of [true, false]) {
            const expected =
              hasClarifyChannel && contextDirective !== 'stop' && (!reviewActive || isClarifyRerun)
            expect(
              resolveEffectiveClarifyChannel({
                hasClarifyChannel,
                contextDirective,
                nodeStopOverride: false,
                reviewActive,
                isClarifyRerun,
              }),
            ).toBe(expected)
          }
        }
      }
    }
  })

  test('STOP override forces ask-back OFF for self AND cross (hasClarifyChannel covers both)', () => {
    // A self-clarify agent and a cross-questioner are indistinguishable here:
    // both wire the same `__clarify__` source port ⇒ hasClarifyChannel=true.
    for (const contextDirective of ['continue', 'stop', undefined] as const) {
      for (const reviewActive of [true, false]) {
        for (const isClarifyRerun of [true, false]) {
          expect(
            resolveEffectiveClarifyChannel({
              hasClarifyChannel: true,
              contextDirective,
              nodeStopOverride: true,
              reviewActive,
              isClarifyRerun,
            }),
          ).toBe(false)
        }
      }
    }
  })

  test('override is moot on a non-asking node (hasClarifyChannel=false stays false)', () => {
    expect(
      resolveEffectiveClarifyChannel({
        hasClarifyChannel: false,
        nodeStopOverride: true,
        reviewActive: false,
        isClarifyRerun: false,
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. renderUserPrompt — clarifyStopNotice (first-run STOP injection)
// ---------------------------------------------------------------------------
describe('RFC-122 renderUserPrompt clarifyStopNotice', () => {
  test('first-run STOP: injects STOP CLARIFYING + output protocol, no mandatory ask-back', () => {
    const out = renderMinimal({ hasClarifyChannel: false, clarifyStopNotice: true })
    expect(out).toContain(STOP_TRAILER)
    expect(out).toContain(OUTPUT_PROTO)
    expect(out).not.toContain(MANDATORY)
  })

  test('golden-lock: no notice + clarify channel ⇒ mandatory ask-back appended (today)', () => {
    const out = renderMinimal({ hasClarifyChannel: true })
    expect(out).toContain(MANDATORY)
    expect(out).not.toContain(STOP_TRAILER)
  })

  test('golden-lock: a plain output node is byte-identical with clarifyStopNotice omitted vs false', () => {
    const base = renderMinimal({})
    const withFalse = renderMinimal({ clarifyStopNotice: false })
    expect(withFalse).toBe(base)
    expect(base).not.toContain(STOP_TRAILER)
  })

  test('guard: clarifyStopNotice is ignored while ask-back is still active (channel wins)', () => {
    // Defensive — the scheduler never sets both, but the renderer must not double-talk.
    const out = renderMinimal({ hasClarifyChannel: true, clarifyStopNotice: true })
    expect(out).toContain(MANDATORY)
    expect(out).not.toContain(STOP_TRAILER)
  })
})

// ---------------------------------------------------------------------------
// 3. buildPromptContext directiveOverride — Case-B trailer rebuild (DB-backed)
// ---------------------------------------------------------------------------
const Q: ClarifyQuestion = {
  id: 'q1',
  title: 'Which DB?',
  kind: 'single',
  recommended: false,
  options: [
    { label: 'Postgres', description: '', recommended: true, recommendationReason: '' },
    { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
  ],
}
const A: ClarifyAnswer = {
  questionId: 'q1',
  selectedOptionIndices: [0],
  selectedOptionLabels: ['Postgres'],
  customText: '',
}

async function seedAnsweredRound(
  db: DbClient,
  taskId: string,
  kind: 'self' | 'cross',
  askingNodeId: string,
  intermediaryNodeId: string,
): Promise<void> {
  await db.insert(workflows).values({
    id: `wf-${taskId}`,
    name: 'wf',
    definition: '{}',
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    ownerUserId: '__system__',
    workflowId: `wf-${taskId}`,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'b',
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await db
    .insert(nodeRuns)
    .values({ id: `${taskId}-ask`, taskId, nodeId: askingNodeId, status: 'done', iteration: 0 })
  await db.insert(nodeRuns).values({
    id: `${taskId}-int`,
    taskId,
    nodeId: intermediaryNodeId,
    status: 'done',
    iteration: 0,
  })
  await db.insert(clarifyRounds).values({
    id: `${taskId}-r0`,
    taskId,
    kind,
    askingNodeId,
    askingNodeRunId: `${taskId}-ask`,
    intermediaryNodeId,
    intermediaryNodeRunId: `${taskId}-int`,
    iteration: 0,
    questionsJson: JSON.stringify([Q]),
    answersJson: JSON.stringify([A]),
    // The user clicked "keep clarifying" on the last answer — without the
    // override the trailer below is KEEP CLARIFYING.
    directive: 'continue',
    status: 'answered',
  })
}

describe('RFC-122 buildPromptContext directiveOverride (Case-B rebuild)', () => {
  test('self: override="stop" rebuilds the answered round trailer to STOP CLARIFYING', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def: WorkflowDefinition = { $schema_version: 3, inputs: [], nodes: [], edges: [] }
    await seedAnsweredRound(db, 't-self', 'self', 'designer', 'clar')

    const base = await buildPromptContext({
      db,
      definition: def,
      taskId: 't-self',
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
    })
    expect(base?.directive).toBe('continue')
    expect(base?.answersBlock ?? '').toContain(KEEP_TRAILER)
    expect(base?.answersBlock ?? '').not.toContain(STOP_TRAILER)

    const overridden = await buildPromptContext({
      db,
      definition: def,
      taskId: 't-self',
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      directiveOverride: 'stop',
    })
    expect(overridden?.directive).toBe('stop')
    expect(overridden?.answersBlock ?? '').toContain(STOP_TRAILER)
    expect(overridden?.answersBlock ?? '').not.toContain(KEEP_TRAILER)
    // The Q&A synthesis itself is untouched — only the trailer flips.
    expect(overridden?.answersBlock ?? '').toContain('Postgres')
  })

  test('cross-questioner: override="stop" rebuilds the trailer too', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def: WorkflowDefinition = { $schema_version: 3, inputs: [], nodes: [], edges: [] }
    await seedAnsweredRound(db, 't-cross', 'cross', 'questioner', 'cc1')

    const overridden = await buildPromptContext({
      db,
      definition: def,
      taskId: 't-cross',
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
      directiveOverride: 'stop',
    })
    expect(overridden?.directive).toBe('stop')
    expect(overridden?.answersBlock ?? '').toContain(STOP_TRAILER)
  })
})

// ---------------------------------------------------------------------------
// 4. isClarifyAskingNode — API + canvas display predicate
// ---------------------------------------------------------------------------
describe('RFC-122 isClarifyAskingNode', () => {
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'selfAgent', kind: 'agent-single', agentName: 'a' },
      { id: 'clar', kind: 'clarify' },
      { id: 'questioner', kind: 'agent-single', agentName: 'q' },
      { id: 'cc1', kind: 'clarify-cross-agent' },
      { id: 'plain', kind: 'agent-single', agentName: 'p' },
    ] as WorkflowDefinition['nodes'],
    edges: [
      // self-clarify channel
      {
        id: 'e1',
        source: { nodeId: 'selfAgent', portName: '__clarify__' },
        target: { nodeId: 'clar', portName: 'questions' },
      },
      // cross-clarify channel (questioner → cross node)
      {
        id: 'e2',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cc1', portName: 'questions' },
      },
    ],
  }

  test('true for a self-clarify agent and a cross-questioner', () => {
    expect(isClarifyAskingNode(def, 'selfAgent')).toBe(true)
    expect(isClarifyAskingNode(def, 'questioner')).toBe(true)
  })

  test('false for the clarify / cross channel nodes and a plain agent', () => {
    // The toggle must NOT appear on the channel nodes (they are edge targets).
    expect(isClarifyAskingNode(def, 'clar')).toBe(false)
    expect(isClarifyAskingNode(def, 'cc1')).toBe(false)
    expect(isClarifyAskingNode(def, 'plain')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. H2 — STOP CLARIFYING injected EXACTLY ONCE, incl. a review rerun that
//    carries prior clarify Q&A but withheld the trailer (applyLatestDirective=false).
// ---------------------------------------------------------------------------
const countStop = (s: string) => (s.match(/### User directive: STOP CLARIFYING/g) ?? []).length

describe('RFC-122 H2 shouldInjectStopNotice', () => {
  test('truth table', () => {
    // Inject ⟺ override is stop AND the context does not already carry the trailer.
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: undefined })).toBe(
      true,
    )
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: 'continue' })).toBe(
      true,
    )
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: 'stop' })).toBe(false)
    // No override ⇒ never inject (golden-lock — the trailer source is unchanged).
    expect(shouldInjectStopNotice({ nodeStopOverride: false, contextDirective: undefined })).toBe(
      false,
    )
    expect(shouldInjectStopNotice({ nodeStopOverride: false, contextDirective: 'continue' })).toBe(
      false,
    )
  })
})

describe('RFC-122 H2 — STOP CLARIFYING appears exactly once on a review rerun with prior Q&A', () => {
  test('applyLatestDirective=false + override=stop ⇒ trailer via the notice (exactly once)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def: WorkflowDefinition = { $schema_version: 3, inputs: [], nodes: [], edges: [] }
    await seedAnsweredRound(db, 't-rev', 'self', 'designer', 'clar')

    // A review reject/iterate rerun: NOT a clarify-answer rerun, so the scheduler
    // sets applyLatestDirective=false → buildPromptContext withholds the trailer
    // even though directiveOverride='stop'. The context still carries the prior Q&A.
    const ctx = await buildPromptContext({
      db,
      definition: def,
      taskId: 't-rev',
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      applyLatestDirective: false,
      directiveOverride: 'stop',
    })
    expect(ctx).toBeDefined()
    expect(ctx?.directive).not.toBe('stop') // trailer withheld → notice MUST fire
    expect(countStop(ctx?.answersBlock ?? '')).toBe(0)

    const notice = shouldInjectStopNotice({
      nodeStopOverride: true,
      contextDirective: ctx?.directive,
    })
    expect(notice).toBe(true)

    const prompt = renderMinimal({
      hasClarifyChannel: false, // ask-back suppressed by the override
      ...(ctx !== undefined ? { clarifyContext: ctx } : {}),
      clarifyStopNotice: notice,
    })
    expect(prompt).not.toContain(MANDATORY)
    expect(prompt).toContain(OUTPUT_PROTO)
    expect(countStop(prompt)).toBe(1) // EXACTLY once — the H2 regression
  })

  test('applyLatestDirective=true + override=stop ⇒ trailer via answersBlock (no double)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const def: WorkflowDefinition = { $schema_version: 3, inputs: [], nodes: [], edges: [] }
    await seedAnsweredRound(db, 't-clr', 'self', 'designer', 'clar')

    const ctx = await buildPromptContext({
      db,
      definition: def,
      taskId: 't-clr',
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      applyLatestDirective: true,
      directiveOverride: 'stop',
    })
    expect(ctx?.directive).toBe('stop')
    expect(countStop(ctx?.answersBlock ?? '')).toBe(1)

    const notice = shouldInjectStopNotice({
      nodeStopOverride: true,
      contextDirective: ctx?.directive,
    })
    expect(notice).toBe(false) // answersBlock already carries it

    const prompt = renderMinimal({
      hasClarifyChannel: false,
      ...(ctx !== undefined ? { clarifyContext: ctx } : {}),
      clarifyStopNotice: notice,
    })
    expect(countStop(prompt)).toBe(1) // still exactly once — no double inject
  })
})
