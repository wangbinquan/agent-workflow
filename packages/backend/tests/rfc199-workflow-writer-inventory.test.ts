// RFC-199 production-writer ratchet.
//
// Editable workflow bytes (name/description/definition/version) normally have
// one write authority: Resource Catalog's legacy/workflow.ts implementation.
// The fixed-id fusion seeder is the sole exception: it minimally repairs the
// merger node's legacy agentId and bumps the workflow version only when that
// byte changes. Fixed-id host seeds
// may INSERT, but they share the canonical definition serializer. Tests and
// migrations are intentionally outside this production-source inventory.

// RFC-395 II-a A2 update (the original rationale above is retained as history):
// Synthesized task subjects no longer INSERT workflow rows; the fusion repair exception remains.
// Tests and migrations remain outside this production-source inventory.

import ts from 'typescript'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const DEFINITION_WRITER = 'modules/resource-catalog/infrastructure/workflowDefinitionWrite.ts'

// A5 routes the same seven insert / five editable-update decisions through one
// transport. Inventory both the business call sites and that sole raw writer.

const EXPECTED_WRITERS = {
  insert: {
    // RFC-395 II-a A2：合成主体不再播种 catalog workflow。
    'modules/resource-catalog/infrastructure/fusionResourceSeed.ts': 1,
    'modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts.ts': 1,
    'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts': 1,
    'modules/resource-catalog/infrastructure/legacy/workflow.ts': 1,
    'modules/resource-catalog/infrastructure/workflowRepository.ts': 2,
    'modules/resource-catalog/infrastructure/demoResourceCatalogSeed.ts': 1,
  },
  updateEditable: {
    'modules/resource-catalog/infrastructure/fusionResourceSeed.ts': 1,
    'modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts.ts': 1,
    'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts': 1,
    'modules/resource-catalog/infrastructure/legacy/workflow.ts': 1,
    'modules/resource-catalog/infrastructure/workflowRepository.ts': 1,
  },
  updateMetadata: {},
  delete: {
    'modules/resource-catalog/infrastructure/legacy/workflow.ts': 1,
    'modules/resource-catalog/infrastructure/workflowRepository.ts': 1,
  },
} as const

function walkTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkTsFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
        ? ''
        : line
    })
    .join('\n')
}

function extractCallArg(content: string, from: number, method: string): string | null {
  const call = new RegExp(`\\.${method}\\s*\\(`, 'g')
  call.lastIndex = from
  if (call.exec(content) === null) return null
  const start = call.lastIndex
  let depth = 1
  for (let index = start; index < content.length; index += 1) {
    const character = content[index]
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return content.slice(start, index)
    }
  }
  return null
}

function increment(counts: Record<string, number>, file: string): void {
  counts[file] = (counts[file] ?? 0) + 1
}

interface WorkflowWriterInventory {
  insert: Record<string, number>
  updateEditable: Record<string, number>
  updateMetadata: Record<string, number>
  delete: Record<string, number>
  insertValueArgs: Array<{ file: string; valueArg: string | null }>
  metadataSetArgs: Array<{ file: string; setArg: string | null }>
  physicalInsertValueArgs: Array<string | null>
  physicalUpdateSetArgs: Array<string | null>
}

function inventoryWorkflowWriters(
  sources = walkTsFiles(BACKEND_SRC).map((path) => ({
    file: relative(BACKEND_SRC, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  })),
): WorkflowWriterInventory {
  const inventory: WorkflowWriterInventory = {
    insert: {},
    updateEditable: {},
    updateMetadata: {},
    delete: {},
    insertValueArgs: [],
    metadataSetArgs: [],
    physicalInsertValueArgs: [],
    physicalUpdateSetArgs: [],
  }
  const editableField = /\b(?:name|description|definition|version)\s*:/

  for (const input of sources) {
    const { file } = input
    const source = stripCommentLines(input.source)

    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'insertOne' &&
        node.arguments[1]?.getText(ast) === 'workflows'
      ) {
        increment(inventory.insert, file)
        inventory.insertValueArgs.push({ file, valueArg: node.arguments[2]?.getText(ast) ?? null })
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const target = node.expression
        const receiver = target.expression
        if (
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === 'createWorkflowDefinitionWriteParticipant'
        ) {
          if (target.name.text === 'insert') {
            increment(inventory.insert, file)
            inventory.insertValueArgs.push({
              file,
              valueArg: node.arguments[0]?.getText(ast) ?? null,
            })
          } else if (target.name.text === 'update') {
            const argument = node.arguments[0]
            const set =
              argument && ts.isObjectLiteralExpression(argument)
                ? argument.properties.find(
                    (property): property is ts.PropertyAssignment =>
                      ts.isPropertyAssignment(property) && property.name.getText(ast) === 'set',
                  )
                : undefined
            const setArg = set?.initializer.getText(ast) ?? null
            if (setArg !== null && editableField.test(setArg)) {
              increment(inventory.updateEditable, file)
            } else {
              increment(inventory.updateMetadata, file)
              inventory.metadataSetArgs.push({ file, setArg })
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    const insert = /\.insert\s*\(\s*workflows\s*\)/g
    for (;;) {
      if (insert.exec(source) === null) break
      const valueArg = extractCallArg(source, insert.lastIndex, 'values')
      if (file === DEFINITION_WRITER) {
        inventory.physicalInsertValueArgs.push(valueArg)
      } else {
        increment(inventory.insert, file)
        inventory.insertValueArgs.push({ file, valueArg })
      }
    }

    const update = /\.update\s*\(\s*workflows\s*\)/g
    for (;;) {
      if (update.exec(source) === null) break
      const setArg = extractCallArg(source, update.lastIndex, 'set')
      if (file === DEFINITION_WRITER) {
        inventory.physicalUpdateSetArgs.push(setArg)
        continue
      }
      if (setArg !== null && editableField.test(setArg)) {
        increment(inventory.updateEditable, file)
      } else {
        increment(inventory.updateMetadata, file)
        inventory.metadataSetArgs.push({ file, setArg })
      }
    }

    const remove = /\.delete\s*\(\s*workflows\s*\)/g
    for (;;) {
      if (remove.exec(source) === null) break
      increment(inventory.delete, file)
    }
  }

  return inventory
}

describe('RFC-199 workflow writer inventory', () => {
  const inventory = inventoryWorkflowWriters()

  test('production workflow inserts, editable updates, and deletes stay on the fenced allowlist', () => {
    expect(inventory.insert).toEqual(EXPECTED_WRITERS.insert)
    expect(inventory.updateEditable).toEqual(EXPECTED_WRITERS.updateEditable)
    expect(inventory.delete).toEqual(EXPECTED_WRITERS.delete)
  })

  test('there are no standalone raw metadata-only workflow updates', () => {
    expect(inventory.updateMetadata).toEqual(EXPECTED_WRITERS.updateMetadata)
    expect(inventory.metadataSetArgs).toEqual([])
  })

  test('the sole physical writer forwards exact caller bytes and editable fields', () => {
    expect(inventory.physicalInsertValueArgs).toEqual(['record'])
    expect(inventory.physicalUpdateSetArgs).toEqual(['input.set'])
  })

  test('writer call-site inventory detects inserts, editable updates and metadata-only bypasses', () => {
    const scanned = inventoryWorkflowWriters([
      {
        file: 'fixture.ts',
        source: `
        createWorkflowDefinitionWriteParticipant(tx).insert({ definition: canonical })
        createWorkflowDefinitionWriteParticipant(tx).update({ id, set: { definition: canonical, version: 2 } })
        createWorkflowDefinitionWriteParticipant(tx).update({ id, set: { updatedAt: 3 } })
        createWorkflowDefinitionWriteParticipant(tx).update({ id, set: unknownPatch })
        tx.insert(workflows).values({ definition: raw })
        tx.update(workflows).set({ name: 'raw' })
        otherWriter(tx).insert({ definition: unrelated })
      `,
      },
    ])
    expect(scanned.insert).toEqual({ 'fixture.ts': 2 })
    expect(scanned.updateEditable).toEqual({ 'fixture.ts': 2 })
    expect(scanned.updateMetadata).toEqual({ 'fixture.ts': 2 })
    expect(scanned.insertValueArgs.map((entry) => entry.valueArg)).toEqual([
      '{ definition: canonical }',
      '{ definition: raw }',
    ])
    expect(scanned.metadataSetArgs.map((entry) => entry.setArg)).toEqual([
      '{ updatedAt: 3 }',
      'unknownPatch',
    ])
  })

  test('every production insert stores a canonically serialized definition', () => {
    const canonicalMarkerByWriter: Record<string, string> = {
      'modules/resource-catalog/infrastructure/fusionResourceSeed.ts': 'repairDefinition.repair(',
      'modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts.ts':
        'serializeWorkflowDefinitionStorageV1(',
      'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts':
        'createWorkflowPersistenceValues(',
      'modules/resource-catalog/infrastructure/legacy/workflow.ts':
        'serializeWorkflowDefinitionStorageV1(',
      'modules/resource-catalog/infrastructure/workflowRepository.ts':
        'createWorkflowPersistenceValues(',
      'modules/resource-catalog/infrastructure/demoResourceCatalogSeed.ts':
        'createWorkflowPersistenceValues(',
    }
    expect(
      readFileSync(
        join(BACKEND_SRC, 'modules/knowledge-evolution/infrastructure/fusionRepository.ts'),
        'utf8',
      ),
    ).toContain('input.resourceSeed.seed(seed, { repair: repairFusionWorkflowDefinition })')
    // RFC-359 W4-B2：演示种子的两份 provider 持久化合成一份（14 → 13）；
    // RFC-359 W4-D5：融合仓库的两份 provider 实现合成一份（13 → 12）；
    // RFC-359 AC-1（plan §5ge）：agent 启动资源的两份合成一份（12 → 11）；
    // RFC-359 AC-1（plan §5hn 批次二 ①）：工作组宿主锚行的懒种同样合成一份（11 → 10）
    // RFC-395 II-a A2：再删 agent / workgroup / digital-employee 三个宿主播种（10 → 7）。
    expect(inventory.insertValueArgs).toHaveLength(7)
    expect(Object.keys(inventory.insert).sort()).toEqual(
      Object.keys(canonicalMarkerByWriter).sort(),
    )
    for (const file of Object.keys(inventory.insert)) {
      expect(readFileSync(join(BACKEND_SRC, file), 'utf8')).toContain(
        canonicalMarkerByWriter[file]!,
      )
    }
  })
})
