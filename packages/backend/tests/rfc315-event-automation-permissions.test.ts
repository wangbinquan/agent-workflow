// RFC-315 — Webhook and source-neutral rules share one permission family.
// These HTTP tests lock the capability shrink that motivated the RFC: a normal
// user still has event-sources:update but cannot write automation rules, every
// non-admin writer is owner-scoped, and the source-neutral channel rejects PATs.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { eventResponseRules, eventSources, eventTypeCatalog } from '@/db/schema'
import { createApp } from '@/server'
import { createPat } from '@/auth/patStore'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { createSession } from '@/auth/sessionStore'
import { createUser } from '@/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 31))

function ruleBody(name: string, targetKind: 'workflow' | 'digital-employee' = 'workflow') {
  return {
    name,
    enabled: true,
    eventTypeRef: { id: 'test.work.requested', revision: 1 },
    subjectMatch: 'all',
    subjectPattern: null,
    target:
      targetKind === 'workflow'
        ? {
            kind: 'workflow' as const,
            refId: 'workflow-1',
            nameTemplate: '{{trigger.test.work_id}}',
            inputs: {},
          }
        : {
            kind: 'digital-employee' as const,
            refId: 'employee-1',
            intakeKind: 'body' as const,
            target: {},
            valueTemplate: '{{trigger.test.work_id}}',
          },
  }
}

async function harness() {
  const db = createInMemoryDb(MIGRATIONS)
  const source = {
    schemaVersion: 1 as const,
    sourceRef: { id: 'test.source', revision: 1 },
    ownerTypeId: 'test.owner',
    displayName: { 'zh-CN': '测试来源', 'en-US': 'Test source' },
    description: { 'zh-CN': '测试来源', 'en-US': 'Test source' },
    observationMode: 'passive' as const,
    observerProgramRef: null,
    pollIntervalMs: 1_000,
    batchSize: 10,
  }
  const eventType = {
    schemaVersion: 1 as const,
    eventTypeRef: { id: 'test.work.requested', revision: 1 },
    sourceRef: source.sourceRef,
    ownerTypeId: 'test.owner',
    subjectTypeId: 'test.work',
    payloadSchemaId: 'test.payload',
    displayName: { 'zh-CN': '工作已请求', 'en-US': 'Work requested' },
    description: { 'zh-CN': '工作已请求', 'en-US': 'Work requested' },
    deliveryClass: 'test.delivery',
    catalogVisibility: 'public' as const,
    triggerParameters: {
      namespace: 'test',
      fields: [
        {
          fieldId: 'work_id',
          displayName: { 'zh-CN': '工作 ID', 'en-US': 'Work ID' },
          description: { 'zh-CN': '工作 ID', 'en-US': 'Work ID' },
        },
      ],
    },
  }
  await db.insert(eventSources).values({
    sourceId: source.sourceRef.id,
    revision: source.sourceRef.revision,
    descriptorJson: JSON.stringify(source),
    descriptorDigest: 'source-digest',
    registeredAt: 1,
  })
  await db.insert(eventTypeCatalog).values({
    eventTypeId: eventType.eventTypeRef.id,
    revision: eventType.eventTypeRef.revision,
    sourceId: source.sourceRef.id,
    sourceRevision: source.sourceRef.revision,
    descriptorJson: JSON.stringify(eventType),
    descriptorDigest: 'event-digest',
    catalogVisibility: 'public',
    registeredAt: 1,
  })

  const makeUser = async (
    username: string,
    role: 'admin' | 'manager' | 'user' | 'guest',
    additionalPermissions: Parameters<typeof createUser>[1]['additionalPermissions'] = [],
  ) => {
    const user = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
      additionalPermissions,
    })
    const { token } = await createSession({ db, userId: user.id })
    return { user, token }
  }

  const admin = await makeUser('rfc315-admin', 'admin')
  const manager = await makeUser('rfc315-manager', 'manager')
  const user = await makeUser('rfc315-user', 'user')
  const guest = await makeUser('rfc315-guest', 'guest')
  const editor = await makeUser('rfc315-editor', 'user', [
    'event-automation-rules:create',
    'event-automation-rules:update',
    'event-automation-rules:delete',
  ])
  const overrideEditor = await makeUser('rfc315-override-editor', 'user', [
    'event-automation-rules:create',
    'event-automation-rules:update',
    'event-automation-rules:delete',
    'event-automation-rules:override-owner',
  ])
  const app = createApp({
    token: 'a'.repeat(64),
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox,
  })
  const call = (token: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { db, app, call, admin, manager, user, guest, editor, overrideEditor }
}

async function responseCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code
}

describe('RFC-315 event automation permissions', () => {
  test('default role matrix is read-all / manager-own-write / admin-global-write', async () => {
    const h = await harness()

    const userMe = await h.call(h.user.token, 'GET', '/api/auth/me')
    expect((await userMe.json()) as { permissions: string[] }).toMatchObject({
      permissions: expect.arrayContaining(['event-sources:update', 'event-automation-rules:read']),
    })
    expect(
      (await h.call(h.user.token, 'POST', '/api/event-center/response-rules', ruleBody('no')))
        .status,
    ).toBe(403)
    expect((await h.call(h.guest.token, 'GET', '/api/event-center/response-rules')).status).toBe(
      403,
    )

    const adminCreated = await h.call(
      h.admin.token,
      'POST',
      '/api/event-center/response-rules',
      ruleBody('admin rule'),
    )
    expect(adminCreated.status).toBe(201)
    const adminRule = (await adminCreated.json()) as { id: string; ownerUserId: string }
    expect(adminRule.ownerUserId).toBe(h.admin.user.id)

    const managerCreated = await h.call(
      h.manager.token,
      'POST',
      '/api/event-center/response-rules',
      ruleBody('manager rule'),
    )
    expect(managerCreated.status).toBe(201)
    const managerRule = (await managerCreated.json()) as { id: string; ownerUserId: string }
    expect(managerRule.ownerUserId).toBe(h.manager.user.id)

    expect(
      (
        await h.call(h.manager.token, 'PUT', `/api/event-center/response-rules/${adminRule.id}`, {
          malformed: true,
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await h.call(
          h.manager.token,
          'PUT',
          `/api/event-center/response-rules/${managerRule.id}`,
          ruleBody('manager updated'),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await h.call(
          h.admin.token,
          'PUT',
          `/api/event-center/response-rules/${managerRule.id}`,
          ruleBody('admin override'),
        )
      ).status,
    ).toBe(200)
    expect((await h.call(h.user.token, 'GET', '/api/event-center/response-rules')).status).toBe(200)
  })

  test('explicit CRUD grants stay owner-scoped and body owner injection is rejected', async () => {
    const h = await harness()
    const own = await h.call(
      h.editor.token,
      'POST',
      '/api/event-center/response-rules',
      ruleBody('editor own'),
    )
    expect(own.status).toBe(201)
    const ownRule = (await own.json()) as { id: string; ownerUserId: string }
    expect(ownRule.ownerUserId).toBe(h.editor.user.id)

    const forged = await h.call(h.editor.token, 'POST', '/api/event-center/response-rules', {
      ...ruleBody('forged'),
      ownerUserId: h.admin.user.id,
    })
    expect(forged.status).toBe(422)
    expect(await responseCode(forged)).toBe('event-response-rule-invalid')

    const adminCreated = await h.call(
      h.admin.token,
      'POST',
      '/api/event-center/response-rules',
      ruleBody('admin other'),
    )
    const otherRule = (await adminCreated.json()) as { id: string }
    expect(
      (await h.call(h.editor.token, 'DELETE', `/api/event-center/response-rules/${otherRule.id}`))
        .status,
    ).toBe(404)
    expect(
      (
        await h.call(
          h.overrideEditor.token,
          'DELETE',
          `/api/event-center/response-rules/${otherRule.id}`,
        )
      ).status,
    ).toBe(200)
    expect(
      (await h.call(h.editor.token, 'DELETE', `/api/event-center/response-rules/${ownRule.id}`))
        .status,
    ).toBe(200)
  })

  test('source-neutral rule routes reject PATs and digital-employee create keeps launch permission', async () => {
    const h = await harness()
    const pat = await createPat({
      db: h.db,
      userId: h.admin.user.id,
      name: 'rfc315',
      scopes: [
        'event-automation-rules:create',
        'event-automation-rules:update',
        'event-automation-rules:delete',
      ],
      purpose: 'general',
    })
    expect((await h.call(pat.token, 'GET', '/api/webhook-triggers')).status).toBe(200)
    const patGet = await h.call(pat.token, 'GET', '/api/event-center/response-rules')
    expect(patGet.status).toBe(403)
    expect(await responseCode(patGet)).toBe('token-forbidden-route')

    const limited = await createUser(h.db, {
      username: 'rfc315-limited',
      displayName: 'limited',
      role: 'guest',
      password: 'longEnoughPassword',
      additionalPermissions: [
        'event-automation-rules:create',
        'event-automation-rules:update',
        'tasks:execute',
      ],
    })
    const limitedToken = (await createSession({ db: h.db, userId: limited.id })).token
    const denied = await h.call(
      limitedToken,
      'POST',
      '/api/event-center/response-rules',
      ruleBody('employee', 'digital-employee'),
    )
    expect(denied.status).toBe(403)
    expect(await responseCode(denied)).toBe('forbidden')

    const workflowRule = await h.call(
      limitedToken,
      'POST',
      '/api/event-center/response-rules',
      ruleBody('workflow first'),
    )
    expect(workflowRule.status).toBe(201)
    const workflowRuleId = ((await workflowRule.json()) as { id: string }).id
    const deniedUpdate = await h.call(
      limitedToken,
      'PUT',
      `/api/event-center/response-rules/${workflowRuleId}`,
      ruleBody('employee update', 'digital-employee'),
    )
    expect(deniedUpdate.status).toBe(403)
    expect(await responseCode(deniedUpdate)).toBe('forbidden')

    expect(await h.db.select({ id: eventResponseRules.id }).from(eventResponseRules)).toEqual([
      { id: workflowRuleId },
    ])
  })
})
