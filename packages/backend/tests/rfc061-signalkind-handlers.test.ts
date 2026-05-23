// RFC-061 PR-B — unit tests for the 5 production SignalKindHandlers +
// the await-external-data v1 throw-on-use stub.
//
// Locks every method contract spelled out in design.md §5:
//   onSuspend / validateResolution / applyResolution / autoResolve /
//   effectOnLogicalRun / renderPromptSection
//
// Each handler is tested in isolation against synthetic event log
// contexts; no DB, no opencode subprocess.

import { describe, expect, test } from 'bun:test'

import {
  selfClarifySignalKindHandler,
  type SelfClarifyBody,
  type SelfClarifyResolution,
} from '../src/handlers/signalKind/selfClarify'
import {
  crossClarifySignalKindHandler,
  type CrossClarifyBody,
  type CrossClarifyResolution,
} from '../src/handlers/signalKind/crossClarify'
import {
  reviewSignalKindHandler,
  type ReviewBody,
  type ReviewResolution,
} from '../src/handlers/signalKind/review'
import {
  retryPendingAutoSignalKindHandler,
  type RetryPendingAutoBody,
  type RetryPendingAutoResolution,
} from '../src/handlers/signalKind/retryPendingAuto'
import {
  retryPendingHumanSignalKindHandler,
  type RetryPendingHumanResolution,
} from '../src/handlers/signalKind/retryPendingHuman'
import { awaitExternalDataSignalKindHandler } from '../src/handlers/signalKind/awaitExternalData'
import type { Event, Scope } from '@agent-workflow/shared'

const baseScope: Scope = { nodeId: 'designer', loopIter: 0, shardKey: '', iter: 2 }

function priorTaskEvent(taskId = 't1'): Event<'task-started'> {
  return {
    id: 'evt_seed',
    taskId,
    ts: 1,
    kind: 'task-started',
    nodeId: null,
    loopIter: null,
    shardKey: null,
    iter: null,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload: {},
  }
}

describe('selfClarifySignalKindHandler', () => {
  test('onSuspend → [suspension-created]', async () => {
    const body: SelfClarifyBody = {
      questions: [{ id: 'q1', text: 'what is X?' }],
    }
    const events = await selfClarifySignalKindHandler.onSuspend(
      { scope: baseScope, events: [priorTaskEvent()] },
      body,
    )
    expect(events).toHaveLength(1)
    const e0 = events[0]!
    expect(e0.kind).toBe('suspension-created')
    if (e0.kind === 'suspension-created') {
      expect(e0.payload.signalKind).toBe('self-clarify')
      expect(e0.payload.awaitsActor).toBe('user:')
      const b = e0.payload.body as SelfClarifyBody
      expect(b.questions[0]!.text).toBe('what is X?')
    }
  })

  test('validateResolution: well-formed', () => {
    const r = selfClarifySignalKindHandler.validateResolution({
      answers: [{ questionId: 'q1', text: 'X is foo' }],
    })
    expect(r.valid).toBe(true)
  })

  test('validateResolution: missing answers', () => {
    expect(selfClarifySignalKindHandler.validateResolution({}).valid).toBe(false)
    expect(selfClarifySignalKindHandler.validateResolution(null).valid).toBe(false)
    expect(
      selfClarifySignalKindHandler.validateResolution({
        answers: [{ questionId: 'q1' }],
      }).valid,
    ).toBe(false)
  })

  test('applyResolution: emits suspension-resolved + logical-run-iter-bumped', async () => {
    const resolution: SelfClarifyResolution = {
      answers: [{ questionId: 'q1', text: 'A' }],
    }
    const events = await selfClarifySignalKindHandler.applyResolution(
      {
        scope: baseScope,
        suspensionId: 'sus_x',
        events: [priorTaskEvent()],
      },
      resolution,
    )
    expect(events).toHaveLength(2)
    const e0 = events[0]!
    const e1 = events[1]!
    expect(e0.kind).toBe('suspension-resolved')
    expect(e1.kind).toBe('logical-run-iter-bumped')
    if (e1.kind === 'logical-run-iter-bumped') {
      expect(e1.iter).toBe(baseScope.iter + 1)
      expect(e1.payload.triggerEventId).toBe(e0.id)
    }
  })

  test('effectOnLogicalRun: bump-iter', () => {
    expect(selfClarifySignalKindHandler.effectOnLogicalRun()).toBe('bump-iter')
  })

  test('renderPromptSection: groups Q+A with markup', () => {
    const resolutions: Event<'suspension-resolved'>[] = [
      {
        id: 'r1',
        taskId: 't',
        ts: 1,
        kind: 'suspension-resolved',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 1,
        attemptId: null,
        parentEventId: null,
        actor: 'user:',
        resolutionId: 'res_a',
        payload: {
          suspensionId: 'sus_x',
          signalKind: 'self-clarify',
          decision: { answers: [{ questionId: 'q1', text: 'aye' }] },
        },
      },
    ]
    const out = selfClarifySignalKindHandler.renderPromptSection(resolutions)
    expect(out).toContain('<workflow-self-clarify>')
    expect(out).toContain('Q[q1]:')
    expect(out).toContain('A: aye')
  })
})

describe('crossClarifySignalKindHandler', () => {
  test('onSuspend produces suspension-created', async () => {
    const body: CrossClarifyBody = {
      questionerNodeId: 'q',
      designerNodeId: 'd',
      questions: [{ id: 'q1', text: 'should X?' }],
    }
    const events = await crossClarifySignalKindHandler.onSuspend(
      { scope: baseScope, events: [priorTaskEvent()] },
      body,
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('suspension-created')
  })

  test('validateResolution: all 3 directives', () => {
    expect(crossClarifySignalKindHandler.validateResolution({ directive: 'stop' }).valid).toBe(true)
    expect(
      crossClarifySignalKindHandler.validateResolution({
        directive: 'submit',
        answers: [{ questionId: 'q1', text: 'ok' }],
      }).valid,
    ).toBe(true)
    expect(
      crossClarifySignalKindHandler.validateResolution({
        directive: 'reject',
        answers: [],
        rejectionFeedback: 'nope',
      }).valid,
    ).toBe(true)
  })

  test('validateResolution: rejects unknown directive', () => {
    expect(crossClarifySignalKindHandler.validateResolution({ directive: 'maybe' }).valid).toBe(
      false,
    )
  })

  test('validateResolution: submit/reject need answers + reject needs feedback', () => {
    expect(crossClarifySignalKindHandler.validateResolution({ directive: 'submit' }).valid).toBe(
      false,
    )
    expect(
      crossClarifySignalKindHandler.validateResolution({
        directive: 'reject',
        answers: [],
      }).valid,
    ).toBe(false)
  })

  test('applyResolution: stop emits only suspension-resolved (persistent stop)', async () => {
    const events = await crossClarifySignalKindHandler.applyResolution(
      {
        scope: baseScope,
        suspensionId: 'sus_x',
        events: [priorTaskEvent()],
      },
      { directive: 'stop' } as CrossClarifyResolution,
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('suspension-resolved')
  })

  test('applyResolution: reject bumps questioner', async () => {
    const events = await crossClarifySignalKindHandler.applyResolution(
      {
        scope: baseScope,
        suspensionId: 'sus_x',
        events: [priorTaskEvent()],
      } as never,
      {
        directive: 'reject',
        answers: [{ questionId: 'q1', text: 'a' }],
        rejectionFeedback: 'no',
      } as CrossClarifyResolution,
    )
    expect(events.length).toBe(2)
    const e1 = events[1]!
    expect(e1.kind).toBe('logical-run-iter-bumped')
    if (e1.kind === 'logical-run-iter-bumped') {
      expect(e1.nodeId).toBe(baseScope.nodeId)
    }
  })

  test('applyResolution: submit bumps designer + cascades (extras-driven)', async () => {
    const body: CrossClarifyBody = {
      questionerNodeId: 'questioner',
      designerNodeId: 'designer',
      questions: [{ id: 'q1', text: 'q' }],
    }
    const susCreated: Event<'suspension-created'> = {
      id: 'sus_evt',
      taskId: 't',
      ts: 0,
      kind: 'suspension-created',
      nodeId: 'questioner',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId: null,
      parentEventId: null,
      actor: 'system',
      resolutionId: null,
      payload: {
        suspensionId: 'sus_x',
        signalKind: 'cross-clarify',
        awaitsActor: 'user:',
        body,
      },
    }
    const ctx = {
      scope: { ...baseScope, nodeId: 'questioner' },
      suspensionId: 'sus_x',
      events: [priorTaskEvent('t'), susCreated],
      readDesignerScope: async (_n: string, _s: Scope): Promise<Scope> => ({
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      }),
      cascadeQuestioners: async (): Promise<ReadonlyArray<Scope>> => [
        { nodeId: 'questioner2', loopIter: 0, shardKey: '', iter: 0 },
      ],
    }
    const events = await crossClarifySignalKindHandler.applyResolution(
      ctx as never,
      {
        directive: 'submit',
        answers: [{ questionId: 'q1', text: 'yes' }],
      } as CrossClarifyResolution,
    )
    expect(events.length).toBe(3) // resolved + designer-bump + cascade1-bump
    const bumps = events.filter((e) => e.kind === 'logical-run-iter-bumped')
    expect(bumps.map((b) => b.nodeId).sort()).toEqual(['designer', 'questioner2'])
  })

  test('effectOnLogicalRun: bump-iter', () => {
    expect(crossClarifySignalKindHandler.effectOnLogicalRun()).toBe('bump-iter')
  })

  test('renderPromptSection includes directive + persistent-stop marker', () => {
    const stopRes: Event<'suspension-resolved'> = {
      id: 'r',
      taskId: 't',
      ts: 1,
      kind: 'suspension-resolved',
      nodeId: 'questioner',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId: null,
      parentEventId: null,
      actor: 'user:',
      resolutionId: 'r1',
      payload: {
        suspensionId: 'sus_x',
        signalKind: 'cross-clarify',
        decision: { directive: 'stop' },
      },
    }
    const out = crossClarifySignalKindHandler.renderPromptSection([stopRes])
    expect(out).toContain('persistent-stop')
  })
})

describe('reviewSignalKindHandler', () => {
  test('validateResolution: approve OK without comments; iterate/reject require comments', () => {
    expect(reviewSignalKindHandler.validateResolution({ decision: 'approve' }).valid).toBe(true)
    expect(reviewSignalKindHandler.validateResolution({ decision: 'iterate' }).valid).toBe(false)
    expect(
      reviewSignalKindHandler.validateResolution({
        decision: 'iterate',
        comments: [{ comment: 'fix this' }],
      }).valid,
    ).toBe(true)
  })

  test('applyResolution: approve → suspension-resolved + logical-run-completed', async () => {
    const events = await reviewSignalKindHandler.applyResolution(
      {
        scope: baseScope,
        suspensionId: 'sus_x',
        events: [priorTaskEvent()],
      },
      { decision: 'approve' } as ReviewResolution,
    )
    expect(events.length).toBe(2)
    expect(events[0]!.kind).toBe('suspension-resolved')
    expect(events[1]!.kind).toBe('logical-run-completed')
  })

  test('applyResolution: reject → suspension-resolved + logical-run-canceled', async () => {
    const events = await reviewSignalKindHandler.applyResolution(
      {
        scope: baseScope,
        suspensionId: 'sus_x',
        events: [priorTaskEvent()],
      },
      {
        decision: 'reject',
        comments: [{ comment: 'no' }],
      } as ReviewResolution,
    )
    expect(events.length).toBe(2)
    expect(events[1]!.kind).toBe('logical-run-canceled')
  })

  test('applyResolution: iterate → bumps designer scope', async () => {
    const body: ReviewBody = { docNodeId: 'designer', docPortName: 'draft', docContent: 'x' }
    const susCreated: Event<'suspension-created'> = {
      id: 'sus_evt',
      taskId: 't',
      ts: 0,
      kind: 'suspension-created',
      nodeId: 'rv',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId: null,
      parentEventId: null,
      actor: 'system',
      resolutionId: null,
      payload: { suspensionId: 'sus_x', signalKind: 'review', awaitsActor: 'user:', body },
    }
    const ctx = {
      scope: { ...baseScope, nodeId: 'rv' },
      suspensionId: 'sus_x',
      events: [priorTaskEvent('t'), susCreated],
      readDesignerScope: async (): Promise<Scope> => ({
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      }),
    }
    const events = await reviewSignalKindHandler.applyResolution(
      ctx as never,
      {
        decision: 'iterate',
        comments: [{ comment: 'tighten' }],
      } as ReviewResolution,
    )
    const bump = events.find((e) => e.kind === 'logical-run-iter-bumped')
    expect(bump).toBeDefined()
    if (bump && bump.kind === 'logical-run-iter-bumped') {
      expect(bump.nodeId).toBe('designer')
    }
  })

  test('effectOnLogicalRun: depends-on-payload', () => {
    expect(reviewSignalKindHandler.effectOnLogicalRun()).toBe('depends-on-payload')
  })

  test('renderPromptSection: approve omitted, iterate/reject shown', () => {
    const approve: Event<'suspension-resolved'> = {
      id: 'r1',
      taskId: 't',
      ts: 1,
      kind: 'suspension-resolved',
      nodeId: 'rv',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId: null,
      parentEventId: null,
      actor: 'user:',
      resolutionId: 'r1',
      payload: { suspensionId: 'sus_x', signalKind: 'review', decision: { decision: 'approve' } },
    }
    const iterate: Event<'suspension-resolved'> = {
      ...approve,
      id: 'r2',
      resolutionId: 'r2',
      payload: {
        suspensionId: 'sus_x',
        signalKind: 'review',
        decision: {
          decision: 'iterate',
          summary: 'tighten',
          comments: [{ filePath: 'a.ts', comment: 'reword' }],
        },
      },
    }
    const out = reviewSignalKindHandler.renderPromptSection([approve, iterate])
    expect(out).toContain('summary: tighten')
    expect(out).toContain('file: a.ts')
    expect(out).toContain('reword')
  })
})

describe('retryPendingAutoSignalKindHandler', () => {
  test('autoResolve: budget > 0 returns resolution', async () => {
    const body: RetryPendingAutoBody = {
      outcome: 'envelope-fail',
      lastAttemptId: 'a1',
      reason: 'no envelope',
      remainingBudget: 2,
    }
    const r = await retryPendingAutoSignalKindHandler.autoResolve!({
      id: 'sus_x',
      signalKind: 'retry-pending-auto',
      scope: baseScope,
      body,
      createdAt: 1,
    })
    expect(r).not.toBeNull()
    const decision = r as RetryPendingAutoResolution
    expect(decision.followupAction).toBe('keep-session') // envelope-fail policy
  })

  test('autoResolve: budget = 0 returns null', async () => {
    const body: RetryPendingAutoBody = {
      outcome: 'crash',
      lastAttemptId: 'a1',
      reason: 'oom',
      remainingBudget: 0,
    }
    const r = await retryPendingAutoSignalKindHandler.autoResolve!({
      id: 'sus_x',
      signalKind: 'retry-pending-auto',
      scope: baseScope,
      body,
      createdAt: 1,
    })
    expect(r).toBeNull()
  })

  test('autoResolve: crash defaults to isolate session', async () => {
    const body: RetryPendingAutoBody = {
      outcome: 'crash',
      lastAttemptId: 'a1',
      reason: 'oom',
      remainingBudget: 3,
    }
    const r = (await retryPendingAutoSignalKindHandler.autoResolve!({
      id: 'sus_x',
      signalKind: 'retry-pending-auto',
      scope: baseScope,
      body,
      createdAt: 1,
    })) as RetryPendingAutoResolution
    expect(r.followupAction).toBe('isolate')
  })

  test('applyResolution: emits resolved + iter-bumped', async () => {
    const events = await retryPendingAutoSignalKindHandler.applyResolution(
      { scope: baseScope, suspensionId: 'sus_x', events: [priorTaskEvent()] },
      { followupAction: 'isolate' } as RetryPendingAutoResolution,
    )
    expect(events).toHaveLength(2)
    expect(events[1]!.kind).toBe('logical-run-iter-bumped')
  })

  test('renderPromptSection always empty (control signal)', () => {
    expect(retryPendingAutoSignalKindHandler.renderPromptSection([])).toBe('')
  })
})

describe('retryPendingHumanSignalKindHandler', () => {
  test('validateResolution: 3 decisions accepted', () => {
    expect(retryPendingHumanSignalKindHandler.validateResolution({ decision: 'retry' }).valid).toBe(
      true,
    )
    expect(
      retryPendingHumanSignalKindHandler.validateResolution({ decision: 'give-up' }).valid,
    ).toBe(true)
    expect(
      retryPendingHumanSignalKindHandler.validateResolution({ decision: 'escalate' }).valid,
    ).toBe(true)
  })

  test('applyResolution: give-up → resolved + canceled', async () => {
    const events = await retryPendingHumanSignalKindHandler.applyResolution(
      { scope: baseScope, suspensionId: 'sus_x', events: [priorTaskEvent()] },
      { decision: 'give-up' } as RetryPendingHumanResolution,
    )
    expect(events.length).toBe(2)
    expect(events[1]!.kind).toBe('logical-run-canceled')
  })

  test('applyResolution: escalate → resolved only', async () => {
    const events = await retryPendingHumanSignalKindHandler.applyResolution(
      { scope: baseScope, suspensionId: 'sus_x', events: [priorTaskEvent()] },
      { decision: 'escalate' } as RetryPendingHumanResolution,
    )
    expect(events.length).toBe(1)
  })

  test('applyResolution: retry → resolved + iter-bumped', async () => {
    const events = await retryPendingHumanSignalKindHandler.applyResolution(
      { scope: baseScope, suspensionId: 'sus_x', events: [priorTaskEvent()] },
      { decision: 'retry' } as RetryPendingHumanResolution,
    )
    expect(events.length).toBe(2)
    expect(events[1]!.kind).toBe('logical-run-iter-bumped')
  })

  test('effectOnLogicalRun: depends-on-payload', () => {
    expect(retryPendingHumanSignalKindHandler.effectOnLogicalRun()).toBe('depends-on-payload')
  })

  test('renderPromptSection always empty', () => {
    expect(retryPendingHumanSignalKindHandler.renderPromptSection([])).toBe('')
  })
})

describe('awaitExternalDataSignalKindHandler (v1 stub)', () => {
  test('onSuspend throws explaining reservation', async () => {
    await expect(
      awaitExternalDataSignalKindHandler.onSuspend(
        { scope: baseScope, events: [priorTaskEvent()] },
        {},
      ),
    ).rejects.toThrow('reserved for a future RFC')
  })

  test('validateResolution: always invalid (not implemented)', () => {
    expect(awaitExternalDataSignalKindHandler.validateResolution({}).valid).toBe(false)
  })

  test('applyResolution throws', async () => {
    await expect(
      awaitExternalDataSignalKindHandler.applyResolution(
        { scope: baseScope, suspensionId: 'sus_x', events: [priorTaskEvent()] },
        {},
      ),
    ).rejects.toThrow('reserved for a future RFC')
  })

  test('renderPromptSection returns empty string', () => {
    expect(awaitExternalDataSignalKindHandler.renderPromptSection([])).toBe('')
  })
})
