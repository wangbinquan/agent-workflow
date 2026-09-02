// RFC-345 回归防护 —— 每一次 ACL 写入都必须唤醒在线连接。
//
// 为什么这条测试存在：这条 post-commit 通知原先挂在 `services/resourceAcl` 的兼容
// 包装上（它把 `afterCommit` 硬写成 `triggerRevalidation('resource-acl-changed')`）。
// RFC-345 把数字员工 / development-config / capability-template 三处 ACL 挂载点直接
// 切到 composition 的 `updateResourceAcl`，而 composition 只在调用方**自己传**
// `afterCommit` 时才通知——三处都没传。于是降档 / 升档后，已经打开页面的人一直停在
// 旧控件上，直到他自己刷新，而他没有任何理由去刷新（RFC-324 当初就是为了消灭这件事）。
// e2e `rfc330-digital-employee-acl` 的「不刷新页面即在卡片上收敛」死在这条上。
//
// 判据：通知归 composition 所有（谁调用都发），且调用方自己的 `afterCommit` 不被吞掉。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents } from '../src/db/schema'
import { updateResourceAcl } from '../src/modules/resource-catalog/composition/resourceAcl'
import { createAgent } from '../src/services/agent'
import { createUser } from '../src/services/users'
import { registerRevalidationTrigger, type RevocationReason } from '../src/ws/revalidationHook'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const AGENT_FIELDS = {
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: 'do the thing',
}

describe('RFC-345 resource ACL revalidation', () => {
  let db: DbClient
  let admin: Actor
  let bobId: string
  let reasons: RevocationReason[]

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    reasons = []
    registerRevalidationTrigger(async (reason) => {
      reasons.push(reason)
    })
    const owner = await createUser(db, {
      username: 'acl_owner',
      email: 'acl-owner@example.test',
      displayName: 'acl owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const bob = await createUser(db, {
      username: 'acl_bob',
      email: 'acl-bob@example.test',
      displayName: 'acl bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    bobId = bob.id
    admin = buildActor({
      user: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
  })

  afterEach(() => {
    // The WS server never booted in this process; leave the hook dormant again.
    registerRevalidationTrigger(async () => {})
  })

  test('the composition notifies live sockets on every ACL write, whoever calls it', async () => {
    const agent = await createAgent(
      db,
      { ...AGENT_FIELDS, name: 'acl-fixture' },
      {
        ownerUserId: admin.user.id,
      },
    )
    const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
    await updateResourceAcl(db, admin, 'agent', row, {
      visibility: 'private',
      grants: [{ userId: bobId, level: 'read' }],
      expectedResourceId: agent.id,
      expectedAclRevision: row.aclRevision,
    })
    expect(reasons, 'ACL 写入没有唤醒在线连接 ⇒ 被改档位的人要一直等到自己刷新页面').toContain(
      'resource-acl-changed',
    )
  })

  test("a caller's own post-commit effect is still run, not replaced by the notification", async () => {
    const agent = await createAgent(
      db,
      { ...AGENT_FIELDS, name: 'acl-fixture-2' },
      {
        ownerUserId: admin.user.id,
      },
    )
    const row = db.select().from(agents).where(eq(agents.id, agent.id)).get()!
    let ownEffect = 0
    await updateResourceAcl(
      db,
      admin,
      'agent',
      row,
      {
        visibility: 'private',
        grants: [{ userId: bobId, level: 'write' }],
        expectedResourceId: agent.id,
        expectedAclRevision: row.aclRevision,
      },
      { afterCommit: () => void (ownEffect += 1) },
    )
    expect(ownEffect).toBe(1)
    expect(reasons).toContain('resource-acl-changed')
  })
})
