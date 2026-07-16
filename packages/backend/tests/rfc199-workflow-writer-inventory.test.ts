// RFC-199 production-writer ratchet.
//
// Editable workflow bytes (name/description/definition/version) have one write
// authority: services/workflow.ts. The only raw UPDATE exceptions are the two
// fusion identity/ACL repairs, which must remain metadata-only. Fixed-id host
// seeds may INSERT, but they share the canonical definition serializer. Tests
// and migrations are intentionally outside this production-source inventory.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

const EXPECTED_WRITERS = {
  insert: {
    'services/agentLaunch.ts': 1,
    'services/workflow.ts': 1,
    'services/workgroupLaunch.ts': 1,
  },
  updateEditable: { 'services/workflow.ts': 1 },
  updateMetadata: { 'services/fusion.ts': 2 },
  delete: { 'services/workflow.ts': 1 },
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
}

function inventoryWorkflowWriters(): WorkflowWriterInventory {
  const inventory: WorkflowWriterInventory = {
    insert: {},
    updateEditable: {},
    updateMetadata: {},
    delete: {},
    insertValueArgs: [],
    metadataSetArgs: [],
  }
  const editableField = /\b(?:name|description|definition|version)\s*:/

  for (const path of walkTsFiles(BACKEND_SRC)) {
    const file = relative(BACKEND_SRC, path).split(sep).join('/')
    const source = stripCommentLines(readFileSync(path, 'utf8'))

    const insert = /\.insert\s*\(\s*workflows\s*\)/g
    for (;;) {
      if (insert.exec(source) === null) break
      increment(inventory.insert, file)
      inventory.insertValueArgs.push({
        file,
        valueArg: extractCallArg(source, insert.lastIndex, 'values'),
      })
    }

    const update = /\.update\s*\(\s*workflows\s*\)/g
    for (;;) {
      if (update.exec(source) === null) break
      const setArg = extractCallArg(source, update.lastIndex, 'set')
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

  test('the only raw updates are the two fusion metadata repairs', () => {
    expect(inventory.updateMetadata).toEqual(EXPECTED_WRITERS.updateMetadata)
    for (const { file, setArg } of inventory.metadataSetArgs) {
      expect(file).toBe('services/fusion.ts')
      expect(setArg).not.toBeNull()
      expect(setArg).not.toMatch(/\b(?:name|description|definition|version|updatedAt)\s*:/)
      expect(setArg).toMatch(/\b(?:ownerUserId|visibility|builtin)\s*:/)
    }
  })

  test('every production insert stores a canonically serialized definition', () => {
    expect(inventory.insertValueArgs).toHaveLength(3)
    for (const { valueArg } of inventory.insertValueArgs) {
      expect(valueArg).not.toBeNull()
      expect(valueArg).toMatch(/\bdefinition\s*:\s*serializeWorkflowDefinitionStorageV1\s*\(/)
    }
  })
})
