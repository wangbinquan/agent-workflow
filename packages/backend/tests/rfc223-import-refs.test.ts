import ts from 'typescript'
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stringify } from 'yaml'
import type { ImportRefSelection, WorkflowDefinition } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, skills, users, workflows } from '../src/db/schema'
import {
  resolveAgentImportRefs,
  resolveImportRefs,
} from '../src/modules/resource-catalog/infrastructure/legacy/importRefs'
import { importWorkflowYaml, workflowDefinitionToSelectors } from '../src/services/workflow.yaml'

function assertImportRefTransactionAwaiting(source: string): void {
  const file = ts.createSourceFile('importRefs.ts', source, ts.ScriptTarget.Latest, true)
  const identifier = (node: ts.Node | undefined): string =>
    node && ts.isIdentifier(node) ? node.text : '<expression>'
  const functionByName = (name: string): ts.FunctionDeclaration => {
    const matches = file.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    const fn = matches[0]
    if (matches.length !== 1 || !fn?.body) throw new Error(`Expected one body for ${name}`)
    expect(fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)).toBe(
      true,
    )
    return fn
  }
  const outer = functionByName('resolveImportRefs')
  const returns = outer.body?.statements.filter(ts.isReturnStatement) ?? []
  const result = returns[0]?.expression
  if (returns.length !== 1 || !result || !ts.isAwaitExpression(result)) {
    throw new Error('resolveImportRefs must return the awaited transaction')
  }
  const transaction = result.expression
  if (
    !ts.isCallExpression(transaction) ||
    !ts.isPropertyAccessExpression(transaction.expression) ||
    !ts.isCallExpression(transaction.expression.expression)
  ) {
    throw new Error('Expected the databaseSessionFor transaction call')
  }
  const session = transaction.expression.expression
  expect(transaction.expression.name.text).toBe('transaction')
  expect(identifier(session.expression)).toBe('databaseSessionFor')
  expect(session.arguments.map(identifier)).toEqual(['db'])
  expect(transaction.arguments).toHaveLength(1)
  const callback = transaction.arguments[0]
  if (!callback || !ts.isArrowFunction(callback) || !ts.isAwaitExpression(callback.body)) {
    throw new Error('Expected the transaction callback to await its delegate')
  }
  expect(callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)).toBe(
    true,
  )
  expect(callback.parameters.map((parameter) => identifier(parameter.name))).toEqual(['tx'])
  const delegate = callback.body.expression
  if (!ts.isCallExpression(delegate)) throw new Error('Expected the transaction delegate call')
  expect(identifier(delegate.expression)).toBe('resolveImportRefsInTx')
  expect(delegate.arguments.map(identifier)).toEqual([
    'tx',
    'actor',
    'selectors',
    'requestedSelections',
  ])

  const asyncDelegates = new Set([
    'assertSelectedIdsVisibleInTx',
    'buildCandidateSnapshotsInTx',
    'grantedIdsInTx',
    'listAclResourceIdentityRowsByIds',
    'listAclResourceIdentityRowsByNames',
    'listGrantedResourceIds',
  ])
  const reads: string[] = []
  for (const name of [
    'resolveImportRefsInTx',
    'assertSelectedIdsVisibleInTx',
    'buildCandidateSnapshotsInTx',
    'grantedIdsInTx',
  ]) {
    const fn = functionByName(name)
    expect(identifier(fn.parameters[0]?.name)).toBe('tx')
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        let root: ts.Expression = node
        const chain: string[] = []
        while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression)) {
          chain.unshift(`${root.expression.name.text}/${root.arguments.length}`)
          root = root.expression.expression
        }
        const directDelegate =
          ts.isIdentifier(node.expression) && asyncDelegates.has(node.expression.text)
        const queryTerminal =
          ts.isPropertyAccessExpression(node.expression) &&
          ['all', 'get', 'run', 'execute', 'values'].includes(node.expression.name.text) &&
          chain.some((step) => step.startsWith('select/'))
        if (directDelegate || queryTerminal) {
          let scope: ts.Node | undefined = node.parent
          while (scope && !ts.isFunctionLike(scope)) scope = scope.parent
          expect(scope === fn).toBe(true)
          expect(ts.isAwaitExpression(node.parent)).toBe(true)
          expect(identifier(directDelegate ? node.arguments[0] : root)).toBe('tx')
          reads.push(
            directDelegate
              ? `${name}:${identifier(node.expression)}(${node.arguments.map(identifier).join(',')})`
              : `${name}:${identifier(root)}.${chain.join('.')}`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    if (fn.body) visit(fn.body)
  }
  expect(reads).toEqual([
    'resolveImportRefsInTx:assertSelectedIdsVisibleInTx(tx,actor,<expression>)',
    'resolveImportRefsInTx:buildCandidateSnapshotsInTx(tx,actor,uniqueSelectors)',
    'assertSelectedIdsVisibleInTx:listAclResourceIdentityRowsByIds(tx,type,selectedIds)',
    'assertSelectedIdsVisibleInTx:grantedIdsInTx(tx,actor,type)',
    'buildCandidateSnapshotsInTx:listAclResourceIdentityRowsByNames(tx,type,names)',
    'buildCandidateSnapshotsInTx:grantedIdsInTx(tx,actor,type)',
    'buildCandidateSnapshotsInTx:tx.select/1.from/1.where/1.all/0',
    'grantedIdsInTx:listGrantedResourceIds(tx,actor,type)',
  ])
}

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

function portableWorkflowYaml(input?: { id?: string; name?: string; agentName?: string }): string {
  return stringify({
    ...(input?.id === undefined ? {} : { id: input.id }),
    name: input?.name ?? 'import-race',
    description: '',
    definition: {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'n1',
          kind: 'agent-single',
          agentName: input?.agentName ?? 'shared',
        },
      ],
      edges: [],
    },
  })
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

  test('candidate, grant, and owner reads stay on the asynchronous transaction surface', () => {
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/resource-catalog/infrastructure/legacy/importRefs.ts',
      ),
      'utf8',
    )
    expect(source).toContain(
      `return await databaseSessionFor(db).transaction(
    async (tx) => await resolveImportRefsInTx(tx, actor, selectors, requestedSelections),
  )`,
    )
    const syncCore = source.slice(
      source.indexOf('function resolveImportRefsInTx('),
      source.indexOf('function ownerUsernameFor('),
    )
    assertImportRefTransactionAwaiting(source)
    expect(syncCore).not.toContain('filterVisibleRows')
    expect(syncCore).toContain('.all()')
  })

  test('second submit binds the selected id but hides a now-invisible selection as unresolved', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')
    await seedAgent(db, 'agent-b', 'owner-b')
    const selection: ImportRefSelection = {
      selector: { type: 'agent', name: 'shared' },
      resourceId: 'agent-b',
      expectedAclRevision: 0,
    }
    const resolved = await resolveImportRefs(db, viewer, [selection.selector], [selection])
    expect(resolved.bySelector.get(JSON.stringify(['agent', 'shared', null]))).toBe('agent-b')

    await db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, 'agent-b'))
    await expect(
      resolveImportRefs(db, viewer, [selection.selector], [selection]),
    ).rejects.toMatchObject({
      code: 'import-ref-unresolved',
      status: 422,
      details: {
        unresolved: [{ type: 'agent', name: 'shared' }],
      },
    })
  })

  test('second submit rejects same-id ACL revision drift and returns the fresh candidates', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')
    const selection: ImportRefSelection = {
      selector: { type: 'agent', name: 'shared' },
      resourceId: 'agent-a',
      expectedAclRevision: 0,
    }
    await db.update(agents).set({ aclRevision: 1 }).where(eq(agents.id, 'agent-a'))

    await expect(
      resolveImportRefs(db, viewer, [selection.selector], [selection]),
    ).rejects.toMatchObject({
      code: 'import-ref-selection-stale',
      status: 409,
      details: {
        ambiguities: [
          {
            selector: selection.selector,
            candidates: [{ id: 'agent-a', aclRevision: 1 }],
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
        expectedAclRevision: 0,
      },
    ])
  })

  test('agent.md managed selectors resolve by owner hint; project skills remain portable names', async () => {
    await db.insert(skills).values({
      id: 'skill-a',
      name: 'lint',
      ownerUserId: 'owner-a',
      visibility: 'public',
    })
    await db.insert(skills).values({
      id: 'skill-b',
      name: 'lint',
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
            expectedAclRevision: 0,
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

  test('create import rejects public-to-private drift in the final write transaction with zero writes', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')

    await expect(
      importWorkflowYaml(
        db,
        { yamlText: portableWorkflowYaml(), mode: 'new' },
        { kind: 'actor', actor: viewer },
        {
          afterResolve: async () => {
            await db
              .update(agents)
              .set({ visibility: 'private', aclRevision: 1 })
              .where(eq(agents.id, 'agent-a'))
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'import-ref-unresolved',
      status: 422,
      details: { unresolved: [{ type: 'agent', name: 'shared' }] },
    })
    expect(await db.select().from(workflows)).toHaveLength(0)
  })

  test('create import rejects same-id owner transfer and exposes only the fresh visible candidate', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')

    await expect(
      importWorkflowYaml(
        db,
        { yamlText: portableWorkflowYaml(), mode: 'new' },
        { kind: 'actor', actor: viewer },
        {
          afterResolve: async () => {
            await db
              .update(agents)
              .set({ ownerUserId: 'owner-b', aclRevision: 1 })
              .where(eq(agents.id, 'agent-a'))
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'import-ref-selection-stale',
      status: 409,
      details: {
        ambiguities: [
          {
            selector: { type: 'agent', name: 'shared' },
            candidates: [
              {
                id: 'agent-a',
                ownerUserId: 'owner-b',
                ownerUsername: 'owner-b',
                visibility: 'public',
                aclRevision: 1,
              },
            ],
          },
        ],
      },
    })
    expect(await db.select().from(workflows)).toHaveLength(0)
  })

  test('create import rejects a selected-id rename with an empty fresh candidate set and zero writes', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')

    await expect(
      importWorkflowYaml(
        db,
        { yamlText: portableWorkflowYaml(), mode: 'new' },
        { kind: 'actor', actor: viewer },
        {
          afterResolve: async () => {
            await db.update(agents).set({ name: 'renamed' }).where(eq(agents.id, 'agent-a'))
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'import-ref-selection-stale',
      status: 409,
      details: {
        ambiguities: [
          {
            selector: { type: 'agent', name: 'shared' },
            candidates: [],
          },
        ],
      },
    })
    expect(await db.select().from(workflows)).toHaveLength(0)
  })

  test('create import rejects private-grant revocation as unresolved and writes nothing', async () => {
    await seedAgent(db, 'agent-a', 'owner-a', 'shared', 'private')
    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: 'agent-a',
      userId: 'viewer',
      addedBy: 'owner-a',
      addedAt: 1,
    })

    await expect(
      importWorkflowYaml(
        db,
        { yamlText: portableWorkflowYaml(), mode: 'new' },
        { kind: 'actor', actor: viewer },
        {
          afterResolve: async () => {
            await db.delete(resourceGrants).where(eq(resourceGrants.resourceId, 'agent-a'))
            await db.update(agents).set({ aclRevision: 1 }).where(eq(agents.id, 'agent-a'))
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'import-ref-unresolved',
      status: 422,
      details: { unresolved: [{ type: 'agent', name: 'shared' }] },
    })
    expect(await db.select().from(workflows)).toHaveLength(0)
  })

  test('auto-resolved 1-to-N drift becomes ambiguous inside the create transaction', async () => {
    await seedAgent(db, 'agent-a', 'owner-a')

    await expect(
      importWorkflowYaml(
        db,
        { yamlText: portableWorkflowYaml(), mode: 'new' },
        { kind: 'actor', actor: viewer },
        {
          afterResolve: async () => {
            await seedAgent(db, 'agent-b', 'owner-b')
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'import-ref-ambiguous',
      status: 409,
      details: {
        ambiguities: [
          {
            selector: { type: 'agent', name: 'shared' },
            candidates: [{ id: 'agent-a' }, { id: 'agent-b' }],
          },
        ],
      },
    })
    expect(await db.select().from(workflows)).toHaveLength(0)
  })

  test('overwrite import rechecks grant visibility in its CAS transaction and preserves the target', async () => {
    await seedAgent(db, 'agent-a', 'owner-a', 'shared', 'private')
    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: 'agent-a',
      userId: 'viewer',
      addedBy: 'owner-a',
      addedAt: 1,
    })
    const originalDefinition = JSON.stringify({
      $schema_version: 4,
      inputs: [],
      nodes: [],
      edges: [],
    })
    await db.insert(workflows).values({
      id: 'workflow-target',
      name: 'before-import',
      description: 'untouched',
      definition: originalDefinition,
      version: 1,
      ownerUserId: 'viewer',
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    })

    await expect(
      importWorkflowYaml(
        db,
        {
          yamlText: portableWorkflowYaml({
            id: 'workflow-target',
            name: 'after-import',
          }),
          mode: 'overwrite',
          overwrite: {
            workflowId: 'workflow-target',
            expectedVersion: 1,
            clientMutationId: ulid(),
          },
        },
        { kind: 'actor', actor: viewer },
        {
          afterResolve: async () => {
            await db.delete(resourceGrants).where(eq(resourceGrants.resourceId, 'agent-a'))
            await db.update(agents).set({ aclRevision: 1 }).where(eq(agents.id, 'agent-a'))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'import-ref-unresolved', status: 422 })

    const target = (await db.select().from(workflows).where(eq(workflows.id, 'workflow-target')))[0]
    expect(target).toMatchObject({
      name: 'before-import',
      description: 'untouched',
      definition: originalDefinition,
      version: 1,
    })
  })

  test('stale-version logical-same overwrite cannot bypass the final reference guard', async () => {
    await seedAgent(db, 'agent-a', 'owner-a', 'shared', 'private')
    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: 'agent-a',
      userId: 'viewer',
      addedBy: 'owner-a',
      addedAt: 1,
    })
    const currentDefinition = JSON.stringify({
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'n1',
          kind: 'agent-single',
          agentId: 'agent-a',
          agentName: 'shared',
        },
      ],
      edges: [],
    })
    await db.insert(workflows).values({
      id: 'logical-same-target',
      name: 'logical-same',
      description: '',
      definition: currentDefinition,
      version: 2,
      ownerUserId: 'viewer',
      visibility: 'public',
      createdAt: 1,
      updatedAt: 2,
    })

    await expect(
      importWorkflowYaml(
        db,
        {
          yamlText: portableWorkflowYaml({
            id: 'logical-same-target',
            name: 'logical-same',
          }),
          mode: 'overwrite',
          overwrite: {
            workflowId: 'logical-same-target',
            expectedVersion: 1,
            clientMutationId: ulid(),
          },
        },
        { kind: 'actor', actor: viewer },
        {
          afterResolve: async () => {
            await db.delete(resourceGrants).where(eq(resourceGrants.resourceId, 'agent-a'))
            await db.update(agents).set({ aclRevision: 1 }).where(eq(agents.id, 'agent-a'))
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'import-ref-unresolved',
      status: 422,
      details: { unresolved: [{ type: 'agent', name: 'shared' }] },
    })

    const target = (
      await db.select().from(workflows).where(eq(workflows.id, 'logical-same-target'))
    )[0]
    expect(target).toMatchObject({
      name: 'logical-same',
      definition: currentDefinition,
      version: 2,
    })
  })
})
