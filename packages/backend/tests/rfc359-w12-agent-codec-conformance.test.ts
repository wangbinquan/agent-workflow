// RFC-359 AC1: preserve both established Agent row-decoding contracts while
// removing the duplicate projection. These cases ran against both old entry
// points before extraction; database rows remain real on each selected provider.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import ts from 'typescript'
import type { Agent } from '@agent-workflow/shared'
import { agents } from '@/db/schema'
import {
  agentFromPersistenceRow,
  type AgentPersistenceRow,
} from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { rowToAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000
const baseRow: AgentPersistenceRow = {
  id: 'agent-codec',
  name: 'agent-codec',
  description: 'stored description',
  outputs: '["report","done"]',
  inputs: '[]',
  syncOutputsOnIterate: false,
  runtime: null,
  permission: '{}',
  skills: '[]',
  dependsOn: '[]',
  mcp: '[]',
  plugins: '[]',
  frontmatterExtra: '{}',
  bodyMd: '# Stored agent\n',
  ownerUserId: null,
  visibility: 'public',
  aclRevision: 7,
  builtin: true,
  schemaVersion: 3,
  createdAt: T0,
  updatedAt: T0 + 8,
}
const baseAgent: Agent = {
  id: 'agent-codec',
  name: 'agent-codec',
  description: 'stored description',
  outputs: ['report', 'done'],
  inputs: [],
  syncOutputsOnIterate: false,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '# Stored agent\n',
  ownerUserId: null,
  visibility: 'public',
  aclRevision: 7,
  builtin: true,
  schemaVersion: 3,
  createdAt: T0,
  updatedAt: T0 + 8,
}
const decoders = [agentFromPersistenceRow, rowToAgent]

describeEachProvider('RFC-359 Agent row codec preservation', (harness) => {
  async function persisted(patch: Partial<AgentPersistenceRow> = {}) {
    const row = { ...baseRow, ...patch }
    await harness.db.insert(agents).values(row)
    const loaded = await harness.db.select().from(agents).where(eq(agents.id, row.id)).get()
    if (loaded === undefined) throw new Error('agent codec fixture row disappeared')
    expect(loaded).toEqual(row)
    return Object.freeze(loaded)
  }

  test('both entry points project every stored field and lift all four sidecars', async () => {
    const row = await persisted({
      inputs: '[{"name":"source","kind":"markdown","required":true}]',
      syncOutputsOnIterate: true,
      runtime: 'registered-runtime',
      skills: '[{"kind":"managed","skillId":"skill-id"},{"kind":"project","name":"notes"}]',
      dependsOn: '["dependency-id"]',
      mcp: '["mcp-id"]',
      plugins: '["plugin-id"]',
      frontmatterExtra: JSON.stringify({
        tag: 'kept',
        nested: { counter: 2 },
        outputKinds: { report: 'path<md>', done: 'signal' },
        role: 'aggregator',
        outputWrapperPortNames: { report: 'final' },
        branchPorts: ['done'],
      }),
    })
    const expected: Agent = {
      ...baseAgent,
      inputs: [{ name: 'source', kind: 'markdown', required: true }],
      syncOutputsOnIterate: true,
      runtime: 'registered-runtime',
      skills: [
        { kind: 'managed', skillId: 'skill-id' },
        { kind: 'project', name: 'notes' },
      ],
      dependsOn: ['dependency-id'],
      mcp: ['mcp-id'],
      plugins: ['plugin-id'],
      frontmatterExtra: { tag: 'kept', nested: { counter: 2 } },
      outputKinds: { report: 'path<md>', done: 'signal' },
      role: 'aggregator',
      outputWrapperPortNames: { report: 'final' },
      branchPorts: ['done'],
    }
    for (const decode of decoders) expect(decode(row)).toEqual(expected)
    expect(await harness.db.select().from(agents).where(eq(agents.id, row.id)).get()).toEqual(row)
  })

  for (const runtime of [null, '', 'custom-runtime']) {
    test(`runtime ${JSON.stringify(runtime)} retains its value or stays absent`, async () => {
      const row = await persisted({ runtime })
      for (const decode of decoders) {
        const agent = decode(row)
        if (runtime === null || runtime === '') {
          expect(agent).toEqual(baseAgent)
          expect(Object.hasOwn(agent, 'runtime')).toBe(false)
        } else {
          expect(agent).toEqual({ ...baseAgent, runtime })
        }
      }
    })
  }

  test('absent sidecars and explicit empty tombstones all stay absent on the DTO', async () => {
    const row = await persisted({
      frontmatterExtra: JSON.stringify({
        kept: 1,
        outputKinds: {},
        role: 'normal',
        outputWrapperPortNames: {},
        branchPorts: [],
      }),
    })
    for (const decode of decoders) {
      const agent = decode(row)
      expect(agent).toEqual({ ...baseAgent, frontmatterExtra: { kept: 1 } })
      for (const key of ['outputKinds', 'role', 'outputWrapperPortNames', 'branchPorts']) {
        expect(Object.hasOwn(agent, key)).toBe(false)
        expect(Object.hasOwn(decode(baseRow), key)).toBe(false)
      }
    }
  })

  test('sidecar maps drop non-string and empty values, preserving list order and duplicates', async () => {
    const row = await persisted({
      frontmatterExtra: JSON.stringify({
        kept: ['x'],
        outputKinds: { report: 'path<md>', blank: '', invalid: 1, none: null },
        role: 'unrecognized',
        outputWrapperPortNames: { report: 'final', blank: '', invalid: false, none: null },
        branchPorts: ['done', '', 1, null, 'done'],
      }),
    })
    for (const decode of decoders) {
      expect(decode(row)).toEqual({
        ...baseAgent,
        frontmatterExtra: { kept: ['x'] },
        outputKinds: { report: 'path<md>' },
        outputWrapperPortNames: { report: 'final' },
        branchPorts: ['done', 'done'],
      })
    }
  })

  for (const value of [null, false, 4, 'not-a-map']) {
    test(`non-object sidecar maps ${JSON.stringify(value)} remain omitted`, async () => {
      const row = await persisted({
        frontmatterExtra: JSON.stringify({
          outputKinds: value,
          outputWrapperPortNames: value,
          branchPorts: value,
        }),
      })
      for (const decode of decoders) expect(decode(row)).toEqual(baseAgent)
    })
  }

  test('stored-json sidecar arrays retain numeric keys while normalized maps omit them', async () => {
    const row = await persisted({
      frontmatterExtra: JSON.stringify({
        kept: true,
        outputKinds: ['path<md>', '', 'signal', null],
        outputWrapperPortNames: ['first', false, 'last'],
      }),
    })
    expect(rowToAgent(row)).toEqual({
      ...baseAgent,
      frontmatterExtra: { kept: true },
      outputKinds: { '0': 'path<md>', '2': 'signal' },
      outputWrapperPortNames: { '0': 'first', '2': 'last' },
    })
    expect(agentFromPersistenceRow(row)).toEqual({
      ...baseAgent,
      frontmatterExtra: { kept: true },
    })
  })

  test('input decoding supplies defaults, strips unknown keys and preserves duplicate names', async () => {
    const row = await persisted({
      inputs:
        '[{"name":"same","ignored":1},{"name":"same","kind":"markdown","required":false,"description":"kept"}]',
    })
    for (const decode of decoders) {
      expect(decode(row).inputs).toEqual([
        { name: 'same', kind: 'string' },
        { name: 'same', kind: 'markdown', required: false, description: 'kept' },
      ])
    }
  })

  for (const inputs of ['', 'not-json', 'null', '{}', '[42]', '[{"name":"x"},{"name":""}]']) {
    test(`invalid inputs ${JSON.stringify(inputs)} become an empty list`, async () => {
      const row = await persisted({ inputs })
      for (const decode of decoders) expect(decode(row).inputs).toEqual([])
    })
  }

  test('skill refs retain only valid managed/project records and preserve their order', async () => {
    const row = await persisted({
      skills:
        '[{"kind":"managed","skillId":"skill-id","ignored":true},{"kind":"project","name":"notes"},null,"old-name",{"kind":"managed","skillId":""},{"kind":"unknown"},{"kind":"project","name":"notes"}]',
    })
    for (const decode of decoders) {
      expect(decode(row).skills).toEqual([
        { kind: 'managed', skillId: 'skill-id' },
        { kind: 'project', name: 'notes' },
        { kind: 'project', name: 'notes' },
      ])
    }
  })

  for (const raw of ['', 'not-json', 'null', '{}', 'false', '42']) {
    test(`invalid reference columns ${JSON.stringify(raw)} become empty lists`, async () => {
      const row = await persisted({ skills: raw, dependsOn: raw, mcp: raw, plugins: raw })
      for (const decode of decoders) {
        const agent = decode(row)
        expect([agent.skills, agent.dependsOn, agent.mcp, agent.plugins]).toEqual([[], [], [], []])
      }
    })
  }

  test('string reference columns filter by type and preserve empty strings and duplicates', async () => {
    const raw = '["first",42,null,"","first"]'
    const row = await persisted({ dependsOn: raw, mcp: raw, plugins: raw })
    for (const decode of decoders) {
      const agent = decode(row)
      expect([agent.dependsOn, agent.mcp, agent.plugins]).toEqual([
        ['first', '', 'first'],
        ['first', '', 'first'],
        ['first', '', 'first'],
      ])
    }
  })

  test('outputs retain stored JSON values on the old entry and strings on the normalized entry', async () => {
    const outputs = '["report",42,null,"","report"]'
    const row = await persisted({ outputs })
    expect(JSON.stringify(rowToAgent(row).outputs)).toBe(outputs)
    expect(agentFromPersistenceRow(row).outputs).toEqual(['report', '', 'report'])
  })

  for (const outputs of ['null', '{}', 'false', '42', '"stored-text"']) {
    test(`non-array outputs ${outputs} preserve the two existing JSON contracts`, async () => {
      const row = await persisted({ outputs })
      expect(JSON.stringify(rowToAgent(row).outputs)).toBe(outputs)
      expect(agentFromPersistenceRow(row).outputs).toEqual([])
    })
  }

  for (const outputs of ['', 'not-json']) {
    test(`malformed outputs ${JSON.stringify(outputs)} preserve SyntaxError versus empty list`, async () => {
      const row = await persisted({ outputs })
      expect(() => rowToAgent(row)).toThrow(SyntaxError)
      expect(agentFromPersistenceRow(row).outputs).toEqual([])
    })
  }

  const frontmatterValues: ReadonlyArray<{
    readonly raw: string
    readonly storedExtra: Record<string, unknown>
  }> = [
    { raw: '["kept",42]', storedExtra: { '0': 'kept', '1': 42 } },
    { raw: '"text"', storedExtra: { '0': 't', '1': 'e', '2': 'x', '3': 't' } },
    { raw: 'false', storedExtra: {} },
    { raw: '42', storedExtra: {} },
  ]
  for (const value of frontmatterValues) {
    test(`non-record frontmatter ${value.raw} preserves stored spread versus normalized empty record`, async () => {
      const row = await persisted({ frontmatterExtra: value.raw })
      expect(rowToAgent(row).frontmatterExtra).toEqual(value.storedExtra)
      expect(agentFromPersistenceRow(row).frontmatterExtra).toEqual({})
    })
  }

  for (const frontmatterExtra of ['', 'not-json']) {
    test(`malformed frontmatter ${JSON.stringify(frontmatterExtra)} preserves SyntaxError versus empty record`, async () => {
      const row = await persisted({ frontmatterExtra })
      expect(() => rowToAgent(row)).toThrow(SyntaxError)
      expect(agentFromPersistenceRow(row)).toEqual(baseAgent)
    })
  }

  test('JSON null frontmatter preserves the stored-entry TypeError', async () => {
    const row = await persisted({ frontmatterExtra: 'null' })
    expect(() => rowToAgent(row)).toThrow(TypeError)
    expect(agentFromPersistenceRow(row)).toEqual(baseAgent)
  })

  test('frontmatter is decoded before outputs when both columns would fail', async () => {
    const row = await persisted({ frontmatterExtra: 'null', outputs: 'not-json' })
    expect(() => rowToAgent(row)).toThrow(TypeError)
    expect(agentFromPersistenceRow(row)).toEqual({ ...baseAgent, outputs: [] })
  })
})

test('both Agent row entries use one projection and the obsolete decoders are removed', () => {
  function source(path: string) {
    return ts.createSourceFile(
      path,
      readFileSync(
        new URL(`../src/modules/resource-catalog/infrastructure/${path}`, import.meta.url),
        'utf8',
      ),
      ts.ScriptTarget.Latest,
      true,
    )
  }
  function declaration(file: ts.SourceFile, name: string) {
    const found = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    if (found?.body === undefined) throw new Error(`missing function ${name}`)
    return found.body
  }
  function delegatedCall(file: ts.SourceFile, name: string) {
    const body = declaration(file, name)
    expect(body.statements).toHaveLength(1)
    const statement = body.statements[0]
    if (
      statement === undefined ||
      !ts.isReturnStatement(statement) ||
      statement.expression === undefined ||
      !ts.isCallExpression(statement.expression)
    ) {
      throw new Error(`${name} does not delegate its projection`)
    }
    return {
      name: statement.expression.expression.getText(file),
      arguments: statement.expression.arguments.map((argument) => argument.getText(file)),
    }
  }
  const legacy = source('legacy/agent.ts')
  const common = source('agentPersistence.ts')
  expect(
    legacy.statements
      .filter(ts.isFunctionDeclaration)
      .map((node) => node.name?.text)
      .filter((name) =>
        [
          'parseDependsOnColumn',
          'parseStringArrayColumn',
          'parseSkillRefsColumn',
          'parseInputsColumn',
        ].includes(name ?? ''),
      ),
  ).toEqual([])
  expect(delegatedCall(legacy, 'rowToAgent')).toEqual({
    name: 'agentFromStoredJsonRow',
    arguments: ['row'],
  })
  expect(delegatedCall(common, 'agentFromPersistenceRow')).toEqual({
    name: 'decodeAgentPersistenceRow',
    arguments: ['row', "'normalized'"],
  })
  expect(delegatedCall(common, 'agentFromStoredJsonRow')).toEqual({
    name: 'decodeAgentPersistenceRow',
    arguments: ['row', "'stored-json'"],
  })
  expect(
    declaration(common, 'decodeAgentPersistenceRow').statements.filter(
      (node) =>
        ts.isReturnStatement(node) &&
        node.expression !== undefined &&
        ts.isObjectLiteralExpression(node.expression),
    ),
  ).toHaveLength(1)
})
