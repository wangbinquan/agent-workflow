// RFC-231 — user resources default private and Workflow/Workgroup copies are
// exact, actor-owned, reference-safe snapshots.

import {
  CreateMcpSchema,
  CreateWorkgroupSchema,
  RESOURCE_DISPLAY_NAME_MAX,
  RESOURCE_DISPLAY_NAME_RE,
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
import { AuthorityClaimRegistry } from '../src/modules/identity-access/application/operationContext'
import { composeMcpCatalog } from '../src/modules/resource-catalog/composition/mcpOperations'
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
import {
  composePluginServiceBindingForTest,
  createPlugin,
  type PluginServiceBinding,
} from './helpers/pluginServiceBinding'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { ResourceOperationCoordinator } from '../src/services/resourceOperationCoordinator'
import {
  createMcpForTest as createMcp,
  type McpCatalogTestBinding as McpServiceBinding,
} from './helpers/mcpServiceBinding'
import { nextResourceCopyName } from '../src/services/resourceCopyName'
import { createManagedSkill } from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import {
  copyWorkflow,
  createWorkflow,
  getWorkflow,
  workflowRevisionOf,
} from '../src/services/workflow'
import { copyWorkgroup, createWorkgroup, workgroupRevisionOf } from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.ts')
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

function mcpBinding(db: DbClient, principal: Actor): McpServiceBinding {
  const catalog = composeMcpCatalog({
    db,
    coordinator: new ResourceOperationCoordinator(),
    nextMutationTimestamp: async (mcp) => mcp.updatedAt + 1,
    runtime: Object.freeze({
      prepareDelete: async () => undefined,
      reconcileDurableIntents: async () => undefined,
    }),
    transitionMutationInTx: () => undefined,
    deletePreparedInTx: () => undefined,
  })
  const authority = new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: principal.user.id, source: principal.source },
    { ...principal, userId: principal.user.id },
  ).actor
  return Object.freeze({ catalog, authority })
}

function pluginBinding(db: DbClient, principal: Actor, pluginsDir: string): PluginServiceBinding {
  return composePluginServiceBindingForTest(db, {
    actor: principal,
    pluginsDir,
    npmBin: FAKE_NPM,
  })
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
    // RFC-264 EXPLICIT RE-JUDGEMENT of two assertions that used to read
    // `'legacy-flow-copy'` and `'workgroup-copy'`: names are no longer folded
    // to a lowercase ASCII slug, so a copy keeps the source's own characters
    // instead of collapsing to the bare fallback.
    expect(nextResourceCopyName('Legacy Flow / 中文', [], 'workflow')).toBe(
      'Legacy Flow / 中文-copy',
    )
    expect(nextResourceCopyName('中文', [], 'workgroup')).toBe('中文-copy')

    const long = nextResourceCopyName('a'.repeat(128), [], 'workflow')
    expect(long).toHaveLength(128)
    expect(long.endsWith('-copy')).toBe(true)
  })
})

// RFC-264 — copy names for human-readable (Chinese) resource names.
// The `-copy` suffix family stays ASCII; everything before it is the source's
// own text. The truncation case is a REGRESSION LOCK for a real bug the old
// ASCII-only charset hid: `String.prototype.slice` cuts UTF-16 units, so
// truncating an emoji/extension-B name split a surrogate pair into a lone
// surrogate, which the RFC-264 rule rejects — i.e. "copy" would 500.
describe('RFC-264 copy names keep their script', () => {
  test('Chinese names copy and chain without collapsing to the fallback', () => {
    expect(nextResourceCopyName('代码审计流水线', [], 'workflow')).toBe('代码审计流水线-copy')
    expect(nextResourceCopyName('代码审计流水线-copy', [], 'workflow')).toBe(
      '代码审计流水线-copy-2',
    )
    expect(nextResourceCopyName('代码审计流水线', ['代码审计流水线-copy'], 'workflow')).toBe(
      '代码审计流水线-copy-2',
    )
    expect(nextResourceCopyName('审计 Pipeline v2', [], 'workgroup')).toBe('审计 Pipeline v2-copy')
  })

  test('the source name is folded before it becomes a copy base', () => {
    expect(nextResourceCopyName('代码审计 ', [], 'workflow')).toBe('代码审计-copy')
    expect(nextResourceCopyName('审计　流程', [], 'workflow')).toBe('审计 流程-copy')
  })

  test('an all-punctuation name still falls back instead of producing a bare suffix', () => {
    expect(nextResourceCopyName('---', [], 'workflow')).toBe('workflow-copy')
    expect(nextResourceCopyName('   ', [], 'workgroup')).toBe('workgroup-copy')
  })

  test('truncation cuts CODE POINTS — never half of a surrogate pair', () => {
    const astral = '🎯'.repeat(RESOURCE_DISPLAY_NAME_MAX)
    const copied = nextResourceCopyName(astral, [], 'workflow')
    expect([...copied].length).toBeLessThanOrEqual(RESOURCE_DISPLAY_NAME_MAX)
    expect(copied.endsWith('-copy')).toBe(true)
    // The whole point: the result must still be a LEGAL name.
    expect(RESOURCE_DISPLAY_NAME_RE.test(copied)).toBe(true)
    expect(/\p{Cs}/u.test(copied)).toBe(false)
  })

  test('long Chinese names truncate to the code-point bound and stay legal', () => {
    const long = '审'.repeat(RESOURCE_DISPLAY_NAME_MAX)
    const copied = nextResourceCopyName(long, [], 'workflow')
    expect([...copied].length).toBe(RESOURCE_DISPLAY_NAME_MAX)
    expect(RESOURCE_DISPLAY_NAME_RE.test(copied)).toBe(true)
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
        mcpBinding(db, alice),
        CreateMcpSchema.parse({
          name: 'private-mcp',
          description: '',
          type: 'local',
          config: { command: ['printf'] },
        }),
      )
      const createdPlugin = await createPlugin(pluginBinding(db, alice, join(appHome, 'plugins')), {
        name: 'private-plugin',
        spec: 'private-plugin@1',
      })
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

  test('actor-backed creates derive owner from the exact admitted authority', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUsers(db, ['alice', 'bob'])
    const created = await createMcp(
      mcpBinding(db, actor('bob')),
      CreateMcpSchema.parse({
        name: 'authority-owned',
        type: 'local',
        config: { command: ['printf'] },
      }),
    )
    expect(db.select().from(mcps).where(eq(mcps.id, created.id)).get()?.ownerUserId).toBe('bob')
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
      agents: { 'modules/resource-catalog/infrastructure/legacy/agent.ts': 1 },
      // RFC-234: stageManagedSkill (intent-bundle pre-stage) is a second
      // reserve-writer in skill.ts — same invisible-until-ready pipeline, same
      // initialPrivateResourceAcl stamp as createManagedSkillWithFiles.
      skills: { 'modules/resource-catalog/infrastructure/legacy/skill.ts': 2 },
      mcps: { 'modules/resource-catalog/infrastructure/sqliteMcpRepository.ts': 1 },
      plugins: { 'modules/resource-catalog/infrastructure/sqlitePluginRepository.ts': 1 },
      workflows: {
        'modules/resource-catalog/infrastructure/legacy/workflow.ts': 1,
        'modules/resource-catalog/infrastructure/legacy/workgroup/launch.ts': 1,
      },
      workgroups: {
        'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts': 1,
        'modules/resource-catalog/infrastructure/legacy/workgroups.ts': 1,
      },
    }
    const sourceFiles = [
      'modules/resource-catalog/infrastructure/legacy/agent.ts',
      'modules/resource-catalog/infrastructure/legacy/skill.ts',
      'modules/resource-catalog/infrastructure/sqliteMcpRepository.ts',
      'modules/resource-catalog/infrastructure/sqlitePluginRepository.ts',
      'modules/resource-catalog/infrastructure/legacy/workflow.ts',
      'modules/resource-catalog/infrastructure/legacy/workgroups.ts',
      'modules/resource-catalog/infrastructure/legacy/workgroup/launch.ts',
      'modules/resource-catalog/infrastructure/legacy/workgroup/dwActions.ts',
      'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts',
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
    for (const file of [
      'modules/resource-catalog/infrastructure/legacy/agent.ts',
      'modules/resource-catalog/infrastructure/legacy/skill.ts',
      'modules/resource-catalog/infrastructure/legacy/workflow.ts',
      'modules/resource-catalog/infrastructure/legacy/workgroups.ts',
    ]) {
      expect(sources.get(file)).toContain('initialPrivateResourceAcl')
    }
    for (const file of [
      'modules/resource-catalog/application/mcps/mcpApplication.ts',
      'modules/resource-catalog/application/plugins/pluginApplication.ts',
    ]) {
      expect(await readFile(join(BACKEND_SRC, file), 'utf8')).toContain(
        'initialPrivateResourceAcl(authority.user.id)',
      )
    }
    expect(
      sources.get('modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts'),
    ).toContain('...input.initialAcl')
    for (const file of ['modules/resource-catalog/infrastructure/legacy/workgroup/launch.ts']) {
      expect(sources.get(file)).toContain('initialBuiltinResourceAcl')
    }
    expect(
      sources.get('modules/resource-catalog/infrastructure/legacy/workgroup/dwActions.ts'),
    ).toContain('{ ownerUserId: actor.user.id, actor }')
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
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
    const copied = await copyWorkflow(
      db,
      legacyId,
      {
        expectedVersion: revision.version,
        expectedSnapshotHash: revision.snapshotHash,
      },
      bob,
    )
    // RFC-264 EXPLICIT RE-JUDGEMENT (was 'legacy-flow-copy'): a copy no longer
    // slug-folds the source name, so a legacy free-form row copies verbatim
    // plus the ASCII `-copy` suffix. Still create-safe, which is what this
    // assertion has always been about.
    expect(copied.name).toBe('Legacy Flow / 中文-copy')
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
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })

    db.update(users).set({ status: 'disabled' }).where(eq(users.id, 'reviewer')).run()
    await expect(copyWorkgroup(db, source.id, request, bob)).rejects.toMatchObject({
      code: 'workgroup-member-user-invalid',
    })
  })
})
