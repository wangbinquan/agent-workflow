// RFC-359 AC1: preserve the existing Agent content encodings while sharing the
// repeated field projection. These database cases ran on the old neutral
// builders before extraction. The synchronous legacy writer remains covered by
// the existing RFC-166 / RFC-060 / RFC-014 and intent branch-port SQLite cases;
// these tests do not claim PostgreSQL can execute that physical InTx mechanism.

import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import ts from 'typescript'
import { ZodError } from 'zod'
import type { CreateAgent } from '@agent-workflow/shared'
import { agents, users } from '@/db/schema'
import {
  agentContentPersistenceValues,
  agentFromPersistenceRow,
  createAgentPersistenceValues,
  updateAgentPersistenceValues,
  type AgentPersistenceRow,
} from '@/modules/resource-catalog/infrastructure/agentPersistence'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'agent-values-owner'
const T0 = 1_700_000_000_000

function input(): CreateAgent {
  return {
    name: 'agent-values',
    description: 'original description',
    outputs: ['report', 'done'],
    inputs: [{ name: 'source', kind: 'markdown', required: true }],
    syncOutputsOnIterate: true,
    runtime: 'runtime-one',
    permission: {},
    skills: [
      { kind: 'managed', skillId: 'skill-b' },
      { kind: 'project', name: 'notes' },
      { kind: 'managed', skillId: 'skill-a' },
    ],
    dependsOn: ['dependency-b', 'dependency-a'],
    mcp: ['mcp-b', 'mcp-a'],
    plugins: ['plugin-b', 'plugin-a'],
    frontmatterExtra: { tag: 'kept', nested: { count: 2 } },
    outputKinds: { report: 'path<md>', done: 'signal' },
    role: 'aggregator',
    outputWrapperPortNames: { report: 'final' },
    branchPorts: ['done'],
    bodyMd: '# Agent\ncontent\n',
  }
}

const expectedRow: AgentPersistenceRow = {
  id: 'agent-values',
  name: 'agent-values',
  description: 'original description',
  outputs: '["report","done"]',
  inputs: '[{"name":"source","kind":"markdown","required":true}]',
  syncOutputsOnIterate: true,
  runtime: 'runtime-one',
  permission: '{}',
  skills:
    '[{"kind":"managed","skillId":"skill-b"},{"kind":"project","name":"notes"},{"kind":"managed","skillId":"skill-a"}]',
  dependsOn: '["dependency-b","dependency-a"]',
  mcp: '["mcp-b","mcp-a"]',
  plugins: '["plugin-b","plugin-a"]',
  frontmatterExtra:
    '{"tag":"kept","nested":{"count":2},"outputKinds":{"report":"path<md>","done":"signal"},"role":"aggregator","outputWrapperPortNames":{"report":"final"},"branchPorts":["done"]}',
  bodyMd: '# Agent\ncontent\n',
  ownerUserId: OWNER,
  visibility: 'private',
  aclRevision: 0,
  builtin: false,
  schemaVersion: 1,
  createdAt: T0,
  updatedAt: T0,
}

async function readRow(db: DatabaseTransaction, id = expectedRow.id) {
  const row = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (row === undefined) throw new Error(`agent values fixture row disappeared: ${id}`)
  return row
}

describeEachProvider('RFC-359 Agent write values on real databases', (harness) => {
  beforeEach(async () => {
    await harness.db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: OWNER,
      role: 'admin',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    })
  })

  async function create(agent = input()) {
    return await harness.session.transaction(async (tx) => {
      await tx
        .insert(agents)
        .values(
          createAgentPersistenceValues({ id: expectedRow.id, agent, ownerUserId: OWNER, now: T0 }),
        )
      return await readRow(tx)
    })
  }

  test('create preserves every stored field, ordered refs, raw JSON and supplied timestamp', async () => {
    expect(await create()).toEqual(expectedRow)
    expect(await readRow(harness.db)).toEqual(expectedRow)
  })

  test('create canonicalizes raw input ports before storing their own column', async () => {
    const agent = input()
    // Exercise the existing writer boundary without first normalizing its data.
    Reflect.set(agent, 'inputs', [{ name: 'source', unknown: 'discard' }])
    const expected = { ...expectedRow, inputs: '[{"name":"source","kind":"string"}]' }
    expect(await create(agent)).toEqual(expected)
    expect(await readRow(harness.db)).toEqual(expected)
  })

  for (const branchPorts of [undefined, []]) {
    test(`create with ${JSON.stringify(branchPorts)} branch ports keeps the neutral sidecar bytes`, async () => {
      const agent = input()
      delete agent.inputs
      delete agent.runtime
      delete agent.outputKinds
      delete agent.role
      delete agent.outputWrapperPortNames
      delete agent.branchPorts
      if (branchPorts !== undefined) agent.branchPorts = branchPorts
      agent.syncOutputsOnIterate = false
      expect(await create(agent)).toEqual({
        ...expectedRow,
        inputs: '[]',
        runtime: null,
        syncOutputsOnIterate: false,
        frontmatterExtra: '{"tag":"kept","nested":{"count":2}}',
      })
    })
  }

  test('a sparse submitted patch still rewrites the complete neutral content projection', async () => {
    await create()
    const rawInputs = '[{"name":"source", "unknown":"old raw bytes"}]'
    await harness.db.update(agents).set({ inputs: rawInputs }).where(eq(agents.id, expectedRow.id))
    const original = await readRow(harness.db)
    expect(original.inputs).toBe(rawInputs)
    await harness.session.transaction(async (tx) => {
      const current = agentFromPersistenceRow(await readRow(tx))
      await tx
        .update(agents)
        .set(updateAgentPersistenceValues(current, { description: 'changed' }, T0 + 7))
        .where(eq(agents.id, current.id))
    })
    expect(await readRow(harness.db)).toEqual({
      ...expectedRow,
      description: 'changed',
      inputs: '[{"name":"source","kind":"string"}]',
      updatedAt: T0 + 7,
    })
  })

  test('explicit clearing keeps empty sidecar maps, clears runtime and preserves row metadata', async () => {
    await create()
    await harness.session.transaction(async (tx) => {
      const current = agentFromPersistenceRow(await readRow(tx))
      await tx
        .update(agents)
        .set(
          updateAgentPersistenceValues(
            current,
            {
              description: 'cleared',
              outputs: [],
              inputs: [],
              syncOutputsOnIterate: false,
              runtime: null,
              skills: [],
              dependsOn: [],
              mcp: [],
              plugins: [],
              frontmatterExtra: { replacement: true },
              outputKinds: {},
              role: 'normal',
              outputWrapperPortNames: {},
              branchPorts: [],
              bodyMd: '',
            },
            T0 + 11,
          ),
        )
        .where(eq(agents.id, current.id))
    })
    expect(await readRow(harness.db)).toEqual({
      ...expectedRow,
      description: 'cleared',
      outputs: '[]',
      inputs: '[]',
      syncOutputsOnIterate: false,
      runtime: null,
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{"replacement":true,"outputKinds":{},"outputWrapperPortNames":{}}',
      bodyMd: '',
      updatedAt: T0 + 11,
    })
  })

  test('an outer abort rolls back both a newly inserted row and its subsequent update', async () => {
    const failure = new Error('abort created Agent transaction')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.insert(agents).values(
          createAgentPersistenceValues({
            id: expectedRow.id,
            agent: input(),
            ownerUserId: OWNER,
            now: T0,
          }),
        )
        expect(await readRow(tx)).toEqual(expectedRow)
        await tx
          .update(agents)
          .set(
            updateAgentPersistenceValues(
              agentFromPersistenceRow(await readRow(tx)),
              { description: 'transaction only' },
              T0 + 3,
            ),
          )
          .where(eq(agents.id, expectedRow.id))
        expect(await readRow(tx)).toEqual({
          ...expectedRow,
          description: 'transaction only',
          updatedAt: T0 + 3,
        })
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await harness.db.select().from(agents).where(eq(agents.id, expectedRow.id)).get()).toBe(
      undefined,
    )
  })

  test('an outer abort preserves all original bytes after a full update', async () => {
    await create()
    const failure = new Error('abort existing Agent transaction')
    await expect(
      harness.session.transaction(async (tx) => {
        const current = agentFromPersistenceRow(await readRow(tx))
        await tx
          .update(agents)
          .set(updateAgentPersistenceValues(current, { inputs: [], runtime: null }, T0 + 5))
          .where(eq(agents.id, current.id))
        expect((await readRow(tx)).inputs).toBe('[]')
        expect((await readRow(tx)).runtime).toBe(null)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await readRow(harness.db)).toEqual(expectedRow)
  })

  test('invalid inputs fail before cyclic frontmatter and roll back prior writes', async () => {
    await create()
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    await expect(
      harness.session.transaction(async (tx) => {
        await tx
          .update(agents)
          .set({ description: 'not committed' })
          .where(eq(agents.id, expectedRow.id))
        const current = agentFromPersistenceRow(await readRow(tx))
        updateAgentPersistenceValues(
          current,
          {
            inputs: [
              { name: 'duplicate', kind: 'string' },
              { name: 'duplicate', kind: 'markdown' },
            ],
            frontmatterExtra: cycle,
          },
          T0 + 9,
        )
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(await readRow(harness.db)).toEqual(expectedRow)
  })

  test('output encoding still fails before input validation and writes no row', async () => {
    const agent = input()
    const failure = new Error('outputs encoded first')
    Object.defineProperty(agent.outputs, 'toJSON', {
      value: () => {
        throw failure
      },
    })
    agent.inputs = [
      { name: 'duplicate', kind: 'string' },
      { name: 'duplicate', kind: 'markdown' },
    ]
    await expect(create(agent)).rejects.toBe(failure)
    expect(await harness.db.select().from(agents).where(eq(agents.id, expectedRow.id)).get()).toBe(
      undefined,
    )
  })
})

test('prepared legacy refs and empty branch sidecars encode without reading replaced input fields', () => {
  const agent = input()
  const unexpected = new Error('unrelated input getter was evaluated')
  for (const key of ['skills', 'dependsOn', 'mcp', 'plugins', 'unrelated']) {
    Object.defineProperty(agent, key, {
      enumerable: true,
      get: () => {
        throw unexpected
      },
    })
  }
  expect(
    agentContentPersistenceValues(
      agent,
      { tag: 'prepared', branchPorts: [] },
      {
        skills: [{ kind: 'managed', skillId: 'resolved-skill' }],
        dependsOn: ['resolved-agent'],
        mcp: ['resolved-mcp'],
        plugins: ['resolved-plugin'],
      },
    ),
  ).toEqual({
    description: expectedRow.description,
    outputs: expectedRow.outputs,
    inputs: expectedRow.inputs,
    syncOutputsOnIterate: expectedRow.syncOutputsOnIterate,
    runtime: expectedRow.runtime,
    permission: expectedRow.permission,
    skills: '[{"kind":"managed","skillId":"resolved-skill"}]',
    dependsOn: '["resolved-agent"]',
    mcp: '["resolved-mcp"]',
    plugins: '["resolved-plugin"]',
    frontmatterExtra: '{"tag":"prepared","branchPorts":[]}',
    bodyMd: expectedRow.bodyMd,
  })
})

test('input validation precedes prepared frontmatter encoding and later input getters', () => {
  const agent = input()
  agent.inputs = [
    { name: 'duplicate', kind: 'string' },
    { name: 'duplicate', kind: 'markdown' },
  ]
  const touched: string[] = []
  Object.defineProperty(agent, 'bodyMd', {
    enumerable: true,
    get: () => {
      touched.push('bodyMd')
      throw new Error('body read too early')
    },
  })
  const preparedFrontmatter = {
    toJSON() {
      touched.push('frontmatter')
      throw new Error('frontmatter encoded too early')
    },
  }
  expect(() => agentContentPersistenceValues(agent, preparedFrontmatter)).toThrow(ZodError)
  expect(touched).toEqual([])
})

test('all three full content writers delegate while legacy sparse preparation stays separate', () => {
  const common = ts.createSourceFile(
    'agentPersistence.ts',
    readFileSync(
      new URL(
        '../src/modules/resource-catalog/infrastructure/agentPersistence.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  )
  const legacy = ts.createSourceFile(
    'legacy/agent.ts',
    readFileSync(
      new URL('../src/modules/resource-catalog/infrastructure/legacy/agent.ts', import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  )
  function declaration(source: ts.SourceFile, name: string) {
    const result = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    if (result === undefined) throw new Error(`missing writer function: ${name}`)
    return result
  }
  function callArguments(
    source: ts.SourceFile,
    name: string,
    called = 'agentContentPersistenceValues',
  ) {
    const result: string[][] = []
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === called
      ) {
        result.push(node.arguments.map((arg) => arg.getText(source).replace(/\s/g, '')))
      }
      ts.forEachChild(node, visit)
    }
    visit(declaration(source, name))
    return result
  }
  expect(callArguments(common, 'createAgentPersistenceValues')).toEqual([['candidate']])
  expect(callArguments(common, 'updateAgentPersistenceValues')).toEqual([['next']])
  expect(callArguments(legacy, 'commitAgentCreate')).toEqual([
    ['input', 'fmExtra', '{skills:skillRefs,dependsOn:dependsOnIds,mcp:mcpIds,plugins:pluginIds,}'],
  ])
  expect(callArguments(legacy, 'commitAgentCreateInTx', 'commitAgentCreate')).toEqual([
    ['tx', 'p', '(actor,groups)=>assertRefsUsableInTx(tx,actor,groups)'],
  ])
  expect(callArguments(legacy, 'createAgent', 'commitAgentCreate')).toEqual([
    ['tx', 'prepared', '(actor,groups)=>assertRefsUsableForTx(tx,actor,groups)'],
  ])
  expect(callArguments(legacy, 'commitAgentCreateInTx')).toEqual([])
  expect(callArguments(legacy, 'createAgent')).toEqual([])
  expect(callArguments(legacy, 'prepareAgentUpdate')).toEqual([])
  for (const name of ['serializeInputs', 'serializeSkillRefs']) {
    expect(
      legacy.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name),
    ).toBe(false)
  }
})
