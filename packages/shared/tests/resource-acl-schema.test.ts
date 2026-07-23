import { describe, expect, test } from 'bun:test'
import { UpdateResourceAclBodySchema } from '../src/schemas/resourceAcl'

describe('UpdateResourceAclBodySchema', () => {
  test('requires the immutable resource id and observed ACL revision', () => {
    expect(UpdateResourceAclBodySchema.safeParse({ visibility: 'private' }).success).toBe(false)
    expect(
      UpdateResourceAclBodySchema.safeParse({
        visibility: 'private',
        expectedResourceId: 'agent-id',
      }).success,
    ).toBe(false)
    expect(
      UpdateResourceAclBodySchema.safeParse({
        visibility: 'private',
        expectedAclRevision: 2,
      }).success,
    ).toBe(false)
  })

  test('accepts one mutation field with the complete OCC fence', () => {
    expect(
      UpdateResourceAclBodySchema.parse({
        userIds: ['user-a'],
        expectedResourceId: 'agent-id',
        expectedAclRevision: 2,
      }),
    ).toEqual({
      userIds: ['user-a'],
      expectedResourceId: 'agent-id',
      expectedAclRevision: 2,
    })
  })

  test('the OCC fence alone is not a mutation', () => {
    expect(
      UpdateResourceAclBodySchema.safeParse({
        expectedResourceId: 'agent-id',
        expectedAclRevision: 2,
      }).success,
    ).toBe(false)
  })
})
