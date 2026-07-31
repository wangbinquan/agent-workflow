// RFC-243 PR-3 (T15, design §5.3/§5.5) — call-workflow cross-resource refs +
// YAML portability. LOCKS:
//
//   1. `extractWorkflowWorkflowRefs` extracts call nodes' authoritative
//      `workflowName` selectors (deduped; malformed nodes skipped);
//   2. save-time D15 ACL in the NAME domain: a NEW call ref whose every
//      matching workflow row is invisible to the editor rejects with
//      `acl-missing-refs` (create / update / copy), a name matching zero rows
//      is dangling-legal (launch fails closed elsewhere), and stored refs are
//      grandfathered (an update that adds no new name never re-checks). This
//      gate is the ONLY thing between a name-guessing editor and the ACL-free
//      launch closure freeze — if these red, that exfiltration fence broke;
//   3. YAML: export strips the installation-local `workflowId` cache (shared +
//      backend faces), import resolves `workflowName` per RFC-223 flow but
//      tolerates zero candidates (dangling name imports successfully), and a
//      resolved import backfills THIS install's id (foreign ids never
//      persist).
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stringify } from 'yaml'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { workflowDefinitionToNameSelectors } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, users, workflows } from '../src/db/schema'
import { resolveImportRefs } from '../src/services/importRefs'
import { extractWorkflowWorkflowRefs } from '../src/services/resourceRefs'
import { copyWorkflow, createWorkflow, getWorkflow, updateWorkflow } from '../src/services/workflow'
import { importWorkflowYaml, workflowDefinitionToSelectors } from '../src/services/workflow.yaml'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: DbClient, id: string, role: 'admin' | 'user' = 'user') {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
}

function callDef(
  names: readonly string[],
  extra: Record<string, unknown> = {},
): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: names.map((workflowName, i) => ({
      id: `c${i + 1}`,
      kind: 'call-workflow',
      workflowName,
      ...extra,
    })),
    edges: [],
  }
}

async function seedWorkflowRow(
  db: DbClient,
  input: {
    id?: string
    name: string
    ownerUserId: string | null
    visibility: 'public' | 'private'
    definition?: WorkflowDefinition
  },
): Promise<string> {
  const id = input.id ?? ulid()
  await db.insert(workflows).values({
    id,
    name: input.name,
    description: '',
    definition: JSON.stringify(
      input.definition ?? { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    ),
    version: 1,
    ownerUserId: input.ownerUserId,
    visibility: input.visibility,
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

async function storedDefinition(db: DbClient, workflowId: string): Promise<WorkflowDefinition> {
  const row = (await db.select().from(workflows).where(eq(workflows.id, workflowId)))[0]
  if (row === undefined) throw new Error(`missing workflow ${workflowId}`)
  return JSON.parse(row.definition) as WorkflowDefinition
}

// ---------------------------------------------------------------------------
describe('RFC-243 — extractWorkflowWorkflowRefs', () => {
  test('dedupes call-node workflowNames in declaration order; skips malformed and other kinds', () => {
    const refs = extractWorkflowWorkflowRefs({
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'c1', kind: 'call-workflow', workflowName: 'wf-b' },
        { id: 'c2', kind: 'call-workflow', workflowName: 'wf-a', workflowId: 'CACHE' },
        { id: 'c3', kind: 'call-workflow', workflowName: 'wf-b' }, // dup
        { id: 'c4', kind: 'call-workflow' }, // malformed — validator owns it
        { id: 'n1', kind: 'input', inputKey: 'req' },
        { id: 'n2', kind: 'agent-single', agentId: 'A1' },
      ],
      edges: [],
    } as unknown as WorkflowDefinition)
    expect(refs).toEqual(['wf-b', 'wf-a'])
  })
})

// ---------------------------------------------------------------------------
describe('RFC-243 §5.3 — save-time call-ref ACL (name domain, D15)', () => {
  let db: DbClient
  const editor = actor('editor')

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a')
    await seedUser(db, 'editor')
    await seedWorkflowRow(db, {
      name: 'target-priv',
      ownerUserId: 'owner-a',
      visibility: 'private',
    })
    await seedWorkflowRow(db, { name: 'target-pub', ownerUserId: 'owner-a', visibility: 'public' })
  })

  const createFor = (names: readonly string[]) =>
    createWorkflow(
      db,
      { name: 'caller', description: '', definition: callDef(names) },
      { ownerUserId: 'editor', actor: editor },
    )

  test('create rejects a call ref whose only matching row is invisible (echoes the input name)', async () => {
    await expect(createFor(['target-priv'])).rejects.toMatchObject({
      code: 'acl-missing-refs',
      details: { missing: [{ type: 'workflow', name: 'target-priv' }] },
    })
  })

  test('create accepts a public target, a granted private target, and a dangling name', async () => {
    await expect(createFor(['target-pub'])).resolves.toMatchObject({ name: 'caller' })

    const privRow = (await db.select().from(workflows).where(eq(workflows.name, 'target-priv')))[0]!
    await db.insert(resourceGrants).values({
      resourceType: 'workflow',
      resourceId: privRow.id,
      userId: 'editor',
      addedBy: 'owner-a',
      addedAt: 1,
    })
    await expect(
      createWorkflow(
        db,
        { name: 'caller-granted', description: '', definition: callDef(['target-priv']) },
        { ownerUserId: 'editor', actor: editor },
      ),
    ).resolves.toMatchObject({ name: 'caller-granted' })

    // Zero matching rows = dangling until launch — the save must NOT block.
    await expect(
      createWorkflow(
        db,
        { name: 'caller-dangling', description: '', definition: callDef(['ghost-wf']) },
        { ownerUserId: 'editor', actor: editor },
      ),
    ).resolves.toMatchObject({ name: 'caller-dangling' })
  })

  test('update checks only NEW names; stored invisible refs are grandfathered', async () => {
    // Seed the editor's workflow ALREADY referencing the invisible name (as if
    // saved before the target went private).
    const mineId = await seedWorkflowRow(db, {
      name: 'mine',
      ownerUserId: 'editor',
      visibility: 'private',
      definition: callDef(['target-priv']),
    })

    // No new name → no re-check → succeeds even though target-priv is invisible.
    const receipt = await updateWorkflow(
      db,
      mineId,
      {
        expectedVersion: 1,
        clientMutationId: ulid(),
        snapshot: { name: 'mine', description: 'edited', definition: callDef(['target-priv']) },
      },
      { kind: 'actor', actor: editor },
    )
    expect(receipt.outcome).toBe('committed')

    // Adding a SECOND invisible name is a new reference → rejected.
    await seedWorkflowRow(db, { name: 'priv-2', ownerUserId: 'owner-a', visibility: 'private' })
    await expect(
      updateWorkflow(
        db,
        mineId,
        {
          expectedVersion: 2,
          clientMutationId: ulid(),
          snapshot: {
            name: 'mine',
            description: 'edited',
            definition: callDef(['target-priv', 'priv-2']),
          },
        },
        { kind: 'actor', actor: editor },
      ),
    ).rejects.toMatchObject({
      code: 'acl-missing-refs',
      details: { missing: [{ type: 'workflow', name: 'priv-2' }] },
    })
  })

  test('copy re-checks the FULL source call-ref set (invisible rejects, dangling passes)', async () => {
    const sourceInvisible = await seedWorkflowRow(db, {
      name: 'src-invisible-ref',
      ownerUserId: 'owner-a',
      visibility: 'public',
      definition: callDef(['target-priv']),
    })
    const detailA = await getWorkflow(db, sourceInvisible)
    await expect(
      copyWorkflow(
        db,
        sourceInvisible,
        { expectedVersion: detailA!.version, expectedSnapshotHash: detailA!.snapshotHash },
        editor,
      ),
    ).rejects.toMatchObject({
      code: 'acl-missing-refs',
      details: { missing: [{ type: 'workflow', name: 'target-priv' }] },
    })

    const sourceDangling = await seedWorkflowRow(db, {
      name: 'src-dangling-ref',
      ownerUserId: 'owner-a',
      visibility: 'public',
      definition: callDef(['ghost-wf']),
    })
    const detailB = await getWorkflow(db, sourceDangling)
    await expect(
      copyWorkflow(
        db,
        sourceDangling,
        { expectedVersion: detailB!.version, expectedSnapshotHash: detailB!.snapshotHash },
        editor,
      ),
    ).resolves.toMatchObject({ ownerUserId: 'editor' })
  })

  test('route segment: validate-draft diffs NEW call names into the same gate (source lock)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'workflows.ts'),
      'utf8',
    )
    expect(src).toContain('extractWorkflowWorkflowRefs')
    expect(src).toContain("{ type: 'workflow', names: addedWorkflowNames, domain: 'name' }")
  })
})

// ---------------------------------------------------------------------------
describe('RFC-243 §5.5 — YAML export strips the workflowId cache', () => {
  test('shared workflowDefinitionToNameSelectors drops workflowId, keeps workflowName', () => {
    const portable = workflowDefinitionToNameSelectors({
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'c1', kind: 'call-workflow', workflowName: 'child-wf', workflowId: 'LOCAL_ID' },
        { id: 'n1', kind: 'input', inputKey: 'req' },
      ],
      edges: [],
    } as unknown as WorkflowDefinition)
    const call = portable.nodes.find((n) => n.id === 'c1') as Record<string, unknown>
    expect(call.workflowName).toBe('child-wf')
    expect(call.workflowId).toBeUndefined()
    expect((portable.nodes.find((n) => n.id === 'n1') as Record<string, unknown>).inputKey).toBe(
      'req',
    )
  })

  test('backend workflowDefinitionToSelectors drops workflowId on BOTH the agent-free fast path and the agent path', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a')
    const viewer = actor('viewer')

    // Agent-free definition → the early-return path must already be stripped.
    const fast = await workflowDefinitionToSelectors(db, viewer, {
      $schema_version: 4,
      inputs: [],
      nodes: [{ id: 'c1', kind: 'call-workflow', workflowName: 'child-wf', workflowId: 'LOCAL' }],
      edges: [],
    } as unknown as WorkflowDefinition)
    expect((fast.nodes[0] as Record<string, unknown>).workflowId).toBeUndefined()
    expect((fast.nodes[0] as Record<string, unknown>).workflowName).toBe('child-wf')

    // With an agent node the main mapping path runs; the call node still loses
    // only its id cache while the agent node gains its portable selector.
    await db.insert(agents).values({
      id: 'agent-a',
      name: 'helper',
      ownerUserId: 'owner-a',
      visibility: 'public',
    })
    const full = await workflowDefinitionToSelectors(db, viewer, {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'a1', kind: 'agent-single', agentId: 'agent-a', agentName: 'stale' },
        { id: 'c1', kind: 'call-workflow', workflowName: 'child-wf', workflowId: 'LOCAL' },
      ],
      edges: [],
    } as unknown as WorkflowDefinition)
    const call = full.nodes.find((n) => n.id === 'c1') as Record<string, unknown>
    const agent = full.nodes.find((n) => n.id === 'a1') as Record<string, unknown>
    expect(call.workflowId).toBeUndefined()
    expect(call.workflowName).toBe('child-wf')
    expect(agent.agentId).toBeUndefined()
    expect(agent.agentName).toBe('helper')
  })
})

// ---------------------------------------------------------------------------
describe('RFC-243 §5.5 — YAML import resolves / dangles call-workflow names', () => {
  let db: DbClient
  const viewer = actor('viewer')

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a')
    await seedUser(db, 'owner-b')
    await seedUser(db, 'viewer')
  })

  function callYaml(input: { name?: string; workflowName: string; workflowId?: string }): string {
    return stringify({
      name: input.name ?? 'imported-caller',
      description: '',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'c1',
            kind: 'call-workflow',
            workflowName: input.workflowName,
            ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
          },
        ],
        edges: [],
      },
    })
  }

  test('round-trip: a resolved name backfills THIS install id and never keeps the foreign one', async () => {
    const childId = await seedWorkflowRow(db, {
      name: 'child-wf',
      ownerUserId: 'owner-a',
      visibility: 'public',
    })
    const result = await importWorkflowYaml(
      db,
      { yamlText: callYaml({ workflowName: 'child-wf', workflowId: 'FOREIGN_ID' }), mode: 'new' },
      { kind: 'actor', actor: viewer },
    )
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('unreachable')
    const node = (await storedDefinition(db, result.workflow.id)).nodes[0] as Record<
      string,
      unknown
    >
    expect(node.workflowName).toBe('child-wf')
    expect(node.workflowId).toBe(childId)
  })

  test('zero candidates: the dangling name imports successfully with no id cache', async () => {
    const result = await importWorkflowYaml(
      db,
      { yamlText: callYaml({ workflowName: 'ghost-wf', workflowId: 'FOREIGN_ID' }), mode: 'new' },
      { kind: 'actor', actor: viewer },
    )
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('unreachable')
    const node = (await storedDefinition(db, result.workflow.id)).nodes[0] as Record<
      string,
      unknown
    >
    expect(node.workflowName).toBe('ghost-wf')
    expect(node.workflowId).toBeUndefined()
  })

  test('a name whose only rows are invisible is NOT importable (save fence, anti-exfiltration)', async () => {
    // The import resolver treats invisible as missing (skip → dangling), but
    // the save-time name-domain ACL still rejects: without it, launch's
    // ACL-free closure freeze would happily execute the private definition.
    await seedWorkflowRow(db, {
      name: 'secret-wf',
      ownerUserId: 'owner-a',
      visibility: 'private',
    })
    await expect(
      importWorkflowYaml(
        db,
        { yamlText: callYaml({ workflowName: 'secret-wf' }), mode: 'new' },
        { kind: 'actor', actor: viewer },
      ),
    ).rejects.toMatchObject({
      code: 'acl-missing-refs',
      details: { missing: [{ type: 'workflow', name: 'secret-wf' }] },
    })
  })

  test('ambiguous visible candidates keep the RFC-223 mapping flow; a selection binds and backfills', async () => {
    const idA = await seedWorkflowRow(db, {
      name: 'dup-wf',
      ownerUserId: 'owner-a',
      visibility: 'public',
    })
    const idB = await seedWorkflowRow(db, {
      name: 'dup-wf',
      ownerUserId: 'owner-b',
      visibility: 'public',
    })
    const ordered = [idA, idB].sort((a, b) => a.localeCompare(b))
    await expect(
      importWorkflowYaml(
        db,
        { yamlText: callYaml({ workflowName: 'dup-wf' }), mode: 'new' },
        { kind: 'actor', actor: viewer },
      ),
    ).rejects.toMatchObject({
      code: 'import-ref-ambiguous',
      status: 409,
      details: {
        ambiguities: [
          {
            selector: { type: 'workflow', name: 'dup-wf' },
            candidates: [{ id: ordered[0] }, { id: ordered[1] }],
          },
        ],
      },
    })

    const result = await importWorkflowYaml(
      db,
      {
        yamlText: callYaml({ workflowName: 'dup-wf' }),
        mode: 'new',
        selections: [
          {
            selector: { type: 'workflow', name: 'dup-wf' },
            resourceId: idB,
            expectedAclRevision: 0,
          },
        ],
      },
      { kind: 'actor', actor: viewer },
    )
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') throw new Error('unreachable')
    const node = (await storedDefinition(db, result.workflow.id)).nodes[0] as Record<
      string,
      unknown
    >
    expect(node.workflowId).toBe(idB)
  })

  test('resolveImportRefs: workflow selectors skip on zero candidates while agent selectors still fail closed', async () => {
    const skipped = await resolveImportRefs(db, viewer, [{ type: 'workflow', name: 'nope' }])
    expect(skipped.bySelector.size).toBe(0)
    expect(skipped.fence.entries).toEqual([])
    await expect(
      resolveImportRefs(db, viewer, [{ type: 'agent', name: 'nope' }]),
    ).rejects.toMatchObject({ code: 'import-ref-unresolved' })
  })
})
