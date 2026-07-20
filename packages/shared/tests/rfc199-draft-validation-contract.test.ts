import { describe, expect, test } from 'bun:test'
import {
  WORKFLOW_DEFINITION_CANDIDATE_DOMAIN_V1,
  WorkflowDraftValidationReceiptSchema,
  WorkflowDraftValidationRequestSchema,
  serializeWorkflowDefinitionCandidateV1,
} from '../src'

describe('RFC-199 T11.2 — draft validation wire contract', () => {
  test('candidate bytes are domain-separated and canonical', () => {
    const serialized = serializeWorkflowDefinitionCandidateV1({
      edges: [],
      nodes: [],
      inputs: [],
      $schema_version: 4,
    })
    expect(serialized).toBe(
      `${WORKFLOW_DEFINITION_CANDIDATE_DOMAIN_V1}{"$schema_version":4,"edges":[],"inputs":[],"nodes":[]}`,
    )
  })

  test('request and receipt are strict lowercase-SHA contracts', () => {
    const definition = { $schema_version: 4 as const, inputs: [], nodes: [], edges: [] }
    const hash = 'a'.repeat(64)
    expect(
      WorkflowDraftValidationRequestSchema.parse({ definition, claimedCandidateHash: hash }),
    ).toEqual({ definition, claimedCandidateHash: hash })
    expect(
      WorkflowDraftValidationRequestSchema.safeParse({
        definition,
        claimedCandidateHash: hash.toUpperCase(),
      }).success,
    ).toBe(false)
    expect(
      WorkflowDraftValidationReceiptSchema.parse({
        candidateHash: hash,
        validationContextHash: 'b'.repeat(64),
        validatedAt: 1,
        ok: true,
        issues: [],
      }),
    ).toMatchObject({ candidateHash: hash, ok: true })
  })
})
