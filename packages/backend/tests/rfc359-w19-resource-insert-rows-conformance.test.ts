// RFC-359 AC1: share only MCP/plugin INSERT row construction. The existing
// array-returning writer and Intent's single-row/default-column shape retain
// their own statements and caller-owned transactions. No artifact work runs here.
import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import ts from 'typescript'
import type { CreateMcp } from '@agent-workflow/shared'
import { mcps, plugins, users } from '@/db/schema'
import {
  createMcpInsertValues,
  insertMcpRowInTx,
  type McpInsertRecord,
  type McpPersistenceRow as McpRow,
} from '@/modules/resource-catalog/infrastructure/mcpPersistence'
import {
  createPluginInsertValues,
  insertPluginRowInTx,
} from '@/modules/resource-catalog/infrastructure/pluginPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'resource-insert-owner'
const AT = 1_700_000_000_123
const mcpInputs: readonly CreateMcp[] = [
  {
    name: 'mcp-local',
    description: '配置中文',
    type: 'local',
    config: { command: ['node', 'service.js'], env: { Z: 'last', A: 'first' } },
    enabled: false,
  },
  {
    name: 'mcp-remote',
    description: 'remote',
    type: 'remote',
    config: { url: 'https://example.test/mcp', headers: { Z: 'last', A: 'first' } },
    enabled: true,
  },
]
type PluginInsertRecord = Parameters<typeof insertPluginRowInTx>[1]
const pluginRecords: readonly PluginInsertRecord[] = [
  {
    id: 'plugin-explicit',
    name: 'plugin-explicit',
    spec: 'file:/fixture/plugin',
    options: { z: 1, nested: { no: false, empty: null }, array: [1, 'two'], omit: undefined },
    description: '插件中文',
    enabled: false,
    sourceKind: 'file',
    cachedPath: '/fixture/cache',
    resolvedVersion: null,
    ownerUserId: OWNER,
    visibility: 'private',
    aclRevision: 0,
    now: AT,
  },
  {
    id: 'plugin-default',
    name: 'plugin-default',
    spec: 'fixture-plugin@1',
    options: {},
    description: 'default',
    enabled: true,
    sourceKind: 'npm',
    cachedPath: '/fixture/cache',
    resolvedVersion: '1.2.3',
    ownerUserId: null,
    visibility: 'private',
    aclRevision: 0,
    now: AT,
  },
]

function expectedMcpValues(record: McpInsertRecord) {
  return {
    id: record.id,
    name: record.input.name,
    description: record.input.description,
    type: record.input.type,
    config: JSON.stringify(record.input.config),
    enabled: record.input.enabled,
    ownerUserId: record.ownerUserId,
    visibility: record.visibility,
    aclRevision: record.aclRevision,
    createdAt: record.now,
    updatedAt: record.now,
  }
}
function expectedPluginValues(record: PluginInsertRecord) {
  return {
    id: record.id,
    name: record.name,
    spec: record.spec,
    optionsJson: JSON.stringify(record.options),
    description: record.description,
    enabled: record.enabled,
    sourceKind: record.sourceKind,
    cachedPath: record.cachedPath,
    resolvedVersion: record.resolvedVersion,
    installedAt: record.now,
    ownerUserId: record.ownerUserId,
    visibility: record.visibility,
    aclRevision: record.aclRevision,
    createdAt: record.now,
    updatedAt: record.now,
  }
}

describeEachProvider('RFC-359 shared resource INSERT rows', (harness) => {
  beforeEach(async () => {
    await harness.db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'Insert Owner',
      role: 'admin',
      status: 'active',
      createdAt: AT,
      updatedAt: AT,
    })
  })

  for (const input of mcpInputs) {
    test(`MCP ${input.type} preserves every column and both schema-default mechanisms`, async () => {
      const record: McpInsertRecord = {
        id: input.name,
        input,
        ownerUserId: input.type === 'local' ? OWNER : null,
        visibility: 'private',
        aclRevision: 0,
        now: AT,
      }
      const expected = expectedMcpValues(record)
      const values = createMcpInsertValues(record)
      expect(values).toEqual(expected)
      expect(Object.hasOwn(values, 'schemaVersion')).toBe(false)
      const originalSql = harness.db.insert(mcps).values(expected).returning().toSQL()
      expect(harness.db.insert(mcps).values(values).returning().toSQL()).toEqual(originalSql)
      expect(
        harness.db
          .insert(mcps)
          .values({ ...values, schemaVersion: 1 })
          .returning()
          .toSQL(),
      ).toEqual(
        harness.db
          .insert(mcps)
          .values({ ...expected, schemaVersion: 1 })
          .returning()
          .toSQL(),
      )
      const expectedRow = { ...expected, schemaVersion: 1 }
      const rows = await harness.session.transaction((tx) => insertMcpRowInTx(tx, record))
      expect(rows).toEqual([expectedRow])
      expect<McpRow[]>(await harness.db.select().from(mcps).where(eq(mcps.id, record.id))).toEqual(
        rows,
      )

      // Use a second id/name so both real insert shapes commit independently.
      const singleRecord: McpInsertRecord = {
        ...record,
        id: `${record.id}-single`,
        input: { ...input, name: `${input.name}-single` },
      }
      const singleRow = await harness.session.transaction(
        async (tx) =>
          await tx.insert(mcps).values(createMcpInsertValues(singleRecord)).returning().get(),
      )
      if (singleRow === undefined) throw new Error('MCP single-row insert returned no row')
      expect(singleRow).toEqual({ ...expectedMcpValues(singleRecord), schemaVersion: 1 })
      expect(await harness.db.select().from(mcps).where(eq(mcps.id, singleRecord.id))).toEqual([
        singleRow,
      ])
    })
  }

  for (const record of pluginRecords) {
    test(`plugin ${record.name} preserves every column and both schema-default mechanisms`, async () => {
      const expected = expectedPluginValues(record)
      const values = createPluginInsertValues(record)
      expect(values).toEqual(expected)
      expect(Object.hasOwn(values, 'schemaVersion')).toBe(false)
      const originalSql = harness.db.insert(plugins).values(expected).returning().toSQL()
      expect(harness.db.insert(plugins).values(values).returning().toSQL()).toEqual(originalSql)
      expect(
        harness.db
          .insert(plugins)
          .values({ ...values, schemaVersion: 1 })
          .returning()
          .toSQL(),
      ).toEqual(
        harness.db
          .insert(plugins)
          .values({ ...expected, schemaVersion: 1 })
          .returning()
          .toSQL(),
      )
      const rows = await harness.session.transaction((tx) => insertPluginRowInTx(tx, record))
      expect(rows).toEqual([{ ...expected, schemaVersion: 1 }])
      expect(await harness.db.select().from(plugins).where(eq(plugins.id, record.id))).toEqual(rows)

      const singleRecord = { ...record, id: `${record.id}-single`, name: `${record.name}-single` }
      const singleRow = await harness.session.transaction(
        async (tx) =>
          await tx.insert(plugins).values(createPluginInsertValues(singleRecord)).returning().get(),
      )
      if (singleRow === undefined) throw new Error('plugin single-row insert returned no row')
      expect(singleRow).toEqual({ ...expectedPluginValues(singleRecord), schemaVersion: 1 })
      expect(
        await harness.db.select().from(plugins).where(eq(plugins.id, singleRecord.id)),
      ).toEqual([singleRow])
    })
  }

  test('both MCP insertion shapes remain inside the caller rollback', async () => {
    const input = mcpInputs[0]
    if (input === undefined) throw new Error('MCP fixture missing')
    const record: McpInsertRecord = {
      id: 'rollback-mcp',
      input,
      ownerUserId: OWNER,
      visibility: 'private',
      aclRevision: 0,
      now: AT,
    }
    const sentinel = new Error('rollback both MCP insert shapes')
    await expect(
      harness.session.transaction(async (tx) => {
        const rows = await insertMcpRowInTx(tx, record)
        const single = { ...record, id: 'rollback-mcp-single', input: { ...input, name: 'single' } }
        const row = await tx.insert(mcps).values(createMcpInsertValues(single)).returning().get()
        if (row === undefined) throw new Error('MCP rollback insert returned no row')
        expect<McpRow[]>(await tx.select().from(mcps).orderBy(mcps.id)).toEqual([...rows, row])
        throw sentinel
      }),
    ).rejects.toBe(sentinel)
    expect(await harness.db.select().from(mcps)).toEqual([])
  })

  test('both plugin insertion shapes remain inside the caller rollback', async () => {
    const record = pluginRecords[0]
    if (record === undefined) throw new Error('plugin fixture missing')
    const sentinel = new Error('rollback both plugin insert shapes')
    await expect(
      harness.session.transaction(async (tx) => {
        const rows = await insertPluginRowInTx(tx, record)
        const single = { ...record, id: `${record.id}-single`, name: `${record.name}-single` }
        const row = await tx
          .insert(plugins)
          .values(createPluginInsertValues(single))
          .returning()
          .get()
        if (row === undefined) throw new Error('plugin rollback insert returned no row')
        expect(await tx.select().from(plugins).orderBy(plugins.id)).toEqual([...rows, row])
        throw sentinel
      }),
    ).rejects.toBe(sentinel)
    expect(await harness.db.select().from(plugins)).toEqual([])
  })
})

const infrastructure = join(import.meta.dir, '../src/modules/resource-catalog/infrastructure')
function sourceFile(relative: string) {
  const file = join(infrastructure, relative)
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}
function compact(text: string) {
  return text.replace(/\s+/g, '')
}
function insertValues(source: ts.SourceFile, table: string) {
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'values' &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression.expression) &&
      node.expression.expression.expression.name.text === 'insert' &&
      node.expression.expression.arguments[0]?.getText(source) === table
    )
      found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (found.length !== 1 || found[0] === undefined) throw new Error(`expected one ${table} INSERT`)
  return found[0]
}

test('Intent retains its statements, omitted schema version, defaults and exact insert delegation', () => {
  const source = sourceFile('aggregateAdapters/postgresqlIntentApplyResourcePorts.ts')
  const mcp = insertValues(source, 'mcps')
  const plugin = insertValues(source, 'plugins')
  expect(compact(mcp.arguments[0]?.getText(source) ?? '')).toBe(
    compact(`createMcpInsertValues({
    id: plan.resourceId, input: prepared.input, ownerUserId: actor.user.id,
    visibility: 'private', aclRevision: 0, now: at,
  })`),
  )
  expect(compact(plugin.arguments[0]?.getText(source) ?? '')).toBe(
    compact(`createPluginInsertValues({
    id: plan.resourceId, name: plan.payload.name, spec: plan.payload.spec,
    options: plan.payload.optionsJson ?? {}, description: plan.payload.description,
    enabled: plan.payload.enabled ?? true, sourceKind: prepared.staged.sourceKind,
    cachedPath: prepared.staged.cachedPath, resolvedVersion: prepared.staged.resolvedVersion,
    ownerUserId: actor.user.id, visibility: 'private', aclRevision: 0, now: at,
  })`),
  )
  for (const [table, values] of [
    ['mcps', mcp],
    ['plugins', plugin],
  ] as const) {
    let node: ts.Node = values
    while (!ts.isVariableDeclaration(node) && node.parent !== undefined) node = node.parent
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined)
      throw new Error('insert result missing')
    expect(compact(node.initializer.getText(source))).toBe(
      `awaittransaction.insert(${table}).values(${compact(values.arguments[0]?.getText(source) ?? '')},).returning().get()`,
    )
  }
  expect(source.text).toContain(
    "if (inserted === undefined) throw new Error('mcp insert returned no row')",
  )
  expect(source.text).toContain(
    "if (inserted === undefined) throw new Error('plugin insert returned no row')",
  )
})

test('the existing array-returning writers retain explicit schema version and the same transaction', () => {
  for (const [path, table, factory] of [
    ['mcpPersistence.ts', 'mcps', 'createMcpInsertValues'],
    ['pluginPersistence.ts', 'plugins', 'createPluginInsertValues'],
  ]) {
    if (path === undefined || table === undefined || factory === undefined)
      throw new Error('writer fixture missing')
    const source = sourceFile(path)
    const values = insertValues(source, table)
    expect(compact(values.arguments[0]?.getText(source) ?? '')).toBe(
      `{...${factory}(record),schemaVersion:1,}`,
    )
    let node: ts.Node = values
    while (!ts.isReturnStatement(node) && node.parent !== undefined) node = node.parent
    if (!ts.isReturnStatement(node) || node.expression === undefined)
      throw new Error('insert return missing')
    expect(compact(node.expression.getText(source))).toBe(
      `awaittx.insert(${table}).values({...${factory}(record),schemaVersion:1,}).returning()`,
    )
  }
})
