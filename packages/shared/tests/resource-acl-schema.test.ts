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
    // RFC-324 —— 授权名单从 `userIds: string[]` 换成带档位的 `grants`。旧字段被
    // 删除而不是保留：两种表达同一份名单，就得回答「同时出现时听谁的」。
    expect(
      UpdateResourceAclBodySchema.parse({
        grants: [{ userId: 'user-a', level: 'read' }],
        expectedResourceId: 'agent-id',
        expectedAclRevision: 2,
      }),
    ).toEqual({
      grants: [{ userId: 'user-a', level: 'read' }],
      expectedResourceId: 'agent-id',
      expectedAclRevision: 2,
    })
  })

  test('RFC-324 —— 档位是封闭两值域；旧 userIds 不再被接受', () => {
    expect(
      UpdateResourceAclBodySchema.safeParse({
        grants: [{ userId: 'user-a', level: 'manage' }],
        expectedResourceId: 'agent-id',
        expectedAclRevision: 2,
      }).success,
      '第三档只能是拼写错误——本 RFC 明确选了两档',
    ).toBe(false)
    expect(
      UpdateResourceAclBodySchema.safeParse({
        userIds: ['user-a'],
        expectedResourceId: 'agent-id',
        expectedAclRevision: 2,
      }).success,
      '静默忽略旧字段比报错更糟：调用方会以为授权成功了',
    ).toBe(false)
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
