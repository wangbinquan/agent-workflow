// Locks in RFC-005 PR-A T1 shared-schema contract. If this goes red, check
// packages/shared/src/schemas/{review,workflow,agent,task,ws,config}.ts in
// lock-step — they evolve together (NODE_KIND ⇄ ReviewNodeSchema ⇄ status
// enums ⇄ ws events).

import { describe, expect, test } from 'bun:test'
import {
  AGENT_OUTPUT_KIND,
  AgentOutputKindSchema,
  AgentOutputKindsMapSchema,
  AgentSchema,
  ConfigSchema,
  CreateAgentSchema,
  DEFAULT_CONFIG,
  DocVersionSchema,
  ListReviewsQuerySchema,
  NODE_KIND,
  NODE_RUN_STATUS,
  NodeRunSchema,
  ReviewCommentSchema,
  ReviewNodeSchema,
  SubmitReviewCommentSchema,
  SubmitReviewDecisionSchema,
  TASK_STATUS,
  TaskWsMessageSchema,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_SCHEMA_VERSIONS,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'

describe('RFC-005 NODE_KIND + WORKFLOW_SCHEMA_VERSION', () => {
  test('NODE_KIND contains review', () => {
    expect(NODE_KIND).toContain('review')
  })

  test('original six kinds still present', () => {
    const expected = [
      'agent-single',
      'agent-multi',
      'input',
      'output',
      'wrapper-git',
      'wrapper-loop',
    ] as const
    for (const k of expected) {
      expect(NODE_KIND).toContain(k)
    }
  })

  // Note: when this test was written (RFC-005), WORKFLOW_SCHEMA_VERSION was
  // bumped from 1 → 2 for the addition of the 'review' node. RFC-023 has
  // since bumped it to 3 for the 'clarify' node. The assertion here loosens
  // to "≥ 2" so the RFC-005 schema invariants stay locked without the test
  // breaking on every future bump.
  test('WORKFLOW_SCHEMA_VERSION at or above 2 (RFC-005 floor)', () => {
    expect(WORKFLOW_SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
  })

  test('WORKFLOW_SCHEMA_VERSIONS includes 1 and 2 (backward read after RFC-005)', () => {
    expect([...WORKFLOW_SCHEMA_VERSIONS]).toContain(1)
    expect([...WORKFLOW_SCHEMA_VERSIONS]).toContain(2)
  })

  test('WorkflowDefinitionSchema accepts $schema_version=1', () => {
    const out = WorkflowDefinitionSchema.parse({
      $schema_version: 1,
      inputs: [],
      nodes: [],
      edges: [],
    })
    expect(out.$schema_version).toBe(1)
  })

  test('WorkflowDefinitionSchema accepts $schema_version=2', () => {
    const out = WorkflowDefinitionSchema.parse({
      $schema_version: 2,
      inputs: [],
      nodes: [],
      edges: [],
    })
    expect(out.$schema_version).toBe(2)
  })

  test('WorkflowDefinitionSchema rejects far-future $schema_version=99', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({ $schema_version: 99, inputs: [], nodes: [], edges: [] }),
    ).toThrow()
  })

  test('review node passes through WorkflowNodeSchema (permissive root)', () => {
    const def = WorkflowDefinitionSchema.parse({
      $schema_version: 2,
      inputs: [],
      nodes: [
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          title: 'Design Review',
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer'],
        },
      ],
      edges: [],
    })
    expect(def.nodes[0]!.kind).toBe('review')
  })
})

describe('RFC-005 ReviewNodeSchema strict', () => {
  const valid = {
    id: 'rev_1',
    kind: 'review' as const,
    inputSource: { nodeId: 'designer', portName: 'design' },
    title: 'Design Review',
    description: 'Review the design doc',
    rerunnableOnReject: ['designer'],
    rerunnableOnIterate: ['designer'],
  }

  test('parses canonical shape', () => {
    const out = ReviewNodeSchema.parse(valid)
    expect(out.id).toBe('rev_1')
    expect(out.rollbackFilesOnReject).toBe(true) // default
    expect(out.rollbackFilesOnIterate).toBe(false) // default
  })

  test('rejects when inputSource missing', () => {
    const { inputSource: _drop, ...rest } = valid
    expect(() => ReviewNodeSchema.parse(rest)).toThrow()
  })

  test('rejects when kind != review', () => {
    expect(() => ReviewNodeSchema.parse({ ...valid, kind: 'agent-single' })).toThrow()
  })

  test('defaults rerunnable arrays to empty when omitted', () => {
    const { rerunnableOnReject: _r1, rerunnableOnIterate: _r2, ...rest } = valid
    const out = ReviewNodeSchema.parse(rest)
    expect(out.rerunnableOnReject).toEqual([])
    expect(out.rerunnableOnIterate).toEqual([])
  })

  test('passes through unknown fields (forward-compat for future props)', () => {
    const out = ReviewNodeSchema.parse({ ...valid, _futureProp: 'whatever' })
    expect((out as Record<string, unknown>)._futureProp).toBe('whatever')
  })
})

describe('RFC-005 AgentOutputKind + outputKinds sidecar', () => {
  test('AgentOutputKindSchema accepts each defined kind', () => {
    for (const k of AGENT_OUTPUT_KIND) {
      expect(AgentOutputKindSchema.parse(k)).toBe(k)
    }
  })

  test('AgentOutputKindSchema rejects unknown kinds', () => {
    expect(() => AgentOutputKindSchema.parse('html')).toThrow()
  })

  test('AgentOutputKindsMapSchema accepts record of port → kind', () => {
    const m = AgentOutputKindsMapSchema.parse({
      design: 'markdown',
      plan: 'markdown_file',
      other: 'string',
    })
    expect(m.design).toBe('markdown')
  })

  test('Agent.outputs stays string[] (legacy callers unchanged)', () => {
    const agent = AgentSchema.parse({
      id: '01H',
      name: 'designer',
      description: '',
      outputs: ['design', 'plan'],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    expect(agent.outputs).toEqual(['design', 'plan'])
    expect(agent.outputKinds).toBeUndefined()
  })

  test('Agent accepts optional outputKinds sidecar', () => {
    const agent = AgentSchema.parse({
      id: '01H',
      name: 'designer',
      description: '',
      outputs: ['design', 'plan'],
      outputKinds: { design: 'markdown' },
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    expect(agent.outputKinds?.design).toBe('markdown')
  })

  test('CreateAgent also accepts outputKinds', () => {
    const c = CreateAgentSchema.parse({
      name: 'designer',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
    })
    expect(c.outputKinds?.design).toBe('markdown')
  })
})

describe('RFC-005 status enums', () => {
  test('TASK_STATUS contains awaiting_review', () => {
    expect(TASK_STATUS).toContain('awaiting_review')
  })

  test('NODE_RUN_STATUS contains awaiting_review', () => {
    expect(NODE_RUN_STATUS).toContain('awaiting_review')
  })

  test('NodeRun.reviewIteration defaults to 0 when omitted', () => {
    const nr = NodeRunSchema.parse({
      id: 'nr_1',
      taskId: 't_1',
      nodeId: 'designer',
      parentNodeRunId: null,
      iteration: 0,
      shardKey: null,
      retryIndex: 0,
      status: 'done',
      startedAt: null,
      finishedAt: null,
      pid: null,
      exitCode: null,
      errorMessage: null,
      promptText: null,
      tokInput: null,
      tokOutput: null,
      tokTotal: null,
      tokCacheCreate: null,
      tokCacheRead: null,
    })
    expect(nr.reviewIteration).toBe(0)
  })

  test('NodeRun accepts reviewIteration > 0', () => {
    const nr = NodeRunSchema.parse({
      id: 'nr_1',
      taskId: 't_1',
      nodeId: 'rev_1',
      parentNodeRunId: null,
      iteration: 0,
      shardKey: null,
      retryIndex: 0,
      reviewIteration: 3,
      status: 'awaiting_review',
      startedAt: null,
      finishedAt: null,
      pid: null,
      exitCode: null,
      errorMessage: null,
      promptText: null,
      tokInput: null,
      tokOutput: null,
      tokTotal: null,
      tokCacheCreate: null,
      tokCacheRead: null,
    })
    expect(nr.reviewIteration).toBe(3)
  })
})

describe('RFC-005 review.ts resource schemas', () => {
  test('DocVersionSchema parses canonical shape', () => {
    const v = DocVersionSchema.parse({
      id: 'dv_1',
      taskId: 't_1',
      reviewNodeId: 'rev_1',
      reviewNodeRunId: 'nr_rev_1',
      sourceNodeId: 'designer',
      sourcePortName: 'design',
      versionIndex: 2,
      reviewIteration: 1,
      bodyPath: 'runs/t_1/review/rev_1/design/v2.md',
      commentsJson: '[]',
      decision: 'pending',
      decisionReason: null,
      promptSnapshot: null,
      agentSnapshot: null,
      createdAt: 0,
      decidedAt: null,
      decidedBy: null,
    })
    expect(v.versionIndex).toBe(2)
  })

  test('DocVersion rejects versionIndex=0 (1-based contract)', () => {
    expect(() =>
      DocVersionSchema.parse({
        id: 'dv_1',
        taskId: 't_1',
        reviewNodeId: 'rev_1',
        reviewNodeRunId: 'nr_rev_1',
        sourceNodeId: 'designer',
        sourcePortName: 'design',
        versionIndex: 0,
        reviewIteration: 0,
        bodyPath: 'x',
        commentsJson: '[]',
        decision: 'pending',
        decisionReason: null,
        promptSnapshot: null,
        agentSnapshot: null,
        createdAt: 0,
        decidedAt: null,
        decidedBy: null,
      }),
    ).toThrow()
  })

  test('ReviewCommentSchema requires non-empty selectedText + commentText', () => {
    const valid = {
      id: 'c_1',
      docVersionId: 'dv_1',
      anchor: {
        sectionPath: '## Foo',
        paragraphIdx: 0,
        offsetStart: 10,
        offsetEnd: 20,
        selectedText: 'hello',
        contextBefore: '...before...',
        contextAfter: '...after...',
        occurrenceIndex: 1,
      },
      commentText: 'looks wrong',
      author: 'local',
      createdAt: 0,
    }
    expect(ReviewCommentSchema.parse(valid).commentText).toBe('looks wrong')

    expect(() => ReviewCommentSchema.parse({ ...valid, commentText: '' })).toThrow()
    expect(() =>
      ReviewCommentSchema.parse({ ...valid, anchor: { ...valid.anchor, selectedText: '' } }),
    ).toThrow()
  })

  test('ReviewCommentSchema requires occurrenceIndex >= 1 (anchor invariant)', () => {
    const a = {
      sectionPath: '## Foo',
      paragraphIdx: 0,
      offsetStart: 0,
      offsetEnd: 1,
      selectedText: 'x',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 0,
    }
    expect(() =>
      ReviewCommentSchema.parse({
        id: 'c',
        docVersionId: 'dv',
        anchor: a,
        commentText: 'c',
        author: 'local',
        createdAt: 0,
      }),
    ).toThrow()
  })
})

describe('RFC-005 SubmitReviewDecisionSchema (rejectReason invariant)', () => {
  test('approve without reason is valid', () => {
    const d = SubmitReviewDecisionSchema.parse({ decision: 'approved', reviewIteration: 0 })
    expect(d.decision).toBe('approved')
  })

  test('iterate without reason is valid', () => {
    const d = SubmitReviewDecisionSchema.parse({ decision: 'iterated', reviewIteration: 1 })
    expect(d.decision).toBe('iterated')
  })

  test('reject without rejectReason throws', () => {
    expect(() =>
      SubmitReviewDecisionSchema.parse({ decision: 'rejected', reviewIteration: 0 }),
    ).toThrow()
  })

  test('reject with whitespace-only rejectReason throws', () => {
    expect(() =>
      SubmitReviewDecisionSchema.parse({
        decision: 'rejected',
        reviewIteration: 0,
        rejectReason: '   ',
      }),
    ).toThrow()
  })

  test('reject with non-empty rejectReason is valid', () => {
    const d = SubmitReviewDecisionSchema.parse({
      decision: 'rejected',
      reviewIteration: 0,
      rejectReason: 'wrong direction',
    })
    expect(d.rejectReason).toBe('wrong direction')
  })
})

describe('RFC-005 SubmitReviewCommentSchema', () => {
  test('parses canonical anchor + comment', () => {
    const c = SubmitReviewCommentSchema.parse({
      anchor: {
        sectionPath: '## Foo',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 5,
        selectedText: 'hello',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      },
      commentText: 'needs work',
    })
    expect(c.commentText).toBe('needs work')
  })

  test('empty commentText rejected', () => {
    expect(() =>
      SubmitReviewCommentSchema.parse({
        anchor: {
          sectionPath: '',
          paragraphIdx: 0,
          offsetStart: 0,
          offsetEnd: 1,
          selectedText: 'x',
          contextBefore: '',
          contextAfter: '',
          occurrenceIndex: 1,
        },
        commentText: '',
      }),
    ).toThrow()
  })
})

describe('RFC-005 ListReviewsQuerySchema defaults', () => {
  test('status defaults to pending', () => {
    const q = ListReviewsQuerySchema.parse({})
    expect(q.status).toBe('pending')
    expect(q.limit).toBe(100)
  })

  test('rejects invalid status', () => {
    expect(() => ListReviewsQuerySchema.parse({ status: 'whatever' })).toThrow()
  })
})

describe('RFC-005 TaskWsMessage discriminated union extension', () => {
  test('review.created event parses', () => {
    const m = TaskWsMessageSchema.parse({
      id: 1,
      type: 'review.created',
      nodeRunId: 'nr_1',
      reviewNodeId: 'rev_1',
      docVersionId: 'dv_1',
      versionIndex: 1,
      reviewIteration: 0,
    })
    expect(m.type).toBe('review.created')
  })

  test('review.decision_made event parses', () => {
    const m = TaskWsMessageSchema.parse({
      id: 2,
      type: 'review.decision_made',
      nodeRunId: 'nr_1',
      decision: 'approved',
      reviewIteration: 1,
      docVersionDecision: 'approved',
    })
    expect(m.type).toBe('review.decision_made')
  })

  test('review.comment_added carries full comment', () => {
    const m = TaskWsMessageSchema.parse({
      id: 3,
      type: 'review.comment_added',
      nodeRunId: 'nr_1',
      docVersionId: 'dv_1',
      comment: {
        id: 'c_1',
        docVersionId: 'dv_1',
        anchor: {
          sectionPath: '## X',
          paragraphIdx: 0,
          offsetStart: 0,
          offsetEnd: 1,
          selectedText: 'y',
          contextBefore: '',
          contextAfter: '',
          occurrenceIndex: 1,
        },
        commentText: 'comment',
        author: 'local',
        createdAt: 0,
      },
    })
    expect(m.type).toBe('review.comment_added')
  })

  test('review.comment_deleted parses', () => {
    const m = TaskWsMessageSchema.parse({
      id: 4,
      type: 'review.comment_deleted',
      nodeRunId: 'nr_1',
      docVersionId: 'dv_1',
      commentId: 'c_1',
    })
    expect(m.type).toBe('review.comment_deleted')
  })

  test('existing task.status event still parses (no regression)', () => {
    const m = TaskWsMessageSchema.parse({
      id: 5,
      type: 'task.status',
      status: 'awaiting_review',
    })
    expect(m.type).toBe('task.status')
  })
})

describe('RFC-005 ConfigSchema plantuml fields', () => {
  test('DEFAULT_CONFIG omits plantuml fields (both undefined)', () => {
    expect(DEFAULT_CONFIG.plantumlEndpoint).toBeUndefined()
    expect(DEFAULT_CONFIG.plantumlAuthHeader).toBeUndefined()
  })

  test('accepts custom plantuml endpoint + auth header', () => {
    const cfg = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      plantumlEndpoint: 'https://kroki.io',
      plantumlAuthHeader: 'Bearer xxx',
    })
    expect(cfg.plantumlEndpoint).toBe('https://kroki.io')
    expect(cfg.plantumlAuthHeader).toBe('Bearer xxx')
  })

  test('round-trips config without plantuml fields (forward-compat)', () => {
    const cfg = ConfigSchema.parse(DEFAULT_CONFIG)
    expect(cfg.plantumlEndpoint).toBeUndefined()
  })
})
