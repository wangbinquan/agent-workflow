import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { stringify } from 'yaml'
import type { ImportRefSelection, WorkflowDefinition } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, skills, users, workflows } from '../src/db/schema'
import { resolveAgentImportRefs, resolveImportRefs } from '../src/services/importRefs'
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

async function seedAgent(
  db: DbClient,
  id: string,
  ownerUserId: string,
  name = 'shared',
  visibility: 'public' | 'private' = 'public',
) {
  await db.insert(agents).values({ id, name, ownerUserId, visibility })
}

describe('RFC-223 AC10 portable import reference resolution', () => {
  let db: DbClient
  let viewer: Actor

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a')
    await seedUser(db, 'owner-b')
    await seedUser(db, 'viewer')
    await seedUser(db, 'admin', 'admin')
    viewer = actor('viewer')
  })

  test('0/1/N: missing is unresolved, one auto-resolves, multiple return visible owner metadata', async () => {
    await expect(
      resolveImportRefs(db, viewer, [{ type: 'agent', name: 'missing' }]),
    ).rejects.toMatchObject({
      code: 'import-ref-unresolved',
      status: 422,
      details: { unresolved: [{ type: 'agent', name: 'missing' }] },
    })

    await seedAgent(db, 'agent-a', 'owner-a')
    const one = await resolveImportRefs(db, viewer, [{ type: 'agent', name: 'shared' }])
    expect(one.bySelector.get(JSON.stringify(['agent', 'shared', null]))).toBe('agent-a')

    await seedAgent(db, 'agent-b', 'owner-b')
    await expect(
      resolveImportRefs(db, viewer, [{ type: 'agent', name: 'shared' }]),
    ).rejects.toMatchObject({
      code: 'import-ref-ambiguous',
      status: 409,
      details: {
        ambiguities: [
          {
            selector: { type: 'agent', name: 'shared' },
            candidates: [
              {
                id: 'agent-a',
                ownerUserId: 'owner-a',
                ownerUsername: 'owner-a',
                visibility: 'public',
              },
              {
                id: 'agent-b',
                ownerUserId: 'owner-b',
                ownerUsername: 'owner-b',
                visibility: 'public',
              },
            ],
          },
        ],
      },
    })
  })

  test('second submit binds the selected id and rechecks visibility/owner/name drift', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')
    await seedAgent(db, 'agent-b', 'owner-b')
    const selection: ImportRefSelection = {
      selector: { type: 'agent', name: 'shared' },
      resourceId: 'agent-b',
    }
    const resolved = await resolveImportRefs(db, viewer, [selection.selector], [selection])
    expect(resolved.bySelector.get(JSON.stringify(['agent', 'shared', null]))).toBe('agent-b')

    await db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, 'agent-b'))
    await expect(
      resolveImportRefs(db, viewer, [selection.selector], [selection]),
    ).rejects.toMatchObject({
      code: 'import-ref-selection-stale',
      status: 409,
      details: {
        selector: { type: 'agent', name: 'shared' },
        ambiguities: [
          {
            selector: { type: 'agent', name: 'shared' },
            candidates: [{ id: 'agent-a', ownerUsername: 'owner-a' }],
          },
        ],
      },
    })
  })

  test('RFC-099 universe includes a private explicit grant but never leaks an ungranted row', async () => {
    await seedAgent(db, 'private-a', 'owner-a', 'private-only', 'private')
    await expect(
      resolveImportRefs(db, viewer, [{ type: 'agent', name: 'private-only' }]),
    ).rejects.toMatchObject({
      code: 'import-ref-unresolved',
      details: { unresolved: [{ type: 'agent', name: 'private-only' }] },
    })

    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: 'private-a',
      userId: 'viewer',
      addedBy: 'owner-a',
      addedAt: 1,
    })
    const granted = await resolveImportRefs(db, viewer, [{ type: 'agent', name: 'private-only' }])
    expect(granted.selections).toEqual([
      {
        selector: { type: 'agent', name: 'private-only' },
        resourceId: 'private-a',
      },
    ])
  })

  test('agent.md managed selectors resolve by owner hint; project skills remain portable names', async () => {
    await db.insert(skills).values({
      id: 'skill-a',
      name: 'lint',
      sourceKind: 'managed',
      ownerUserId: 'owner-a',
      visibility: 'public',
    })
    await db.insert(skills).values({
      id: 'skill-b',
      name: 'lint',
      sourceKind: 'managed',
      ownerUserId: 'owner-b',
      visibility: 'public',
    })
    const result = await resolveAgentImportRefs(db, viewer, {
      skills: [
        { kind: 'managed', name: 'lint', ownerUsername: 'owner-b' },
        { kind: 'project', name: 'repo-lint' },
      ],
      selections: [],
    })
    expect(result.skills).toEqual([
      { kind: 'managed', skillId: 'skill-b' },
      { kind: 'project', name: 'repo-lint' },
    ])
  })

  test('workflow YAML preview mapping persists the selected local id', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')
    await seedAgent(db, 'agent-b', 'owner-b')
    const yamlText = stringify({
      id: 'foreign-workflow',
      name: 'imported',
      description: '',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'n1',
            kind: 'agent-single',
            agentName: 'shared',
          },
        ],
        edges: [],
      },
    })
    await expect(
      importWorkflowYaml(db, { yamlText, mode: 'new' }, { kind: 'actor', actor: viewer }),
    ).rejects.toMatchObject({ code: 'import-ref-ambiguous', status: 409 })

    const result = await importWorkflowYaml(
      db,
      {
        yamlText,
        mode: 'new',
        selections: [
          {
            selector: { type: 'agent', name: 'shared' },
            resourceId: 'agent-b',
          },
        ],
      },
      { kind: 'actor', actor: viewer },
    )
    expect(result.outcome).toBe('created')
    const rows = await db.select().from(workflows)
    const node = JSON.parse(rows[0]!.definition).nodes[0] as Record<string, unknown>
    expect(node.agentId).toBe('agent-b')
    expect(node.agentName).toBe('shared')
    expect(node.agentOwnerUsername).toBeUndefined()
  })

  test('workflow export emits name+owner selectors that re-import without ambiguity', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')
    await seedAgent(db, 'agent-b', 'owner-b')
    const portable = await workflowDefinitionToSelectors(db, viewer, {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'n1',
          kind: 'agent-single',
          agentId: 'agent-b',
          agentName: 'stale-display-name',
        },
      ],
      edges: [],
    } satisfies WorkflowDefinition)
    const exportedNode = portable.nodes[0] as Record<string, unknown>
    expect(exportedNode).toMatchObject({
      agentName: 'shared',
      agentOwnerUsername: 'owner-b',
    })
    expect(exportedNode.agentId).toBeUndefined()

    const result = await importWorkflowYaml(
      db,
      {
        yamlText: stringify({
          name: 'portable-owner',
          description: '',
          definition: portable,
        }),
        mode: 'new',
      },
      { kind: 'actor', actor: viewer },
    )
    expect(result.outcome).toBe('created')
    const row = (await db.select().from(workflows).where(eq(workflows.name, 'portable-owner')))[0]
    const importedNode = JSON.parse(row!.definition).nodes[0] as Record<string, unknown>
    expect(importedNode.agentId).toBe('agent-b')
    expect(importedNode.agentOwnerUsername).toBeUndefined()
  })

  test('admins see all same-name candidates and still must choose explicitly', async () => {
    await seedAgent(db, 'agent-a', 'owner-a', 'private-shared', 'private')
    await seedAgent(db, 'agent-b', 'owner-b', 'private-shared', 'private')
    await expect(
      resolveImportRefs(db, actor('admin', 'admin'), [{ type: 'agent', name: 'private-shared' }]),
    ).rejects.toMatchObject({
      code: 'import-ref-ambiguous',
      details: { ambiguities: [{ candidates: [{ id: 'agent-a' }, { id: 'agent-b' }] }] },
    })
  })
})
