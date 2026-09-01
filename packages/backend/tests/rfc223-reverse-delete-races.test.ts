// RFC-223 final implementation gate — reverse-reference checks must share the
// target DELETE transaction. These deterministic hooks recreate the old
// check→await→delete window and prove a newly saved canonical-id reference
// blocks deletion. Managed-skill deletion additionally proves the fs-staged
// root/trash/op/lock rollback is complete before the ACL-safe error escapes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, plugins, skillOperationLocks, skills } from '../src/db/schema'
import {
  composeMcpServiceBindingForTest,
  createMcpForTest as createMcp,
  deleteMcpForTest as deleteMcp,
  getMcpByIdForTest as getMcpById,
} from './helpers/mcpServiceBinding'
import {
  composePluginServiceBindingForTest,
  deletePlugin,
  getPluginById,
} from './helpers/pluginServiceBinding'
import {
  createManagedSkill,
  deleteSkill,
  getSkillById,
} from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import { getActiveOp } from '../src/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { ConflictError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ACTOR = buildActor({
  user: {
    id: 'u-owner',
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
})

function insertReferencingAgent(
  db: DbClient,
  input: { name: string; mcp?: string[]; plugins?: string[]; skillId?: string },
): void {
  db.insert(agents)
    .values({
      id: ulid(),
      name: input.name,
      mcp: JSON.stringify(input.mcp ?? []),
      plugins: JSON.stringify(input.plugins ?? []),
      skills: JSON.stringify(
        input.skillId === undefined ? [] : [{ kind: 'managed', skillId: input.skillId }],
      ),
      ownerUserId: 'u-other',
      visibility: 'private',
    })
    .run()
}

function assertHiddenReference(error: unknown, code: string, privateName: string): void {
  expect(error).toBeInstanceOf(ConflictError)
  expect(error).toMatchObject({ code })
  const details = (error as ConflictError).details as {
    visible: Array<{ id: string; name: string }>
    hiddenCount: number
  }
  expect(details.visible).toEqual([])
  expect(details.hiddenCount).toBe(1)
  expect(JSON.stringify(details)).not.toContain(privateName)
}

describe('RFC-223 reverse-reference delete transaction races', () => {
  let db: DbClient
  let appHome: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc223-delete-race-'))
  })

  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
  })

  test('MCP: an agent reference saved after the preliminary scan blocks final DELETE without leaking its name', async () => {
    let mcpId = ''
    const mcpBinding = composeMcpServiceBindingForTest(db, {
      actor: ACTOR,
      beforeDelete: async () => {
        insertReferencingAgent(db, { name: 'private-mcp-user', mcp: [mcpId] })
      },
    })
    const mcp = await createMcp(mcpBinding, {
      name: 'race-mcp',
      description: '',
      type: 'local',
      config: { command: ['echo'] },
      enabled: true,
    })
    mcpId = mcp.id

    let caught: unknown
    try {
      await deleteMcp(mcpBinding, mcp.id)
    } catch (error) {
      caught = error
    }

    assertHiddenReference(caught, 'mcp-still-referenced', 'private-mcp-user')
    expect(await getMcpById(mcpBinding, mcp.id)).not.toBeNull()
  })

  test('MCP: mutable row/ACL drift in the await window trips the complete operation fence', async () => {
    let mcpId = ''
    const mcpBinding = composeMcpServiceBindingForTest(db, {
      actor: ACTOR,
      beforeDelete: async () => {
        await db
          .update(mcps)
          .set({ ownerUserId: 'u-other', visibility: 'private', aclRevision: 1 })
          .where(eq(mcps.id, mcpId))
      },
    })
    const mcp = await createMcp(mcpBinding, {
      name: 'fenced-mcp',
      description: '',
      type: 'local',
      config: { command: ['echo'] },
      enabled: true,
    })
    mcpId = mcp.id

    await expect(deleteMcp(mcpBinding, mcp.id)).rejects.toMatchObject({
      code: 'resource-operation-stale',
    })
    expect(await getMcpById(mcpBinding, mcp.id)).not.toBeNull()
  })

  test('plugin: an agent reference saved after the preliminary scan blocks the full-row-fenced DELETE', async () => {
    const pluginId = ulid()
    await db.insert(plugins).values({
      id: pluginId,
      name: 'race-plugin',
      spec: 'file:/tmp/race-plugin.js',
      sourceKind: 'file',
      cachedPath: '/tmp/race-plugin.js',
      installedAt: 1,
      ownerUserId: ACTOR.user.id,
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    })

    let caught: unknown
    const pluginBinding = composePluginServiceBindingForTest(db, {
      actor: ACTOR,
      beforeDelete: async () => {
        insertReferencingAgent(db, {
          name: 'private-plugin-user',
          plugins: [pluginId],
        })
      },
    })
    try {
      await deletePlugin(pluginBinding, pluginId)
    } catch (error) {
      caught = error
    }

    assertHiddenReference(caught, 'plugin-still-referenced', 'private-plugin-user')
    expect(await getPluginById(pluginBinding, pluginId)).not.toBeNull()
  })

  test('managed skill: a ref appearing after fs-staged restores root, empties trash, and releases op/lock', async () => {
    const skill = await createManagedSkill(
      db,
      { appHome },
      {
        name: 'race-skill',
        description: '',
        bodyMd: 'keep me',
        frontmatterExtra: {},
      },
      { ownerUserId: ACTOR.user.id },
    )
    const root = join(appHome, 'skills', skill.id)

    let caught: unknown
    try {
      await deleteSkill(db, { appHome }, skill.id, ACTOR, undefined, {
        afterPhase: (phase) => {
          if (phase === 'fs-staged') {
            expect(existsSync(root)).toBe(false)
            insertReferencingAgent(db, {
              name: 'private-skill-user',
              skillId: skill.id,
            })
          }
        },
      })
    } catch (error) {
      caught = error
    }

    assertHiddenReference(caught, 'skill-in-use', 'private-skill-user')
    expect(await getSkillById(db, skill.id)).not.toBeNull()
    expect(
      (await db.select({ id: skills.id }).from(skills).where(eq(skills.id, skill.id))).length,
    ).toBe(1)
    expect(existsSync(root)).toBe(true)
    expect(readFileSync(join(root, 'files', 'SKILL.md'), 'utf8')).toContain('keep me')
    const trashDir = join(appHome, 'skills', '.trash')
    expect(existsSync(trashDir) ? readdirSync(trashDir) : []).toEqual([])
    expect(getActiveOp(db, skill.id)).toBeNull()
    expect(
      await db
        .select()
        .from(skillOperationLocks)
        .where(eq(skillOperationLocks.lockedSkillId, skill.id)),
    ).toEqual([])
  })
})
