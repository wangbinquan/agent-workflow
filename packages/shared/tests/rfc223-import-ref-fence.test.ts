// RFC-223 AC10 — the preview-to-submit fence must travel on the public wire.
// Without expectedAclRevision, a same-id owner/visibility/grant change between
// preview and apply is indistinguishable from the candidate the user saw.

import { describe, expect, test } from 'bun:test'
import {
  ImportRefAmbiguitySchema,
  ImportRefCandidateSchema,
  ImportRefSelectionSchema,
} from '../src'

describe('RFC-223 import reference ACL fence schemas', () => {
  test('candidate and selection require the same monotonic ACL revision', () => {
    const candidate = ImportRefCandidateSchema.parse({
      id: 'agent-a',
      ownerUserId: 'owner-a',
      ownerUsername: 'alice',
      visibility: 'public',
      aclRevision: 7,
    })
    expect(
      ImportRefSelectionSchema.parse({
        selector: { type: 'agent', name: 'planner' },
        resourceId: candidate.id,
        expectedAclRevision: candidate.aclRevision,
      }),
    ).toMatchObject({ resourceId: 'agent-a', expectedAclRevision: 7 })

    expect(
      ImportRefCandidateSchema.safeParse({
        id: 'agent-a',
        ownerUserId: 'owner-a',
        ownerUsername: 'alice',
        visibility: 'public',
      }).success,
    ).toBe(false)
    expect(
      ImportRefSelectionSchema.safeParse({
        selector: { type: 'agent', name: 'planner' },
        resourceId: 'agent-a',
      }).success,
    ).toBe(false)
  })

  test('stale details may carry an empty current candidate set after rename', () => {
    expect(
      ImportRefAmbiguitySchema.parse({
        selector: { type: 'agent', name: 'planner' },
        candidates: [],
      }),
    ).toEqual({
      selector: { type: 'agent', name: 'planner' },
      candidates: [],
    })
  })
})
