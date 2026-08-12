// RFC-056 — shared layer: ClarifyCrossAgentNode schema + NodeKind union +
// NODE_KIND_BEHAVIORS row + $schema_version bump.
//
// LOCKS: cross-clarify-agent shape is additive on top of RFC-023. If any of
// these go red the surface contracts the runner / validator / canvas all
// depend on have drifted — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  ClarifyCrossAgentNodeSchema,
  ClarifyCrossAgentSessionModeSchema,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  NODE_KIND,
  NODE_KIND_BEHAVIORS,
  NodeKindSchema,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_SCHEMA_VERSIONS,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'

describe('RFC-056 NodeKind union + $schema_version bump', () => {
  test("NODE_KIND contains 'clarify-cross-agent'", () => {
    expect(NODE_KIND).toContain('clarify-cross-agent')
    expect(NodeKindSchema.safeParse('clarify-cross-agent').success).toBe(true)
  })

  test('RFC-292 keeps v4 readable while v5 is the latest schema', () => {
    expect(WORKFLOW_SCHEMA_VERSION).toBe(5)
    expect(WORKFLOW_SCHEMA_VERSIONS).toEqual([1, 2, 3, 4, 5])
  })

  test('WorkflowDefinitionSchema accepts $schema_version = 4', () => {
    const res = WorkflowDefinitionSchema.safeParse({
      $schema_version: 4,
      inputs: [],
      nodes: [],
      edges: [],
    })
    expect(res.success).toBe(true)
  })

  test('WorkflowDefinitionSchema still accepts $schema_version = 3 (v3 docs upgrade transparently)', () => {
    const res = WorkflowDefinitionSchema.safeParse({
      $schema_version: 3,
      inputs: [],
      nodes: [],
      edges: [],
    })
    expect(res.success).toBe(true)
  })

  test('WorkflowDefinitionSchema rejects $schema_version = 6 (unknown future version)', () => {
    const res = WorkflowDefinitionSchema.safeParse({
      $schema_version: 6,
      inputs: [],
      nodes: [],
      edges: [],
    })
    expect(res.success).toBe(false)
  })
})

describe('RFC-056 cross-clarify port name constants', () => {
  test('hard-coded port name constants', () => {
    expect(CROSS_CLARIFY_INPUT_PORT_NAME).toBe('questions')
    expect(CROSS_CLARIFY_OUT_TO_DESIGNER_PORT).toBe('to_designer')
    expect(CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT).toBe('to_questioner')
    expect(CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT).toBe('__external_feedback__')
  })
})

describe('RFC-056 ClarifyCrossAgentNodeSchema parsing', () => {
  test('minimal happy node parses with defaults', () => {
    const parsed = ClarifyCrossAgentNodeSchema.parse({
      id: 'cc1',
      kind: 'clarify-cross-agent',
    })
    expect(parsed.id).toBe('cc1')
    expect(parsed.kind).toBe('clarify-cross-agent')
    expect(parsed.title).toBe('')
    expect(parsed.description).toBe('')
    expect(parsed.sessionModeForQuestioner).toBeUndefined()
  })

  test('explicit questioner session mode round-trips', () => {
    const parsed = ClarifyCrossAgentNodeSchema.parse({
      id: 'cc1',
      kind: 'clarify-cross-agent',
      title: 'Cross feedback',
      sessionModeForQuestioner: 'inline',
    })
    expect(parsed.sessionModeForQuestioner).toBe('inline')
  })

  test('rejects kind mismatch', () => {
    const res = ClarifyCrossAgentNodeSchema.safeParse({
      id: 'cc1',
      kind: 'clarify',
    })
    expect(res.success).toBe(false)
  })

  test('ClarifyCrossAgentSessionModeSchema only accepts isolated | inline', () => {
    expect(ClarifyCrossAgentSessionModeSchema.safeParse('isolated').success).toBe(true)
    expect(ClarifyCrossAgentSessionModeSchema.safeParse('inline').success).toBe(true)
    expect(ClarifyCrossAgentSessionModeSchema.safeParse('hybrid').success).toBe(false)
  })
})

describe("RFC-056 NODE_KIND_BEHAVIORS['clarify-cross-agent']", () => {
  test('shares the non-process 5-dim row with RFC-023 clarify', () => {
    const ccBehavior = NODE_KIND_BEHAVIORS['clarify-cross-agent']
    const clarifyBehavior = NODE_KIND_BEHAVIORS.clarify
    expect(ccBehavior).toEqual(clarifyBehavior)
  })

  test('matches the documented behavior values exactly', () => {
    expect(NODE_KIND_BEHAVIORS['clarify-cross-agent']).toEqual({
      retryCascade: 'skip',
      isProcess: false,
      isAgent: false,
      settlesWithoutRow: true,
    })
  })
})
