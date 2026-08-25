// RFC-036 task collaborator schemas — rewritten for RFC-099 (D6/D10):
// the NodeAssignment* schemas are gone with the assignment mechanism, the
// role enum collapsed to owner|collaborator, and the members panel schemas
// (TaskMembers / UpdateTaskMembersBody) joined.

import { describe, expect, test } from 'bun:test'
import {
  AssignableTaskMemberRoleSchema,
  TaskCollaboratorRoleSchema,
  TaskMembersSchema,
  UpdateTaskMembersBodySchema,
} from '../src/schemas/taskCollab'

describe('TaskCollaboratorRoleSchema', () => {
  test('accepts exactly the 2 RFC-099 roles', () => {
    for (const r of ['owner', 'collaborator']) {
      TaskCollaboratorRoleSchema.parse(r)
    }
  })
  test('RFC-324 —— observer 是第三档（能看不能动），不再是被拒的字符串', () => {
    TaskCollaboratorRoleSchema.parse('observer')
    // 但它不是可**指派**的 owner：所有权由 ownerUserId 单独表达。
    expect(() => AssignableTaskMemberRoleSchema.parse('owner')).toThrow()
    for (const r of ['collaborator', 'observer']) AssignableTaskMemberRoleSchema.parse(r)
  })
  test('rejects the retired RFC-036 role tags and other strings', () => {
    expect(() => TaskCollaboratorRoleSchema.parse('reviewer')).toThrow()
    expect(() => TaskCollaboratorRoleSchema.parse('clarify_target')).toThrow()
    expect(() => TaskCollaboratorRoleSchema.parse('admin')).toThrow()
  })
})

describe('UpdateTaskMembersBodySchema', () => {
  test('accepts ownerUserId-only, members-only, and both', () => {
    UpdateTaskMembersBodySchema.parse({ ownerUserId: '01HQ' })
    // RFC-324 —— 成员带档位；`role` 不接受 'owner'（所有权只有 ownerUserId 一处表达）。
    UpdateTaskMembersBodySchema.parse({
      members: [
        { userId: '01HQ', role: 'collaborator' },
        { userId: '01HR', role: 'observer' },
      ],
    })
    UpdateTaskMembersBodySchema.parse({ ownerUserId: '01HQ', members: [] })
    expect(() =>
      UpdateTaskMembersBodySchema.parse({ members: [{ userId: '01HQ', role: 'owner' }] }),
    ).toThrow()
  })
  test('rejects the empty object (at least one field required)', () => {
    expect(() => UpdateTaskMembersBodySchema.parse({})).toThrow()
  })
  test('rejects empty-string ids', () => {
    expect(() => UpdateTaskMembersBodySchema.parse({ ownerUserId: '' })).toThrow()
    expect(() =>
      UpdateTaskMembersBodySchema.parse({ members: [{ userId: '', role: 'collaborator' }] }),
    ).toThrow()
  })
})

describe('TaskMembersSchema', () => {
  test('round-trips the members panel response', () => {
    TaskMembersSchema.parse({
      taskId: 't1',
      ownerUserId: '01HQ',
      owner: {
        id: '01HQ',
        username: 'alice',
        displayName: 'Alice',
        role: 'user',
        status: 'active',
      },
      members: [],
      canManage: true,
      canOperate: true,
    })
    TaskMembersSchema.parse({
      taskId: 't1',
      ownerUserId: null,
      owner: null,
      // RFC-324 —— 成员带档位；canOperate 是「能不能推动这个任务」，与 canManage
      // （能不能改成员名单）分开，观察者两者都是 false。
      members: [
        {
          user: { id: '01HR', username: 'bob', displayName: 'Bob', role: 'user', status: 'active' },
          role: 'observer',
        },
      ],
      canManage: false,
      canOperate: false,
    })
  })
})
