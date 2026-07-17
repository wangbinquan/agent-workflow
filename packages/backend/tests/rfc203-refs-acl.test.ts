// RFC-203 T6 —— 删除/改名拒绝详情的 principal-aware 披露（deleteWorkflow 先例
// 推广到全部引用发射点）。
//
// LOCKS（rfc099 隐藏语义在错误详情面的延伸）：
//   1. 形状：拒绝详情恒为 { visible: [{id,name}], hiddenCount }——legacy 裸
//      数组（referencedBy / workflows / agents / scheduledTaskIds）不得回潮；
//   2. 不泄名：他人的 PRIVATE 引用资源对非 admin 只贡献 hiddenCount，名字
//      绝不进 payload（404 同形隐藏纪律的一致延伸）；
//   3. 可见即列名：public / 本人 / admin 视角下引用名单完整；
//   4. 计划（schedule）走成员私有规则（owner / tasks:read:all），非 ACL 表。
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks, users, workflows, workgroups } from '../src/db/schema'
import { createAgent, deleteAgent } from '../src/services/agent'
import { createMcp, deleteMcp } from '../src/services/mcp'
import { deleteWorkgroup } from '../src/services/workgroups'
import { ConflictError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorOfUser(id: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id}`, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: DbClient, id: string, role: 'admin' | 'user'): Promise<void> {
  await db.insert(users).values({
    id,
    username: `u-${id}`,
    displayName: id,
    role,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
}

const AGENT_BASE = {
  description: '',
  outputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
}

describe('RFC-203 T6 引用披露 ACL', () => {
  let db: DbClient
  const owner = actorOfUser('u-owner', 'user')
  const admin = actorOfUser('u-admin', 'admin')

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'u-owner', 'user')
    await seedUser(db, 'u-other', 'user')
    await seedUser(db, 'u-admin', 'admin')
  })

  async function seedWorkflowUsing(agentName: string, visibility: 'public' | 'private') {
    await db.insert(workflows).values({
      id: ulid(),
      name: `wf-${visibility}`,
      definition: JSON.stringify({
        $schema_version: 1,
        nodes: [{ id: 'n1', kind: 'agent-single', agentName }],
        edges: [],
      }),
      version: 1,
      ownerUserId: 'u-other',
      visibility,
      createdAt: 1,
      updatedAt: 1,
    })
  }

  test('agent-in-use：他人私有工作流只计数不泄名；admin 全可见', async () => {
    await createAgent(db, { name: 'ax', ...AGENT_BASE })
    await seedWorkflowUsing('ax', 'private')
    await seedWorkflowUsing('ax', 'public')

    // 非 admin 的资源 owner：public 名单可见，私有只进 hiddenCount。
    try {
      await deleteAgent(db, 'ax', owner)
      throw new Error('expected ConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      const d = (err as ConflictError).details as {
        visible: Array<{ name: string }>
        hiddenCount: number
      }
      expect(d.visible.map((v) => v.name)).toEqual(['wf-public'])
      expect(d.hiddenCount).toBe(1)
      expect(JSON.stringify(d)).not.toContain('wf-private')
      // legacy 键零回潮
      expect(JSON.stringify(d)).not.toContain('referencedBy')
    }

    // admin：两条全列名。
    try {
      await deleteAgent(db, 'ax', admin)
      throw new Error('expected ConflictError')
    } catch (err) {
      const d = (err as ConflictError).details as {
        visible: Array<{ name: string }>
        hiddenCount: number
      }
      expect(d.visible.map((v) => v.name).sort()).toEqual(['wf-private', 'wf-public'])
      expect(d.hiddenCount).toBe(0)
    }
  })

  test('mcp-still-referenced：他人私有代理引用只计数不泄名', async () => {
    await createMcp(db, {
      name: 'm1',
      description: '',
      type: 'local',
      config: { command: ['echo'] },
      enabled: true,
    })
    await createAgent(db, { name: 'pub-user', ...AGENT_BASE, mcp: ['m1'] })
    // 他人私有代理也引用 m1
    await createAgent(db, { name: 'priv-user', ...AGENT_BASE, mcp: ['m1'] })
    const { agents } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await db
      .update(agents)
      .set({ ownerUserId: 'u-other', visibility: 'private' })
      .where(eq(agents.name, 'priv-user'))

    try {
      await deleteMcp(db, 'm1', owner)
      throw new Error('expected ConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      const d = (err as ConflictError).details as {
        visible: Array<{ name: string }>
        hiddenCount: number
      }
      expect(d.visible.map((v) => v.name)).toEqual(['pub-user'])
      expect(d.hiddenCount).toBe(1)
      expect(JSON.stringify(d)).not.toContain('priv-user')
    }
  })

  test('workgroup-scheduled-referenced：他人计划只计数；tasks:read:all 全可见', async () => {
    await db.insert(workgroups).values({
      id: ulid(),
      name: 'wg1',
      description: '',
      mode: 'free_collab',
      ownerUserId: 'u-owner',
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(scheduledTasks).values({
      id: ulid(),
      name: 'their-nightly',
      ownerUserId: 'u-other',
      launchKind: 'workgroup',
      launchPayload: JSON.stringify({ workgroupName: 'wg1' }),
      scheduleSpec: JSON.stringify({ kind: 'daily', at: '09:00', timezone: 'UTC' }),
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })

    try {
      await deleteWorkgroup(db, 'wg1', owner)
      throw new Error('expected ConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      const d = (err as ConflictError).details as {
        visible: Array<{ name: string }>
        hiddenCount: number
      }
      expect(d.visible).toEqual([])
      expect(d.hiddenCount).toBe(1)
      expect(JSON.stringify(d)).not.toContain('their-nightly')
      expect(JSON.stringify(d)).not.toContain('scheduledTaskIds')
    }

    try {
      await deleteWorkgroup(db, 'wg1', admin)
      throw new Error('expected ConflictError')
    } catch (err) {
      const d = (err as ConflictError).details as {
        visible: Array<{ name: string }>
        hiddenCount: number
      }
      expect(d.visible.map((v) => v.name)).toEqual(['their-nightly'])
      expect(d.hiddenCount).toBe(0)
    }
  })
})
