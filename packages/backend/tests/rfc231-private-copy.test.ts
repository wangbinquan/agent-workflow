// RFC-231 — user resources default private and Workflow/Workgroup copies are
// exact, actor-owned, reference-safe snapshots.

import {
  CreateMcpSchema,
  CreateWorkgroupSchema,
  serializeWorkflowDefinitionStorageV1,
  type AclResourceType,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  mcps,
  plugins,
  resourceGrants,
  skills,
  users,
  workflows,
  workgroupMembers,
  workgroups,
} from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createMcp } from '../src/services/mcp'
import { createPlugin } from '../src/services/plugin'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { nextResourceCopyName } from '../src/services/resourceCopyName'
import { createManagedSkill } from '../src/services/skill'
import {
  copyWorkflow,
  createWorkflow,
  getWorkflow,
  workflowRevisionOf,
} from '../src/services/workflow'
import { copyWorkgroup, createWorkgroup, workgroupRevisionOf } from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.sh')
const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
}

function actor(id: string): Actor {
  return buildActor({
    source: 'session',
    user: {
      id,
      username: id,
      displayName: id,
      role: 'user',
      status: 'active',
    },
  })
}

function seedUsers(db: DbClient, ids: readonly string[]): void {
  const now = Date.now()
  db.insert(users)
    .values(
      ids.map((id) => ({
        id,
        username: id,
        displayName: id,
        role: 'user' as const,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .run()
}

function grant(db: DbClient, type: AclResourceType, resourceId: string, userId: string): void {
  db.insert(resourceGrants)
    .values({
      resourceType: type,
      resourceId,
      userId,
      addedBy: 'alice',
      addedAt: Date.now(),
    })
    .run()
}

const AGENT_INPUT = {
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: '',
}

describe('RFC-231 copy-name allocator', () => {
  test('increments copy chains, skips occupied names, normalizes legacy names and truncates safely', () => {
    expect(nextResourceCopyName('flow', [], 'workflow')).toBe('flow-copy')
    expect(nextResourceCopyName('flow-copy', [], 'workflow')).toBe('flow-copy-2')
    expect(nextResourceCopyName('flow-copy-2', [], 'workflow')).toBe('flow-copy-3')
    expect(
      nextResourceCopyName('flow', ['flow-copy', 'flow-copy-2', 'flow-copy-4'], 'workflow'),
    ).toBe('flow-copy-3')
    expect(nextResourceCopyName('Legacy Flow / 中文', [], 'workflow')).toBe('legacy-flow-copy')
    expect(nextResourceCopyName('中文', [], 'workgroup')).toBe('workgroup-copy')

    const long = nextResourceCopyName('a'.repeat(128), [], 'workflow')
    expect(long).toHaveLength(128)
    expect(long.endsWith('-copy')).toBe(true)
  })
})

describe('RFC-231 private create invariant', () => {
  test('all six canonical create services stamp owner/private/revision 0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUsers(db, ['alice'])
    const alice = actor('alice')
    const appHome = await mkdtemp(join(tmpdir(), 'rfc231-private-'))
    resetNpmProbeCacheForTests()
    process.env.FAKE_NPM_MODE = 'success'
    try {
      const createdAgent = await createAgent(
        db,
        { name: 'private-agent', ...AGENT_INPUT },
        { ownerUserId: 'alice', actor: alice },
      )
      const createdSkill = await createManagedSkill(
        db,
        { appHome },
        {
          name: 'private-skill',
          description: '',
          bodyMd: '',
          frontmatterExtra: {},
        },
        { ownerUserId: 'alice', actor: alice },
      )
      const createdMcp = await createMcp(
        db,
        CreateMcpSchema.parse({
          name: 'private-mcp',
          description: '',
          type: 'local',
          config: { command: ['printf'] },
        }),
        { ownerUserId: 'alice', actor: alice },
      )
      const createdPlugin = await createPlugin(
        db,
        { name: 'private-plugin', spec: 'private-plugin@1' },
        { pluginsDir: join(appHome, 'plugins'), npmBin: FAKE_NPM },
        { ownerUserId: 'alice', actor: alice },
      )
      const createdWorkflow = await createWorkflow(
        db,
        { name: 'private-workflow', description: '', definition: EMPTY_DEFINITION },
        { ownerUserId: 'alice', actor: alice },
      )
      const createdWorkgroup = await createWorkgroup(
        db,
        CreateWorkgroupSchema.parse({
          name: 'private-workgroup',
          mode: 'free_collab',
          members: [],
        }),
        { ownerUserId: 'alice', actor: alice },
      )

      const rows = [
        db.select().from(agents).where(eq(agents.id, createdAgent.id)).get(),
        db.select().from(skills).where(eq(skills.id, createdSkill.id)).get(),
        db.select().from(mcps).where(eq(mcps.id, createdMcp.id)).get(),
        db.select().from(plugins).where(eq(plugins.id, createdPlugin.id)).get(),
        db.select().from(workflows).where(eq(workflows.id, createdWorkflow.id)).get(),
        db.select().from(workgroups).where(eq(workgroups.id, createdWorkgroup.id)).get(),
      ]
      for (const row of rows) {
        expect(row).toMatchObject({
          ownerUserId: 'alice',
          visibility: 'private',
          aclRevision: 0,
        })
      }
    } finally {
      delete process.env.FAKE_NPM_MODE
      await rm(appHome, { recursive: true, force: true })
    }
  })

  test('actor-backed creates reject a forged owner', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUsers(db, ['alice', 'bob'])
    await expect(
      createMcp(
        db,
        CreateMcpSchema.parse({
          name: 'forged-owner',
          type: 'local',
          config: { command: ['printf'] },
        }),
        { ownerUserId: 'alice', actor: actor('bob') },
      ),
    ).rejects.toMatchObject({ code: 'resource-owner-mismatch' })
  })

  test('workflow create rechecks the actor reference gate after public access is tightened', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUsers(db, ['alice', 'target-owner'])
    const owner = actor('target-owner')
    const target = await createAgent(
      db,
      { name: 'tightened-agent', ...AGENT_INPUT },
      { ownerUserId: 'target-owner', actor: owner },
    )
    db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, target.id)).run()

    await expect(
      createWorkflow(
        db,
        {
          name: 'dynamic-save-race',
          description: '',
          definition: {
            $schema_version: 4,
            inputs: [],
            nodes: [
              {
                id: 'agent-node',
                kind: 'agent-single',
                agentId: target.id,
                agentName: target.name,
              },
            ],
            edges: [],
          },
        },
        {
          ownerUserId: 'alice',
          actor: actor('alice'),
          beforeWriteTransaction: () => {
            db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, target.id)).run()
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    expect(db.select().from(workflows).where(eq(workflows.name, 'dynamic-save-race')).get()).toBe(
      undefined,
    )
  })

  test('production writer inventory stays classified as user-private or builtin-public', async () => {
    const expectedInserts: Record<string, Record<string, number>> = {
      agents: { 'services/agent.ts': 1 },
      // RFC-234: stageManagedSkill (intent-bundle pre-stage) is a second
      // reserve-writer in skill.ts — same invisible-until-ready pipeline, same
      // initialPrivateResourceAcl stamp as createManagedSkillWithFiles.
      skills: { 'services/skill.ts': 2 },
      mcps: { 'services/mcp.ts': 1 },
      plugins: { 'services/plugin.ts': 1 },
      workflows: {
        'services/agentLaunch.ts': 1,
        'services/workflow.ts': 1,
        'services/workgroup/launch.ts': 1,
      },
      workgroups: { 'services/workgroups.ts': 1 },
    }
    const sourceFiles = [
      'services/agent.ts',
      'services/skill.ts',
      'services/mcp.ts',
      'services/plugin.ts',
      'services/workflow.ts',
      'services/workgroups.ts',
      'services/agentLaunch.ts',
      'services/workgroup/launch.ts',
      'services/workgroup/dwActions.ts',
    ]
    const sources = new Map(
      await Promise.all(
        sourceFiles.map(
          async (file) => [file, await readFile(join(BACKEND_SRC, file), 'utf8')] as const,
        ),
      ),
    )

    for (const [table, expected] of Object.entries(expectedInserts)) {
      const actual: Record<string, number> = {}
      const pattern = new RegExp(`\\.insert\\s*\\(\\s*${table}\\s*\\)`, 'g')
      for (const [file, source] of sources) {
        const count = source.match(pattern)?.length ?? 0
        if (count > 0) actual[file] = count
      }
      expect(actual).toEqual(expected)
    }
    for (const file of sourceFiles.slice(0, 6)) {
      expect(sources.get(file)).toContain('initialPrivateResourceAcl')
    }
    for (const file of ['services/agentLaunch.ts', 'services/workgroup/launch.ts']) {
      expect(sources.get(file)).toContain('initialBuiltinResourceAcl')
    }
    expect(sources.get('services/workgroup/dwActions.ts')).toContain(
      '{ ownerUserId: actor.user.id, actor }',
    )
  })
})

describe('RFC-231 Workflow exact copy', () => {
  test('a viewer becomes private owner, all refs are re-authorized, and names increment', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUsers(db, ['alice', 'bob'])
    const alice = actor('alice')
    const bob = actor('bob')
    const sourceAgent = await createAgent(
      db,
      { name: 'source-agent', ...AGENT_INPUT },
      { ownerUserId: 'alice', actor: alice },
    )
    const source = await createWorkflow(
      db,
      {
        name: 'secure-flow',
        description: 'copy every editable byte',
        definition: {
          $schema_version: 4,
          inputs: [],
          nodes: [
            {
              id: 'agent-node',
              kind: 'agent-single',
              agentId: sourceAgent.id,
              agentName: sourceAgent.name,
            },
          ],
          edges: [],
        },
      },
      { ownerUserId: 'alice', actor: alice },
    )
    grant(db, 'workflow', source.id, 'bob')
    const request = {
      expectedVersion: source.version,
      expectedSnapshotHash: source.snapshotHash,
    }
    const countBefore = db.select({ id: workflows.id }).from(workflows).all().length

    await expect(copyWorkflow(db, source.id, request, bob)).rejects.toMatchObject({
      code: 'acl-missing-refs',
    })
    expect(db.select({ id: workflows.id }).from(workflows).all()).toHaveLength(countBefore)

    grant(db, 'agent', sourceAgent.id, 'bob')
    const first = await copyWorkflow(db, source.id, request, bob)
    expect(first).toMatchObject({
      name: 'secure-flow-copy',
      description: source.description,
      ownerUserId: 'bob',
      visibility: 'private',
      version: 1,
      builtin: false,
      definition: source.definition,
    })
    expect(first.id).not.toBe(source.id)
    expect(
      db.select().from(resourceGrants).where(eq(resourceGrants.resourceId, first.id)).all(),
    ).toEqual([])
    expect(db.select().from(workflows).where(eq(workflows.id, first.id)).get()?.aclRevision).toBe(0)

    const firstRevision = workflowRevisionOf(first)
    const second = await copyWorkflow(
      db,
      first.id,
      {
        expectedVersion: firstRevision.version,
        expectedSnapshotHash: firstRevision.snapshotHash,
      },
      bob,
    )
    expect(second.name).toBe('secure-flow-copy-2')
    const third = await copyWorkflow(db, source.id, request, bob)
    expect(third.name).toBe('secure-flow-copy-3')
  })

  test('visibility precedes parsing, stale revisions fail, and legacy names become create-safe', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUsers(db, ['alice', 'bob'])
    const bob = actor('bob')
    const corruptId = ulid()
    db.insert(workflows)
      .values({
        id: corruptId,
        name: 'corrupt-private',
        definition: '{not-json',
        ownerUserId: 'alice',
        visibility: 'private',
      })
      .run()
    await expect(
      copyWorkflow(
        db,
        corruptId,
        { expectedVersion: 1, expectedSnapshotHash: '0'.repeat(64) },
        bob,
      ),
    ).rejects.toMatchObject({ code: 'workflow-not-found' })

    const legacyId = ulid()
    db.insert(workflows)
      .values({
        id: legacyId,
        name: 'Legacy Flow / 中文',
        description: 'legacy',
        definition: serializeWorkflowDefinitionStorageV1(EMPTY_DEFINITION),
        ownerUserId: 'alice',
        visibility: 'public',
      })
      .run()
    const legacy = await getWorkflow(db, legacyId)
    expect(legacy).not.toBeNull()
    const revision = workflowRevisionOf(legacy!)
    await expect(
      copyWorkflow(
        db,
        legacyId,
        {
          expectedVersion: revision.version + 1,
          expectedSnapshotHash: revision.snapshotHash,
        },
        bob,
      ),
    ).rejects.toMatchObject({ code: 'workflow-copy-stale' })
    const copied = await copyWorkflow(
      db,
      legacyId,
      {
        expectedVersion: revision.version,
        expectedSnapshotHash: revision.snapshotHash,
      },
      bob,
    )
    expect(copied.name).toBe('legacy-flow-copy')
  })
})

describe('RFC-231 Workgroup exact copy', () => {
  test('roster ids are reminted, canonical labels refreshed, and human activity is fenced', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUsers(db, ['alice', 'bob', 'reviewer'])
    const alice = actor('alice')
    const bob = actor('bob')
    const sourceAgent = await createAgent(
      db,
      { name: 'roster-agent', ...AGENT_INPUT },
      { ownerUserId: 'alice', actor: alice },
    )
    const source = await createWorkgroup(
      db,
      CreateWorkgroupSchema.parse({
        name: 'review-squad',
        description: 'same description',
        instructions: 'same charter',
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        switches: { shareOutputs: true, directMessages: true, blackboard: true },
        maxRounds: 7,
        completionGate: true,
        clarifyBudget: 4,
        fanOut: true,
        members: [
          {
            memberType: 'agent',
            agentId: sourceAgent.id,
            displayName: 'lead',
            roleDesc: 'coordinate',
          },
          {
            memberType: 'human',
            userId: 'reviewer',
            displayName: 'reviewer',
            roleDesc: 'review',
          },
        ],
      }),
      { ownerUserId: 'alice', actor: alice },
    )
    grant(db, 'workgroup', source.id, 'bob')
    const sourceRevision = workgroupRevisionOf(source)
    const request = {
      expectedVersion: sourceRevision.version,
      expectedSnapshotHash: sourceRevision.snapshotHash,
    }
    const countBefore = db.select({ id: workgroups.id }).from(workgroups).all().length

    await expect(copyWorkgroup(db, source.id, request, bob)).rejects.toMatchObject({
      code: 'acl-missing-refs',
    })
    expect(db.select({ id: workgroups.id }).from(workgroups).all()).toHaveLength(countBefore)

    grant(db, 'agent', sourceAgent.id, 'bob')
    db.update(agents)
      .set({ name: 'roster-agent-renamed' })
      .where(eq(agents.id, sourceAgent.id))
      .run()
    const copied = await copyWorkgroup(db, source.id, request, bob)
    expect(copied).toMatchObject({
      name: 'review-squad-copy',
      description: source.description,
      instructions: source.instructions,
      mode: source.mode,
      switches: source.switches,
      maxRounds: source.maxRounds,
      completionGate: source.completionGate,
      clarifyBudget: source.clarifyBudget,
      fanOut: source.fanOut,
      ownerUserId: 'bob',
      visibility: 'private',
      version: 1,
    })
    expect(copied.members.map((member) => member.id)).not.toEqual(
      source.members.map((member) => member.id),
    )
    expect(copied.members.find((member) => member.memberType === 'agent')?.agentName).toBe(
      'roster-agent-renamed',
    )
    expect(copied.leaderMemberId).not.toBe(source.leaderMemberId)
    expect(copied.members.find((member) => member.id === copied.leaderMemberId)?.displayName).toBe(
      'lead',
    )
    expect(
      db.select().from(resourceGrants).where(eq(resourceGrants.resourceId, copied.id)).all(),
    ).toEqual([])
    expect(
      db.select().from(workgroups).where(eq(workgroups.id, copied.id)).get()?.aclRevision,
    ).toBe(0)
    expect(
      db.select().from(workgroupMembers).where(eq(workgroupMembers.workgroupId, copied.id)).all(),
    ).toHaveLength(source.members.length)

    await expect(
      copyWorkgroup(db, source.id, { ...request, expectedSnapshotHash: '0'.repeat(64) }, bob),
    ).rejects.toMatchObject({ code: 'workgroup-copy-stale' })

    db.update(users).set({ status: 'disabled' }).where(eq(users.id, 'reviewer')).run()
    await expect(copyWorkgroup(db, source.id, request, bob)).rejects.toMatchObject({
      code: 'workgroup-member-user-invalid',
    })
  })
})
