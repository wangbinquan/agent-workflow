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
//      backend faces). (The import half — RFC-223 resolution, dangling names,
//      id backfill — went with the test-only YAML import writer, RFC-401 T6.)
import { agentFixture, readWorkflowFixtures, workflowFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { workflowDefinitionToNameSelectors } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'

import { extractWorkflowWorkflowRefs } from '../src/modules/resource-catalog/infrastructure/legacy/resourceRefs'
import { getWorkflow } from '../src/services/workflow'
import { workflowDefinitionToSelectors } from '../src/modules/resource-catalog/infrastructure/legacy/workflow.yaml'
import { copyWorkflow, createWorkflow, updateWorkflow } from './helpers/model/resourceWrites'

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: PersistenceDb, id: string, role: 'admin' | 'user' = 'user') {
  const { users } = tablesOf(db)
  await insertOne(db, users, {
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
  db: PersistenceDb,
  input: {
    id?: string
    name: string
    ownerUserId: string | null
    visibility: 'public' | 'private'
    definition?: WorkflowDefinition
  },
): Promise<string> {
  const id = input.id ?? ulid()
  await workflowFixture(db, {
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
describeEachProvider('RFC-243 §5.3 — save-time call-ref ACL (name domain, D15)', (harness) => {
  let db: PersistenceDb
  const editor = actor('editor')

  beforeEach(async () => {
    db = harness.db
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

    const { resourceGrants } = tablesOf(db)
    const privRow = (await readWorkflowFixtures(db, { name: 'target-priv' }))[0]!
    await insertOne(db, resourceGrants, {
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
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'application',
        'workflows',
        'workflowValidation.ts',
      ),
      'utf8',
    )
    expect(src).toContain('collectWorkflowCallRefs')
    expect(src).toContain("resourceType: 'workflow' as const")
    expect(src).toContain("domain: 'name' as const")
  })
})

// ---------------------------------------------------------------------------
describeEachProvider('RFC-243 §5.5 — YAML export strips the workflowId cache', (harness) => {
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
    const db = harness.db
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
    await agentFixture(db, {
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

// RFC-401 T6 (proposal G5): the YAML import writer and its legacy reference resolver
// (`legacy/importRefs.ts`) are deleted — no production route imported a workflow through them — so the
// import round-trip and W53 resolution suites went with them. Export and save-time gates above stay.
